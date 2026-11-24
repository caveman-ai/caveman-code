// Sends what the outbox holds to Caveman Cloud (docs/):
// POST /api/v1/code/bug-reports on the kept Caveman sign-in, multipart with the
// `report` part first (Cloud checks idempotency and rate limits before it reads
// an attachment, and refuses another order with 400). A report waits through
// being offline, signed out or rate limited and is tried again with backoff; a
// report Cloud refuses for good (too large, malformed) says why. Only over
// HTTPS, or to a Cloud on this computer (a local Caveman Cloud in development).
// Once Cloud has it, the logs and screenshot leave this computer's outbox.
import { BUG_REPORT_ROUTE, BUG_REPORTS_UNAVAILABLE } from "@caveman-app/bug-report";
import type { BugReportOutbox, OutboxRecord } from "@caveman-app/bug-report/node";

import { accountCall, SignedOut, type AccountStore } from "../cloudLink/account.ts";

/** The first retry's wait; it doubles per attempt up to MAX_BACKOFF_MS. */
export const MIN_BACKOFF_MS = 30_000;
export const MAX_BACKOFF_MS = 60 * 60_000;
/** Signed out: look again this often (a sign-in sends it sooner, through the next tick). */
export const SIGNED_OUT_WAIT_MS = 5 * 60_000;
/** A Cloud that takes no reports yet (404): look again this often, within GIVE_UP_AFTER_MS. */
export const UNAVAILABLE_WAIT_MS = 24 * 60 * 60_000;
/** A report that could not go out for this long stops trying and says so. */
export const GIVE_UP_AFTER_MS = 7 * 24 * 60 * 60_000;

/** HTTPS, or a Cloud on this computer. Nothing is sent in the clear over a network. */
export function secureCloudUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    return (
      parsed.protocol === "http:" &&
      /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(MIN_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
  return Math.round(base * (0.8 + 0.4 * random()));
}

const SERVER_STATUSES = new Set(["received", "triaged", "fixed"]);

async function reason(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; message?: string };
    return body.message ?? body.error ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

export interface SenderDeps {
  readonly outbox: BugReportOutbox;
  readonly store: AccountStore;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly log?: (line: string) => void;
}

export type BugReportSender = ReturnType<typeof makeBugReportSender>;

export function makeBugReportSender(deps: SenderDeps) {
  const { outbox, store } = deps;
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  /** One attempt per report at a time; a delete waits for one in flight. */
  const inflight = new Map<string, Promise<OutboxRecord | undefined>>();

  const iso = (ms: number) => new Date(ms).toISOString();

  const retryLater = (
    record: OutboxRecord,
    lastError: string,
    waitMs?: number,
  ): OutboxRecord | undefined => {
    const attempts = record.attempts + 1;
    if (now() - Date.parse(record.createdAt) > GIVE_UP_AFTER_MS) {
      return outbox.update(record.reportId, {
        state: "failed",
        attempts,
        lastError: `Not sent after a week of trying: ${lastError}`,
        nextAttemptAt: undefined,
      });
    }
    return outbox.update(record.reportId, {
      state: "queued",
      attempts,
      lastError,
      nextAttemptAt: iso(now() + (waitMs ?? backoffMs(attempts, deps.random))),
    });
  };

  const attemptOnce = async (id: string): Promise<OutboxRecord | undefined> => {
    const record = outbox.get(id);
    if (!record || record.state === "sent" || record.state === "failed") return record;
    const parts = outbox.parts(id);
    if (!parts)
      return outbox.update(id, {
        state: "failed",
        lastError: "The report's files are missing from this computer.",
        nextAttemptAt: undefined,
      });
    const session = await store.load();
    if (!session) {
      // Not counted towards giving up quickly: signing in is the person's to do.
      return outbox.update(id, {
        state: "queued",
        lastError: "Sign in to Caveman to send it.",
        nextAttemptAt: iso(now() + SIGNED_OUT_WAIT_MS),
      });
    }
    if (!secureCloudUrl(session.cloud_url)) {
      return outbox.update(id, {
        state: "failed",
        lastError: "Not sent: the Caveman server you're signed in to isn't on HTTPS.",
        nextAttemptAt: undefined,
      });
    }
    outbox.update(id, { state: "sending" });
    const form = new FormData();
    // The contract's order: report first, then the attachments.
    form.append(
      "report",
      new Blob([JSON.stringify(parts.payload)], { type: "application/json" }),
      "report.json",
    );
    if (parts.logs)
      form.append(
        "logs",
        new Blob([new Uint8Array(parts.logs)], { type: "application/gzip" }),
        "logs.tar.gz",
      );
    if (parts.screenshot)
      form.append(
        "screenshot",
        new Blob([new Uint8Array(parts.screenshot)], { type: "image/png" }),
        "screenshot.png",
      );
    let response: Response;
    try {
      response = await accountCall(
        store,
        BUG_REPORT_ROUTE,
        { method: "POST", body: form },
        fetchImpl,
      );
    } catch (error) {
      if (error instanceof SignedOut)
        return outbox.update(id, {
          state: "queued",
          lastError: "Sign in to Caveman to send it.",
          nextAttemptAt: iso(now() + SIGNED_OUT_WAIT_MS),
        });
      log(
        `bug report ${id}: not sent (${error instanceof Error ? error.message : String(error)}); will retry`,
      );
      return retryLater(record, "Couldn't reach Caveman. It sends when you're back online.");
    }
    if (response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        status?: string;
        duplicateOf?: string;
      };
      outbox.dropParts(id);
      log(`bug report ${id}: sent`);
      return outbox.update(id, {
        state: "sent",
        attempts: record.attempts + 1,
        sentAt: iso(now()),
        serverStatus: SERVER_STATUSES.has(body.status ?? "")
          ? (body.status as OutboxRecord["serverStatus"])
          : "received",
        ...(body.duplicateOf ? { duplicateOf: body.duplicateOf } : {}),
        lastError: undefined,
        nextAttemptAt: undefined,
      });
    }
    const why = await reason(response);
    log(`bug report ${id}: Cloud answered ${response.status} (${why})`);
    if (response.status === 413)
      return outbox.update(id, {
        state: "failed",
        attempts: record.attempts + 1,
        lastError: "Too large for Caveman to take. Send it again without the logs or screenshot.",
        nextAttemptAt: undefined,
      });
    if (response.status === 429) {
      const after = Number(response.headers.get("retry-after"));
      return retryLater(
        record,
        "Caveman is taking no more reports from you today. It sends later.",
        Number.isFinite(after) && after > 0 ? after * 1000 : undefined,
      );
    }
    if (response.status >= 500 || response.status === 408)
      return retryLater(
        record,
        `Caveman couldn't take it just now (${response.status}). It tries again.`,
      );
    // No report route on this Cloud (not deployed yet, or a company's own without it): the report stays here, its
    // parts kept, and is tried once a day until the week is up, so it goes once the route ships.
    if (response.status === 404)
      return retryLater(record, BUG_REPORTS_UNAVAILABLE, UNAVAILABLE_WAIT_MS);
    // 400, 403, 422: trying again would get the same answer.
    return outbox.update(id, {
      state: "failed",
      attempts: record.attempts + 1,
      lastError: `Caveman refused it: ${why}`,
      nextAttemptAt: undefined,
    });
  };

  const attempt = (id: string): Promise<OutboxRecord | undefined> => {
    const running = inflight.get(id);
    if (running) return running;
    const flight = attemptOnce(id).finally(() => inflight.delete(id));
    inflight.set(id, flight);
    return flight;
  };

  return {
    attempt,

    /** Every waiting report that is due, one after another. */
    sendDue: async (): Promise<void> => {
      for (const record of outbox.list().reverse()) {
        if (record.state !== "queued") continue;
        if (record.nextAttemptAt && Date.parse(record.nextAttemptAt) > now()) continue;
        await attempt(record.reportId).catch((error) =>
          log(`bug report ${record.reportId}: ${String(error)}`),
        );
      }
    },

    /** At start: a report left mid-send by a crash goes back in the queue, and old records go. */
    recover: (): void => {
      outbox.prune(now());
      for (const record of outbox.list())
        if (record.state === "sending")
          outbox.update(record.reportId, { state: "queued", nextAttemptAt: undefined });
    },

    /** What Cloud says of a sent report now (GET /api/v1/code/bug-reports/{id}). */
    refresh: async (id: string): Promise<OutboxRecord | undefined> => {
      const record = outbox.get(id);
      if (!record || record.state !== "sent") return record;
      const response = await accountCall(
        store,
        `${BUG_REPORT_ROUTE}/${encodeURIComponent(id)}`,
        {},
        fetchImpl,
      );
      if (response.status === 404)
        return outbox.update(id, {
          lastError: "Caveman no longer holds this report (deleted, or past 90 days).",
        });
      if (!response.ok) return record;
      const body = (await response.json()) as { status?: string; fixedInVersion?: string };
      return outbox.update(id, {
        ...(SERVER_STATUSES.has(body.status ?? "")
          ? { serverStatus: body.status as OutboxRecord["serverStatus"] }
          : {}),
        ...(body.fixedInVersion ? { fixedInVersion: body.fixedInVersion } : {}),
      });
    },

    /**
     * Deletes a report: from Cloud first when it was sent (DELETE …/{id}; one Cloud no longer holds counts
     * as deleted), then from this computer. A report not sent yet only leaves the outbox.
     */
    remove: async (id: string): Promise<void> => {
      await inflight.get(id)?.catch(() => undefined);
      const record = outbox.get(id);
      if (!record) return;
      if (record.state === "sent") {
        const response = await accountCall(
          store,
          `${BUG_REPORT_ROUTE}/${encodeURIComponent(id)}`,
          { method: "DELETE" },
          fetchImpl,
        );
        if (!response.ok && response.status !== 404)
          throw new Error(`Caveman couldn't delete it: ${await reason(response)}`);
      }
      outbox.remove(id);
    },
  };
}
