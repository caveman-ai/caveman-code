/**
 * MemoryStore: one SQLite file per account and its single writer, the commit
 * path (docs/memory.md "The store", "The commit path"). Its fixtures run in
 * MemoryStore.test.ts.
 *
 * Every version and purge carries an HMAC with the account's memory key.
 * Rows that fail it are quarantined: never rendered. `memory_head` is only a
 * cache, rebuilt from valid rows whenever another connection (a process
 * editing the file) has written.
 *
 * Synchronous on purpose: node:sqlite's DatabaseSync, one connection, every
 * write in one IMMEDIATE transaction. Agents never reach this file; they get
 * copies (MemoryCopy.ts, MemorySandbox.ts).
 *
 * @module memory/MemoryStore
 */
import { createHmac, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { MEMORY_SCHEMA, RUNTIME_SCHEMA } from "./schema.ts";

export type Authority = "told" | "team" | "learned" | "draft";
/** chief: the Chief's remember, the person's words relayed with their exact quote (chief/tools.ts). */
export type WriterKind = "live" | "user" | "mirror" | "import" | "chief";

/** One version of a note, as stored. */
export interface NoteRow {
  readonly vid: string;
  readonly store: string;
  readonly id: string;
  readonly path: string;
  readonly text: string;
  readonly added: string;
  readonly until: string | null;
  readonly source: string;
  readonly meta: string;
  readonly authority: Authority;
  readonly tainted: number;
  readonly by: string;
  readonly at: string;
  readonly mac?: string | null;
}

/** A row as readers see it: a row failing its MAC is tainted and quarantined. */
export interface VisibleRow extends NoteRow {
  readonly quarantined: boolean;
}

/** Who is writing, and what the runtime knows about them. */
export interface WriterContext {
  readonly kind: WriterKind;
  session: string;
  /** This session's repository (live writes stay inside it). */
  readonly repoId?: string;
  /** Repositories this account has opened: every writer but a live session may write any of them. */
  readonly knownRepos: ReadonlyArray<string>;
  readonly teamStores: ReadonlyArray<string>;
  /** What the user typed in this session, verbatim (never tool results). */
  readonly userMessages: ReadonlyArray<string>;
  /**
   * Exact values to redact besides the scrubber's, when at least 16 characters. The runtime passes none: `scrubber`
   * holds every value the broker does, plugin credentials included.
   */
  readonly brokerSecrets: ReadonlyArray<string>;
  /**
   * The egress scrub's scrubber (ProjectSecrets as EgressScrub provides it): every repository's secrets, the
   * credentials granted to plugins and the runtime's own tokens, masked as `[secret:NAME]`.
   */
  readonly scrubber?: { readonly scrub: (text: string) => string } | undefined;
  tainted?: boolean;
  readonly quarantine?: boolean;
  /** Settings' explicit Keep: the only thing that clears taint. */
  readonly keep?: boolean;
  readonly subagent?: boolean;
  readonly agent_id?: string;
  readonly automation?: boolean;
  readonly codeMode?: boolean;
}

/** One requested change. `baseVid` is the head the writer read (null for a new note). */
export interface Operation {
  readonly type?: "put" | "forget" | "proposal";
  readonly id?: string | undefined;
  readonly store?: string;
  readonly baseVid?: string | null | undefined;
  readonly path?: string;
  readonly text?: string;
  readonly meta?: Record<string, unknown>;
  readonly added?: string;
  readonly until?: string | null;
  readonly source?: string;
  readonly authority?: string | null;
  readonly target?: string | null;
  readonly why?: string;
  /** The person's undo: the earlier version of this note it puts back, with that version's authority and taint. */
  readonly restore?: string;
}

export interface ProposalRow {
  readonly pid: string;
  readonly store: string;
  readonly target: string | null;
  readonly path: string;
  readonly text: string;
  readonly why: string;
  readonly by: string;
  readonly at: string;
  readonly status: string;
}

/** The brief a session froze at its start (docs/memory.md "The brief"). */
export interface SessionBrief {
  readonly text: string;
  /** Its MEMORY.md: the lines name notes only by the copy path render gave each, and notes can share a store path. */
  readonly index: string;
  /** The notes the index lists, as `store:id`; absent for a brief an older runtime froze. */
  readonly notes?: ReadonlyArray<string>;
}

export interface CommitResult {
  saved: Array<NoteRow & { readonly pid?: undefined }>;
  proposals: ProposalRow[];
  rejected: Array<{ readonly reason: string }>;
  conflicts: Array<{ readonly id: string | undefined; readonly current: NoteRow | null }>;
  similar: VisibleRow[];
}

export const COLUMNS = ["vid", "store", "id", "path", "text", "added", "until", "source", "meta", "authority", "tainted", "by", "at"] as const;
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const ID = /^[0-9a-hjkmnp-tv-z]{10}$/;
const nowIso = () => new Date().toISOString();
export const today = () => nowIso().slice(0, 10);
const fail = (reason: string): never => {
  throw new Error(reason);
};
const encode = (n: bigint, size: number) => {
  let s = "";
  do {
    s = ALPHABET[Number(n & 31n)] + s;
    n >>= 5n;
  } while (n);
  return s.padStart(size, "0");
};
const decode = (s: string) => [...s].reduce((n, c) => n * 32n + BigInt(ALPHABET.indexOf(c)), 0n);
const random = (bytes: number) => BigInt(`0x${randomBytes(bytes).toString("hex")}`);
/** A note id: 10 lowercase Crockford base32 characters (50 bits, no `_` or `%`). */
export const newId = () => encode(random(7) & ((1n << 50n) - 1n), 10);
export const pick = <T extends object, K extends string>(row: T, keys: ReadonlyArray<K>) =>
  Object.fromEntries(keys.map((k) => [k, (row as Record<string, unknown>)[k]])) as Record<K, unknown>;
/** JSON with sorted object keys: what MACs and comparisons are computed over. */
export const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, v) =>
    v && !Array.isArray(v) && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v,
  );
export const metaOf = (row: Pick<NoteRow, "meta">): Record<string, unknown> => JSON.parse(row.meta) as Record<string, unknown>;
export const alive = (row: Pick<NoteRow, "text" | "until"> | null | undefined) => !!row?.text && (!row.until || row.until >= today());

const STRIP = /[\u0000-\u001f\u007f-\u009f­؜᠎​-‏‪-‮⁠-⁯﻿]/g;
const strip = (s: string) => s.replace(STRIP, "");

/** Clean every string in `value`: control and bidi characters, exact broker secrets, key shapes, our markup. Best-effort. */
export function clean<T>(ctx: Pick<WriterContext, "brokerSecrets" | "scrubber">, value: T): T {
  if (Array.isArray(value)) return value.map((v) => clean(ctx, v)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [clean(ctx, k), clean(ctx, v)])) as T;
  if (typeof value !== "string") return value;
  let s = strip(value);
  if (ctx.scrubber) s = ctx.scrubber.scrub(s);
  for (const secret of ctx.brokerSecrets.map(strip).filter((x) => x.length >= 16).sort((a, b) => b.length - a.length))
    s = s.split(secret).join("redacted");
  return s
    .replace(/<private>[\s\S]*?<\/private>/gi, "redacted")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "redacted")
    .replace(/\b(?:sk-[a-z0-9_-]{8,}|sk_live_[a-z0-9_-]+|AKIA[A-Z0-9]{16}|gh[a-z]*_[a-z0-9_]+|github_pat_[a-z0-9_]+|xox[baprs]-[a-z0-9-]+)\b/gi, "redacted")
    .replace(/\bBearer\s+[^\s,;]+/gi, "redacted")
    // The project scrubber's mask, `[secret:NAME]`, reads as an assignment; it is what a redaction leaves, so it stays whole.
    .replace(/(?!(?<=\[)secret:\w+(?:,\w+)*\])["']?[\w-]*(?:key|token|secret|passw(?:or)?d|pwd)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, "redacted")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/gi, "redacted-")
    .replace(/<\/?(?:memory|system-reminder|system|assistant|developer)\b[^>]*>/gi, (tag) => tag.replaceAll("<", "‹").replaceAll(">", "›")) as T;
}

/**
 * The writer with what the person typed cleaned as the store keeps a quote (prepare cleans meta), so a quote is
 * checked against their words in the form it is saved in: a value a secret holds is masked on both sides. Line by
 * line, since cleaning drops line breaks and statedQuote splits sentences on them.
 */
const typedAsKept = (ctx: WriterContext): WriterContext =>
  ctx.userMessages.length === 0 ? ctx : { ...ctx, userMessages: ctx.userMessages.map((message) => message.split("\n").map((line) => clean(ctx, line)).join("\n")) };

/** A copy path or store path, lowercased, mapped to the store path the writer may write. */
export function scope(ctx: WriterContext, input: string, store = "me"): string {
  // Redact before validating syntax, keeping the extension even for an open PEM.
  // Claude names note files feedback_testing.md; store paths take hyphens, and a secret's mask by its names alone.
  let p = (/\.md$/i.test(input) ? `${clean(ctx, input.slice(0, -3))}.md` : clean(ctx, input))
    .toLowerCase()
    .replaceAll("_", "-")
    .replace(/\[secret:([^\]]+)\]/g, (_mask, names: string) => `secret-${names.replaceAll(",", "-")}`);
  if (p.includes("..") || !/^[a-z0-9._/-]+\.md$/.test(p) || p.split("/").some((part) => !part || part === ".") || p.length > 200) fail("invalid path");
  if (store.startsWith("team:")) {
    if (!ctx.teamStores.includes(store)) fail("unknown team store");
    const prefix = `team/${store.slice(5)}/`;
    if (p.startsWith(prefix)) p = p.slice(prefix.length);
  } else {
    if (store !== "me") fail("store must be me");
    if (p.startsWith("repo/")) {
      if (!ctx.repoId) fail("no repository for repo/");
      p = `repos/${ctx.repoId!.toLowerCase()}/${p.slice(5)}`;
    }
    const repos = ctx.kind === "live" ? (ctx.repoId ? [ctx.repoId] : []) : ctx.knownRepos;
    if (!p.startsWith("user/") && !repos.some((repo) => p.startsWith(`repos/${repo.toLowerCase()}/`))) fail("repo outside write scope");
  }
  if (p.length > 200) fail("path too long");
  return p;
}

const STOP_WORDS = new Set(
  "a an the and or but to of in on at for with from by is are be was were it this that these those i me my we our you your please use do not".split(" "),
);
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
export const contentWords = (s: string) => new Set(words(s).filter((w) => w.length > 1 && !STOP_WORDS.has(w)));
/** A note can't flip the user's meaning: "do not run X" never makes "run X" told. Typed contractions too ("shouldnt"). */
const negated = (s: string) => /\b(?:not|no|never|don'?t|doesn'?t|won'?t|can'?t|cannot|shouldn'?t|wouldn'?t|couldn'?t|isn'?t|aren'?t|without|avoid|stop)\b/i.test(s);

/** Long enough to stand for the user's words: at least 20 characters and 4 words. */
export const quotable = (quote: unknown): quote is string => typeof quote === "string" && quote.length >= 20 && words(quote).length >= 4;

/** What a polarity refusal says: the Chief's remember matches it to keep the person's own words instead. */
export const POLARITY_CLASH = "says no, never or don't and the";

/**
 * Why a quote does not stand for the user's words behind a note, or undefined when it does: long enough, typed in
 * this session, on topic, same polarity. Each reason says what to change, so the Chief's retry can be the right one.
 */
export function quoteProblem(ctx: Pick<WriterContext, "userMessages">, quote: unknown, text: string): string | undefined {
  if (!quotable(quote)) return "quote what they typed, at least 20 characters and 4 words";
  if (!ctx.userMessages.some((message) => message.includes(quote))) return "the quote is not verbatim in anything they typed to you";
  if ([...contentWords(quote)].filter((w) => contentWords(text).has(w)).length < 2) return "the quote is not on the note's topic (they share fewer than two words)";
  if (negated(quote) !== negated(text)) {
    return negated(text)
      ? `the note ${POLARITY_CLASH} quote does not: quote the words that say so, or write the note the way they said it`
      : `the quote ${POLARITY_CLASH} note does not: keep what they ruled out in the note`;
  }
  return undefined;
}

/** The user's words behind a note: long enough, typed in this session, on topic, same polarity (quoteProblem). */
export function verifiedQuote(ctx: Pick<WriterContext, "userMessages">, quote: unknown, text: string): boolean {
  return quoteProblem(ctx, quote, text) === undefined;
}

/** A sentence that says what to keep: the person's own memory statement. */
const STATEMENT = /\b(?:remember|from now on|going forward|in future|always|never|i prefer|i'd prefer|i'd rather|i want you to)\b/i;

/**
 * The person's words behind a live note, when it carries no quote: the newest
 * sentence they typed this session that says what to keep ("remember…", "from
 * now on…", "always…", "never…") and that the note restates: verifiedQuote,
 * and at least half the sentence's content words, so a note that only shares
 * a term with it stays the agent's. How "remember X" in a chat becomes a told
 * note without a dream.
 */
export function statedQuote(ctx: Pick<WriterContext, "userMessages">, text: string): string | undefined {
  const noteWords = contentWords(text);
  const sentences = ctx.userMessages.flatMap((message) => message.split(/(?<=[.!?])\s+|\n+/)).map((s) => s.trim());
  return sentences.reverse().find((s) => {
    const words = contentWords(s);
    return STATEMENT.test(s) && verifiedQuote(ctx, s, text) && [...words].filter((w) => noteWords.has(w)).length * 2 >= words.size;
  });
}

/** told and team notes are the user's: only the user changes them. A live session can still fix a gotcha it just proved wrong. */
export const protectedNote = (row: NoteRow | null | undefined): row is NoteRow => !!row && ["told", "team"].includes(row.authority);

export function protectedChange(old: NoteRow | null | undefined, next: NoteRow): boolean {
  if (!protectedNote(old)) return false;
  // Version bookkeeping necessarily changes. Every note field is compared.
  const fields = ["store", "id", "path", "text", "added", "until", "source", "authority", "tainted"] as const;
  if (fields.some((k) => old[k] !== next[k])) return true;
  const before = metaOf(old);
  const after = metaOf(next);
  if ("suspect" in before && canonical(before.suspect) !== canonical(after.suspect)) return true;
  if ("suspect" in after && (typeof after.suspect !== "string" || !after.suspect)) return true;
  delete before.suspect;
  delete after.suspect;
  return canonical(before) !== canonical(after);
}

export class MemoryStore {
  readonly db: DatabaseSync;
  /** Rows that failed their MAC: a runtime diagnostic, never rendered or counted as evidence. */
  readonly quarantine: Array<{ readonly table: string; readonly row: unknown }> = [];
  readonly file: string;
  private readonly key: Uint8Array;
  private clock = 0n;
  private dataVersion = -1;

  constructor(file: string, key: Uint8Array) {
    this.file = file;
    this.key = key;
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    if (file !== ":memory:") fs.chmodSync(file, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
    const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_version'").get();
    if (!exists) this.db.exec(MEMORY_SCHEMA);
    this.db.exec(RUNTIME_SCHEMA);
    // Briefs an older runtime froze keep no notes: pushes tell theirs by the index's paths.
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('session_brief') WHERE name='notes'").get()) this.db.exec("ALTER TABLE session_brief ADD COLUMN notes TEXT");
  }

  close() {
    this.db.close();
  }

  // ------------------------------------------------------------ primitives

  /** A version id strictly greater than `head` and every id this process made (ponytail: protects against a fast clock elsewhere). */
  vid(head = "") {
    const time = (BigInt(Date.now()) << 80n) | random(10);
    this.clock = [time, this.clock + 1n, head ? decode(head) + 1n : 0n].reduce((a, b) => (a > b ? a : b));
    if (this.clock >= 1n << 128n) fail("ULID exhausted");
    return encode(this.clock, 26);
  }

  /** Account key, not a machine key. Table names domain-separate the MACs. */
  mac(table: string, row: object) {
    return createHmac("sha256", this.key)
      .update(`${table}:${canonical(Object.fromEntries(Object.entries(row).filter(([k]) => k !== "mac")))}`)
      .digest("hex");
  }
  sealed<T extends object>(table: string, row: T): T & { mac: string } {
    return { ...row, mac: this.mac(table, row) };
  }
  valid(table: string, row: { readonly mac?: string | null } | null | undefined) {
    return !!row && row.mac === this.mac(table, row);
  }

  insert(table: string, row: object) {
    const keys = Object.keys(row);
    return this.db
      .prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
      .run(...(Object.values(row) as Array<string | number | null>));
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private all<T>(sql: string, ...params: Array<string | number | null>): T[] {
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }
  private get<T>(sql: string, ...params: Array<string | number | null>): T | undefined {
    return this.db.prepare(sql).get(...params) as unknown as T | undefined;
  }

  // ---------------------------------------------------------------- reads

  /** Heads from valid rows only; valid purges erase what they name, forged purges are quarantined. */
  rebuildHeads() {
    for (const row of this.all<{ store: string; id: string; at: string; mac: string | null }>("SELECT * FROM purged")) {
      if (!this.valid("purged", row)) {
        this.quarantine.push({ table: "purged", row });
        this.db.prepare("DELETE FROM purged WHERE store=? AND id=?").run(row.store, row.id);
      } else {
        this.db.prepare("DELETE FROM memory_version WHERE store=? AND id=?").run(row.store, row.id);
        // A purge arriving from another computer erases the same retained rows as a local erase.
        this.db.prepare("DELETE FROM dream_version WHERE store=? AND id=?").run(row.store, row.id);
        this.db.prepare("DELETE FROM memory_sighting WHERE store=? AND id=?").run(row.store, row.id);
      }
    }
    this.db.exec("DELETE FROM memory_head");
    const heads = new Map<string, NoteRow>();
    for (const row of this.all<NoteRow>("SELECT * FROM memory_version ORDER BY vid"))
      if (this.valid("memory_version", row)) heads.set(`${row.store}:${row.id}`, row);
    for (const row of heads.values()) this.insert("memory_head", pick(row, ["store", "id", "vid"]));
    this.dataVersion = this.currentDataVersion();
  }

  private currentDataVersion() {
    return (this.db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
  }

  /** Heads are a cache: rebuilt when another connection wrote the file (or on demand after tampering in tests). */
  private ensureHeads(force = false) {
    if (force || this.dataVersion !== this.currentDataVersion()) this.rebuildHeads();
  }

  /** Forget the cached heads: the next read rebuilds them from valid rows. */
  invalidate() {
    this.dataVersion = -1;
  }

  head(store: string, id: string): NoteRow | undefined {
    this.ensureHeads();
    return this.get<NoteRow>("SELECT v.* FROM memory_head h JOIN memory_version v ON v.vid=h.vid WHERE h.store=? AND h.id=?", store, id);
  }

  purged(store: string, id: string) {
    return !!this.get("SELECT 1 FROM purged WHERE store=? AND id=?", store, id);
  }

  version(vid: string) {
    return this.get<NoteRow>("SELECT * FROM memory_version WHERE vid=?", vid);
  }

  /** Every head (or every version, with `history`) in this account's stores; rows failing their MAC are tainted and quarantined. */
  visible(ctx: Pick<WriterContext, "teamStores">, history = false): VisibleRow[] {
    this.ensureHeads();
    const all = this.all<NoteRow>("SELECT * FROM memory_version");
    const heads = new Set(this.all<{ vid: string }>("SELECT vid FROM memory_head").map((r) => r.vid));
    const purged = new Set(this.all<{ store: string; id: string }>("SELECT store, id FROM purged").map((r) => `${r.store}:${r.id}`));
    return all
      .filter((r) => (r.store === "me" || ctx.teamStores.includes(r.store)) && !purged.has(`${r.store}:${r.id}`))
      .map((r) => ({ row: r, ok: this.valid("memory_version", r) }))
      .filter(({ row, ok }) => history || heads.has(row.vid) || !ok)
      .map(({ row, ok }) => ({ ...row, tainted: Number(!!row.tainted || !ok), quarantined: !ok }));
  }

  current(ctx: Pick<WriterContext, "teamStores">) {
    return this.visible(ctx).filter(alive);
  }

  // ----------------------------------------------------------- the commit path

  /** One operation validated into a sealed row (or a proposal, or a conflict). Throws the reason it is refused. */
  prepare(
    ctx: WriterContext,
    op: Operation,
  ): (NoteRow & { mac: string }) | ProposalRow | { readonly conflict: { readonly id: string | undefined; readonly current: NoteRow | null } } {
    if (ctx.subagent || ctx.agent_id || ctx.automation) fail("context cannot write");
    if (!["live", "user", "mirror", "import", "chief"].includes(ctx.kind)) fail("invalid writer");
    const proposal = op.type === "proposal";
    // The Chief adds the person's notes; it never edits, forgets or proposes.
    if (ctx.kind === "chief" && (proposal || op.type === "forget" || op.id !== undefined)) fail("the Chief only adds notes");
    const store = op.store ?? "me";
    const old = op.id ? this.head(store, op.id) : undefined;
    const p = scope(ctx, op.path ?? old?.path ?? "repo/notes.md", store);
    const rawText = op.type === "forget" ? "" : (op.text ?? old?.text ?? "");
    if (typeof rawText !== "string" || /[\r\n]/.test(rawText) || /[\r\n]/.test(op.why ?? "")) fail("newline in text or why");
    const text = clean(ctx, rawText).replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, "");
    const meta = clean(ctx, op.meta ?? (old ? metaOf(old) : {})) as Record<string, unknown>;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) fail("meta must be an object");
    if (text.length > 500 || JSON.stringify(meta).length > 2000) fail("note too long");
    // Never a draft from the Chief: the person's exact words as its quote, or nothing.
    if (ctx.kind === "chief") {
      const problem = quoteProblem(ctx, meta.quote, text);
      if (problem !== undefined) fail(`not the person's words: ${problem}`);
    }
    // Only the person restores, only an earlier version of the same note, and only its own words. The version comes
    // back as it was: an agent's draft stays a draft (an undo is not an edit) and a note kept from outside is
    // quarantined again.
    const earlier = op.restore !== undefined && ctx.kind === "user" ? this.version(op.restore) : undefined;
    const restored = earlier && earlier.store === store && earlier.id === op.id && this.valid("memory_version", earlier) ? earlier : undefined;
    if (op.restore !== undefined && (!restored || restored.text === "" || restored.text !== text)) fail("invalid restore");
    const tainted = restored ? restored.tainted : Number(ctx.kind === "user" && ctx.keep ? false : !!(ctx.tainted || ctx.quarantine || old?.tainted));
    if (proposal) {
      if (!store.startsWith("team:") || !ctx.teamStores.includes(store)) fail("proposal needs a known team");
      if (tainted) fail("tainted sessions cannot propose");
      if ((this.get<{ n: number }>("SELECT count(*) n FROM proposal WHERE by=?", ctx.session)?.n ?? 0) >= 10) fail("proposal limit");
      const target = op.target ?? op.id ?? null;
      if (target !== null && !ID.test(target)) fail("invalid proposal target");
      const why = clean(ctx, op.why ?? "Suggested from this session");
      if (why.length > 300) fail("why too long");
      return { pid: newId(), store, target, path: p, text, why, by: clean(ctx, ctx.session), at: nowIso(), status: "open" };
    }
    if (op.id && !ID.test(op.id)) fail("invalid id");
    if (op.id && this.purged(store, op.id)) fail("purged id");
    if ((old?.vid ?? null) !== (op.baseVid ?? null)) return { conflict: { id: op.id, current: old ?? null } };
    // Only the person pins: a pinned note loads in every brief, so no writer but the user changes it.
    if (ctx.kind !== "user") {
      if (old && metaOf(old).pinned === true) meta.pinned = true;
      else delete meta.pinned;
    }
    // Unchanged text keeps authority. Nothing writes `learned` any more: an agent's own note stays a draft,
    // unless it restates what the person said to keep, in their words.
    const keep = !!old && text === old.text;
    if (ctx.kind === "live" && !keep && !ctx.quarantine && meta.quote === undefined) {
      const stated = statedQuote(ctx, text);
      if (stated !== undefined) meta.quote = stated;
    }
    const authority: Authority = restored
      ? restored.authority
      : keep
        ? old!.authority
        : ctx.quarantine
          ? "draft"
          : ctx.kind === "mirror"
            ? "team"
            : ctx.kind === "user" || verifiedQuote(ctx, meta.quote, text)
              ? "told"
              : "draft";
    const row: NoteRow = {
      vid: this.vid(old?.vid),
      store,
      id: op.id ?? newId(),
      path: p,
      text,
      added: op.added ?? old?.added ?? today(),
      until: Object.hasOwn(op, "until") ? (op.until ?? null) : (old?.until ?? null),
      source: clean(ctx, op.source ?? old?.source ?? ctx.session),
      meta: JSON.stringify(meta),
      authority,
      tainted,
      by: clean(ctx, ctx.session),
      at: nowIso(),
    };
    if (
      row.source.length > 300 ||
      [row.added, row.until].some((d) => d !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d))
    )
      fail("invalid source or date");
    const attemptedAuthorityChange = !!old && op.authority != null && op.authority !== old.authority;
    if (ctx.kind !== "user" && protectedNote(old) && (protectedChange(old, row) || attemptedAuthorityChange)) fail("protected note; ask the user");
    if (store !== "me" && !old && ctx.kind !== "mirror") fail("team notes are read-only; propose instead");
    return this.sealed("memory_version", row);
  }

  /** Validate and write `ops` in one transaction. */
  commit(ctx: WriterContext, ops: ReadonlyArray<Operation>): CommitResult {
    const result: CommitResult = { saved: [], proposals: [], rejected: [], conflicts: [], similar: [] };
    const writer = typedAsKept(ctx);
    this.transaction(() => {
      for (const op of ops) {
        try {
          const row = this.prepare(writer, op);
          if ("conflict" in row) result.conflicts.push(row.conflict);
          else if ("pid" in row) {
            this.insert("proposal", row);
            result.proposals.push(row);
          } else {
            this.insert("memory_version", row);
            result.saved.push(row);
          }
        } catch (error) {
          result.rejected.push({ reason: (error as Error).message });
        }
      }
    });
    // Notes in the same path that share words: "search before you insert" without asking.
    result.similar = this.current(ctx)
      .filter(
        (r) =>
          !r.tainted &&
          result.saved.some((s) => s.id !== r.id && s.store === r.store && s.path === r.path && [...contentWords(s.text)].some((w) => contentWords(r.text).has(w))),
      )
      .slice(0, 3);
    return result;
  }

  /** Erase: every version of the note goes, and a sealed purge keeps it gone across sync. User only. */
  erase(ctx: WriterContext, row: Pick<NoteRow, "store" | "id">) {
    if (ctx.kind !== "user") fail("only the user can erase");
    this.transaction(() => {
      this.db.prepare("DELETE FROM memory_version WHERE store=? AND id=?").run(row.store, row.id);
      // Rows the retired dreams left in older files (docs/memory.md "The store") carry the note's text too.
      this.db.prepare("DELETE FROM dream_version WHERE store=? AND id=?").run(row.store, row.id);
      this.db.prepare("DELETE FROM memory_sighting WHERE store=? AND id=?").run(row.store, row.id);
      this.db.prepare("DELETE FROM memory_head WHERE store=? AND id=?").run(row.store, row.id);
      this.insert("purged", this.sealed("purged", { store: row.store, id: row.id, at: nowIso() }));
    });
  }

  // ------------------------------------------------------- frozen session briefs

  sessionBrief(session: string): SessionBrief | undefined {
    const row = this.get<{ text: string; idx: string; notes: string | null }>("SELECT text, idx, notes FROM session_brief WHERE session=?", session);
    return row && { text: row.text, index: row.idx, ...(row.notes === null ? {} : { notes: JSON.parse(row.notes) as string[] }) };
  }

  saveSessionBrief(session: string, brief: SessionBrief) {
    this.db
      .prepare("INSERT OR IGNORE INTO session_brief (session, text, idx, notes, at) VALUES (?,?,?,?,?)")
      .run(session, brief.text, brief.index, brief.notes === undefined ? null : JSON.stringify(brief.notes), nowIso());
    return this.sessionBrief(session)!;
  }

  // ------------------------------------------------------- tainted sessions

  sessionTainted(session: string): boolean {
    return this.get("SELECT 1 FROM session_taint WHERE session=?", session) !== undefined;
  }

  taintSession(session: string) {
    this.db.prepare("INSERT OR IGNORE INTO session_taint (session, at) VALUES (?,?)").run(session, nowIso());
  }

  /** A store revision: moves on every write here or in another connection (the SQL copies rebuild when it does). */
  /** Notes that reached a session, and how (memory_use): what the benchmark and disuse read. */
  use(rows: ReadonlyArray<Pick<NoteRow, "store" | "id">>, session: string, how: "push" | "recall" | "query" | "acted") {
    const at = nowIso();
    const insert = this.db.prepare("INSERT INTO memory_use (store, id, session, at, how) VALUES (?, ?, ?, ?, ?)");
    this.transaction(() => {
      for (const row of rows) insert.run(row.store, row.id, session, at, how);
    });
  }

  /** How often each note reached a session and when last (memory_use), for the notes named; absent when never. */
  uses(ids: ReadonlyArray<string>): Map<string, { readonly count: number; readonly last_at: string }> {
    const out = new Map<string, { count: number; last_at: string }>();
    if (ids.length === 0) return out;
    const rows = this.db
      .prepare(`SELECT id, count(*) n, max(at) last FROM memory_use WHERE id IN (${ids.map(() => "?").join(",")}) GROUP BY id`)
      .all(...ids) as Array<{ id: string; n: number; last: string }>;
    for (const row of rows) out.set(row.id, { count: row.n, last_at: row.last });
    return out;
  }

  revision() {
    return `${this.currentDataVersion()}:${(this.db.prepare("SELECT total_changes() n").get() as { n: number }).n}`;
  }
}
