// Which URLs web_fetch may fetch (docs/ "Safety"): only one the person wrote in the thread, or one
// a web result showed it (a search result, a link in a page it read, a redirect's target). A tool's output never
// counts: the model writes what a code cell prints or a file holds (`.env` read, then printed as a URL), so a link
// from there could carry anything out. Web results are kept here per thread; the person's messages are read from
// the orchestration projection, only the rows that mention the URL's host.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { MAX_URL_CHARS } from "./inline.ts";

/**
 * The form two mentions of one page share: host without `www.` and default port, path without a trailing slash,
 * the query as written. The scheme does not count (fetching https for an http link carries nothing) and the
 * fragment never reaches the server.
 */
export function urlKey(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const port = url.port === "" || url.port === "80" || url.port === "443" ? "" : `:${url.port}`;
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : "";
  return `${host}${port}${path}${url.search}`;
}

/** The host a key starts with, which is how a row is found that may mention it. */
export const keyHost = (key: string) => key.split(/[/:?]/, 1)[0]!;

const WITH_SCHEME = /\bhttps?:\/\/[^\s<>"'`)\]}\\]+/gi;
// A bare `docs.example.com/guide`, as people write links; never part of an email address or a longer word.
const BARE = /(?<![\w@./-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{2,5})?(?:\/[^\s<>"'`)\]}\\]*)?/gi;

/** The URL keys written in `text`, trailing punctuation off. */
export function urlKeysIn(text: string): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const re of [WITH_SCHEME, BARE]) {
    for (const match of text.matchAll(re)) {
      const key = urlKey(match[0].replace(/[.,;:!?*_~]+$/, ""));
      if (key !== undefined) keys.add(key);
    }
  }
  return keys;
}

const MAX_THREADS = 200;
const MAX_KEYS_PER_THREAD = 5_000;
/** All threads' links together, in memory (UTF-16, two bytes a character): past it the least recent threads go. */
export const MAX_LINK_BYTES = 8 * 1024 * 1024;
/**
 * Links a page can make fetchable, per thread: the first this many the model was shown of it. Which link the model
 * follows is a choice it could encode data in; a short list keeps that to a few bits a fetch.
 */
export const MAX_LINKS_PER_PAGE = 50;

interface ThreadLinks {
  readonly keys: Set<string>;
  /** Links each page has made fetchable, by the page's key. */
  readonly fromPage: Map<string, number>;
  bytes: number;
}

/**
 * URLs web results showed each thread, the most recent threads kept within MAX_THREADS and MAX_LINK_BYTES. Memory
 * only: nothing about a thread's reading is written.
 */
export class WebLinks {
  readonly #threads = new Map<string, ThreadLinks>();
  #bytes = 0;

  #thread(threadId: string) {
    const thread = this.#threads.get(threadId) ?? { keys: new Set<string>(), fromPage: new Map<string, number>(), bytes: 0 };
    this.#threads.delete(threadId);
    this.#threads.set(threadId, thread);
    return thread;
  }

  /** The key, kept, when it is new and the thread has room; web_fetch would refuse a longer URL, so none is kept. */
  #keep(thread: ThreadLinks, url: string) {
    if (thread.keys.size >= MAX_KEYS_PER_THREAD || url.length > MAX_URL_CHARS) return false;
    const key = urlKey(url);
    if (key === undefined || thread.keys.has(key)) return false;
    thread.keys.add(key);
    thread.bytes += key.length * 2;
    this.#bytes += key.length * 2;
    return true;
  }

  /** The least recent threads go until all fit; the one just added to stays. */
  #trim() {
    while (this.#threads.size > 1 && (this.#threads.size > MAX_THREADS || this.#bytes > MAX_LINK_BYTES)) {
      const [oldest, thread] = this.#threads.entries().next().value!;
      this.#threads.delete(oldest);
      this.#bytes -= thread.bytes;
    }
  }

  /** Search results and redirect targets: every one shown. */
  add(threadId: string, urls: Iterable<string>) {
    const thread = this.#thread(threadId);
    for (const url of urls) this.#keep(thread, url);
    this.#trim();
  }

  /** Links shown in a read of the page with key `pageKey`, until the page has made MAX_LINKS_PER_PAGE fetchable. */
  addFromPage(threadId: string, pageKey: string, urls: Iterable<string>) {
    const thread = this.#thread(threadId);
    let added = thread.fromPage.get(pageKey) ?? 0;
    for (const url of urls) {
      if (added >= MAX_LINKS_PER_PAGE) break;
      if (this.#keep(thread, url)) added += 1;
    }
    thread.fromPage.set(pageKey, added);
    this.#trim();
  }

  has(threadId: string, key: string) {
    return this.#threads.get(threadId)?.keys.has(key) ?? false;
  }
}

/** The person's own words: a user message they wrote here, not one another agent sent this thread. */
const personWrote = (payload: Record<string, unknown>) => payload.role === "user" && payload.createdBy === "user" && payload.senderThreadId === undefined;

const parse = (json: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/**
 * Whether the person wrote the URL with this key in one of the thread's messages. Reads only the user rows whose
 * JSON contains its host.
 */
export const personWroteInThread = Effect.fn("web.provenance.personWroteInThread")(function* (threadId: string, key: string) {
  const sql = yield* SqlClient.SqlClient;
  const messages = yield* sql<{ payload_json: string }>`SELECT payload_json FROM orchestration_v2_projection_messages
    WHERE thread_id = ${threadId} AND role = 'user' AND instr(lower(payload_json), ${keyHost(key)}) > 0`;
  return messages.some((row) => {
    const payload = parse(row.payload_json);
    return personWrote(payload) && typeof payload.text === "string" && urlKeysIn(payload.text).has(key);
  });
});
