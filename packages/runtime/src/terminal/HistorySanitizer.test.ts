import * as NodeModule from "node:module";

import { expect, it } from "vitest";

import {
  TerminalHistorySanitizer,
  shouldStripCsiSequence,
  shouldStripDcsSequence,
  shouldStripOscSequence,
} from "./HistorySanitizer.ts";

// History replays in xterm.js, the web client's terminal, so xterm.js's own parser
// is the judge: replayed, history must do what the output did, less the queries.
// The parser is internal to xterm.js; a fresh one is built from the class a
// Terminal uses, so it runs with xterm.js's own transition table.
interface XtermParams {
  toArray(): Array<number | Array<number>>;
}

interface XtermParser {
  setPrintHandler(handler: (data: Uint32Array, start: number, end: number) => void): void;
  setExecuteHandlerFallback(handler: (code: number) => void): void;
  setCsiHandlerFallback(handler: (ident: number, params: XtermParams) => void): void;
  setEscHandlerFallback(handler: (ident: number) => void): void;
  setOscHandlerFallback(
    handler: (id: number, action: "START" | "PUT" | "END", data?: string | boolean) => void,
  ): void;
  setDcsHandlerFallback(
    handler: (
      ident: number,
      action: "HOOK" | "PUT" | "UNHOOK",
      payload?: XtermParams | string | boolean,
    ) => void,
  ): void;
  identToString(ident: number): string;
  parse(data: Uint32Array, length: number): void;
}

// xterm.js's typings reference the DOM library, which the runtime does not build
// against, so only the shape used here is typed.
const requireCjs = NodeModule.createRequire(import.meta.url);
const {
  Terminal,
}: {
  Terminal: new () => {
    _core: { _inputHandler: { _parser: { constructor: new () => XtermParser } } };
    dispose(): void;
  };
} = requireCjs("@xterm/xterm");
const terminal = new Terminal();
const XtermEscapeSequenceParser = terminal._core._inputHandler._parser.constructor;
terminal.dispose();

interface ReplayedAction {
  readonly kind: "print" | "execute" | "esc" | "csi" | "osc" | "dcs";
  value: string;
  readonly query?: boolean;
}

const paramsText = (params: XtermParams) =>
  params
    .toArray()
    .map((param) => (Array.isArray(param) ? param.join(":") : String(param)))
    .join(";");

// What xterm.js does with `text`, judged by what its handlers act on: print runs are
// merged however the chunks split them, and an OSC or DCS string counts once, when
// it ends with success. ESC \ on its own, CAN and SUB do nothing in xterm.js; history
// writes ESC \ and CAN to end strings it would otherwise leave open.
function replay(text: string): Array<ReplayedAction> {
  const parser = new XtermEscapeSequenceParser();
  const actions: Array<ReplayedAction> = [];
  const push = (action: ReplayedAction) => {
    const last = actions.at(-1);
    if (action.kind === "print" && last?.kind === "print") last.value += action.value;
    else actions.push(action);
  };
  let osc = { id: 0, data: "" };
  let dcs = { head: "", data: "" };
  parser.setPrintHandler((data, start, end) =>
    push({ kind: "print", value: String.fromCodePoint(...data.subarray(start, end)) }),
  );
  parser.setExecuteHandlerFallback((code) => {
    if (code !== 0x18 && code !== 0x1a) push({ kind: "execute", value: String(code) });
  });
  parser.setEscHandlerFallback((ident) => {
    const sequence = parser.identToString(ident);
    if (sequence !== "\\") push({ kind: "esc", value: sequence });
  });
  parser.setCsiHandlerFallback((ident, params) => {
    const sequence = parser.identToString(ident);
    const prefix = /^[<=>?]/.test(sequence) ? sequence.charAt(0) : "";
    const intermediates = sequence.slice(prefix.length, -1);
    const body = prefix + paramsText(params) + intermediates;
    push({
      kind: "csi",
      value: `${body}${sequence.at(-1)}`,
      query: shouldStripCsiSequence(body, sequence.at(-1) ?? ""),
    });
  });
  parser.setOscHandlerFallback((id, action, data) => {
    if (action === "START") osc = { id, data: "" };
    if (action === "PUT") osc.data += String(data);
    if (action === "END" && data === true) {
      const content = `${osc.id};${osc.data}`;
      push({ kind: "osc", value: content, query: shouldStripOscSequence(content) });
    }
  });
  parser.setDcsHandlerFallback((ident, action, payload) => {
    if (action === "HOOK") {
      dcs = { head: paramsText(payload as XtermParams) + parser.identToString(ident), data: "" };
    }
    if (action === "PUT") dcs.data += String(payload);
    if (action === "UNHOOK" && payload === true) {
      const content = dcs.head + dcs.data;
      push({ kind: "dcs", value: content, query: shouldStripDcsSequence(content) });
    }
  });
  const codePoints = Uint32Array.from(text, (character) => character.codePointAt(0) ?? 0);
  parser.parse(codePoints, codePoints.length);
  return actions;
}

const withoutQueries = (actions: Array<ReplayedAction>) => {
  const kept: Array<ReplayedAction> = [];
  for (const action of actions) {
    const last = kept.at(-1);
    if (action.query) continue;
    if (action.kind === "print" && last?.kind === "print") last.value += action.value;
    else kept.push({ ...action });
  }
  return kept;
};

const TOKENS = [
  // Text, including bytes that would finish a sequence cut short before them.
  ...["A", "d", "text", "é", "🙂", "(", " ", "[", "]", "\\", "?", "6n", "u", "P", "X", "_"],
  // C0 and C1 controls.
  ...["\r", "\n", "\u0007", "\u007f", "\u0018", "\u001a", "\u009c", "\u0085", "\u0000"],
  ...["\u009b", "\u009d", "\u0090", "\u0098", "\u009e", "\u009f"],
  // Sequences cut off by whatever comes next.
  ...["\u001b", "\u001b(", "\u001b#", "\u001b ", "\u001b\r", "\u001b[", "\u001b[1", "\u001b[?"],
  ...["\u001b[1;", "\u001b[1?", "\u001b[ ", "\u001b]", "\u001b]0;", "\u001b]1", "\u001bP"],
  ...["\u001bP1", "\u001bX", "\u001b^", "\u001b_"],
  // Sequences history keeps.
  ...["\u001b[1m", "\u001b[?2004h", "\u001b]0;t\u0007", "\u001b]0;title text here\u0007"],
  ...["\u001b]8;;u\u001b\\", "\u001bM", "\u001b(B", "\u001b[!p", "\u001b[4 q", "\u001b[u"],
  ...["\u001bPq#0\u001b\\", "\u001b_Gf\u001b\\", "\u001b\\"],
  // Queries and replies history strips.
  ...["\u001b[6n", "\u009b6n", "\u001b[c", "\u001b[>c", "\u001b[?2026$p", "\u001b[>q"],
  ...["\u001b[?u", "\u001b[12;1R", "\u001b[?1;2$y", "\u001b]11;?\u0007", "\u001b\r]11;?\u0007"],
  ...["\u001b]10;rgb:0/0/0\u001b\\", "\u009d11;?\u009c", "\u001bP$q m\u001b\\", "\u0090$q\u009c"],
  ...["\u001bP1$r0m\u001b\\", "\u001b\nP+q544e\u001b\\", "\u001bP+q\u0007"],
];

it("replays in xterm.js as the output did, less its queries, however the output is chunked", () => {
  let seed = 0x5eed;
  const random = (below: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return Math.floor((seed / 0x80000000) * below);
  };
  const failures: Array<{ output: string; history: string }> = [];
  for (let run = 0; run < 10_000; run += 1) {
    let output = "";
    for (let count = 1 + random(10); count > 0; count -= 1) output += TOKENS[random(TOKENS.length)];
    output += "end";
    const sanitizer = new TerminalHistorySanitizer();
    let history = "";
    for (let offset = 0; offset < output.length;) {
      const size = 1 + random(6);
      history += sanitizer.sanitize(output.slice(offset, offset + size));
      offset += size;
    }
    history += sanitizer.finish();
    const replayed = replay(history);
    const expected = withoutQueries(replay(output));
    if (JSON.stringify(replayed) !== JSON.stringify(expected)) {
      failures.push({ output: JSON.stringify(output), history: JSON.stringify(history) });
    }
  }
  expect({ failing: failures.length, first: failures.slice(0, 3) }).toEqual({
    failing: 0,
    first: [],
  });
});
