// The Review page's reads: one cache for the whole app (module level), so leaving a pull request and coming back, or
// hovering a queue row first, paints at once. Each read is deduped while in flight and shown stale while it
// refreshes; a write invalidates what it touched. Polls only a guide that is being written.
import type { Client } from "@caveman-app/session-protocol/client";
import type { PrDetail, PrDiscussionItem, PrGuideResult, PrSummary } from "@caveman-app/session-protocol";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { DiffFile } from "../../panels/diff/parsePatch.ts";
import { prKey, type PrAddress } from "./model.ts";
import { sourceTag } from "./source.ts";

export interface Queue {
  readonly prs: ReadonlyArray<PrSummary>;
  readonly viewers: Readonly<Record<string, string>>;
  /** `repo`: Cloud names the repository it could not read (its projects are not this computer's). */
  readonly errors: ReadonlyArray<{ readonly project_id: string; readonly message: string; readonly repo?: string | undefined }>;
  readonly unavailable?: string | undefined;
  /** From Cloud (source.ts): "not_connected" when Cloud keeps no GitHub link of the person's, and where to make one. */
  readonly github?: "connected" | "not_connected" | undefined;
  readonly connect_url?: string | undefined;
}
export interface PrDiff {
  readonly head_sha?: string | undefined;
  /** The host's name for the push these patches were read at, when it can read that push again. */
  readonly revision?: string | undefined;
  readonly files: ReadonlyArray<DiffFile>;
  readonly omitted: ReadonlyArray<string>;
}

interface Entry {
  value?: unknown;
  error?: string;
  /** When `value` was read; 0 for never. */
  at: number;
  inflight?: Promise<unknown> | undefined;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Fresh enough to show without asking again. */
const TTL = { queue: 60_000, detail: 30_000, diff: 5 * 60_000, discussion: 30_000, guide: 30_000, file: 10 * 60_000, symbol: 5 * 60_000 } as const;
type Kind = keyof typeof TTL;

/**
 * `force` (a write's refresh, a guide run asked for) never shares a read already out: that one left before the change,
 * so a new one goes now, and only the read that went last lands in the cache.
 */
function load<T>(key: string, kind: Kind, read: () => Promise<T>, force = false): Promise<T> {
  const entry = entries.get(key) ?? { at: 0 };
  entries.set(key, entry);
  if (entry.inflight && !force) return entry.inflight as Promise<T>;
  if (!force && entry.at > 0 && Date.now() - entry.at < TTL[kind]) return Promise.resolve(entry.value as T);
  const run: Promise<T> = read().then(
    (value) => {
      if (entry.inflight !== run) return value;
      entry.value = value;
      delete entry.error;
      entry.at = Date.now();
      entry.inflight = undefined;
      emit();
      return value;
    },
    (error: unknown) => {
      if (entry.inflight !== run) throw error;
      entry.error = error instanceof Error ? error.message : String(error);
      entry.inflight = undefined;
      emit();
      throw error;
    },
  );
  entry.inflight = run;
  emit();
  return run;
}

export interface Resource<T> {
  readonly value: T | undefined;
  readonly error: string | undefined;
  /** A read is in flight (with or without a stale value showing). */
  readonly loading: boolean;
  readonly reload: () => void;
}

function useResource<T>(client: Client | null, key: string | null, kind: Kind, read: (client: Client) => Promise<T>): Resource<T> {
  useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    if (client && key) void load(key, kind, () => read(client)).catch(() => undefined);
    // `read` is rebuilt each render; the key names what it reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, kind]);
  const reload = useCallback(() => {
    if (client && key) void load(key, kind, () => read(client), true).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `read` is rebuilt each render; the key names what it reads.
  }, [client, key, kind]);
  const entry = key ? entries.get(key) : undefined;
  return { value: entry?.value as T | undefined, error: entry?.error, loading: Boolean(entry?.inflight), reload };
}

/** The wire address: only the fields that are set. */
export const prRef = (pr: PrAddress) => ({ project_id: pr.project_id, number: pr.number, ...(pr.repo ? { repo: pr.repo } : {}), ...(pr.host ? { host: pr.host } : {}) });

const readQueue = (client: Client) => client.call("pr.list", { state: "open" }) as Promise<Queue>;
const readDetail = (pr: PrAddress) => (client: Client) => client.call("pr.get", prRef(pr)) as Promise<PrDetail>;
const readDiff = (pr: PrAddress) => (client: Client) => client.call("pr.diff", prRef(pr)) as Promise<PrDiff>;
const readDiscussion = (pr: PrAddress) => (client: Client) => client.call("pr.discussion", prRef(pr)).then((r) => r.items as ReadonlyArray<PrDiscussionItem>);
const readGuide = (pr: PrAddress) => (client: Client) => client.call("pr.guide", prRef(pr)) as Promise<PrGuideResult>;

/** The queue, kept per source: a window that leaves Cloud for a Mac never shows Cloud's rows as the Mac's. */
export const useQueue = (client: Client | null) => useResource(client, `queue${sourceTag(client)}`, "queue", readQueue);
export const usePrDetail = (client: Client | null, pr: PrAddress) => useResource(client, `detail:${prKey(pr)}`, "detail", readDetail(pr));
export const usePrDiff = (client: Client | null, pr: PrAddress, enabled = true) => useResource(client, enabled ? `diff:${prKey(pr)}` : null, "diff", readDiff(pr));
export const usePrDiscussion = (client: Client | null, pr: PrAddress) => useResource(client, `discussion:${prKey(pr)}`, "discussion", readDiscussion(pr));

/** A changed file whole, before and after: read only once a reader opens lines its patch leaves out. */
export interface PrFileContents {
  readonly old: string;
  readonly new: string;
}
/** A key of the patch itself, the same for the same patch: cyrb53 over every file's path and hunks. */
const patchKeys = new WeakMap<PrDiff, string>();
const patchKeyOf = (diff: PrDiff) => {
  const known = patchKeys.get(diff);
  if (known !== undefined) return known;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  const feed = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
  };
  for (const file of diff.files) for (const part of [file.path, file.old_path ?? "", file.status, file.patch]) feed(`${part}\0`);
  for (const path of diff.omitted) feed(`${path}\0`);
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const key = `patch:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
  patchKeys.set(diff, key);
  return key;
};
/**
 * Where Files reads from, both from the patch on screen: what its marks and file reads are kept under, and the revision
 * the patch was read at, so a file opened after a push still matches the hunks it opens into. They are kept under the
 * head the host read the patch at, and under the patch itself where no host vouches for a head (it cannot say, or a
 * push landed mid-read): never under a head a separate read found, which may already be the next push's.
 */
export const filesReadAt = (diff: PrDiff | undefined) => ({ head: diff === undefined ? "" : diff.head_sha ?? patchKeyOf(diff), revision: diff?.revision });
export const readPrFile = (pr: PrAddress, revision: string | undefined, file: Pick<DiffFile, "path" | "old_path" | "status">) => (client: Client) =>
  client.call("pr.file", { ...prRef(pr), path: file.path, ...(file.old_path ? { old_path: file.old_path } : {}), status: file.status, ...(revision ? { revision } : {}) }) as Promise<PrFileContents>;
/**
 * `file` null reads nothing (nothing asked for yet). Read at `revision`, the diff's, so the lines match the patch they
 * open into even after a push; keyed by head and revision, so a push reads the new file once the new patch is shown.
 */
export const usePrFile = (client: Client | null, pr: PrAddress, head: string, revision: string | undefined, file: Pick<DiffFile, "path" | "old_path" | "status"> | null) =>
  useResource(client, file ? `file:${prKey(pr)}@${head}#${revision ?? ""}:${file.path}` : null, "file", readPrFile(pr, revision, file ?? { path: "", status: "modified" }));

/** Every line naming a symbol in this project's checkout (pr.symbol): at the head when it is here, else the base. */
export interface PrSymbolHits {
  readonly at: "head" | "base";
  readonly commit: string;
  readonly hits: ReadonlyArray<{ readonly path: string; readonly line: number; readonly text: string }>;
  readonly truncated: boolean;
}
const readSymbol = (pr: PrAddress, name: string) => (client: Client) => client.call("pr.symbol", { ...prRef(pr), name }) as Promise<PrSymbolHits>;
export const usePrSymbol = (client: Client | null, pr: PrAddress, head: string, name: string | null) =>
  useResource(client, name ? `symbol:${prKey(pr)}@${head}:${name}` : null, "symbol", readSymbol(pr, name ?? ""));

/** How often a guide being written is asked after. */
const GUIDE_POLL_MS = 2500;
/** Heads a guide run was started for from this page: once per head, so a failed run is never retried by itself. */
const started = new Set<string>();
/** Why there is no guide when the run started for its head ended with neither a guide nor a failure. */
export const GUIDE_RUN_LOST = "The run stopped before the guide was written.";
/** Why the last run asked for from this page did not start, by guide key, until one does: no run ever stopped. */
const refused = new Map<string, string>();

/** The head a guide run is due for (`guide:<pr>@<head>`): none is written for it and none is running or failed. */
function guideDue(key: string, result: PrGuideResult | undefined, enabled: boolean, short: boolean | null): string | null {
  if (!enabled || !result || result.running || result.failed) return null;
  const guide = result.guide;
  const atHead = guide !== null && (result.head_sha === undefined || guide.head_sha === result.head_sha);
  const tourDue = atHead && guide.depth === "tldr" && short === false;
  return guide && !tourDue ? null : `${key}@${result.head_sha ?? ""}`;
}

/**
 * The pull request's guide. With no guide for its head and no run, one is started (once per head: a run costs a
 * model call, so opening a page never starts a second), and a run in progress is polled until it lands. So is a
 * tour for a long change (`short` false) that so far has only the TL;DR the chat that opened it wrote. Nothing
 * starts while guides are off (`enabled`). `generate({ full: true })` writes the tour even for a short change.
 * A run started here that ends with no guide and no failure (a runtime restart drops a run in progress) reads as
 * failed, so the reader is offered it again; one the runtime refused to start keeps saying why.
 */
export function usePrGuide(
  client: Client | null,
  pr: PrAddress,
  { enabled = true, short = null }: { enabled?: boolean; short?: boolean | null } = {},
): Resource<PrGuideResult> & { readonly generate: (options?: { full?: boolean }) => void } {
  const key = `guide:${prKey(pr)}`;
  const res = useResource(client, key, "guide", readGuide(pr));
  const result = res.value;
  const generate = useCallback(
    (options?: { full?: boolean }) => {
      if (!client) return;
      // Noted before the answer lands, so the render it causes already knows whether this run started.
      const press = () =>
        (client.call("pr.guide", { ...prRef(pr), generate: true, ...(options?.full ? { full: true } : {}) }) as Promise<PrGuideResult>).then(
          (answer) => (refused.delete(key), answer),
          (error: unknown) => {
            refused.set(key, error instanceof Error ? error.message : String(error));
            throw error;
          },
        );
      void load(key, "guide", press, true).catch(() => undefined);
    },
    [client, key, pr],
  );
  const due = guideDue(key, result, enabled, short);
  useEffect(() => {
    if (due === null || !client || started.has(due)) return;
    started.add(due);
    generate();
  }, [due, client, generate]);
  useEffect(() => (client ? pollGuide(client, pr) : undefined), [client, pr]);
  const lost = due !== null && started.has(due) && !res.loading && res.error === undefined;
  const value = useMemo(() => (lost && result ? { ...result, failed: refused.get(key) ?? GUIDE_RUN_LOST } : result), [lost, result, key]);
  return { ...res, value, generate };
}

/**
 * While watched, a guide being written is read again GUIDE_POLL_MS after each read of it lands, until it is no
 * longer running. Paced by reads landing, not by new values: a failed read keeps the value it had (still running),
 * and must not end the polling and leave the page on "reading" for good. Returns the stop.
 */
export function pollGuide(client: Client, pr: PrAddress): () => void {
  const key = `guide:${prKey(pr)}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    const entry = entries.get(key);
    if (timer !== undefined || entry?.inflight || !(entry?.value as PrGuideResult | undefined)?.running) return;
    timer = setTimeout(() => {
      timer = undefined;
      void load(key, "guide", () => readGuide(pr)(client), true).catch(() => undefined);
    }, GUIDE_POLL_MS);
  };
  listeners.add(check);
  check();
  return () => {
    listeners.delete(check);
    clearTimeout(timer);
  };
}

/** Warm a pull request before it is opened (a queue row's hover): its detail, guide and diff. */
export function prefetchPr(client: Client | null, pr: PrAddress): void {
  if (!client) return;
  const k = prKey(pr);
  void load(`detail:${k}`, "detail", () => readDetail(pr)(client)).catch(() => undefined);
  // Cloud runs no guide: none is read from it.
  if (sourceTag(client) === "") void load(`guide:${k}`, "guide", () => readGuide(pr)(client)).catch(() => undefined);
  void load(`diff:${k}`, "diff", () => readDiff(pr)(client)).catch(() => undefined);
}

/** After a write: read these again (and the queue, whose rows carry review state). */
export function invalidatePr(client: Client | null, pr: PrAddress, ...kinds: Array<"detail" | "discussion" | "diff" | "guide">): void {
  if (!client) return;
  const k = prKey(pr);
  const readers = { detail: readDetail, discussion: readDiscussion, diff: readDiff, guide: readGuide } as const;
  for (const kind of kinds) void load<unknown>(`${kind}:${k}`, kind, () => readers[kind](pr)(client) as Promise<unknown>, true).catch(() => undefined);
  void load(`queue${sourceTag(client)}`, "queue", () => readQueue(client), true).catch(() => undefined);
}

