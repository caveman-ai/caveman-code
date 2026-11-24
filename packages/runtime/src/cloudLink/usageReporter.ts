// This Mac's usage to Caveman Cloud: while the runtime is enrolled (signed in), each
// model call's tokens and cost go to Cloud's POST /api/v1/code/runtime/local-usage with the runtime's own
// token. Cloud takes the organization and the person from that token. Only numbers, the model and the
// engine leave, keyed by the session's opaque id and the event's own id: no prompt, path or repository.
// Usage from before the sign-in is never sent. Up to 100 events a request, once a minute; a failure
// retries from the same place next minute, and Cloud records each event once.
import * as fs from "node:fs";
import * as path from "node:path";

import type { SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";

import * as ServerConfig from "../config.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import { SessionStore } from "../session-protocol/store.ts";
import { reportLocalUsage } from "./computers.ts";
import { readIdentity, RECORD_FILE } from "./identity.ts";
import { CloudComputer, CloudLinkState, linkDirOf, type LinkState } from "./index.ts";

type Usage = Extract<SessionEvent, { type: "usage" }>["payload"];

/** Where this runtime's reports have reached: sent journal rows, and the sign-in time nothing before is sent. */
interface Cursor {
  readonly since: string;
  readonly events: number;
  readonly spend: number;
}

const BATCH = 100;

/** Sends what the journal holds past the cursor, in batches; returns how many events Cloud took or refused. */
export const flushUsage = (input: { readonly dir: string; readonly state: LinkState; readonly fetchImpl?: typeof fetch; readonly maxBatches?: number }) =>
  Effect.gen(function* () {
    const identity = readIdentity(input.dir);
    if (!identity) return 0; // not signed in: nothing leaves
    const store = yield* SessionStore;
    const scrubber = yield* (yield* ProjectSecrets).scrubber;
    const key = `cloud_usage_cursor:${identity.runtimeId}`;
    const raw = yield* store.kvGet(key);
    // First sight of this sign-in: start at the moment it enrolled (runtime.json's write).
    let cursor: Cursor = raw ? JSON.parse(raw) : { since: fs.statSync(path.join(input.dir, RECORD_FILE)).mtime.toISOString(), events: 0, spend: 0 };
    if (!raw) yield* store.kvSet(key, JSON.stringify(cursor));
    const records = yield* store.listWorkspaces();
    const bySession = new Map(records.map((r) => [r.session.id, r]));
    const byWorkspace = new Map(records.map((r) => [r.workspace.id, r]));
    let sent = 0;
    for (let batch = 0; batch < (input.maxBatches ?? 10); batch++) {
      const rows = yield* store.sql<{ rowid: number; event: string }>`SELECT rowid, event FROM caveman_sp_events
        WHERE type = 'usage' AND rowid > ${cursor.events} AND at >= ${cursor.since} ORDER BY rowid LIMIT ${BATCH}`.pipe(Effect.orDie);
      const side =
        rows.length < BATCH
          ? yield* store.sql<{ seq: number; at: string; workspace_id: string | null; usage: string }>`SELECT seq, at, workspace_id, usage FROM caveman_sp_spend
              WHERE seq > ${cursor.spend} AND at >= ${cursor.since} ORDER BY seq LIMIT ${BATCH - rows.length}`.pipe(Effect.orDie)
          : [];
      if (rows.length === 0 && side.length === 0) break;
      const events: Array<ReturnType<typeof wire>> = [];
      for (const row of rows) {
        const event = JSON.parse(scrubber.scrub(row.event)) as Extract<SessionEvent, { type: "usage" }>;
        const ws = bySession.get(event.session_id);
        // A fork carries copies of its source's events: its source reports them.
        if (ws?.session.forked_from && event.cursor <= ws.session.forked_from.cursor) continue;
        events.push(wire(`${event.session_id}:${event.cursor}`, event.session_id, event.at, event.payload, ws?.workspace.engine));
      }
      for (const row of side) {
        const ws = row.workspace_id ? byWorkspace.get(row.workspace_id) : undefined;
        const usage = JSON.parse(scrubber.scrub(row.usage)) as Usage & { readonly bucket?: string };
        // Web searches are no model calls: one on credits Cloud billed itself, one on an own key is the provider's to bill.
        if (usage.bucket === "web") continue;
        events.push(wire(`spend:${row.seq}`, ws?.session.id ?? row.workspace_id ?? "runtime", row.at, usage, ws?.workspace.engine));
      }
      if (events.length > 0) yield* Effect.tryPromise(() => reportLocalUsage(identity, input.state, events, input.fetchImpl));
      sent += events.length;
      cursor = { ...cursor, events: rows.at(-1)?.rowid ?? cursor.events, spend: side.at(-1)?.seq ?? cursor.spend };
      yield* store.kvSet(key, JSON.stringify(cursor));
    }
    return sent;
  });

/** One call as Cloud takes it: tokens, cost, model and engine, never more. */
const wire = (requestId: string, sessionId: string, at: string, usage: Usage, engine: string | undefined) => ({
  request_id: requestId,
  session_id: sessionId,
  engine: usage.engine ?? engine ?? "unknown",
  model: usage.model,
  input_tokens: usage.input_tokens,
  output_tokens: usage.output_tokens,
  cache_read_tokens: usage.cache_read_tokens,
  cache_write_tokens: usage.cache_write_tokens,
  cost: usage.cost ? { usd: usage.cost.usd, basis: usage.cost.basis } : null,
  occurred_at: at,
});

/** Reports once a minute on This Mac. A Cloud computer's sessions are Cloud's own and report nothing here. */
export const run = Effect.gen(function* () {
  if (yield* CloudComputer) return;
  const config = yield* ServerConfig.ServerConfig;
  const state = yield* CloudLinkState;
  const dir = linkDirOf(config.stateDir);
  yield* Effect.forever(
    flushUsage({ dir, state }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Could not report usage to Caveman Cloud; trying again in a minute", cause)),
      Effect.andThen(Effect.sleep("1 minute")),
    ),
  );
});
