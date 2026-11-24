// chat.search: find the chat where something happened, even when that chat was mostly about something else.
//
// Every message, answer, plan, question, subagent summary, tool call and title is a passage of its own (long
// messages in paragraph-sized pieces) in an FTS5 table, so one paragraph about Stripe in a long chat about
// settings ranks as that paragraph, not as a rounding error of the chat. The index follows the session journal
// by rowid (crash-safe, no double entries) and rebuilds itself from the journal when its version changes.
//
// It holds the journal as a replay shows it now: every value the scrubber hides is hidden before a passage is cut
// from its event, and a value saved as a secret after its chat was indexed has that chat read again. A search
// matches words, prefixes, typos and meaning, so a passage holding a piece of a value would confirm a guess at it
// however masked the snippet.
//
// A query is matched two ways. By words: the concepts of the question (query.ts) weighed by how rare each is,
// so a passage must hold the rare ones ("stripe") to count. By meaning: an on-device embedding of each passage
// (Embedder.ts), so "how do we bill users" finds the Stripe checkout. The two scores fuse per passage, and a
// chat ranks by its best place, with a little for its second and third: the place it happened, not how often.
import type { ChatSearchPassage, ChatSearchResult, Scrubber, SessionEvent, Workspace } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";

import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import { SessionStore, upgradeStoredEvent, type WorkspaceRecord } from "../session-protocol/store.ts";
import { Embedder } from "./Embedder.ts";
import { passagesOf, titlePassage, type Passage, type PassageKind } from "./passages.ts";
import { anyFts, correction, editDistance, groupFts, parseQuery, type Group } from "./query.ts";

export class ChatSearch extends Context.Service<
  ChatSearch,
  {
    readonly search: (query: string, limit?: number) => Effect.Effect<ChatSearchResult>;
    /** Indexes the journal past the watermark, one batch; how many journal rows it read. */
    readonly indexBatch: Effect.Effect<number>;
    /** Every chat's title as a passage, where it changed. */
    readonly syncTitles: Effect.Effect<void>;
    /** Gives one batch of passages their vectors; how many. 0 without a loaded embedder. */
    readonly embedBatch: Effect.Effect<number, Error>;
    /** Brings every title in, then follows the journal and the embedding backlog. Never returns. */
    readonly run: Effect.Effect<void>;
  }
>()("caveman/search/ChatSearch") {}

/** Bump to rebuild every index from the journal (a change to passages.ts or the tables). */
const VERSION = "2";

/** unicode61 folds case and accents and splits snake_case and paths. */
const WORDS = "unicode61 remove_diacritics 2";

const SCHEMA = [
  // One row per passage. The FTS5 row of the same id holds its text; `vector` its embedding (int8, unit length).
  `CREATE TABLE IF NOT EXISTS caveman_sp_search_rows (
     id INTEGER PRIMARY KEY,
     session_id TEXT NOT NULL,
     key TEXT NOT NULL,
     cursor INTEGER NOT NULL,
     item TEXT NOT NULL,
     kind TEXT NOT NULL,
     at TEXT NOT NULL,
     embed INTEGER NOT NULL,
     vector BLOB,
     UNIQUE (session_id, key))`,
  // The embedding backlog, newest first.
  `CREATE INDEX IF NOT EXISTS caveman_sp_search_rows_unread ON caveman_sp_search_rows (id) WHERE embed = 1 AND vector IS NULL`,
  // Porter stemming ("billing" finds "billed").
  `CREATE VIRTUAL TABLE IF NOT EXISTS caveman_sp_search USING fts5(text, aux, tokenize = 'porter ${WORDS}')`,
  // The index's own terms (stems), for typo correction, and where each was found.
  `CREATE VIRTUAL TABLE IF NOT EXISTS caveman_sp_search_terms USING fts5vocab(caveman_sp_search, 'row')`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS caveman_sp_search_places USING fts5vocab(caveman_sp_search, 'instance')`,
  // One passage at a time, its words unstemmed: the word a stem stands for, read where it was found.
  `CREATE VIRTUAL TABLE IF NOT EXISTS temp.caveman_sp_search_spelling USING fts5(text, tokenize = '${WORDS}')`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS temp.caveman_sp_search_spelled USING fts5vocab(temp, caveman_sp_search_spelling, 'instance')`,
];
const DROP = ["DROP TABLE IF EXISTS caveman_sp_search_places", "DROP TABLE IF EXISTS caveman_sp_search_terms", "DROP TABLE IF EXISTS caveman_sp_search", "DROP TABLE IF EXISTS caveman_sp_search_rows"];

/** Journal events that add, replace or remove passages; the rest (deltas, usage, context) are skipped unread. */
const INDEXED: ReadonlyArray<SessionEvent["type"]> = ["message.done", "tool.started", "diff.changed", "plan.updated", "ask.user", "subagent.started", "subagent.done", "grill.finished", "session.restored"];
const BATCH = 500;
const EMBED_BATCH = 16;
/** How long the index and the embedding backlog sleep with nothing new, in case a wake was missed. */
const QUIET_LOOK = "1 minute";

/** Candidates by words, before coverage decides. */
const CANDIDATES = 400;
/**
 * A passage must hold at least this share of the query's weight (by rarity) to count as found by words: of two
 * concepts the rarer alone passes and the commoner alone does not; of three, one alone does not.
 */
const MIN_COVERAGE = 0.4;
/**
 * Matches by meaning are judged against the query's own spread, not a fixed cosine: bge-small puts every
 * passage between about 0.4 and 0.75, and where a query's crowd sits moves with the query. A passage counts
 * when it stands this far above the query's 90th percentile (on real chats: "kubernetes helm chart" with no
 * such chat tops out near 0.07 above it; "which browser automation did we pick" near 0.09).
 */
const MEANING_MARGIN = 0.075;
/** A match this far under the best one is noise next to it. */
const MEANING_WINDOW = 0.06;
/** The margin that counts as a perfect match by meaning. */
const MEANING_SPAN = 0.15;
/** Vectors sampled for the percentile: plenty for its estimate, cheap at any index size. */
const MEANING_SAMPLE = 4_000;

/** Where a passage was said matters a little: the person's own words, a title (titles go stale), answers, then work. */
const KIND_WEIGHT: Record<PassageKind, number> = { title: 1.1, user: 1.15, assistant: 1, agent: 0.95, plan: 0.95, ask: 0.95, tool: 0.85, files: 0.85 };

/** Places a stem was found that are read for the word it stands for: its common spellings, cheaply. */
const SPELLINGS = 8;

const SNIPPET_TOKENS = 28;
const SNIPPET_CHARS = 240;

const quantize = (v: Float32Array) => Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * 127))));
const blob = (v: Int8Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
const unblob = (b: Uint8Array) => new Int8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

/** BM25's idf: a concept in every passage weighs about nothing, one in a handful decides. */
const idf = (df: number, total: number) => Math.log(1 + (total - df + 0.5) / (df + 0.5));

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

/**
 * `text` scrubbed whole, and where a position of `text` lands in the result: one inside a stored value lands at
 * the start (`toward` -1) or the end (+1) of what replaced it.
 */
function scrubbedWhole(text: string, scrub: (text: string) => string): { readonly text: string; readonly at: (position: number, toward: -1 | 1) => number } {
  const clean = scrub(text);
  if (clean === text) return { text, at: (position) => position };
  // The scrubber says where a value is only by scrubbing: cut outside every value, the two halves scrub to the
  // whole's result; cut through one, neither half holds it whole.
  const cuts = new Map<number, number | undefined>();
  const cut = (position: number) => {
    if (!cuts.has(position)) {
      const head = scrub(text.slice(0, position));
      cuts.set(position, head + scrub(text.slice(position)) === clean ? head.length : undefined);
    }
    return cuts.get(position);
  };
  return {
    text: clean,
    at: (position, toward) => {
      let p = position;
      while (p > 0 && p < text.length && cut(p) === undefined) p += toward;
      return p <= 0 ? 0 : p >= text.length ? clean.length : cut(p)!;
    },
  };
}

/**
 * What a result quotes of a passage: FTS5's snippet of it (\u0001/\u0002 around each match, no ellipses) or, with
 * none, its start, as text and ranges. Both are cut from the passage scrubbed whole: scrubbed after the cut, a
 * marker or the window's edge inside a stored value leaves no piece holding all of it for the scrubber to find.
 */
export function marked(passage: string, snippet: string | undefined, scrub: (text: string) => string): { text: string; marks: Array<{ start: number; end: number }> } {
  const whole = scrubbedWhole(passage, scrub);
  // The index holds a value as its mask, which FTS5 reads as words: a window or a match is never cut inside one either.
  const masks = [...whole.text.matchAll(/\[secret:[^\]]*\]/g)].map((m) => [m.index, m.index + m[0].length] as const);
  const wholeAt = (position: number, toward: -1 | 1) => {
    const p = whole.at(position, toward);
    const mask = masks.find(([s, e]) => s < p && p < e);
    return mask === undefined ? p : mask[toward < 0 ? 0 : 1];
  };
  const parts = snippet?.split(/[\u0001\u0002]/) ?? [];
  const window = parts.join("");
  // FTS5 copies its window from the passage as it is; not there, the passage changed under the search.
  const from = snippet === undefined ? -1 : passage.indexOf(window);
  if (from < 0) return { text: clip(whole.text, SNIPPET_CHARS), marks: [] };
  const start = wholeAt(from, -1);
  const end = wholeAt(from + window.length, 1);
  const lead = start > 0 ? "…" : "";
  const marks: Array<{ start: number; end: number }> = [];
  let at = from;
  for (const [i, part] of parts.entries()) {
    // Odd parts sat between the markers.
    if (i % 2 === 1 && part) {
      const mark = { start: wholeAt(at, -1) - start + lead.length, end: wholeAt(at + part.length, 1) - start + lead.length };
      const last = marks.at(-1);
      // Matches inside one value are one mark, on what replaced it.
      if (last !== undefined && mark.start < last.end) last.end = Math.max(last.end, mark.end);
      else marks.push(mark);
    }
    at += part.length;
  }
  return { text: `${lead}${whole.text.slice(start, end)}${end < whole.text.length ? "…" : ""}`, marks };
}

export const make = Effect.gen(function* () {
  const store = yield* SessionStore;
  const sql = store.sql;
  const secrets = yield* ProjectSecrets;
  const embedder = yield* Embedder;

  const version = yield* store.kvGet("search.version");
  if (version !== VERSION) {
    for (const statement of DROP) yield* sql.unsafe(statement).pipe(Effect.orDie);
    yield* store.kvSet("search.rowid", "0");
  }
  for (const statement of SCHEMA) yield* sql.unsafe(statement).pipe(Effect.orDie);
  if (version !== VERSION) yield* store.kvSet("search.version", VERSION);
  // Vectors of another model (or none) compare with nothing: the backlog embeds them again.
  if (embedder !== undefined && (yield* store.kvGet("search.model")) !== embedder.model) {
    yield* sql`UPDATE caveman_sp_search_rows SET vector = NULL WHERE vector IS NOT NULL`.pipe(Effect.orDie);
    yield* store.kvSet("search.model", embedder.model);
  }

  /** Every vector, by passage id, loaded on the first search by meaning and kept current after. */
  let vectors: Map<number, Int8Array> | undefined;
  /** Caught up with the journal once since start (an upgrade rebuilds from it): until then results may miss chats. */
  let caughtUp = false;
  let loadFailed = false;
  /** The scrubber every passage was read under; none yet since start, so the first read checks the whole journal. */
  let readUnder: Scrubber | undefined;
  /** One writer of passages at a time, and no search while the index is read again under a new scrubber. */
  const lane = yield* Semaphore.make(1);

  const sessions = new Map<string, { readonly forked: number } | null>();
  /** A session's fork point: the turns a fork copied from its source are found in the source, not twice. */
  const sessionInfo = (sessionId: string) =>
    Effect.gen(function* () {
      if (sessions.has(sessionId)) return sessions.get(sessionId)!;
      const record = yield* store.getBySession(sessionId);
      const info = record === undefined ? null : { forked: record.session.forked_from?.cursor ?? 0 };
      if (info !== null) sessions.set(sessionId, info);
      return info;
    });

  const remove = (ids: ReadonlyArray<number>) =>
    Effect.gen(function* () {
      for (const id of ids) {
        yield* sql`DELETE FROM caveman_sp_search WHERE rowid = ${id}`;
        yield* sql`DELETE FROM caveman_sp_search_rows WHERE id = ${id}`;
        vectors?.delete(id);
      }
    });

  const insert = (sessionId: string, cursor: number, at: string, p: Passage) =>
    Effect.gen(function* () {
      const [row] = yield* sql<{ id: number }>`INSERT INTO caveman_sp_search_rows (session_id, key, cursor, item, kind, at, embed)
        VALUES (${sessionId}, ${p.key}, ${cursor}, ${p.item}, ${p.kind}, ${at}, ${p.embed ? 1 : 0}) RETURNING id`;
      yield* sql`INSERT INTO caveman_sp_search (rowid, text, aux) VALUES (${row!.id}, ${p.text}, ${p.aux})`;
    });

  /** Inside a transaction: each passage replaces the session's passage of the same key. */
  const write = (sessionId: string, cursor: number, at: string, passages: ReadonlyArray<Passage>) =>
    Effect.gen(function* () {
      for (const p of passages) {
        const old = yield* sql<{ id: number }>`SELECT id FROM caveman_sp_search_rows WHERE session_id = ${sessionId} AND key = ${p.key}`;
        yield* remove(old.map((r) => r.id));
        if (p.text) yield* insert(sessionId, cursor, at, p);
      }
    });

  /**
   * A journal row as a replay shows it now. Scrubbed before passagesOf: markdown read as plain text (`a__b … __init__`
   * loses both `__`) or a cut between words of a passphrase leaves a value the scrubber no longer recognises.
   */
  const readEvent = (json: string, scrubber: Scrubber) => {
    const event = upgradeStoredEvent(JSON.parse(json) as SessionEvent);
    return scrubber.mayChangeJson?.(json) === false ? event : scrubber.scrubDeep(event);
  };

  /** The chats whose journal, through `mark`, holds a value `scrubber` hides. */
  const holding = (scrubber: Scrubber, mark: number) =>
    Effect.gen(function* () {
      const mayChange = scrubber.mayChangeJson ?? (() => true);
      const found = new Set<string>();
      for (let after = 0; after < mark; ) {
        const rows = yield* sql<{ rowid: number; session_id: string; event: string | null }>`
          SELECT rowid, session_id, CASE WHEN type IN ${sql.in(INDEXED)} THEN event END AS event
          FROM caveman_sp_events WHERE rowid > ${after} AND rowid <= ${mark} ORDER BY rowid LIMIT ${BATCH}`;
        if (rows.length === 0) break;
        for (const row of rows) if (row.event !== null && !found.has(row.session_id) && mayChange(row.event)) found.add(row.session_id);
        after = rows.at(-1)!.rowid;
      }
      return found;
    });

  /**
   * Inside a transaction: a chat's passages read again from its journal (through `mark`) under `scrubber`, as
   * indexBatch leaves them: each replaces its key's, a restore drops what came after its point. A passage that reads
   * as it did stays, vector and all; the rest are written again and embedded again.
   */
  const reread = (sessionId: string, scrubber: Scrubber, mark: number) =>
    Effect.gen(function* () {
      const info = yield* sessionInfo(sessionId);
      if (info === null) return;
      const events = yield* sql<{ cursor: number; event: string }>`SELECT cursor, event FROM caveman_sp_events
        WHERE session_id = ${sessionId} AND type IN ${sql.in(INDEXED)} AND cursor > ${info.forked} AND rowid <= ${mark} ORDER BY rowid`;
      const now = new Map<string, { readonly cursor: number; readonly at: string; readonly passage: Passage }>();
      for (const row of events) {
        const event = readEvent(row.event, scrubber);
        if (event.type === "session.restored") {
          for (const [key, p] of now) if (p.cursor > event.payload.at && p.cursor < row.cursor) now.delete(key);
          continue;
        }
        for (const passage of passagesOf(event)) {
          if (passage.text) now.set(passage.key, { cursor: row.cursor, at: event.at, passage });
          else now.delete(passage.key);
        }
      }
      const stored = yield* sql<{ id: number; key: string; cursor: number; item: string; kind: string; at: string; embed: number; text: string; aux: string }>`
        SELECT r.id, r.key, r.cursor, r.item, r.kind, r.at, r.embed, f.text, f.aux FROM caveman_sp_search_rows r JOIN caveman_sp_search f ON f.rowid = r.id
        WHERE r.session_id = ${sessionId} AND r.key != 'title'`;
      const same = (row: (typeof stored)[number], p: { readonly cursor: number; readonly at: string; readonly passage: Passage } | undefined) =>
        p !== undefined &&
        row.cursor === p.cursor &&
        row.at === p.at &&
        row.item === p.passage.item &&
        row.kind === p.passage.kind &&
        row.embed === (p.passage.embed ? 1 : 0) &&
        row.text === p.passage.text &&
        row.aux === p.passage.aux;
      const kept = new Set(stored.filter((row) => same(row, now.get(row.key))).map((row) => row.key));
      yield* remove(stored.filter((row) => !kept.has(row.key)).map((row) => row.id));
      for (const [key, { cursor, at, passage }] of now) if (!kept.has(key)) yield* insert(sessionId, cursor, at, passage);
    });

  const titleUnder = (scrubber: Scrubber, workspace: Workspace) =>
    Effect.gen(function* () {
      const passage = titlePassage(scrubber.scrub(workspace.title));
      const [row] = yield* sql<{ text: string }>`SELECT f.text FROM caveman_sp_search_rows r JOIN caveman_sp_search f ON f.rowid = r.id
        WHERE r.session_id = ${workspace.session_id} AND r.key = 'title'`;
      if ((row?.text ?? "") === passage.text) return;
      yield* sql.withTransaction(write(workspace.session_id, 0, workspace.created_at, [passage]));
    });

  /**
   * Inside the lane: the scrubber the index is read under, the current one. A new one (a value saved as a secret, a
   * token joining the egress scrub, the first since start) first has every chat holding a value it hides read again.
   */
  const current = Effect.gen(function* () {
    const scrubber = yield* secrets.scrubber;
    if (scrubber === readUnder) return scrubber;
    const mark = Number((yield* store.kvGet("search.rowid")) ?? "0");
    for (const sessionId of yield* holding(scrubber, mark)) yield* sql.withTransaction(reread(sessionId, scrubber, mark));
    for (const record of yield* store.listWorkspaces()) yield* titleUnder(scrubber, record.workspace);
    readUnder = scrubber;
    return scrubber;
  });

  const indexBatch = Effect.gen(function* () {
    const scrubber = yield* current;
    const mark = Number((yield* store.kvGet("search.rowid")) ?? "0");
    const rows = yield* sql<{ rowid: number; session_id: string; cursor: number; event: string | null }>`
      SELECT rowid, session_id, cursor, CASE WHEN type IN ${sql.in(INDEXED)} THEN event END AS event
      FROM caveman_sp_events WHERE rowid > ${mark} ORDER BY rowid LIMIT ${BATCH}`;
    if (rows.length === 0) return 0;
    const work: Array<{ readonly sessionId: string; readonly cursor: number; readonly event: SessionEvent }> = [];
    for (const row of rows) {
      if (row.event === null) continue;
      const info = yield* sessionInfo(row.session_id);
      if (info === null || row.cursor <= info.forked) continue;
      work.push({ sessionId: row.session_id, cursor: row.cursor, event: readEvent(row.event, scrubber) });
    }
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const { sessionId, cursor, event } of work) {
          if (event.type === "session.restored") {
            // The transcript went back to `at`: what came after lives on in the branch, not here.
            const gone = yield* sql<{ id: number }>`SELECT id FROM caveman_sp_search_rows
              WHERE session_id = ${sessionId} AND cursor > ${event.payload.at} AND cursor < ${cursor} AND key != 'title'`;
            yield* remove(gone.map((r) => r.id));
          } else yield* write(sessionId, cursor, event.at, passagesOf(event));
        }
        yield* store.kvSet("search.rowid", String(rows.at(-1)!.rowid));
      }),
    );
    return rows.length;
  }).pipe(lane.withPermits(1), Effect.orDie);

  const syncTitle = (workspace: Workspace) =>
    lane.withPermits(1)(Effect.flatMap(current, (scrubber) => titleUnder(scrubber, workspace))).pipe(Effect.orDie);

  const syncTitles = Effect.gen(function* () {
    for (const record of yield* store.listWorkspaces()) yield* syncTitle(record.workspace);
  });

  const embedBatch = Effect.gen(function* () {
    if (embedder === undefined || !embedder.ready()) return 0;
    const rows = yield* sql<{ id: number; text: string }>`SELECT r.id, f.text FROM caveman_sp_search_rows r JOIN caveman_sp_search f ON f.rowid = r.id
      WHERE r.embed = 1 AND r.vector IS NULL ORDER BY r.id DESC LIMIT ${EMBED_BATCH}`.pipe(Effect.orDie);
    if (rows.length === 0) return 0;
    const embedded = yield* embedder.embed(
      rows.map((r) => r.text),
      "passage",
    );
    const quantized = embedded.map(quantize);
    yield* sql.withTransaction(
      Effect.forEach(
        rows,
        (row, i) =>
          sql<{ id: number }>`UPDATE caveman_sp_search_rows SET vector = ${blob(quantized[i]!)} WHERE id = ${row.id} RETURNING id`.pipe(
            // A passage replaced while it was being embedded keeps no vector, here or in memory.
            Effect.tap((updated) => Effect.sync(() => updated.length > 0 && vectors?.set(row.id, quantized[i]!))),
          ),
        { discard: true },
      ),
    ).pipe(Effect.orDie);
    return rows.length;
  });

  const loadVectors = Effect.gen(function* () {
    if (vectors !== undefined) return vectors;
    const rows = yield* sql<{ id: number; vector: Uint8Array }>`SELECT id, vector FROM caveman_sp_search_rows WHERE vector IS NOT NULL`.pipe(Effect.orDie);
    return (vectors = new Map(rows.map((r) => [r.id, unblob(r.vector)])));
  });

  const count = (rows: ReadonlyArray<{ readonly n: number }>) => rows[0]?.n ?? 0;
  /** How many passages an FTS5 expression matches. */
  const matching = (expression: string) => sql<{ n: number }>`SELECT count(*) AS n FROM caveman_sp_search WHERE caveman_sp_search MATCH ${expression}`.pipe(Effect.map(count));

  /** Passages by words: id -> 0..1, the share of the query's weight it holds (squared) and its bm25 against the best. */
  const byWords = (groups: ReadonlyArray<Group>) =>
    Effect.gen(function* () {
      const found = new Map<number, number>();
      if (groups.length === 0) return found;
      const candidates = yield* sql<{ id: number; rank: number }>`SELECT rowid AS id, bm25(caveman_sp_search, 1.0, 0.35) AS rank
        FROM caveman_sp_search WHERE caveman_sp_search MATCH ${anyFts(groups)} ORDER BY rank LIMIT ${CANDIDATES}`;
      if (candidates.length === 0) return found;
      const total = count(yield* sql<{ n: number }>`SELECT count(*) AS n FROM caveman_sp_search_rows`);
      const ids = candidates.map((c) => c.id);
      const weights: number[] = [];
      const held = new Map<number, number>();
      for (const group of groups) {
        const df = yield* matching(groupFts(group));
        // A word no chat uses tells no chat from another ("functionality" in a question): it weighs nothing.
        const weight = df === 0 ? 0 : idf(df, total);
        weights.push(weight);
        const matched = groups.length === 1 ? ids.map((id) => ({ id })) : yield* sql<{ id: number }>`SELECT rowid AS id FROM caveman_sp_search WHERE caveman_sp_search MATCH ${groupFts(group)} AND rowid IN ${sql.in(ids)}`;
        for (const { id } of matched) held.set(id, (held.get(id) ?? 0) + weight);
      }
      // Mostly words no chat uses ("banana bread recipe"): the question is about something no chat covered, and
      // whatever its one common word matched would be noise.
      if (weights.filter((w) => w === 0).length * 2 > groups.length) return new Map<number, number>();
      const sum = weights.reduce((a, b) => a + b, 0) || 1;
      const best = Math.min(...candidates.map((c) => c.rank));
      for (const c of candidates) {
        const coverage = (held.get(c.id) ?? 0) / sum;
        if (coverage < MIN_COVERAGE) continue;
        found.set(c.id, coverage * coverage * (best < 0 ? 0.6 + 0.4 * (c.rank / best) : 1));
      }
      return found;
    });

  /**
   * The word the chats wrote whose stem is `term`, of those read where the index found it the one nearest `typed`
   * ("databse" -> "database"; "deplyo" -> "deployment", not "deployments"). Searched as it is, a stem is stemmed again
   * ("databas" -> "databa") and finds nothing.
   */
  const spelled = (term: string, typed: string) =>
    Effect.gen(function* () {
      const places = yield* sql<{ doc: number; col: string; offset: number }>`SELECT doc, col, offset FROM caveman_sp_search_places WHERE term = ${term} LIMIT ${SPELLINGS}`;
      let best: { readonly word: string; readonly distance: number } | undefined;
      for (const place of places) {
        const [row] = yield* sql<{ text: string; aux: string }>`SELECT text, aux FROM caveman_sp_search WHERE rowid = ${place.doc}`;
        if (row === undefined) continue;
        const word = yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO temp.caveman_sp_search_spelling (rowid, text) VALUES (1, ${place.col === "aux" ? row.aux : row.text})`;
            const [spelling] = yield* sql<{ term: string }>`SELECT term FROM temp.caveman_sp_search_spelled WHERE offset = ${place.offset}`;
            yield* sql`DELETE FROM temp.caveman_sp_search_spelling`;
            return spelling?.term;
          }),
        );
        if (word === undefined) continue;
        const distance = editDistance(typed, word, typed.length + word.length);
        if (best === undefined || distance < best.distance) best = { word, distance };
      }
      return best?.word;
    });

  /** A word the index has never seen, corrected to the nearest one it has ("stirpe" -> "stripe"). */
  const corrected = (groups: ReadonlyArray<Group>) =>
    Effect.gen(function* () {
      let changed = false;
      const out: Group[] = [];
      for (const group of groups) {
        // One word (still being typed or not): a prefix that matches nothing is a typo too ("stirpe").
        const only = group.alternatives.length === 1 && group.alternatives[0]!.words.length === 1 ? group.alternatives[0]!.words[0]! : undefined;
        if (only === undefined || /\d/.test(only) || embedder?.isWord(only) === true) {
          out.push(group);
          continue;
        }
        if ((yield* matching(groupFts(group))) > 0) {
          out.push(group);
          continue;
        }
        const first = only[0]!;
        const next = String.fromCodePoint(first.codePointAt(0)! + 1);
        const terms = yield* sql<{ term: string; doc: number }>`SELECT term, doc FROM caveman_sp_search_terms WHERE term >= ${first} AND term < ${next}`;
        const fix = correction(only, terms);
        const word = fix === undefined ? undefined : yield* spelled(fix, only);
        if (word === undefined) out.push(group);
        else {
          changed = true;
          out.push({ label: word, alternatives: [{ words: [word], prefix: false }] });
        }
      }
      return { groups: out, changed };
    });

  /** Passages by meaning: id -> 0..1 from the cosine, those within the window of the best and above the floor. */
  const byMeaning = (query: string) =>
    Effect.gen(function* () {
      const found = new Map<number, number>();
      if (embedder === undefined || !embedder.ready() || query.length < 3) return found;
      const [needle] = yield* embedder.embed([query], "query");
      if (needle === undefined) return found;
      const all = yield* loadVectors;
      const ids: number[] = [];
      const cosines: number[] = [];
      for (const [id, v] of all) {
        let dot = 0;
        for (let d = 0; d < v.length; d++) dot += needle[d]! * v[d]!;
        ids.push(id);
        cosines.push(dot / 127);
      }
      // Too few passages to know what stands out from the crowd.
      if (cosines.length < 20) return found;
      const step = Math.max(1, Math.floor(cosines.length / MEANING_SAMPLE));
      const sample = cosines.filter((_, i) => i % step === 0).sort((a, b) => a - b);
      const p90 = sample[Math.floor(sample.length * 0.9)]!;
      const top = Math.max(...cosines);
      if (top - p90 < MEANING_MARGIN) return found;
      const floor = Math.max(p90 + MEANING_MARGIN, top - MEANING_WINDOW);
      const scored = ids.map((id, i) => [id, cosines[i]!] as const).filter(([, c]) => c >= floor).sort((a, b) => b[1] - a[1]).slice(0, 200);
      for (const [id, cosine] of scored) found.set(id, Math.min(1, (cosine - p90) / MEANING_SPAN) * 0.9);
      return found;
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("chat search: no match by meaning", { cause }).pipe(Effect.as(new Map<number, number>()))));

  const meaningState = Effect.gen(function* () {
    if (embedder === undefined || (loadFailed && !embedder.ready())) return "unavailable" as const;
    if (!embedder.ready()) return "preparing" as const;
    const unread = count(yield* sql<{ n: number }>`SELECT count(*) AS n FROM caveman_sp_search_rows WHERE embed = 1 AND vector IS NULL`.pipe(Effect.orDie));
    return unread > 0 ? ("preparing" as const) : ("ready" as const);
  });

  const search = (query: string, limit = 20) =>
    Effect.gen(function* () {
      const text = query.slice(0, 500).trim();
      const meaning = yield* meaningState;
      if (!text) return { chats: [], indexing: !caughtUp, meaning };
      // A value saved as a secret a moment ago is out of every passage before anything is matched.
      yield* lane.withPermits(1)(current);
      const parsed = yield* corrected(parseQuery(query.slice(0, 500)));
      const words = yield* byWords(parsed.groups);
      const meant = yield* byMeaning(text);
      const ids = [...new Set([...words.keys(), ...meant.keys()])];
      if (ids.length === 0) return { chats: [], indexing: !caughtUp, meaning, ...(parsed.changed ? { corrected: parsed.groups.map((g) => g.label).join(" ") } : {}) };

      const rows = yield* sql<{ id: number; session_id: string; cursor: number; item: string; kind: PassageKind; at: string }>`
        SELECT id, session_id, cursor, item, kind, at FROM caveman_sp_search_rows WHERE id IN ${sql.in(ids)}`;
      const texts = new Map((yield* sql<{ id: number; text: string }>`SELECT rowid AS id, text FROM caveman_sp_search WHERE rowid IN ${sql.in(ids)}`).map((r) => [r.id, r.text]));
      const bySession = new Map<string, WorkspaceRecord>((yield* store.listWorkspaces()).map((r) => [r.session.id, r]));
      const now = Date.now();
      const chats = new Map<string, { record: WorkspaceRecord; passages: Array<{ id: number; score: number; row: (typeof rows)[number]; by: ChatSearchPassage["by"] }> }>();
      for (const row of rows) {
        const record = bySession.get(row.session_id);
        if (record === undefined) continue;
        const w = words.get(row.id) ?? 0;
        const m = meant.get(row.id) ?? 0;
        // Both ways at once is the strongest sign; either alone still counts in full.
        const score = (Math.max(w, m) + 0.25 * Math.min(w, m)) * KIND_WEIGHT[row.kind];
        const by = w > 0 && m > 0 ? "both" : w > 0 ? "words" : "meaning";
        const chat = chats.get(record.workspace.id) ?? { record, passages: [] };
        chat.passages.push({ id: row.id, score, row, by });
        chats.set(record.workspace.id, chat);
      }
      const ranked = [...chats.values()]
        .map((chat) => {
          chat.passages.sort((a, b) => b.score - a.score);
          // The same words twice in one chat (a subagent's title repeated, a message quoted back) count and show once.
          const seen = new Set<string>();
          chat.passages = chat.passages.filter((p) => !seen.has(texts.get(p.id) ?? "") && (seen.add(texts.get(p.id) ?? ""), true));
          const [p1, p2, p3] = chat.passages.map((p) => p.score);
          const ageDays = Math.max(0, now - Date.parse(chat.record.workspace.updated_at)) / 86_400_000;
          // The place it happened decides; a second and third place add a little; recent and live chats a little more.
          const score = ((p1 ?? 0) + 0.15 * (p2 ?? 0) + 0.05 * (p3 ?? 0)) * (1 + 0.15 * 0.5 ** (ageDays / 30)) * (chat.record.workspace.status === "archived" ? 0.85 : 1);
          return { ...chat, score };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, Math.min(limit, 50)));

      // Snippets for the passages shown: the words' matches marked, else the passage's start.
      const shown = ranked.flatMap((chat) => chat.passages.slice(0, 3));
      const lexical = shown.filter((p) => p.by !== "meaning").map((p) => p.id);
      const snippets = new Map<number, string>();
      if (lexical.length > 0 && parsed.groups.length > 0) {
        for (const r of yield* sql<{ id: number; snippet: string }>`SELECT rowid AS id, snippet(caveman_sp_search, 0, char(1), char(2), '', ${SNIPPET_TOKENS}) AS snippet
          FROM caveman_sp_search WHERE caveman_sp_search MATCH ${anyFts(parsed.groups)} AND rowid IN ${sql.in(lexical)}`) {
          snippets.set(r.id, r.snippet);
        }
      }
      // A value saved as a secret while this search ran: scrubbed again on the way out, as replays are.
      const scrubber = yield* secrets.scrubber;
      return {
        chats: ranked.map((chat) => ({
          workspace: chat.record.workspace,
          passages: chat.passages.slice(0, 3).map(({ id, row, by }): ChatSearchPassage => {
            const { text, marks } = marked(texts.get(id) ?? "", snippets.get(id), scrubber.scrub);
            return { kind: row.kind, ...(row.item ? { item_id: row.item } : {}), cursor: row.cursor, at: row.at, text, marks, by };
          }),
          more: Math.max(0, chat.passages.length - 3),
        })),
        indexing: !caughtUp,
        meaning,
        ...(parsed.changed ? { corrected: parsed.groups.map((g) => g.label).join(" ") } : {}),
      };
    }).pipe(Effect.orDie);

  /** The journal may hold new passages; and passages may wait for vectors. Each holds one wake at most. */
  const journalGrew = yield* Queue.sliding<void>(1);
  const passagesAdded = yield* Queue.sliding<void>(1);
  const asleepUntil = (wake: Queue.Queue<void>) => Effect.raceFirst(Queue.take(wake), Effect.sleep(QUIET_LOOK));

  const embedLoop = Effect.gen(function* () {
    if (embedder === undefined) return;
    while (true) {
      const loaded = yield* embedder.load.pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("chat search: the on-device model is not available; search is by words until it is", { cause }).pipe(
            Effect.andThen(Effect.sync(() => (loadFailed = true))),
            Effect.as(false),
          ),
        ),
      );
      if (!loaded) {
        yield* Effect.sleep("15 minutes");
        continue;
      }
      loadFailed = false;
      const n = yield* embedBatch.pipe(
        Effect.catchCause((cause) => Effect.logWarning("chat search: could not embed passages", { cause }).pipe(Effect.andThen(Effect.sleep("30 seconds")), Effect.as(0))),
      );
      yield* (n === 0 ? asleepUntil(passagesAdded) : Effect.yieldNow);
    }
  });

  // Asleep while nothing changes: an event search indexes wakes the index, and a changed chat too (a fork or a move
  // writes its copy of a journal in one go, published as the chat's change); new passages wake the embedding backlog.
  const run = Effect.gen(function* () {
    const events = yield* PubSub.subscribe(store.events);
    const changes = yield* PubSub.subscribe(store.workspaceChanges);
    yield* syncTitles;
    yield* Effect.forkScoped(
      Effect.forever(PubSub.take(events).pipe(Effect.flatMap((event) => (INDEXED.includes(event.type) ? Queue.offer(journalGrew, undefined) : Effect.void)))),
    );
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          yield* syncTitle(yield* PubSub.take(changes));
          yield* Queue.offer(journalGrew, undefined);
          yield* Queue.offer(passagesAdded, undefined);
        }
      }),
    );
    yield* Effect.forkScoped(embedLoop);
    while (true) {
      const read = yield* indexBatch.pipe(Effect.catchCause((cause) => Effect.logWarning("chat search: could not index", { cause }).pipe(Effect.as(0))));
      if (read > 0) yield* Queue.offer(passagesAdded, undefined);
      if (read < BATCH) {
        caughtUp = true;
        yield* asleepUntil(journalGrew);
      } else yield* Effect.yieldNow;
    }
  }).pipe(Effect.scoped);

  return ChatSearch.of({ search, indexBatch, syncTitles, embedBatch, run });
});

export const layer = Layer.effect(ChatSearch, make);
