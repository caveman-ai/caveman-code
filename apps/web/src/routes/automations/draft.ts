// The automation file as the Settings form reads and writes it. The file stays the truth: every edit parses the text,
// changes one node and prints it again (the yaml Document API), so comments, key order and every key the form does not
// show come through untouched. Plain functions over text, so the form is tested without a runtime (draft.test.ts).
import { Document, isMap, isNode, isScalar, isSeq, parseDocument, Scalar, type YAMLMap } from "yaml";
import { clockWord, dateWord, everyWord, LOCAL_ZONE, monthDaysWord, onceWord, SCHEMA_LINE } from "./model.ts";

export { everyWord } from "./model.ts";

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const COMPUTERS = ["readonly", "full", "none"] as const;
export type Computer = (typeof COMPUTERS)[number];
/** Every GitHub event a file may name; This Mac polls the first seven, Cloud hears the rest. */
export const GITHUB_EVENTS = [
  "issues.opened",
  "issues.labeled",
  "pull_request.opened",
  "pull_request.synchronize",
  "issue_comment.created",
  "push",
  "workflow_run.completed",
  "pull_request.labeled",
  "pull_request.closed",
  "check_suite.completed",
] as const;
export const CLOUD_ONLY_EVENTS: ReadonlyArray<string> = ["pull_request.labeled", "pull_request.closed", "check_suite.completed"];
export const EVENT_WORD: Record<string, string> = {
  "issues.opened": "An issue is opened",
  "issues.labeled": "An issue is labelled",
  "pull_request.opened": "A pull request is opened",
  "pull_request.synchronize": "A pull request is updated",
  "issue_comment.created": "Someone comments",
  push: "Someone pushes to the default branch",
  "workflow_run.completed": "A CI run finishes",
  "pull_request.labeled": "A pull request is labelled",
  "pull_request.closed": "A pull request is closed",
  "check_suite.completed": "A check suite finishes",
};

export interface Schedule {
  readonly at?: string;
  /** Alone, an interval (6h). With at, every Nth day (3d) or, with weekdays, week (2w). */
  readonly every?: string;
  readonly timezone?: string;
  /** Absent: every day. */
  readonly weekdays?: ReadonlyArray<Weekday>;
  /** With at, instead of weekdays: days of the month, `last` its last day. */
  readonly monthdays?: ReadonlyArray<number | "last">;
  /** One date and time, "2026-11-09 09:00", in timezone. */
  readonly once?: string;
  readonly cron?: string;
  /** A repeat's first and last day ("2026-11-09"), and how many scheduled runs it makes. */
  readonly start?: string;
  readonly until?: string;
  readonly count?: number;
}

/** What shape a schedule has, as the form's first chip says it. */
export type ScheduleKind = "days" | "interval" | "monthly" | "once" | "cron";
export const scheduleKindOf = (s: Schedule): ScheduleKind =>
  s.once !== undefined ? "once" : s.cron !== undefined ? "cron" : s.at !== undefined && s.monthdays !== undefined ? "monthly" : s.at !== undefined ? "days" : "interval";

/** `every` with at: every Nth day or week; undefined for an interval or none. */
export function stepOf(s: Schedule): { readonly n: number; readonly unit: "d" | "w" } | undefined {
  const m = s.at === undefined || s.every === undefined ? null : /^([1-9][0-9]*)(d|w)$/.exec(s.every);
  return m === null ? undefined : { n: Number(m[1]), unit: m[2] as "d" | "w" };
}

/** A date in this computer's calendar, "YYYY-MM-DD", `days` from `now`. */
export function localDay(now: Date, days = 0): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The schedule each kind starts as when the form switches to it, keeping the time and zone it had: once tomorrow,
 * monthly on the 1st, a cron of weekday mornings.
 */
export function scheduleAs(kind: ScheduleKind, s: Schedule, now = new Date()): Schedule {
  const at = s.at ?? s.once?.slice(11) ?? "09:00";
  const timezone = s.timezone ?? LOCAL_ZONE;
  const ends = { ...(s.start ? { start: s.start } : {}), ...(s.until ? { until: s.until } : {}), ...(s.count !== undefined ? { count: s.count } : {}) };
  switch (kind) {
    case "days":
      return { at, timezone, weekdays: ["mon", "tue", "wed", "thu", "fri"], ...ends };
    case "interval":
      return { every: "1h", ...ends, ...(s.start || s.until ? { timezone } : {}) };
    case "monthly":
      return { at, timezone, monthdays: [1], ...ends };
    case "once":
      return { once: `${localDay(now, 1)} ${at}`, timezone };
    case "cron":
      return { cron: `${Number(at.slice(3, 5))} ${Number(at.slice(0, 2))} * * 1-5`, timezone, ...ends };
  }
}
export interface GitHub {
  readonly events: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<string>;
  readonly mention: boolean;
}
/** What starts a run. Slack, Linear and Jira only say what they are here; their file holds the rest. */
export type Trigger =
  | { readonly kind: "schedule"; readonly schedule: Schedule }
  | { readonly kind: "github"; readonly github: GitHub }
  | { readonly kind: "webhook" }
  | { readonly kind: "slack" | "linear" | "jira" };

export interface Step {
  readonly name: string;
  /** prompt: its own instructions; agent: an agent file does it; run: a command, no model; wait: it only waits. */
  readonly kind: "prompt" | "agent" | "run" | "wait";
  readonly prompt?: string;
  readonly agent?: string;
  readonly run?: string;
  readonly model?: string;
  readonly effort?: string;
  /** As written; absent reads as readonly. */
  readonly computer?: Computer;
  readonly retries?: number;
  readonly timeout?: string;
  readonly checks: ReadonlyArray<string>;
  /** "triage decided implement", from `if:`. */
  readonly when?: string;
  readonly decides?: ReadonlyArray<string>;
}

export interface Form {
  readonly description: string;
  readonly host: "this-mac" | "cloud";
  /** The budget as written ($6, 1.5, or `{ usd: 6 }` read as its dollars); absent: no limit. */
  readonly budget?: string;
  readonly triggers: ReadonlyArray<Trigger>;
  readonly steps: ReadonlyArray<Step>;
  readonly outputs: ReadonlyArray<string>;
  readonly inputs: ReadonlyArray<string>;
}

export type Read = { readonly form: Form } | { readonly error: string };

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined || v === null ? [] : [String(v)]);
const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);

/** The text as the form's fields, or why it can't be read as one (then only the File tab edits it). */
export function readForm(text: string): Read {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return { error: doc.errors[0]!.message.split("\n")[0]! };
  if (!isMap(doc.contents)) return { error: doc.contents === null ? "The file is empty" : "The file's top level isn't a list of keys like steps: and on:" };
  let js: Record<string, unknown>;
  try {
    js = record(doc.toJS());
  } catch (e) {
    // yaml reports no error for an alias with no anchor (an unquoted glob, `paths: *.ts`) or past its alias cap: it throws here.
    return { error: (e instanceof Error ? e.message : String(e)).split("\n")[0]! };
  }
  const on = record(js.on);
  const triggers: Trigger[] = [];
  if ("schedule" in on) {
    const s = record(on.schedule);
    const weekdays = list(s.weekdays).filter((d): d is Weekday => (WEEKDAYS as ReadonlyArray<string>).includes(d));
    const monthdays = (Array.isArray(s.monthdays) ? s.monthdays : []).flatMap((d): Array<number | "last"> => (d === "last" ? ["last"] : typeof d === "number" && Number.isInteger(d) && d >= 1 && d <= 31 ? [d] : []));
    triggers.push({
      kind: "schedule",
      schedule: {
        ...(str(s.at) ? { at: str(s.at)! } : {}),
        ...(str(s.every) ? { every: str(s.every)! } : {}),
        ...(str(s.timezone) ? { timezone: str(s.timezone)! } : {}),
        ...(s.weekdays ? { weekdays } : {}),
        ...(s.monthdays ? { monthdays } : {}),
        ...(str(s.once) ? { once: str(s.once)! } : {}),
        ...(str(s.cron) ? { cron: str(s.cron)! } : {}),
        ...(str(s.start) ? { start: str(s.start)! } : {}),
        ...(str(s.until) ? { until: str(s.until)! } : {}),
        ...(typeof s.count === "number" ? { count: s.count } : {}),
      },
    });
  }
  if ("github" in on) {
    const g = record(on.github);
    triggers.push({ kind: "github", github: { events: list(g.event), labels: list(g.label), mention: g.mention === true } });
  }
  if ("webhook" in on) triggers.push({ kind: "webhook" });
  for (const k of ["slack", "linear", "jira"] as const) if (k in on) triggers.push({ kind: k });

  const steps = Object.entries(record(js.steps)).map(([name, raw]): Step => {
    const s = record(raw);
    const when = Object.entries(record(s.if)).map(([step, value]) => (value === "failed" ? `${step} failed` : `${step} decided ${String(value)}`));
    const computer = str(s.computer);
    return {
      name,
      kind: typeof s.run === "string" ? "run" : typeof s.agent === "string" ? "agent" : s.wait !== undefined && s.prompt === undefined ? "wait" : "prompt",
      ...(str(s.prompt) !== undefined ? { prompt: str(s.prompt)! } : {}),
      ...(str(s.agent) ? { agent: str(s.agent)! } : {}),
      ...(str(s.run) ? { run: str(s.run)! } : {}),
      ...(str(s.model) ? { model: str(s.model)! } : {}),
      ...(str(s.effort) ? { effort: str(s.effort)! } : {}),
      ...(computer && (COMPUTERS as ReadonlyArray<string>).includes(computer) ? { computer: computer as Computer } : {}),
      ...(typeof s.retries === "number" ? { retries: s.retries } : {}),
      ...(str(s.timeout) ? { timeout: str(s.timeout)! } : {}),
      // A command as written; an agent check as its agent's name, marked as the explain rows mark it.
      checks: (Array.isArray(s.checks) ? s.checks : []).map((c) => (typeof c === "string" ? c : `agent:${String(record(c).agent)}`)),
      ...(when.length > 0 ? { when: when.join(" and ") } : {}),
      ...(Array.isArray(s.decides) ? { decides: list(s.decides) } : {}),
    };
  });
  const b = js.budget;
  const budget = typeof b === "number" ? `$${b}` : typeof b === "string" ? (b.startsWith("$") ? b : `$${b}`) : typeof record(b).usd === "number" ? `$${String(record(b).usd)}` : undefined;
  return {
    form: {
      description: str(js.description) ?? "",
      host: js.host === "cloud" ? "cloud" : "this-mac",
      ...(budget ? { budget } : {}),
      triggers,
      steps,
      outputs: Object.keys(record(js.outputs)),
      inputs: Object.keys(record(js.inputs)),
    },
  };
}

// ------------------------------------------------------------ edits

// An edit rewrites only the node it changes: yaml finds the node and its place in the text, and the text around it is
// left byte for byte, so a saved form never reflows a prompt or drops a comment the person wrote. Every edit is read
// back: a value that doesn't land as typed goes in double quotes, and failing that the file stays as it was.

/** A string written in double quotes whatever it holds: a time of day, which YAML 1.1 readers take for a number. */
export class Quoted {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
}
type Value = string | number | boolean | Quoted | ReadonlyArray<Value> | { readonly [k: string]: Value };

const RESERVED = /^(?:true|false|yes|no|on|off|y|n|null|~|[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|0x[\da-f]+|0o[0-7]+|[-+]?\.inf|\.nan)$/i;

/** A scalar as YAML: plain when it reads back as the same string, else double-quoted. `inFlow` also quotes , [ ] { }. */
function scalar(v: string | number | boolean | Quoted, inFlow: boolean): string {
  if (v instanceof Quoted) return JSON.stringify(v.value);
  if (typeof v !== "string") return String(v);
  const plain =
    v !== "" &&
    v === v.trim() &&
    !RESERVED.test(v) &&
    !/^\d{1,2}:\d{2}/.test(v) &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/.test(v) &&
    !/: |:$| #|\n|\t/.test(v) &&
    !(inFlow && /[,[\]{}]/.test(v));
  return plain ? v : JSON.stringify(v);
}

const isObject = (v: Value): v is { readonly [k: string]: Value } => typeof v === "object" && !Array.isArray(v) && !(v instanceof Quoted);

/** A value on one line: a scalar, a flow list `[a, b]`, a flow map `{ a: b }` (the templates' style). */
function inline(v: Value, inFlow = false): string {
  if (Array.isArray(v)) return `[${(v as ReadonlyArray<Value>).map((x) => inline(x, true)).join(", ")}]`;
  if (isObject(v)) {
    const pairs = Object.entries(v).map(([k, x]) => `${k}: ${inline(x, true)}`);
    return pairs.length === 0 ? "{}" : `{ ${pairs.join(", ")} }`;
  }
  return scalar(v as string | number | boolean | Quoted, inFlow);
}

/**
 * A prompt as a block under a key at `indent`, printed by yaml (its chomping, its indentation indicator, its folding)
 * and moved to the key's indent: folded when it was folded and is one paragraph, else literal. Text no block can hold
 * comes back quoted on one line.
 */
function block(value: string, indent: number, folded: boolean): string {
  const node = new Scalar(value);
  node.type = folded ? Scalar.BLOCK_FOLDED : Scalar.BLOCK_LITERAL;
  const printed = new Document({ k: node }).toString({ lineWidth: folded ? 88 : 0 }).slice("k: ".length);
  return printed
    .split("\n")
    .map((l, i) => (i === 0 || l === "" ? l : " ".repeat(indent) + l))
    .join("\n");
}

const lineStart = (text: string, at: number) => text.lastIndexOf("\n", at - 1) + 1;
const lineEnd = (text: string, at: number) => {
  const n = text.indexOf("\n", at);
  return n < 0 ? text.length : n + 1;
};
const splice = (text: string, from: number, to: number, put: string) => text.slice(0, from) + put + text.slice(to);
const isBlockScalar = (n: unknown) => isScalar(n) && (n.type === Scalar.BLOCK_FOLDED || n.type === Scalar.BLOCK_LITERAL);

/** A map's own items as plain values, in their order (what a flow map is rewritten from). */
const plainOf = (node: YAMLMap): Record<string, Value> => node.toJSON() as Record<string, Value>;
const plain = (v: Value): unknown => (v instanceof Quoted ? v.value : Array.isArray(v) ? v.map(plain) : isObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v);

/** The text holds `value` at `path` (or nothing there, for undefined), and still parses. */
function holds(text: string, path: ReadonlyArray<string>, value: Value | undefined): boolean {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return false;
  if (value === undefined) return !doc.hasIn(path);
  const got = doc.getIn(path, true);
  return JSON.stringify(isNode(got) ? got.toJSON() : got) === JSON.stringify(plain(value));
}

/**
 * Sets (or with `undefined` removes) the value at `path`. A new key goes at the end of its map, or before `before`
 * at the top level; a map that isn't there yet is made as a block (`on:` with its trigger under it). A flow map
 * (`{ at: "09:00" }`) is written again whole, keeping its keys' order.
 */
export function setIn(text: string, path: ReadonlyArray<string>, value: Value | undefined, opts: { before?: string; block?: boolean } = {}): string {
  const crlf = text.includes("\r\n");
  const lf = crlf ? text.replace(/\r\n/g, "\n") : text;
  // Already so: the file is left exactly as written.
  if (holds(lf, path, value)) return text;
  let out = place(lf, path, value, opts);
  if (!holds(out, path, value)) out = typeof value === "string" ? place(lf, path, new Quoted(value), opts) : lf;
  if (!holds(out, path, value)) out = lf;
  return crlf ? out.replace(/\n/g, "\r\n") : out;
}

function place(text: string, path: ReadonlyArray<string>, value: Value | undefined, opts: { before?: string; block?: boolean }): string {
  const doc = parseDocument(text);
  if (doc.errors.length > 0 || path.length === 0 || !isMap(doc.contents)) return text;
  const key = path[path.length - 1]!;
  const parentPath = path.slice(0, -1);
  const parent = parentPath.length === 0 ? doc.contents : doc.getIn(parentPath, true);

  if (!isMap(parent)) {
    if (value === undefined) return text;
    // Make the missing map, with this key in it, under its own parent.
    return setIn(text, parentPath, { [key]: value }, { block: true, ...(parentPath.length === 1 ? { before: opts.before ?? "steps" } : {}) });
  }

  if (parent.flow) {
    const obj = { ...plainOf(parent) };
    // Keep a time written in quotes in quotes when the map is written again.
    for (const p of parent.items) if (isScalar(p.key) && isScalar(p.value) && p.value.type === Scalar.QUOTE_DOUBLE && typeof p.value.value === "string") obj[String(p.key.value)] = new Quoted(p.value.value);
    if (value === undefined) delete obj[key];
    else obj[key] = value;
    const [from, to] = parent.range!;
    return splice(text, from, to, inline(obj));
  }

  const pair = parent.items.find((p) => isScalar(p.key) && p.key.value === key);
  const keyNode = pair?.key as Scalar | undefined;
  const indent = keyNode ? keyNode.range![0] - lineStart(text, keyNode.range![0]) : parent.items[0] && isScalar(parent.items[0].key) ? parent.items[0].key.range![0] - lineStart(text, parent.items[0].key.range![0]) : 0;

  if (value === undefined) {
    if (!pair || !keyNode) return text;
    const node = pair.value as Scalar | YAMLMap | null;
    // A value's range ends past its own newline when it is a block; either way its last line goes.
    const end = node?.range ? node.range[1] : keyNode.range![2];
    const from = lineStart(text, keyNode.range![0]);
    let to = lineEnd(text, Math.max(end - 1, keyNode.range![1]));
    // One blank line between sections, not two, once a section between them goes.
    if (text.slice(from - 2, from) === "\n\n" && text[to] === "\n") to += 1;
    return splice(text, from, to, "");
  }

  const isBlockValue = typeof value === "string" && value.includes("\n");
  const nested = opts.block === true && isObject(value);
  const nestedSource = (at: number) =>
    `\n${Object.entries(value as Record<string, Value>)
      .map(([k, v]) => `${" ".repeat(at + 2)}${k}: ${inline(v)}`)
      .join("\n")}`;

  if (pair && keyNode) {
    const node = pair.value as Scalar | YAMLMap | null;
    const blockNode = isBlockScalar(node) || ((isMap(node) || isSeq(node)) && !node.flow);
    const empty = !node || (isScalar(node) && node.value === null && node.range![0] === node.range![1]);
    const asBlock = typeof value === "string" && (isBlockValue || isBlockScalar(node));
    if (!blockNode && !empty && !asBlock && !nested) {
      // A plain or quoted value, or a flow one, is its own range; a comment after it stays.
      const [from, to] = node!.range!;
      return splice(text, from, to, inline(value));
    }
    // Everything after the colon to the end of the value's last line is the value; its newline stays.
    const colon = text.indexOf(":", keyNode.range![1]);
    const last = empty ? colon + 1 : node!.range![1] - (blockNode ? 1 : 0);
    const end = lineEnd(text, Math.max(last, colon + 1));
    const to = text[end - 1] === "\n" ? end - 1 : end;
    const put = nested ? nestedSource(indent) : asBlock ? ` ${block(value as string, indent, isScalar(node) && node.type === Scalar.BLOCK_FOLDED && !isBlockValue)}` : ` ${inline(value)}`;
    return splice(text, colon + 1, to, put.replace(/\n$/, ""));
  }

  // A new key: before `before` at the top level, else after its map's last line.
  const source = nested ? nestedSource(indent) : isBlockValue ? ` ${block(value as string, indent, false)}` : ` ${inline(value)}`;
  const line = `${" ".repeat(indent)}${key}:${source.replace(/\n$/, "")}\n`;
  const before = parentPath.length === 0 && opts.before ? parent.items.find((p) => isScalar(p.key) && p.key.value === opts.before) : undefined;
  if (before && isScalar(before.key)) {
    const at = lineStart(text, before.key.range![0]);
    const gap = text.slice(at - 2, at) === "\n\n" ? "\n" : "";
    return splice(text, at, at, `${line}${gap}`);
  }
  const lastItem = parent.items[parent.items.length - 1];
  const lastEnd = lastItem ? ((lastItem.value as Scalar | null)?.range?.[1] ?? (lastItem.key as Scalar).range![2]) : parent.range![1];
  const at = lastItem ? lineEnd(text, Math.max(lastEnd - 1, 0)) : text.length;
  const lead = at > 0 && text[at - 1] !== "\n" ? "\n" : "";
  return splice(text, at, at, `${lead}${line}`);
}

/** Drops `on:` once its last trigger goes. */
function tidyOn(text: string): string {
  const on = parseDocument(text).get("on", true);
  return on === undefined || (isMap(on) && on.items.length > 0) ? text : setIn(text, ["on"], undefined);
}

/** The one line under the name, as typed (a space at its end stays while the next word comes). */
export const setDescription = (text: string, value: string) => {
  const v = value.replace(/\s*\n\s*/g, " ");
  return setIn(text, ["description"], v.trim() === "" ? undefined : v, { before: "on" });
};

export const setHost = (text: string, host: Form["host"]) => setIn(text, ["host"], host === "cloud" ? "cloud" : undefined, { before: "description" });

/** "$6", "1.50", "" (no limit). A budget written as `{ usd, tokens, turns }` keeps its other limits. */
export function setBudget(text: string, value: string): string {
  const n = value.trim().replace(/^\$/, "");
  if (isMap(parseDocument(text).get("budget", true))) {
    const out = setIn(text, ["budget", "usd"], n === "" ? undefined : Number(n));
    const left = parseDocument(out).get("budget", true);
    return isMap(left) && left.items.length === 0 ? setIn(out, ["budget"], undefined) : out;
  }
  return setIn(text, ["budget"], n === "" ? undefined : `$${n}`, { before: "steps" });
}

/** The schedule trigger, in one line as the templates write it when it is new; key by key when it is there already. */
export function setSchedule(text: string, s: Schedule | null): string {
  if (!s) return tidyOn(setIn(text, ["on", "schedule"], undefined));
  const kind = scheduleKindOf(s);
  const step = stepOf(s);
  const sorted = s.weekdays ? [...new Set(s.weekdays)].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b)) : [];
  // Every day is no weekdays, except every few weeks, which needs its days written out.
  const days = sorted.length > 0 && (sorted.length < 7 || step?.unit === "w") ? sorted : null;
  const repeat = kind !== "once";
  const monthdays = s.monthdays && s.monthdays.length > 0 ? [...new Set(s.monthdays)].sort((a, b) => (a === "last" ? 32 : a) - (b === "last" ? 32 : b)) : [1];
  const keys: Record<string, Value | undefined> = {
    once: kind === "once" ? new Quoted(s.once!) : undefined,
    cron: kind === "cron" ? new Quoted(s.cron!) : undefined,
    at: kind === "days" || kind === "monthly" ? new Quoted(s.at!) : undefined,
    every: kind === "interval" ? (s.every ?? "1h") : kind === "days" && step && !(step.n === 1 && step.unit === "d") ? `${step.n}${step.unit}` : undefined,
    // An interval names a zone only for its start and until days.
    timezone: kind === "interval" && !s.start && !s.until ? undefined : s.timezone,
    weekdays: kind === "days" && step?.unit !== "d" ? (days ?? undefined) : undefined,
    monthdays: kind === "monthly" ? monthdays : undefined,
    start: repeat && s.start ? new Quoted(s.start) : undefined,
    until: repeat && s.until ? new Quoted(s.until) : undefined,
    count: repeat && s.count !== undefined && s.count > 0 ? s.count : undefined,
  };
  if (isMap(parseDocument(text).getIn(["on", "schedule"], true))) {
    return Object.entries(keys).reduce((out, [k, v]) => setIn(out, ["on", "schedule", k], v), text);
  }
  return setIn(text, ["on", "schedule"], Object.fromEntries(Object.entries(keys).filter((e): e is [string, Value] => e[1] !== undefined)));
}

/** The GitHub trigger; null removes it. Its other keys (branches, paths, actors) stay as written. */
export function setGitHub(text: string, g: GitHub | null): string {
  if (!g) return tidyOn(setIn(text, ["on", "github"], undefined));
  if (!isMap(parseDocument(text).getIn(["on", "github"], true))) {
    const value: Record<string, Value> = { event: g.events.length === 1 ? g.events[0]! : [...g.events] };
    if (g.labels.length > 0) value.label = g.labels.length === 1 ? g.labels[0]! : [...g.labels];
    if (g.mention && g.events.includes("issue_comment.created")) value.mention = true;
    return setIn(text, ["on", "github"], value);
  }
  let out = setIn(text, ["on", "github", "event"], g.events.length === 1 ? g.events[0]! : [...g.events]);
  out = setIn(out, ["on", "github", "label"], g.labels.length === 0 ? undefined : g.labels.length === 1 ? g.labels[0]! : [...g.labels]);
  // `mention: false` written out stays; only a mention that is on, or turns off, is written.
  const mention = g.mention && g.events.includes("issue_comment.created");
  return parseDocument(out).getIn(["on", "github", "mention"]) === true || mention ? setIn(out, ["on", "github", "mention"], mention ? true : undefined) : out;
}

export const setWebhook = (text: string, on: boolean) => (on ? setIn(text, ["on", "webhook"], {}) : tidyOn(setIn(text, ["on", "webhook"], undefined)));

/** A step's prompt: a block when it has line breaks (the breaks typed are the ones kept); a folded one stays folded. */
export const setPrompt = (text: string, step: string, value: string) => setIn(text, ["steps", step, "prompt"], value);

/** One of a step's plain keys; undefined (or "") removes it. */
export const setStepKey = (text: string, step: string, key: "model" | "effort" | "computer" | "retries" | "timeout" | "run", value: string | number | undefined) =>
  setIn(text, ["steps", step, key], value === "" ? undefined : value);

// ------------------------------------------------------------ a new file

/** The file "Start from scratch" begins with: a weekday schedule in this computer's time zone and one prompt step. */
export function blankText(timezone: string): string {
  return `${SCHEMA_LINE}
version: 1
description: ""

on:
  schedule: { at: "09:00", timezone: ${timezone}, weekdays: [mon, tue, wed, thu, fri] }

steps:
  work:
    prompt: ""
    model: auto
`;
}

// ------------------------------------------------------------ New automation's box

/** When a new one runs, as the box offers it: a schedule, one thing on GitHub, or only by hand. */
export type When = { readonly kind: "schedule"; readonly schedule: Schedule } | { readonly kind: "github"; readonly event: GitHubChoice } | { readonly kind: "manual" };

/** What New automation's box holds: the name, the instructions and its quick choices. */
export interface NewDraft {
  readonly title: string;
  readonly prompt: string;
  readonly when: When;
  readonly model: string;
  readonly computer: Computer;
  /** "me" or "project" (model.ts Scope). */
  readonly scope: "me" | "project";
}

const WORKDAYS: ReadonlyArray<Weekday> = ["mon", "tue", "wed", "thu", "fri"];

export const BLANK_DRAFT: NewDraft = {
  title: "",
  prompt: "",
  when: { kind: "schedule", schedule: { at: "09:00", timezone: LOCAL_ZONE, weekdays: WORKDAYS } },
  model: "auto",
  computer: "readonly",
  scope: "me",
};

export type Preset = "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "once";
export const PRESET: Record<Preset, { label: string; days: ReadonlyArray<Weekday> | null }> = {
  hourly: { label: "Every hour", days: null },
  daily: { label: "Every day", days: [] },
  weekdays: { label: "Every weekday", days: WORKDAYS },
  weekly: { label: "Every Monday", days: ["mon"] },
  monthly: { label: "On the 1st of every month", days: null },
  once: { label: "Once, at a date and time", days: null },
};
export const presetOf = (s: Schedule): Preset => {
  const kind = scheduleKindOf(s);
  if (kind === "once") return "once";
  if (kind === "monthly") return "monthly";
  if (kind !== "days") return "hourly";
  return !s.weekdays || s.weekdays.length === 0 || s.weekdays.length === 7 ? "daily" : s.weekdays.join() === WORKDAYS.join() ? "weekdays" : "weekly";
};

/** The schedule a New automation preset starts as, at `at`. */
export function presetSchedule(p: Preset, at: string, now = new Date()): Schedule {
  if (p === "hourly") return { every: "1h" };
  if (p === "monthly") return { at, timezone: LOCAL_ZONE, monthdays: [1] };
  if (p === "once") return { once: `${localDay(now, 1)} ${at}`, timezone: LOCAL_ZONE };
  return { at, timezone: LOCAL_ZONE, weekdays: PRESET[p].days ?? [] };
}

export type GitHubChoice = "pull_request" | "issue" | "mention" | "ci";
export const GITHUB: Record<GitHubChoice, { event: string; mention: boolean; label: string; chip: string }> = {
  pull_request: { event: "pull_request.opened", mention: false, label: "A pull request opens", chip: "On new pull requests" },
  issue: { event: "issues.opened", mention: false, label: "An issue opens", chip: "On new issues" },
  mention: { event: "issue_comment.created", mention: true, label: "Someone mentions @caveman", chip: "On @caveman mentions" },
  ci: { event: "workflow_run.completed", mention: false, label: "A CI run finishes", chip: "When CI finishes" },
};

/** The When chip's words: "Weekdays at 9:00 AM", "Every hour", "On new pull requests", "By hand only". */
export function whenWord(w: When): string {
  if (w.kind === "manual") return "By hand only";
  if (w.kind === "github") return GITHUB[w.event].chip;
  return scheduleWord(w.schedule);
}

/** A schedule in words, as the box's chip and the form say it: "Weekdays at 9:00 AM", "Once, Mon Nov 9 at 9:00 AM". */
export function scheduleWord(s: Schedule): string {
  const kind = scheduleKindOf(s);
  const zone = s.timezone && s.timezone !== LOCAL_ZONE ? ` (${s.timezone.split("/").pop()!.replace(/_/g, " ")})` : "";
  if (kind === "once") return onceWord(s.once!.slice(0, 10), s.once!.slice(11), s.timezone);
  if (kind === "cron") return `Cron ${s.cron}${zone}`;
  if (kind === "interval") return everyWord(s.every ?? "1h");
  if (kind === "monthly") return `Monthly on the ${monthDaysWord((s.monthdays ?? [1]).map((d) => (d === "last" ? -1 : d)))} at ${clockWord(s.at!)}${zone}`;
  const step = stepOf(s);
  if (step && step.n > 1) return step.unit === "d" ? `Every ${step.n} days at ${clockWord(s.at!)}${zone}` : `Every ${step.n} weeks, ${daysWord(s.weekdays)} at ${clockWord(s.at!)}${zone}`;
  const p = presetOf(s);
  const days = p === "daily" ? "Daily" : p === "weekdays" ? "Weekdays" : daysWord(s.weekdays);
  return `${days} at ${clockWord(s.at ?? "09:00")}`;
}

/** How a repeat ends, in words: "Never", "After Dec 31", "After 10 runs". */
export function endsWord(s: Schedule): string {
  if (s.until) return `Until ${dateWord(s.until)}`;
  if (s.count !== undefined) return `After ${s.count} ${s.count === 1 ? "run" : "runs"}`;
  return "No end";
}

/** The file the box writes: the starting file with each choice set on it, one node at a time. */
export function draftText(d: NewDraft): string {
  let text = blankText(LOCAL_ZONE);
  text = setDescription(text, d.title.trim());
  text = setPrompt(text, "work", d.prompt.trim());
  text = setStepKey(text, "work", "model", d.model);
  if (d.computer !== "readonly") text = setStepKey(text, "work", "computer", d.computer);
  text = setSchedule(text, d.when.kind === "schedule" ? d.when.schedule : null);
  if (d.when.kind === "github") {
    const g = GITHUB[d.when.event];
    text = setGitHub(text, { events: [g.event], labels: [], mention: g.mention });
  }
  return text;
}

// ------------------------------------------------------------ words

const DAY_WORD: Record<Weekday, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const WEEKDAYS_ONLY = "mon,tue,wed,thu,fri";
const WEEKEND = "sat,sun";

/** Which days, said as people say them: "Every day", "Every weekday", "Weekends", "Mon, Wed". */
export function daysWord(days: ReadonlyArray<Weekday> | undefined): string {
  const sorted = [...new Set(days ?? [])].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
  if (sorted.length === 0 || sorted.length === 7) return "Every day";
  if (sorted.join() === WEEKDAYS_ONLY) return "Every weekday";
  if (sorted.join() === WEEKEND) return "Weekends";
  if (sorted.length === 1) return `${{ mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" }[sorted[0]!]}s`;
  return sorted.map((d) => DAY_WORD[d]).join(", ");
}

/** A GitHub trigger in a few words: "An issue is labelled caveman", "Someone comments @caveman". */
export function githubWord(g: GitHub): string {
  const first = g.events[0];
  const lead = first ? (EVENT_WORD[first] ?? first) : "A GitHub event";
  const more = g.events.length > 1 ? ` (+${g.events.length - 1})` : "";
  const label = g.labels.length > 0 && /label/.test(first ?? "") ? ` ${g.labels.join(" or ")}` : "";
  const mention = g.mention ? " mentioning @caveman" : "";
  return `${lead}${label}${mention}${more}`;
}

/**
 * The next time a daily schedule fires, when it runs in this computer's time zone (or names none); null otherwise, so
 * the page says the runtime's own next run instead of guessing another zone's.
 */
export function nextAt(s: Schedule, now: Date, localZone: string): Date | null {
  if (s.timezone && s.timezone !== localZone) return null;
  const kind = scheduleKindOf(s);
  if (kind === "once") {
    const [y, mo, d] = s.once!.slice(0, 10).split("-").map(Number) as [number, number, number];
    const [h, m] = s.once!.slice(11).split(":").map(Number) as [number, number];
    const at = new Date(y, mo - 1, d, h, m);
    return at.getTime() > now.getTime() ? at : null;
  }
  // Every few days or weeks, a start, an end or a count: the runtime's next run says it.
  if ((kind !== "days" && kind !== "monthly") || stepOf(s) || s.start || s.until || s.count !== undefined) return null;
  const [h, m] = s.at!.split(":").map(Number) as [number, number];
  if (kind === "monthly") {
    for (let i = 0; i < 14; i++) {
      const first = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      const days = [...new Set((s.monthdays ?? [1]).map((d) => (d === "last" ? last : d)))].filter((d) => d <= last).sort((a, b) => a - b);
      for (const day of days) {
        const at = new Date(first.getFullYear(), first.getMonth(), day, h, m);
        if (at.getTime() > now.getTime()) return at;
      }
    }
    return null;
  }
  const days = s.weekdays && s.weekdays.length > 0 ? new Set(s.weekdays) : null;
  for (let i = 0; i < 8; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, h, m);
    const day = WEEKDAYS[(d.getDay() + 6) % 7]!;
    if (d.getTime() > now.getTime() && (!days || days.has(day))) return d;
  }
  return null;
}

/** What a step's model is called in its chip: a class by its word, a pin by its model's name. */
export function modelWord(model: string | undefined): string {
  if (!model) return "Default";
  const cls: Record<string, string> = { auto: "Auto", fast: "Fast", base: "Base", frontier: "Frontier", haiku: "Haiku", sonnet: "Sonnet", opus: "Opus" };
  return cls[model] ?? model.split("/").pop()!;
}

export const COMPUTER_LABEL: Record<Computer, { label: string; hint: string }> = {
  readonly: { label: "Read-only copy", hint: "A copy of the repo at the run's commit. Changes are thrown away." },
  full: { label: "Fresh worktree", hint: "Its own branch. What it changes is committed." },
  none: { label: "No checkout", hint: "No repo at all: for steps that only read the web or post." },
};
