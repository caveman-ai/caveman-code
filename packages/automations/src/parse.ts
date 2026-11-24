/**
 * Automation files and agent markdown, parsed with a position for every
 * problem. YAML 1.2 through `yaml`'s Document API: every key and value
 * keeps its source range, so a diagnostic names the line and column of the
 * offending key or value.
 *
 * @module parse
 */
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { isAlias, isMap, isNode, isScalar, isSeq, LineCounter, parseDocument, YAMLParseError, type Alias, type Document, type Node, type Pair, type YAMLError, type YAMLMap } from "yaml";

import { diagnostic, didYouMean, hiddenCharacters, quoteList, type Diagnostic, type Position, type SourceFile } from "./diagnostics.ts";
import {
  AGENT_NAME_PATTERN,
  AutomationFile,
  CLAUDE_ALIASES,
  CONCLUSIONS,
  COMPUTERS,
  type Computer,
  DECISION_PATTERN,
  EFFORTS,
  ENGINES,
  APPROVERS,
  GITHUB_EVENTS,
  GitHubTrigger,
  HOSTS,
  Input,
  JIRA_EVENTS,
  JiraTrigger,
  KEY_HINTS,
  LINEAR_EVENTS,
  LinearTrigger,
  MAX_ITERATIONS,
  MAX_PARALLEL,
  PICKS,
  Rung,
  SlackTrigger,
  MODEL_CLASSES,
  NAME_RULE,
  On,
  Outputs,
  RESERVED_DECISIONS,
  RESERVED_KEYS,
  ScheduleTrigger,
  Step,
  WEEKDAYS,
  isAgentModel,
  isEngine,
  type AutomationFile as AutomationFileType,
} from "./format.ts";
import type { RuleCode } from "./rules.ts";

export type AgentSource = "project" | "user" | "plugin" | "builtin";
export const AGENT_ROLES = ["implementation", "research", "review", "design", "test", "general"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** An agent as steps, checks and `explain` see it. */
export interface AgentInfo {
  readonly name: string;
  readonly description: string;
  /** The harness it runs on; absent: the runtime's new-chat default. */
  readonly engine?: string;
  /** A class, `auto`, a pin, a Claude alias or `inherit`, as written. */
  readonly model?: string;
  readonly effort?: string;
  readonly tools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  /** The values its final `decision:` line may take. */
  readonly decides?: ReadonlyArray<string>;
  /** A JSON Schema file for its typed result, relative to the agent file. */
  readonly returns?: string;
  readonly isolation?: "worktree";
  readonly role?: AgentRole;
  /**
   * What it may touch: `none` (no workspace: a general agent with only its declared tools), `readonly` or `full`.
   * Absent: the host's default (for `agent exec`, a coding agent working in place). A step's own `computer` wins.
   */
  readonly computer?: Computer;
  readonly source: AgentSource;
  readonly path?: string;
  /** Claude Code keys in its file that Caveman reads past (hooks, mcpServers, permissionMode, color, ...); explain lists them. */
  readonly ignoredKeys?: ReadonlyArray<string>;
  /** `tools` entries with `type: custom`: tools whose calls go back to whoever drives the session, who answers with the result. */
  readonly customTools?: ReadonlyArray<CustomToolDecl>;
  /**
   * `mcpServers` as Claude Code writes them inline (`name: {command, args, env, cwd}` or `{type: http, url, headers}`).
   * A host that starts an agent's own servers (`caveman-runtime agent exec`) reads these; the app's chats still read
   * past the key, so it stays in `ignoredKeys`. A server only named (Claude's list form) has no config here.
   */
  readonly mcpServers?: Readonly<Record<string, AgentMcpServer>>;
}

/** One MCP server an agent file declares inline: a local command, or a streamable HTTP endpoint. */
export type AgentMcpServer =
  | { readonly type: "stdio"; readonly command: string; readonly args: ReadonlyArray<string>; readonly env?: Readonly<Record<string, string>>; readonly cwd?: string }
  | { readonly type: "http"; readonly url: string; readonly headers?: Readonly<Record<string, string>> };

/** A custom tool an agent file declares: the engine sees it as an MCP tool; a call waits for the session's driver. */
export interface CustomToolDecl {
  readonly name: string;
  readonly description: string;
  /** A JSON Schema object for the tool's input. */
  readonly input_schema: Readonly<Record<string, unknown>>;
}

export interface ParsedAgent extends AgentInfo {
  readonly instructions: string;
  readonly ignoredKeys: ReadonlyArray<string>;
}

// ------------------------------------------------------------ YAML positions

/** Copies of a value aliases may expand to: past this, a few lines could make millions (a billion laughs). */
const MAX_ALIAS_COUNT = 100;
/**
 * How long a file may be with each alias written out as its value: the 1 MiB the runtime reads of a file. Every rule of
 * check works on what an alias stands for, so a few characters of aliases could otherwise cost a hundred times the file.
 */
const MAX_WRITTEN_OUT = 1024 * 1024;

/** yaml's DUPLICATE_KEY, with the key as written, where it was first set in its map, and the key that map belongs to. */
class DuplicateKey extends YAMLParseError {
  readonly written: string;
  readonly first: number;
  readonly parent: string | undefined;
  constructor(offset: number, first: number, parent: string | undefined, written: string) {
    super([offset, offset + 1], "DUPLICATE_KEY", "Map keys must be unique");
    this.written = written;
    this.first = first;
    this.parent = parent;
  }
}

/**
 * Each key set again in its map (the same scalar value, as yaml compares them), in source order. A plain walk: yaml's
 * `visit` copies the path to every node, which costs the nesting depth times the nodes.
 */
function duplicateKeys(doc: Document.Parsed, text: string): DuplicateKey[] {
  const out: DuplicateKey[] = [];
  const todo: Array<{ readonly node: unknown; readonly parent: string | undefined }> = [{ node: doc.contents, parent: undefined }];
  for (let next = todo.pop(); next !== undefined; next = todo.pop()) {
    const { node, parent } = next;
    if (isSeq(node)) for (const item of node.items) todo.push({ node: item, parent: undefined });
    if (!isMap(node)) continue;
    const first = new Map<unknown, number>();
    for (const pair of node.items) {
      todo.push({ node: pair.value, parent: isScalar(pair.key) ? String(pair.key.value) : undefined });
      if (!isScalar(pair.key)) {
        todo.push({ node: pair.key, parent: undefined });
        continue;
      }
      const [start, end] = pair.key.range ?? [0, 0];
      const seen = first.get(pair.key.value);
      if (seen === undefined) first.set(pair.key.value, start);
      else out.push(new DuplicateKey(start, seen, parent, text.slice(start, end)));
    }
  }
  return out.sort((a, b) => a.pos[0] - b.pos[0]);
}

/** yaml's errors with the duplicates where yaml raises them: at the key, after the errors before it. */
function inOrder(errors: ReadonlyArray<YAMLError>, duplicates: ReadonlyArray<YAMLError>): YAMLError[] {
  const out: YAMLError[] = [];
  let next = 0;
  for (const error of errors) {
    while (next < duplicates.length && duplicates[next]!.pos[0] < error.pos[0]) out.push(duplicates[next++]!);
    out.push(error);
  }
  while (next < duplicates.length) out.push(duplicates[next++]!);
  return out;
}

/** The 0-based line an offset is on, from where each line starts. */
function lineOf(starts: ReadonlyArray<number>, offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** A parsed YAML document that can say where any key or value sits. */
export class YamlSource {
  readonly doc: Document.Parsed;
  readonly path: string;
  readonly text: string;
  /** Lines before this text in the file (an agent's frontmatter starts on line 2). */
  readonly lineOffset: number;
  readonly #lines = new LineCounter();
  readonly #keys = new WeakMap<YAMLMap, ReadonlyMap<string, Pair>>();
  constructor(path: string, text: string, lineOffset = 0) {
    this.path = path;
    this.text = text;
    this.lineOffset = lineOffset;
    // yaml's own duplicate check compares each key with every key before it in its map: a file of many keys took
    // seconds to minutes. duplicateKeys finds the same ones in one pass.
    this.doc = parseDocument(text, { lineCounter: this.#lines, prettyErrors: false, version: "1.2", uniqueKeys: false });
    this.doc.errors = inOrder(this.doc.errors, duplicateKeys(this.doc, text));
  }

  positionOf(offset: number): Position {
    const { line, col } = this.#lines.linePos(offset);
    return { line: line + this.lineOffset, column: col };
  }

  /** The node and pair at a path; as deep as the path exists. */
  find(path: ReadonlyArray<PropertyKey>): { readonly node: Node | null | undefined; readonly pair?: Pair; readonly depth: number } {
    let node = this.doc.contents as Node | null | undefined;
    let pair: Pair | undefined;
    let depth = 0;
    for (const segment of path) {
      if (isMap(node)) {
        const next = this.#pairOf(node, String(segment));
        if (next === undefined) break;
        pair = next;
        node = next.value as Node | null;
      } else if (isSeq(node) && typeof segment === "number" && node.items[segment] !== undefined) {
        pair = undefined;
        node = node.items[segment] as Node;
      } else break;
      depth++;
    }
    return { node, ...(pair === undefined ? {} : { pair }), depth };
  }

  /**
   * The first pair with this key. A map of many keys is read once into an index: every problem in a file of many steps
   * looks its step up, and reading the map each time took the square of its size.
   */
  #pairOf(map: YAMLMap, key: string): Pair | undefined {
    if (map.items.length <= 16) return map.items.find((p) => isScalar(p.key) && String(p.key.value) === key);
    let keys = this.#keys.get(map);
    if (keys === undefined) {
      const index = new Map<string, Pair>();
      for (const p of map.items) if (isScalar(p.key) && !index.has(String(p.key.value))) index.set(String(p.key.value), p);
      this.#keys.set(map, (keys = index));
    }
    return keys.get(key);
  }

  /** Where the key (or its value) at `path` starts; the deepest existing parent when it is absent. */
  at(path: ReadonlyArray<PropertyKey>, part: "key" | "value" = "value"): Position {
    const { node, pair, depth } = this.find(path);
    const keyNode = pair?.key as Node | undefined;
    const range = depth === path.length && part === "key" && keyNode?.range ? keyNode.range : (node?.range ?? keyNode?.range);
    return this.positionOf(range?.[0] ?? 0);
  }

  /**
   * The document as plain values, or the alias problem that stops it. yaml throws on an alias with no anchor before
   * it and on aliases that expand past the cap, and builds a value without end from an alias inside its own anchor.
   * Aliases that take the file past MAX_WRITTEN_OUT, written out, stop it too.
   */
  toValue(): { readonly value: unknown } | { readonly problem: Diagnostic } {
    const problem = (alias: Alias, words: string) => ({ problem: diagnostic(this.path, this.positionOf(alias.range?.[0] ?? 0), "yaml-syntax", words) });
    const anchored = new Map<string, Node>();
    const open = new Set<Node>();
    let firstAlias: Alias | undefined;
    const span = (node: Node) => (node.range ? node.range[1] - node.range[0] : 0);
    // By anchored value: its length with the aliases inside it written out. By open node: what its aliases add.
    const written = new Map<Node, number>();
    const adding: number[] = [];
    let length = this.text.length;
    // In document order, as yaml resolves an alias: to the last node marked with its anchor before it.
    const todo: Array<{ readonly node: unknown; readonly leave?: true }> = [{ node: this.doc.contents }];
    for (let next = todo.pop(); next !== undefined; next = todo.pop()) {
      const { node } = next;
      if (next.leave) {
        open.delete(node as Node);
        const added = adding.pop()!;
        if (adding.length > 0) adding[adding.length - 1]! += added;
        if ((node as Node).anchor !== undefined) written.set(node as Node, span(node as Node) + added);
        continue;
      }
      if (isAlias(node)) {
        firstAlias ??= node;
        const source = anchored.get(node.source);
        if (source === undefined) return problem(node, `*${node.source} names no anchor above it; mark the value to repeat with &${node.source} before this line, or write the value out.`);
        if (open.has(source)) return problem(node, `*${node.source} sits inside the value marked &${node.source}, so it would repeat itself forever; write the value out instead.`);
        const added = written.get(source)! - span(node);
        length += added;
        if (adding.length > 0) adding[adding.length - 1]! += added;
        if (length > MAX_WRITTEN_OUT) {
          return problem(node, `*${node.source} takes this file past the 1 MiB check reads, counting each alias as its value written out; repeat less, or split the file.`);
        }
        continue;
      }
      if (!isNode(node)) continue;
      if (node.anchor !== undefined) anchored.set(node.anchor, node);
      open.add(node);
      adding.push(0);
      todo.push({ node, leave: true });
      if (isMap(node)) for (const pair of [...node.items].reverse()) todo.push({ node: pair.value }, { node: pair.key });
      else if (isSeq(node)) for (const item of [...node.items].reverse()) todo.push({ node: item });
    }
    try {
      return { value: this.doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT }) };
    } catch (error) {
      if (firstAlias !== undefined && error instanceof ReferenceError) {
        return problem(firstAlias, `These aliases expand to more than ${MAX_ALIAS_COUNT} copies of a value, more than Caveman reads; write the values out instead.`);
      }
      return { problem: diagnostic(this.path, this.positionOf(0), "yaml-syntax", sentence(error instanceof Error ? error.message : String(error))) };
    }
  }

  /** One plain sentence per YAML mistake, at the line to fix: the library's errors often come in twos for one slip. */
  syntaxDiagnostics(): Diagnostic[] {
    const byLine = new Map<number, Diagnostic>();
    const lines = this.text.split("\n");
    const starts = [0];
    for (const line of lines) starts.push(starts[starts.length - 1]! + line.length + 1);
    for (const [i, e] of this.doc.errors.entries()) {
      const found = yamlProblem(e, this.text, lines, starts, i < DESCRIBED_ERRORS, this.lineOffset);
      const d = diagnostic(this.path, { line: found.line + 1 + this.lineOffset, column: found.column + 1 }, "yaml-syntax", found.message);
      if (!byLine.has(d.line)) byLine.set(d.line, d);
    }
    return [
      ...[...byLine.values()].sort((a, b) => a.line - b.line),
      ...this.doc.warnings.map((w) => ({ ...diagnostic(this.path, this.positionOf(w.pos[0]), "yaml-syntax", sentence(w.message)), severity: "warning" as const })),
    ];
  }
}

const sentence = (text: string) => {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

// ------------------------------------------------------------ YAML mistakes in words

/** Keys whose value is a map: `if: gate: review` wants braces, not quotes. */
const MAP_VALUED = new Set(["on", "github", "schedule", "webhook", "inputs", "budget", "steps", "outputs", "if", "github.comment", "github.pull_request"]);
/**
 * `key: value` on one line (a list dash allowed), with the value as written: what
 * /^( *)(?:- +)?([^\s#'"{[\]},][^:#]*?|"[^"]*"|'[^']*') *:(?: +(.*?))? *$/ matches, read in one pass. That regex
 * backtracks in the square of a long run of spaces, which held the runtime for minutes on one line.
 */
function keyLine(line: string | undefined): { indent: number; column: number; key: string; value: string } | undefined {
  if (line === undefined) return undefined;
  let indent = 0;
  while (line[indent] === " ") indent++;
  let afterDash = indent + 1;
  while (line[afterDash] === " ") afterDash++;
  for (const start of line[indent] === "-" && line[indent + 1] === " " ? [afterDash, indent] : [indent]) {
    const key = keyAt(line, start);
    const value = key === undefined ? undefined : valueAt(line, key.colon + 1);
    if (key === undefined || value === undefined) continue;
    const written = line.slice(start, key.end);
    const comment = value.indexOf(" #");
    let end = comment === -1 ? value.length : comment;
    while (comment !== -1 && end > 0 && value[end - 1] === " ") end--;
    return { indent, column: line.indexOf(written), key: written.replace(/^["']|["']$/g, ""), value: value.slice(0, end) };
  }
  return undefined;
}

/** A key starting at `start` (quoted, or plain up to the first colon), and the colon after it. */
function keyAt(line: string, start: number): { readonly end: number; readonly colon: number } | undefined {
  const first = line[start];
  if (first === undefined) return undefined;
  if (first === '"' || first === "'") {
    const close = line.indexOf(first, start + 1);
    if (close === -1) return undefined;
    let colon = close + 1;
    while (line[colon] === " ") colon++;
    return line[colon] === ":" ? { end: close + 1, colon } : undefined;
  }
  if (/[\s#'"{[\]},]/.test(first)) return undefined;
  let colon = start + 1;
  while (colon < line.length && line[colon] !== ":" && line[colon] !== "#") colon++;
  if (line[colon] !== ":") return undefined;
  let end = colon;
  while (end > start + 1 && line[end - 1] === " ") end--;
  return { end, colon };
}

/** The value after a key's colon at `from`, without the spaces around it; undefined when the line is not key: value. */
function valueAt(line: string, from: number): string | undefined {
  if (from === line.length) return "";
  if (line[from] !== " ") return undefined;
  let start = from;
  while (line[start] === " ") start++;
  let end = line.length;
  while (end > start && line[end - 1] === " ") end--;
  const value = line.slice(start, end);
  return /[\n\r\u2028\u2029]/.test(value) ? undefined : value;
}
const indentOf = (line: string) => line.length - line.trimStart().length;
const blank = (line: string | undefined) => line === undefined || /^\s*(#.*)?$/.test(line);
/** `"@caveman answer"`, short enough to read in a message. */
const quoted = (value: string) => JSON.stringify(value.length > 32 ? `${value.slice(0, 29)}...` : value);

/** The bracket or quote still open at `upto`, reading YAML the way a person writes it ("don't" opens nothing). */
function openAt(text: string, upto: number): { readonly char: string; readonly offset: number } | undefined {
  const stack: Array<{ char: string; offset: number }> = [];
  let quote: { char: string; offset: number } | undefined;
  for (let i = 0; i < upto; i++) {
    const c = text[i]!;
    const prev = i === 0 ? "\n" : text[i - 1]!;
    if (quote !== undefined) {
      if (c === "\\" && quote.char === '"') i++;
      else if (c === "'" && quote.char === "'" && text[i + 1] === "'") i++;
      else if (c === quote.char) quote = undefined;
    } else if (c === "#" && /\s/.test(prev)) {
      while (i + 1 < upto && text[i + 1] !== "\n") i++;
    } else if ((c === '"' || c === "'") && /[\s:,[{]/.test(prev)) quote = { char: c, offset: i };
    else if (c === "{" || c === "[") stack.push({ char: c, offset: i });
    else if ((c === "}" || c === "]") && stack.length > 0) stack.pop();
  }
  return quote ?? stack[stack.length - 1];
}

/**
 * The YAML errors said in plain words, in file order. Each may read the whole text (where a bracket opened, the lines
 * above), so past these the library's own sentence is used: a file of thousands of errors held the runtime for minutes.
 */
const DESCRIBED_ERRORS = 50;
const asWritten = (message: string) => `${sentence(message)} Check this line's indentation, colons and quotes.`;

/**
 * A YAML error as the sentence that fixes it, at the place to fix (0-based line and column in `text`). A line the
 * sentence names is the file's: `lineOffset` lines sit above `text` there.
 */
function yamlProblem(
  error: YAMLError,
  text: string,
  lines: ReadonlyArray<string>,
  starts: ReadonlyArray<number>,
  describe: boolean,
  lineOffset: number,
): { line: number; column: number; message: string } {
  const { code, message } = error;
  const offset = error.pos[0];
  const lineAt = (o: number) => lineOf(starts, o);
  const fileLine = (l: number) => l + 1 + lineOffset;
  const columnAt = (o: number) => o - starts[lineAt(o)]!;
  const line = lineAt(offset);
  const column = columnAt(offset);
  const at = (l: number, c: number, words: string) => ({ line: l, column: Math.max(0, c), message: words });
  if (!describe) return at(line, column, asWritten(message));
  const here = lines[line] ?? "";

  if (code === "TAB_AS_INDENT" || /^ *\t/.test(here)) return at(line, here.indexOf("\t"), "Use spaces to indent; this line has a tab.");

  if (error instanceof DuplicateKey) {
    const key = error.written.replace(/^["']|["']$/g, "") || "This key";
    const first = lineAt(error.first);
    if (first === line) return at(line, column, `"${key}" appears twice here; keep one of them.`);
    return at(line, column,
      error.parent === "steps" ? `There is already a step named "${key}" on line ${fileLine(first)}; give this one another name.` : `"${key}" is already set on line ${fileLine(first)}; keep one of them.`);
  }

  if (code === "BLOCK_IN_FLOW") return at(line, column, 'A value inside { } has ": " in it, which YAML reads as another key; put that value in quotes.');
  if (/end with an? [}\]]/i.test(message)) {
    const open = openAt(text, offset);
    if (open !== undefined && (open.char === "{" || open.char === "[")) {
      return at(lineAt(open.offset), columnAt(open.offset), `This ${open.char} is never closed; add the ${open.char === "{" ? "}" : "]"} that ends it.`);
    }
  }
  if (/closing .?quote/i.test(message)) {
    const open = openAt(text, offset);
    if (open !== undefined && (open.char === '"' || open.char === "'")) {
      return at(lineAt(open.offset), columnAt(open.offset), `This ${open.char} is never closed; add a closing ${open.char} where the value ends.`);
    }
  }

  const kv = keyLine(here);
  const reserved = /reserved character (\S)/.exec(message)?.[1];
  if (code === "BAD_SCALAR_START" && reserved !== undefined) {
    return at(line, column, `A value cannot start with ${reserved} unless it is quoted; write ${kv ? `${kv.key}: ${quoted(kv.value)}` : `"${reserved}..."`}.`);
  }
  if (code === "UNEXPECTED_TOKEN" && kv !== undefined && /^[{[*&!|>%@`]/.test(kv.value)) {
    return at(line, kv.column, `This value starts with ${kv.value[0]}, which YAML reads as something else; put the whole value in quotes: ${kv.key}: ${quoted(kv.value)}.`);
  }

  if (code === "BLOCK_AS_IMPLICIT_KEY" || code === "MULTILINE_IMPLICIT_KEY" || code === "MISSING_CHAR") {
    // A list item out of line with the one above it.
    if (/^ *- /.test(here)) {
      for (let l = line - 1; l >= 0; l--) {
        if (blank(lines[l])) continue;
        if (/^ *- /.test(lines[l]!) && indentOf(lines[l]!) !== indentOf(here)) {
          return at(line, indentOf(here), `This - is not lined up with the - on line ${fileLine(l)}; give them the same indent.`);
        }
        if (indentOf(lines[l]!) < indentOf(here)) break;
      }
    }
    // A colon inside a plain value: "prompt: End with decision: review".
    if (kv !== undefined && !/^["'{[|>]/.test(kv.value) && (/: /.test(kv.value) || kv.value.endsWith(":"))) {
      if (MAP_VALUED.has(kv.key)) return at(line, kv.column, `${kv.key} takes a map; write it as ${kv.key}: { ${kv.value.replace(/:$/, "")} }.`);
      return at(line, kv.column, `The value of ${kv.key} has ": " in it, which YAML reads as another key. Quote the value, or write it as a block: ${kv.key}: | with the text on the lines below.`);
    }
    // The next line indented further than this one's key: "agent: reviewer" then "  model: base".
    let next = line + 1;
    while (next < lines.length && blank(lines[next])) next++;
    if (kv !== undefined && kv.value !== "" && next < lines.length && indentOf(lines[next]!) > kv.indent) {
      const nk = keyLine(lines[next]);
      return at(next, indentOf(lines[next]!),
        nk !== undefined
          ? `${nk.key} is indented further than ${kv.key} above it; line them up.`
          : `This line is indented further than ${kv.key} above it; line them up, or write ${kv.key}: | to give it several lines.`);
    }
    if (/followed by map values/.test(message) && !here.includes(":")) {
      return at(line, indentOf(here), 'This line has no ":"; write it as key: value, or indent it under the key it belongs to.');
    }
  }
  return at(line, column, asWritten(message));
}

// ------------------------------------------------------------ automation files

type KeyContext = keyof typeof KNOWN_KEYS;
const fields = (schema: { readonly fields: object }) => Object.keys(schema.fields);
/** The keys each map may have, read off the schema so the two never drift. */
const KNOWN_KEYS = {
  top: fields(AutomationFile),
  on: fields(On),
  github: fields(GitHubTrigger),
  schedule: fields(ScheduleTrigger),
  webhook: [] as string[],
  slack: fields(SlackTrigger),
  linear: fields(LinearTrigger),
  jira: fields(JiraTrigger),
  input: fields(Input),
  budget: ["usd", "tokens", "turns"],
  step: fields(Step),
  check: ["agent"],
  rung: fields(Rung),
  approve: ["by", "timeout"],
  outcome: ["rubric", "max_iterations"],
  outputs: fields(Outputs),
  comment: ["from", "field"],
  pull_request: ["from", "draft"],
  slack_message: ["from", "field", "channel"],
  issue_comment: ["from", "field"],
  chief: ["from", "to"],
};
const RESERVED: Partial<Record<KeyContext, Readonly<Record<string, string>>>> = {
  top: RESERVED_KEYS.top,
  step: RESERVED_KEYS.step,
  on: RESERVED_KEYS.on,
  outputs: RESERVED_KEYS.outputs,
};
const PLACE: Record<KeyContext, (path: ReadonlyArray<PropertyKey>) => string> = {
  top: () => "at the top level",
  on: () => "in on",
  github: () => "in on.github",
  schedule: () => "in on.schedule",
  webhook: () => "in on.webhook",
  slack: () => "in on.slack",
  linear: () => "in on.linear",
  jira: () => "in on.jira",
  input: (p) => `in input "${String(p[1])}"`,
  budget: () => "in budget",
  step: (p) => `in step "${String(p[1])}"`,
  check: (p) => `in a check of step "${String(p[1])}"`,
  rung: (p) => `in an escalate rung of step "${String(p[1])}"`,
  approve: (p) => `in approve of step "${String(p[1])}"`,
  outcome: (p) => `in outcome of step "${String(p[1])}"`,
  outputs: () => "in outputs",
  comment: () => "in github.comment",
  pull_request: () => "in github.pull_request",
  slack_message: () => "in slack.message",
  issue_comment: (p) => `in ${String(p[1])}`,
  chief: () => "in chief",
};

/** The map a known key's value is read as: what a key indented too little belonged to. */
const CHILD: Partial<Record<KeyContext, Readonly<Record<string, KeyContext>>>> = {
  top: { on: "on", budget: "budget", outputs: "outputs" },
  on: { github: "github", schedule: "schedule", webhook: "webhook", slack: "slack", linear: "linear", jira: "jira" },
  step: { approve: "approve", outcome: "outcome" },
  outputs: {
    "github.comment": "comment",
    "github.pull_request": "pull_request",
    "slack.message": "slack_message",
    "linear.comment": "issue_comment",
    "jira.comment": "issue_comment",
    chief: "chief",
  },
};
const STEP_KEYS: ReadonlyArray<string> = [...fields(Step), ...Object.keys(RESERVED_KEYS.step)];
const pathKey = (path: ReadonlyArray<PropertyKey>) => path.map(String).join("\0");
/** `key:` with nothing after it: the yaml library gives a null scalar, or no node at all. */
const isEmpty = (node: unknown) => node === null || node === undefined || (isScalar(node) && node.value === null);
const colonList = (keys: ReadonlyArray<string>) => quoteList(keys.map((k) => `${k}:`), "and");

interface KeyCheck {
  readonly diagnostics: Diagnostic[];
  /** Maps holding a typo'd key: the key missing beside it is already explained. */
  readonly typoMaps: ReadonlySet<string>;
  /** Paths whose schema problems only follow from a key indented too little: reported once, as that. */
  readonly misindented: ReadonlySet<string>;
}

/** Unknown and reserved keys, walking the maps the format defines, and keys indented too little. */
function keyDiagnostics(source: YamlSource): KeyCheck {
  const out: Diagnostic[] = [];
  const typoMaps = new Set<string>();
  const misindented = new Set<string>();
  const positionOfKey = (pair: Pair) => source.positionOf((pair.key as Node).range?.[0] ?? 0);
  /** One diagnostic for a run of keys that belong one level further in. */
  const indentUnder = (group: ReadonlyArray<Pair>, parent: string | undefined, setting: string) => {
    const keys = group.map((p) => String((p.key as { value: unknown }).value));
    const one = keys.length === 1;
    out.push(diagnostic(source.path, positionOfKey(group[0]!), "invalid-value",
      parent === undefined
        ? `${colonList(keys)} ${one ? "is a" : "are"} ${setting} ${one ? "setting" : "settings"}, not ${one ? "a step" : "steps"}; put ${one ? "it" : "them"} under a named step, like  review: { agent: reviewer }.`
        : `Indent ${colonList(keys)} under ${parent}; ${one ? "it is a" : "they are"} ${setting} ${one ? "setting" : "settings"}, not ${one ? `a ${setting === "step" ? "step" : "key of its own"}` : setting === "step" ? "steps" : "keys of their own"}.`));
  };

  const visitSteps = (value: Node | null, path: ReadonlyArray<PropertyKey>) => {
    if (!isMap(value)) return;
    let group: Pair[] = [];
    let parent: Pair | undefined;
    const flush = () => {
      if (group.length === 0) return;
      const name = parent === undefined ? undefined : String((parent.key as { value: unknown }).value);
      indentUnder(group, name, "step");
      for (const p of group) misindented.add(pathKey([...path, String((p.key as { value: unknown }).value)]));
      if (name !== undefined && isEmpty(parent!.value)) misindented.add(pathKey([...path, name]));
      group = [];
    };
    for (const entry of value.items) {
      if (!isScalar(entry.key)) continue;
      const name = String(entry.key.value);
      // "agent: reviewer" at the level of the step names: a setting of the step above it.
      if (STEP_KEYS.includes(name) && !isMap(entry.value)) {
        group.push(entry as Pair);
        continue;
      }
      flush();
      parent = entry as Pair;
      visit(entry.value, "step", [...path, name]);
    }
    flush();
  };

  const visit = (node: unknown, context: KeyContext, path: ReadonlyArray<PropertyKey>) => {
    if (!isMap(node)) return;
    let empty: { pair: Pair; context: KeyContext } | undefined;
    let group: Pair[] = [];
    const flush = () => {
      if (group.length > 0 && empty !== undefined) {
        const parent = String((empty.pair.key as { value: unknown }).value);
        indentUnder(group, parent, parent);
        misindented.add(pathKey([...path, parent]));
      }
      group = [];
    };
    for (const pair of node.items) {
      if (!isScalar(pair.key)) continue;
      const name = String(pair.key.value);
      const at = positionOfKey(pair as Pair);
      const reserved = RESERVED[context]?.[name];
      const known = KNOWN_KEYS[context];
      if (reserved === undefined && !known.includes(name) && empty !== undefined && KNOWN_KEYS[empty.context].includes(name)) {
        // "github:" with nothing after it, then "event:" at the same level: event belongs to github.
        group.push(pair as Pair);
        continue;
      }
      flush();
      const child = CHILD[context]?.[name];
      empty = isEmpty(pair.value) && child !== undefined ? { pair: pair as Pair, context: child } : undefined;
      if (reserved !== undefined) {
        out.push(diagnostic(source.path, at, "reserved-key", `"${name}" ${PLACE[context](path)} is coming in a later version. ${reserved}`));
      } else if (!known.includes(name)) {
        const hint = KEY_HINTS[name];
        typoMaps.add(pathKey(path));
        out.push(
          diagnostic(source.path, at, "unknown-key",
            `Unknown key "${name}" ${PLACE[context](path)}.${hint ? ` ${hint}` : known.length === 0 ? " It takes no keys yet." : didYouMean(name, known) || ` Keys here: ${known.join(", ")}.`}`),
        );
      } else {
        const next = [...path, name];
        const value = pair.value as Node | null;
        if (child !== undefined) visit(value, child, next);
        else if (context === "top" && name === "steps") visitSteps(value, next);
        else if (context === "top" && name === "inputs" && isMap(value)) {
          for (const entry of value.items) if (isScalar(entry.key)) visit(entry.value, "input", [...next, String(entry.key.value)]);
        } else if (context === "step" && name === "checks" && isSeq(value)) value.items.forEach((item, i) => visit(item, "check", [...next, i]));
        else if (context === "step" && name === "escalate" && isSeq(value)) value.items.forEach((item, i) => visit(item, "rung", [...next, i]));
      }
    }
    flush();
  };
  visit(source.doc.contents, "top", []);
  return { diagnostics: out, typoMaps, misindented };
}

const STEP_MODELS = ["auto", ...MODEL_CLASSES, ...CLAUDE_ALIASES];

/** `if: gate == review` as the map it meant. */
const ifExample = (value: unknown): string => {
  const m = typeof value === "string" ? /^\s*([a-z][a-z0-9_-]*)\s*(?:==?|:|\bis\b)\s*([a-z][a-z0-9_-]*)\s*$/i.exec(value) : null;
  return m ? `${m[1]}: ${m[2]}` : "triage: implement";
};

/** "write 24h (durations take s, m or h)" for the units people try; undefined when nothing better than the default fits. */
function durationFix(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return `add a unit: ${value}m, ${value}s or ${value}h`;
  const m = typeof value === "string" ? /^\s*([0-9]+)\s*([a-z]+)\s*$/i.exec(value) : null;
  if (m === null) return undefined;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const as = (written: string) => `write ${written} (durations take s, m or h)`;
  if (/^(d|days?)$/.test(unit)) return as(`${n * 24}h`);
  if (/^(w|wks?|weeks?)$/.test(unit)) return `every takes s, m or h; for once a week, use at: "09:00" with weekdays: [mon]`;
  if (/^(hrs?|hours?)$/.test(unit)) return as(`${n}h`);
  if (/^(mins?|minutes?)$/.test(unit)) return as(`${n}m`);
  if (/^(secs?|seconds?)$/.test(unit)) return as(`${n}s`);
  return undefined;
}

/**
 * Real GitHub events and actions that Caveman Code does not watch in v1: these get "not watched yet", never a
 * did-you-mean toward a different event (pull_request.closed is not a typo of pull_request.opened).
 */
const GITHUB_ACTIONS: Readonly<Record<string, ReadonlyArray<string>>> = {
  issues: ["opened", "edited", "deleted", "closed", "reopened", "assigned", "unassigned", "labeled", "unlabeled", "milestoned", "demilestoned", "pinned", "unpinned", "locked", "unlocked", "transferred"],
  pull_request: ["opened", "edited", "closed", "reopened", "synchronize", "assigned", "unassigned", "labeled", "unlabeled", "ready_for_review", "converted_to_draft", "review_requested", "review_request_removed", "locked", "unlocked", "auto_merge_enabled", "auto_merge_disabled"],
  issue_comment: ["created", "edited", "deleted"],
  pull_request_review: ["submitted", "edited", "dismissed"],
  pull_request_review_comment: ["created", "edited", "deleted"],
  workflow_run: ["requested", "in_progress", "completed"],
  release: ["published", "unpublished", "created", "edited", "deleted", "prereleased", "released"],
  discussion: ["created", "edited", "deleted", "answered", "labeled"],
  check_run: ["created", "completed", "rerequested"],
  check_suite: ["completed", "requested", "rerequested"],
};
const GITHUB_PLAIN_EVENTS = ["push", "create", "delete", "fork", "workflow_dispatch", "repository_dispatch", "status", "star", "watch", "merge_group", "deployment", "deployment_status"];

function eventMessage(value: unknown): string {
  const watched = `Watched events: ${GITHUB_EVENTS.join(", ")}.`;
  if (typeof value !== "string") return `event is ${JSON.stringify(value)}; write one event, like issues.opened, or a list of them. ${watched}`;
  const [name = "", action] = value.split(".");
  const actions = GITHUB_ACTIONS[name];
  if (actions !== undefined && action === undefined) {
    const ours = GITHUB_EVENTS.filter((e) => e.startsWith(`${name}.`));
    return `"${value}" needs an action, like ${quoteList(ours.length > 0 ? ours : [`${name}.${actions[0]}`])}. ${watched}`;
  }
  if ((actions !== undefined && actions.includes(action!)) || (action === undefined && GITHUB_PLAIN_EVENTS.includes(name))) {
    const merged = value === "pull_request.closed" ? " For merged pull requests, use push (the default branch)." : "";
    return `"${value}" is not watched in Caveman Code yet.${merged} ${watched}`;
  }
  return `"${value}" is not a GitHub event Caveman watches.${didYouMean(value, GITHUB_EVENTS)} ${watched}`;
}

/** The rule and message for a value the schema rejected, by the key it sits under. */
function valueDiagnostic(path: ReadonlyArray<PropertyKey>, effectMessage: string, value: unknown): { code: RuleCode; message: string } {
  const keys = path.filter((p): p is string => typeof p === "string");
  const key = keys[keys.length - 1] ?? "";
  const parent = keys[keys.length - 2];
  const got = typeof value === "string" ? `"${value}"` : JSON.stringify(value);
  if (effectMessage === "Missing key") {
    if (key === "steps") return { code: "missing-key", message: "Add steps: this file has nothing to run." };
    if (key === "agent") return { code: "missing-key", message: "An agent check needs agent: write { agent: reviewer }." };
    return { code: "missing-key", message: `Add ${key}${parent ? ` to ${parent}` : ""}.` };
  }
  if (parent === "steps" && (value === null || typeof value !== "object" || Array.isArray(value))) {
    return { code: "step-agent-or-prompt", message: `Step "${key}" is empty; give it agent: <name> or prompt: <instructions>.` };
  }
  const typo = (candidates: ReadonlyArray<string>) => (typeof value === "string" ? didYouMean(value, candidates) : "");
  if (key === "version") return { code: "version-unsupported", message: `version is ${got}; this Caveman reads version 1. Write version: 1, or update Caveman.` };
  if (key === "if" && parent !== "steps") return { code: "invalid-value", message: `if is ${got}; write it as a map of earlier steps and what they decided: if: { ${ifExample(value)} }.` };
  if (parent === "if") return { code: "invalid-value", message: `if: { ${key}: ... } tests one value; write if: { ${key}: <value> }, a value "${key}" decides, or failed.` };
  const item = typeof path[path.length - 1] === "number";
  if (key === "decides" && !item) return { code: "invalid-value", message: `decides is ${got}; write a list, like decides: [review, skip].` };
  if (key === "decides") return { code: "decides-invalid", message: `decides has ${got}; use ${NAME_RULE}, like needs_info or needs-info.` };
  if (key === "model") return { code: "model-invalid", message: `model is ${got}; use auto, fast, base, frontier, or a pin like anthropic/claude-sonnet-5-5.${typo(STEP_MODELS)}` };
  if (key === "escalate" || parent === "escalate" || (item && keys.includes("escalate"))) {
    return { code: "escalate-not-class", message: `escalate is ${got}; write a class (fast, base or frontier), or a ladder like [{ model: frontier }, { engine: codex }].${typo(MODEL_CLASSES)}` };
  }
  if (key === "host") return { code: "invalid-value", message: `host is ${got}; use ${quoteList([...HOSTS])}.${typo(HOSTS)}` };
  if (key === "needs" && !item) return { code: "invalid-value", message: `needs is ${got}; write a list of steps, like needs: [triage].` };
  if (key === "needs") return { code: "invalid-value", message: `needs has ${got}; write step names, like needs: [triage].` };
  if (key === "parallel") return { code: "parallel-range", message: `parallel is ${got}; use a whole number from 2 to ${MAX_PARALLEL}.` };
  if (key === "pick") return { code: "invalid-value", message: `pick is ${got}; use ${quoteList([...PICKS])}.${typo(PICKS)}` };
  if (parent === "approve" && key === "by") return { code: "invalid-value", message: `approve.by is ${got}; use ${quoteList([...APPROVERS])}.${typo(APPROVERS)}` };
  if (parent === "approve" && key === "timeout") return { code: "timeout-invalid", message: `approve.timeout is ${got}; ${durationFix(value) ?? "write a duration like 72h"}.` };
  if (key === "approve") return { code: "invalid-value", message: `approve is ${got}; write approve: { by: owner } or approve: { by: members }.` };
  if (key === "wait") return { code: "wait-invalid", message: `wait is ${got}; ${durationFix(value) ?? "write a duration like 30m or 24h"}.` };
  if (key === "run") return { code: "invalid-value", message: `run is ${got}; write the command to run, like run: pnpm build.` };
  if (parent === "outcome" && key === "max_iterations") return { code: "outcome-iterations-range", message: `max_iterations is ${got}; use a whole number from 1 to ${MAX_ITERATIONS}.` };
  if (parent === "outcome" && key === "rubric") return { code: "invalid-value", message: `rubric is ${got}; write what finished work must meet, in words.` };
  if (key === "outcome") return { code: "invalid-value", message: `outcome is ${got}; write outcome: { rubric: <what done means>, max_iterations: 2 }.` };
  if (key === "channels" || parent === "channels") return { code: "invalid-value", message: `channels is ${got}; write a list of channels, like channels: ["#triage"].` };
  if (key === "mention" && keys.includes("slack")) return { code: "invalid-value", message: "on.slack fires on messages that mention @caveman; write mention: true, or leave it out." };
  if ((key === "events" || parent === "events") && keys.includes("linear")) return { code: "invalid-value", message: `on.linear events are ${quoteList([...LINEAR_EVENTS])}; got ${got}.${typo(LINEAR_EVENTS)}` };
  if ((key === "events" || parent === "events") && keys.includes("jira")) return { code: "invalid-value", message: `on.jira events are ${quoteList([...JIRA_EVENTS])}; got ${got}.${typo(JIRA_EVENTS)}` };
  if ((key === "labels" || parent === "labels") && (keys.includes("linear") || keys.includes("jira"))) return { code: "invalid-value", message: `labels is ${got}; write a list, like labels: [caveman].` };
  if (key === "merged") return { code: "invalid-value", message: `merged is ${got}; write true (merged pull requests) or false (closed without merging).` };
  if (key === "effort") return { code: "effort-invalid", message: `effort is ${got}; use ${quoteList([...EFFORTS])}.${typo(EFFORTS)}` };
  if (key === "computer") return { code: "computer-invalid", message: `computer is ${got}; use ${quoteList([...COMPUTERS])}.${typeof value === "string" ? didYouMean(value, COMPUTERS) : ""}` };
  if (key === "retries") return { code: "retries-range", message: `retries is ${got}; use a whole number from 0 to 3.` };
  if (key === "timeout") return { code: "timeout-invalid", message: `timeout is ${got}; ${durationFix(value) ?? "write a duration like 30m, 90s or 2h"}.` };
  if (key === "checks") return { code: "check-invalid", message: `This check is ${got}; write a command like pnpm test, or { agent: reviewer }.` };
  if (key === "event") return { code: "github-event-unknown", message: eventMessage(value) };
  if (key === "actors") return { code: "github-actors-invalid", message: `actors is ${got}; use a list of owner, member and collaborator, or leave it out for all three.` };
  if (key === "conclusion") return { code: "invalid-value", message: `conclusion is ${got}; use ${quoteList([...CONCLUSIONS])}.` };
  if (key === "at") {
    const short = typeof value === "string" ? /^([0-9]):([0-5][0-9])$/.exec(value) : null;
    return { code: "schedule-at-invalid", message: short ? `at is ${got}; write "0${short[1]}:${short[2]}", with two digits for the hour.` : `at is ${got}; write a 24-hour time like "09:00".` };
  }
  if (key === "every") return { code: "schedule-every-invalid", message: `every is ${got}; ${durationFix(value) ?? "write a duration like 6h or 30m"}.` };
  if (key === "monthdays" && !item) return { code: "schedule-monthdays-invalid", message: `monthdays is ${got}; write a list, like monthdays: [1, 15, last].` };
  if (key === "monthdays" || parent === "monthdays") return { code: "schedule-monthdays-invalid", message: `monthdays has ${got}; use days 1 to 31, or last for the month's last day.` };
  if (key === "once") return { code: "schedule-date-invalid", message: `once is ${got}; write a date and 24-hour time, quoted, like once: "2026-11-09 09:00".` };
  if (key === "start" || key === "until") return { code: "schedule-date-invalid", message: `${key} is ${got}; write a date, quoted, like ${key}: "2026-11-09".` };
  if (key === "count") return { code: "schedule-count-invalid", message: `count is ${got}; write how many runs, like count: 10.` };
  if (key === "cron") return { code: "schedule-cron-invalid", message: `cron is ${got}; write five fields in quotes, like cron: "0 9 * * 1-5".` };
  if (key === "weekdays" && !item) return { code: "schedule-weekdays-invalid", message: `weekdays is ${got}; write a list, like weekdays: [mon, fri].` };
  if (key === "weekdays") return { code: "schedule-weekdays-invalid", message: `weekdays has ${got}; use ${quoteList([...WEEKDAYS])}.${typo(WEEKDAYS)}` };
  if (key === "budget" || parent === "budget") {
    return { code: "budget-invalid", message: `budget${parent === "budget" ? `.${key}` : ""} is ${got}; write a positive amount like $6 or $1.50, or { usd: 6, tokens: 2000000, turns: 200 }.` };
  }
  if (key === "github.comment" || parent === "github.comment") return { code: "output-invalid", message: `github.comment is ${got}; write <step>.<field> like review.summary, or { from: review }.` };
  if (key === "github.pull_request" || parent === "github.pull_request") return { code: "output-invalid", message: `github.pull_request is ${got}; write { from: <step>, draft: true }.` };
  if (key === "slack.message" || parent === "slack.message") return { code: "output-invalid", message: `slack.message is ${got}; write <step>.<field> like triage.summary, or { from: triage, channel: "#ops" }.` };
  for (const kind of ["linear.comment", "jira.comment"]) {
    if (key === kind || parent === kind) return { code: "output-invalid", message: `${kind} is ${got}; write <step>.<field> like triage.summary, or { from: triage }.` };
  }
  if (key === "webhook") return { code: "invalid-value", message: "webhook takes no settings yet; write webhook: {}." };
  const expected = effectMessage.replace(/^Expected /, "").replace(/, got .*$/, "");
  return { code: "invalid-value", message: `${key || "This file"} is ${got}; expected ${expected}.` };
}

type IssueAt = { readonly keys: ReadonlyArray<PropertyKey>; readonly message: string };

/** Effect's issues, flattened to a path and a message; empty when the value is a valid file. */
function schemaIssues(value: unknown): IssueAt[] {
  const exit = Schema.decodeUnknownExit(AutomationFile)(value, { errors: "all" });
  if (Exit.isSuccess(exit)) return [];
  const error = exit.cause.reasons.flatMap((reason) => (reason._tag === "Fail" ? [reason.error] : []))[0];
  if (error === undefined) return [];
  return SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map(({ path, message }) => ({
    keys: (path ?? []).map((p) => (typeof p === "object" ? p.key : p)),
    message,
  }));
}

/** Effect's issues as diagnostics at the rejected value. */
function schemaDiagnostics(source: YamlSource, value: unknown, issues: ReadonlyArray<IssueAt>, checked: KeyCheck): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const { keys, message } of issues) {
    // A key indented too little is reported once, as that; the empty map and the stray key it leaves say nothing new.
    if (keys.some((_, i) => checked.misindented.has(pathKey(keys.slice(0, i + 1))))) continue;
    let at: unknown = value;
    for (const k of keys) at = (at as Record<PropertyKey, unknown> | undefined)?.[k];
    const found = valueDiagnostic(keys, message, at);
    // A typo'd key already explains the key that is missing beside it.
    if (found.code === "missing-key" && checked.typoMaps.has(pathKey(keys.slice(0, -1)))) continue;
    const position = source.at(keys, found.code === "missing-key" || found.code === "step-agent-or-prompt" ? "key" : "value");
    const id = `${position.line}:${position.column}:${found.code}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(diagnostic(source.path, position, found.code, found.message));
  }
  return out;
}

/**
 * The file with every rejected value removed, so the rules across files can
 * still run in the same pass; `tainted` lists the paths removed, so check
 * leaves out problems that follow from them. Undefined when nothing usable is left.
 */
function salvage(value: object, first: ReadonlyArray<IssueAt>): Salvaged | undefined {
  const copy = structuredClone(value) as Record<string, unknown>;
  const tainted: Array<ReadonlyArray<string>> = [];
  let issues = first;
  const get = (path: ReadonlyArray<PropertyKey>): unknown => path.reduce<unknown>((at, k) => (at as Record<PropertyKey, unknown> | undefined)?.[k], copy);
  for (let round = 0; round < 4 && issues.length > 0; round++) {
    const dropped = new Map<unknown[], Set<number>>();
    for (const { keys, message } of issues) {
      // A missing key takes its map with it.
      const target = message === "Missing key" ? keys.slice(0, -1) : [...keys];
      const index = target.findIndex((k) => typeof k === "number");
      if (index !== -1) {
        // A bad list item goes on its own, so the rest of the list is still checked. A check keeps its place
        // (later checks are reported by index) as an inert agent check the rules skip; other items are dropped.
        const listPath = target.slice(0, index);
        const list = get(listPath);
        if (!Array.isArray(list)) continue;
        if (listPath[listPath.length - 1] === "checks") {
          list[target[index] as number] = { agent: "" };
          tainted.push(target.slice(0, index + 1).map(String));
        } else {
          if (!dropped.has(list)) dropped.set(list, new Set());
          dropped.get(list)!.add(target[index] as number);
          tainted.push(listPath.map(String));
        }
        continue;
      }
      if (target.length === 0 || (target.length === 1 && target[0] === "steps")) return undefined;
      const parent = get(target.slice(0, -1));
      if (typeof parent === "object" && parent !== null) delete (parent as Record<PropertyKey, unknown>)[target[target.length - 1]!];
      tainted.push(target.map(String));
    }
    // In one pass: a splice for each bad item moved every item after it, the square of a long list.
    for (const [list, indexes] of dropped) {
      let kept = 0;
      for (let i = 0; i < list.length; i++) if (!indexes.has(i)) list[kept++] = list[i];
      list.length = kept;
    }
    issues = schemaIssues(copy);
  }
  return issues.length === 0 ? { file: copy as AutomationFileType, tainted } : undefined;
}

export interface Salvaged {
  readonly file: AutomationFileType;
  readonly tainted: ReadonlyArray<ReadonlyArray<string>>;
}

export interface ParsedAutomation {
  readonly file?: AutomationFileType;
  readonly diagnostics: Diagnostic[];
  /** Positions for later rules; absent when the YAML did not parse. */
  readonly source?: YamlSource;
  /** When the shape is wrong in places: what is left, for the rules across files only. Never run. */
  readonly salvaged?: Salvaged;
}

/** Parse and validate one automation file. `file` is set when its shape is valid. */
export function parseAutomationSource(file: SourceFile): ParsedAutomation {
  const hidden = hiddenCharacters(file.path, file.text);
  const source = new YamlSource(file.path, file.text);
  const syntax = source.syntaxDiagnostics();
  if (syntax.some((d) => d.severity === "error")) return { diagnostics: [...hidden, ...syntax] };
  const converted = source.toValue();
  if ("problem" in converted) return { diagnostics: [...hidden, ...syntax, converted.problem] };
  const value: unknown = converted.value ?? {};
  if (typeof value !== "object" || Array.isArray(value)) {
    return {
      diagnostics: [...hidden, ...syntax, diagnostic(file.path, source.at([]), "invalid-value", "An automation file is a map of keys like steps and on; start with steps:.")],
      source,
    };
  }
  const keys = keyDiagnostics(source);
  const issues = schemaIssues(value);
  const shape = schemaDiagnostics(source, value, issues, keys);
  const steps = (value as { steps?: unknown }).steps;
  if (typeof steps === "object" && steps !== null && Object.keys(steps).length === 0) {
    shape.push(diagnostic(file.path, source.at(["steps"], "key"), "steps-empty", "steps is empty; add a step, like  triage: { agent: triage }."));
  }
  const diagnostics = [...hidden, ...syntax, ...keys.diagnostics, ...shape];
  if (shape.length === 0 && keys.diagnostics.length === 0) return { file: value as AutomationFileType, diagnostics, source };
  const salvaged = shape.some((d) => d.code === "steps-empty") ? undefined : issues.length === 0 ? { file: value as AutomationFileType, tainted: [] } : salvage(value as object, issues);
  return { diagnostics, source, ...(salvaged ? { salvaged } : {}) };
}

export function parseAutomation(file: SourceFile): { readonly file?: AutomationFileType; readonly diagnostics: Diagnostic[] } {
  const { source: _source, ...parsed } = parseAutomationSource(file);
  return parsed;
}

// ------------------------------------------------------------ agent markdown

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const AGENT_KEYS = ["name", "description", "engine", "model", "effort", "tools", "disallowedTools", "decides", "returns", "isolation", "role", "computer"];
/** Claude Code reads these; Caveman does not. Listed by explain, never an error. */
const CLAUDE_ONLY_KEYS = ["hooks", "mcpServers", "permissionMode", "color", "maxTurns", "initialPrompt", "memory", "background"];
const NOT_APPLIED_KEYS = ["skills", "mcp", "secrets"];

const str = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
/** A list as Claude Code writes it: a YAML list or "Read, Grep". */
const list = (value: unknown): ReadonlyArray<string> | undefined => {
  const items = Array.isArray(value)
    ? value.filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.trim())
    : str(value)
        ?.split(",")
        .map((t) => t.trim())
        .filter(Boolean);
  return items && items.length > 0 ? items : undefined;
};
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");

const CUSTOM_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * The custom tools in an agent's `tools` list (entries `{type: custom, name, description, input_schema}`; the
 * names beside them are Claude-style tool names). A bad one is reported and left out.
 */
function customToolsOf(value: unknown, report: (message: string) => void): ReadonlyArray<CustomToolDecl> {
  if (!Array.isArray(value)) return [];
  const out: Array<CustomToolDecl> = [];
  for (const [i, entry] of value.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { type, name, description, input_schema: schema } = entry as Record<string, unknown>;
    const label = typeof name === "string" && name !== "" ? `Custom tool "${name}"` : `tools entry ${i + 1}`;
    if (type !== "custom") {
      report(`${label} has type ${JSON.stringify(type)}; the only tool type is custom.`);
      continue;
    }
    if (typeof name !== "string" || !CUSTOM_TOOL_NAME.test(name)) {
      report(`${label} needs a name of letters, digits, _ and - (at most 64), starting with a letter, like lookup_order.`);
      continue;
    }
    if (name.startsWith("mcp__")) {
      report(`${label} starts with mcp__, which names MCP servers' tools; pick another name.`);
      continue;
    }
    if (out.some((tool) => tool.name === name)) {
      report(`${label} is declared twice; keep one.`);
      continue;
    }
    if (description !== undefined && typeof description !== "string") {
      report(`${label} has a description that is not text.`);
      continue;
    }
    const objectSchema = schema !== null && typeof schema === "object" && !Array.isArray(schema) && ((schema as { type?: unknown }).type ?? "object") === "object";
    if (schema !== undefined && !objectSchema) {
      report(`${label} needs an input_schema that is a JSON Schema object (type: object, with properties).`);
      continue;
    }
    out.push({ name, description: description ?? "", input_schema: (schema as Record<string, unknown> | undefined) ?? { type: "object", properties: {} } });
  }
  return out;
}

const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,59}$/;
const stringRecord = (value: unknown): Record<string, string> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((v) => typeof v === "string")
    ? { ...(value as Record<string, string>) }
    : undefined;

/**
 * The inline servers of an agent's `mcpServers` (Claude Code's shape). A server this host cannot start is reported
 * and left out; the agent still loads. Claude's list form (names of servers configured elsewhere) yields none.
 */
function mcpServersOf(value: unknown, report: (message: string) => void): Readonly<Record<string, AgentMcpServer>> {
  if (value === undefined || Array.isArray(value)) return {};
  if (value === null || typeof value !== "object") {
    report("mcpServers is a map of server names to a command or a URL, like  cave: {command: node, args: [mcp.mjs]}.");
    return {};
  }
  const out: Record<string, AgentMcpServer> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!MCP_SERVER_NAME.test(name)) {
      report(`MCP server "${name}" needs a name of letters, digits, _ and - (at most 59).`);
      continue;
    }
    const server = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const type = typeof server.type === "string" ? server.type : typeof server.url === "string" ? "http" : "stdio";
    if (type === "stdio" && typeof server.command === "string" && server.command.trim() !== "") {
      const args = Array.isArray(server.args) && server.args.every((a) => typeof a === "string") ? (server.args as Array<string>) : [];
      const env = stringRecord(server.env);
      out[name] = { type: "stdio", command: server.command, args, ...(env ? { env } : {}), ...(typeof server.cwd === "string" ? { cwd: server.cwd } : {}) };
    } else if ((type === "http" || type === "streamable-http") && typeof server.url === "string") {
      const headers = stringRecord(server.headers);
      out[name] = { type: "http", url: server.url, ...(headers ? { headers } : {}) };
    } else {
      report(`MCP server "${name}" needs a command (a local server) or type: http with a url.`);
    }
  }
  return out;
}

/**
 * One agent markdown file: Claude-compatible frontmatter plus Caveman's keys
 * (engine, decides, returns). Lenient like Claude Code: a broken frontmatter
 * or a bad value is reported and read past, so the agent still loads. `agent`
 * is absent only when the file has no usable name.
 */
export function parseAgentFile(file: SourceFile, source: AgentSource): { readonly agent?: ParsedAgent; readonly diagnostics: Diagnostic[] } {
  const { yaml: _yaml, ...parsed } = parseAgentSource(file, source);
  return parsed;
}

/** parseAgentFile, plus the frontmatter's positions for later rules. */
export function parseAgentSource(
  file: SourceFile,
  source: AgentSource,
): { readonly agent?: ParsedAgent; readonly diagnostics: Diagnostic[]; readonly yaml?: YamlSource } {
  const diagnostics: Diagnostic[] = hiddenCharacters(file.path, file.text);
  const match = FRONTMATTER.exec(file.text);
  const body = match === null ? file.text : file.text.slice(match[0].length);
  let data: Record<string, unknown> = {};
  let yaml: YamlSource | undefined;
  if (match !== null) {
    yaml = new YamlSource(file.path, match[1] ?? "", 1);
    const syntax = yaml.syntaxDiagnostics();
    for (const d of syntax) diagnostics.push(d);
    const converted = syntax.some((d) => d.severity === "error") ? undefined : yaml.toValue();
    if (converted !== undefined && "problem" in converted) diagnostics.push(converted.problem);
    else if (typeof converted?.value === "object" && converted.value !== null && !Array.isArray(converted.value)) data = converted.value as Record<string, unknown>;
  }
  const at = (key: string, part: "key" | "value" = "value") => yaml?.at([key], part) ?? { line: 1, column: 1 };
  const report = (key: string, code: RuleCode, message: string, part: "key" | "value" = "value") => diagnostics.push(diagnostic(file.path, at(key, part), code, message));

  const name = str(data.name) ?? baseName(file.path);
  if (!AGENT_NAME_PATTERN.test(name)) {
    report("name", "agent-name-invalid", `Agent name "${name}" cannot load; use letters, digits, - and _ (at most 64), like code-reviewer.`);
    return { diagnostics, ...(yaml ? { yaml } : {}) };
  }

  const ignoredKeys: string[] = [];
  for (const key of Object.keys(data)) {
    if (AGENT_KEYS.includes(key)) continue;
    if (CLAUDE_ONLY_KEYS.includes(key)) ignoredKeys.push(key);
    else if (NOT_APPLIED_KEYS.includes(key)) report(key, "agent-key-not-applied", `${key} is reserved and not applied yet; this agent runs without it.`, "key");
    else report(key, "agent-unknown-key", `Unknown key "${key}"; Caveman and Claude Code both ignore it.${didYouMean(key, [...AGENT_KEYS, ...CLAUDE_ONLY_KEYS])}`, "key");
  }

  let engine = str(data.engine);
  if (data.engine !== undefined && (engine === undefined || !isEngine(engine))) {
    report("engine", "engine-unknown",
      engine === "claude-code"
        ? `engine "claude-code" is not an engine. Use "claude-agent".`
        : `engine ${JSON.stringify(data.engine)} is not an engine.${engine ? didYouMean(engine, ENGINES) : ""} Use ${quoteList([...ENGINES])}, or acp:<registry-id>.`);
    engine = undefined;
  }

  let decides = list(data.decides);
  if (decides !== undefined) {
    const bad = decides.filter((d) => !DECISION_PATTERN.test(d));
    const reserved = decides.filter((d) => (RESERVED_DECISIONS as ReadonlyArray<string>).includes(d));
    if (bad.length > 0) report("decides", "decides-invalid", `decides has ${quoteList(bad.map((b) => `"${b}"`), "and")}; use ${NAME_RULE}, like needs_info or needs-info.`);
    if (reserved.length > 0) report("decides", "decides-reserved", `decides lists ${quoteList(reserved, "and")}, which the runtime uses for step status; pick another word.`);
    decides = [...new Set(decides.filter((d) => DECISION_PATTERN.test(d) && !reserved.includes(d)))];
    if (decides.length === 0) decides = undefined;
  }

  const returns = str(data.returns);
  if (data.returns !== undefined && (returns === undefined || !returns.endsWith(".json"))) {
    report("returns", "returns-invalid", "returns is the path of a JSON Schema file next to the agent, like reviewer.schema.json.");
  }

  const role = str(data.role);
  if (role !== undefined && !(AGENT_ROLES as ReadonlyArray<string>).includes(role)) {
    report("role", "agent-role-unknown", `role "${role}" is not one Caveman knows; this agent counts as general. Use ${quoteList([...AGENT_ROLES])}.`);
  }

  // A bad model or effort is reported and dropped, like a bad engine: the agent runs on the engine's default
  // instead of failing every attempt.
  let model = str(data.model);
  if (data.model !== undefined && (model === undefined || !isAgentModel(model))) {
    report("model", "model-invalid",
      `model ${JSON.stringify(data.model)} is not a model Caveman knows, so this agent runs on the engine's default.${model ? didYouMean(model, [...STEP_MODELS, "inherit"]) : ""} Use auto, fast, base, frontier, inherit, haiku, sonnet, opus, a model id like claude-sonnet-5-5, or a pin like anthropic/claude-sonnet-5-5.`);
    model = undefined;
  }
  let effort = str(data.effort)?.toLowerCase();
  if (data.effort !== undefined && (effort === undefined || !(EFFORTS as ReadonlyArray<string>).includes(effort))) {
    report("effort", "agent-effort-unknown",
      `effort ${JSON.stringify(data.effort)} is not one Caveman knows, so this agent runs at the engine's default effort.${effort ? didYouMean(effort, EFFORTS) : ""} Use ${quoteList([...EFFORTS])}.`);
    effort = undefined;
  }
  // The values a step's computer takes; a bad one warns and is dropped (the agent gets the host's default), like a bad
  // model or effort, so an agent version that loaded before still loads.
  const computer = str(data.computer);
  if (data.computer !== undefined && (computer === undefined || !(COMPUTERS as ReadonlyArray<string>).includes(computer))) {
    report("computer", "agent-computer-invalid",
      `computer is ${JSON.stringify(data.computer)}, so this agent gets the host's default; use ${quoteList([...COMPUTERS])}.${computer ? didYouMean(computer, COMPUTERS) : ""}`);
  }
  const tools = list(data.tools);
  const disallowedTools = list(data.disallowedTools);
  const customTools = customToolsOf(data.tools, (message) => report("tools", "custom-tool-invalid", message));
  const mcpServers = mcpServersOf(data.mcpServers, (message) => report("mcpServers", "mcp-server-invalid", message));
  return {
    agent: {
      name,
      description: str(data.description) ?? "",
      ...(engine ? { engine } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(tools ? { tools } : {}),
      ...(disallowedTools ? { disallowedTools } : {}),
      ...(customTools.length > 0 ? { customTools } : {}),
      ...(decides ? { decides } : {}),
      ...(returns?.endsWith(".json") ? { returns } : {}),
      ...(str(data.isolation) === "worktree" ? { isolation: "worktree" as const } : {}),
      ...(role && (AGENT_ROLES as ReadonlyArray<string>).includes(role) ? { role: role as AgentRole } : {}),
      ...(computer && (COMPUTERS as ReadonlyArray<string>).includes(computer) ? { computer: computer as Computer } : {}),
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      source,
      path: file.path,
      instructions: body.trim(),
      ignoredKeys,
    },
    diagnostics,
    ...(yaml ? { yaml } : {}),
  };
}
