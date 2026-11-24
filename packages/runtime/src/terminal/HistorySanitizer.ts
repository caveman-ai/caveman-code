// The query policy (shouldStrip*Sequence) is ),
// apps/server/src/terminal/Manager.ts @ ab3a3cd1; the parser around it is ours.
/**
 * Keeps terminal queries and replies out of terminal history.
 *
 * A client replays history in xterm.js when it attaches. A query stored there (a
 * cursor position or device attributes request, a color query) is answered again
 * on every replay, and the shell takes the answer as typed input: junk such as
 * ^[[12;1R at the prompt.
 *
 * The sanitizer reads output with the state machine of xterm.js's parser (the
 * VT500 table in its EscapeSequenceParser), so that history replays as the output
 * did, less the queries. Where taking a sequence out would change how xterm.js
 * reads what is left, history drops or closes the sequence around it.
 *
 * @module HistorySanitizer
 */

type ParserState =
  | "ground"
  | "escape"
  | "escapeIntermediate"
  | "csiEntry"
  | "csiParam"
  | "csiIntermediate"
  | "csiIgnore"
  | "oscString"
  | "dcsEntry"
  | "dcsParam"
  | "dcsIntermediate"
  | "dcsIgnore"
  | "dcsPassthrough"
  | "sosPmApcString";

type StringState = Extract<
  ParserState,
  | "oscString"
  | "dcsEntry"
  | "dcsParam"
  | "dcsIntermediate"
  | "dcsIgnore"
  | "dcsPassthrough"
  | "sosPmApcString"
>;

export function shouldStripCsiSequence(body: string, finalByte: string): boolean {
  if (finalByte === "n") {
    return true;
  }
  if (finalByte === "R" && /^[0-9;?]*$/.test(body)) {
    return true;
  }
  if (finalByte === "c" && /^[>0-9;?]*$/.test(body)) {
    return true;
  }
  // DECRQM mode queries (…$p) and DECRPM replies (…$y): replaying a stored
  // query makes the terminal answer again, and the shell echoes the answer as
  // junk at the prompt. The `$` guard keeps setters like DECSTR (!p) and
  // DECSCL ("p) intact.
  if ((finalByte === "p" || finalByte === "y") && /^[0-9;?]*\$$/.test(body)) {
    return true;
  }
  // XTVERSION query (>q). DECSCUSR (space-intermediate q) stays.
  if (finalByte === "q" && /^>[0-9;]*$/.test(body)) {
    return true;
  }
  // Kitty keyboard protocol query/reply (?u). Restore-cursor (bare u) stays.
  if (finalByte === "u" && body.startsWith("?")) {
    return true;
  }
  return false;
}

// DECRQSS ($q) and XTGETTCAP (+q) queries plus their replies ([01]$r / [01]+r):
// pure request/response traffic with no visual value, and replaying a stored
// query triggers a fresh reply.
export function shouldStripDcsSequence(content: string): boolean {
  return /^[01]?[$+][qr]/.test(content);
}

export function shouldStripOscSequence(content: string): boolean {
  return /^(10|11|12);(?:\?|rgb:)/.test(content);
}

// The longest content the two string policies above read.
const OSC_QUERY_PREFIX_LENGTH = "12;rgb:".length;
const DCS_QUERY_PREFIX_LENGTH = "1$q".length;

// Only short queries are stripped. A longer unfinished sequence is not held while
// a terminator may never come.
const MAX_HELD_LENGTH = 64 * 1024;

// ESC \ ends a string with success, as the ESC it stands in for did.
const STRING_TERMINATOR = "\u001b\\";
// CAN ends a string without running it, as the C1 control it stands in for did.
const CANCEL = "\u0018";

// eslint-disable-next-line no-control-regex -- Terminal sequence introducers must reach the parser.
const SEQUENCE_START = /[\u001b\u0090\u0098\u009b\u009d\u009e\u009f]/;
const NEXT_SEQUENCE_START = new RegExp(SEQUENCE_START.source, "g");

// The bytes that can end the string xterm.js is in. It reads every other byte as
// part of the string, so a decided string is copied or skipped up to the next one.
const STRING_END: Partial<Record<ParserState, RegExp>> = {
  // eslint-disable-next-line no-control-regex -- The bytes that end a string are controls.
  oscString: /[\u0007\u0018\u001a\u001b\u0080-\u009f]/g,
  // eslint-disable-next-line no-control-regex -- The bytes that end a string are controls.
  dcsPassthrough: /[\u0018\u001a\u001b\u0080-\u009f]/g,
  // eslint-disable-next-line no-control-regex -- The bytes that end a string are controls.
  dcsIgnore: /[\u0018\u001a\u001b\u0080-\u009f]/g,
  // A non-ASCII character also ends an SOS, PM or APC string, as an error.
  // eslint-disable-next-line no-control-regex -- The bytes that end a string are controls.
  sosPmApcString: /[\u0018\u001a\u001b\u0080-\uffff]/g,
};

function isStringState(state: ParserState): state is StringState {
  return (
    state === "oscString" ||
    state === "sosPmApcString" ||
    state === "dcsEntry" ||
    state === "dcsParam" ||
    state === "dcsIntermediate" ||
    state === "dcsIgnore" ||
    state === "dcsPassthrough"
  );
}

// C0 controls xterm.js runs without leaving the escape or CSI sequence they sit in.
function isExecutable(code: number): boolean {
  return code <= 0x17 || code === 0x19 || (code >= 0x1c && code <= 0x1f);
}

// ESC and the C1 introducers abandon any sequence xterm.js is in and start their own.
function startsSequence(code: number): boolean {
  return (
    code === 0x1b ||
    code === 0x90 ||
    code === 0x98 ||
    code === 0x9b ||
    (code >= 0x9d && code <= 0x9f)
  );
}

// CAN, SUB and the other C1 controls end any sequence on their own byte.
function endsSequence(code: number): boolean {
  return code === 0x18 || code === 0x1a || (code >= 0x80 && code <= 0x9f && !startsSequence(code));
}

function nextCsiState(state: ParserState, code: number): ParserState {
  if (code <= 0x2f) return "csiIntermediate";
  if (state === "csiIntermediate") return "csiIgnore";
  // A private prefix (<, =, > or ?) is only read first.
  if (code >= 0x3c && state === "csiParam") return "csiIgnore";
  return "csiParam";
}

function nextDcsState(state: ParserState, code: number): ParserState {
  if (code >= 0x40) return "dcsPassthrough";
  if (code <= 0x2f) return "dcsIntermediate";
  if (state === "dcsIntermediate") return "dcsIgnore";
  if (code >= 0x3c && state === "dcsParam") return "dcsIgnore";
  return "dcsParam";
}

/**
 * Takes a terminal's output chunk by chunk and returns what history keeps of it.
 * It holds the bytes of a sequence it has not yet decided on across chunks.
 */
export class TerminalHistorySanitizer {
  private state: ParserState = "ground";
  // The current sequence's bytes, until history decides whether to keep it.
  private held = "";
  // The controls xterm.js has run inside the current sequence. They stay in
  // history when the sequence goes.
  private executed = "";
  // The current sequence as xterm.js reads it: a CSI's parameter and intermediate
  // bytes, or the start of an OSC or DCS string's content.
  private body = "";
  private fate: "undecided" | "keep" | "strip" = "undecided";
  // The ESC that started the current escape sequence ended a string history stripped.
  private afterStrippedString = false;
  // Ends a string history kept whose terminator, the ESC or C1 control that started
  // the next sequence, left history with that sequence.
  private closer = "";
  private output = "";

  sanitize(data: string): string {
    if (this.state === "ground" && !SEQUENCE_START.test(data)) {
      return data;
    }
    let index = 0;
    while (index < data.length) {
      index = this.state === "ground" ? this.readText(data, index) : this.readSequence(data, index);
    }
    // A client can attach before the next chunk comes. History must not leave a
    // string open there that the output had already ended.
    if (this.state === "ground") this.flushCloser();
    return this.takeOutput();
  }

  /**
   * Ends the output. An unfinished sequence never completes, so history keeps only
   * the controls xterm.js ran in it, and ends a string it holds open.
   */
  finish(): string {
    if (this.state !== "ground") {
      if (this.fate === "undecided") this.emit(this.executed);
      else if (this.fate === "keep") this.emit(CANCEL);
    }
    this.flushCloser();
    this.state = "ground";
    this.held = "";
    this.executed = "";
    this.body = "";
    this.fate = "undecided";
    this.afterStrippedString = false;
    return this.takeOutput();
  }

  private takeOutput(): string {
    const output = this.output;
    this.output = "";
    return output;
  }

  private emit(text: string): void {
    if (text.length === 0) return;
    if (this.closer.length > 0) {
      const code = text.charCodeAt(0);
      // The text itself ends the string the way the sequence that left did: an ESC
      // with success, a C1 control other than ST by abandoning it.
      const endsAlike =
        this.closer === STRING_TERMINATOR
          ? code === 0x1b
          : code >= 0x80 && code <= 0x9f && code !== 0x9c;
      if (!endsAlike) this.output += this.closer;
      this.closer = "";
    }
    this.output += text;
  }

  private flushCloser(): void {
    this.output += this.closer;
    this.closer = "";
  }

  private readText(data: string, index: number): number {
    NEXT_SEQUENCE_START.lastIndex = index;
    const start = NEXT_SEQUENCE_START.exec(data)?.index ?? data.length;
    this.emit(data.slice(index, start));
    if (start === data.length) return start;
    this.begin(data.charCodeAt(start), data.charAt(start));
    return start + 1;
  }

  private begin(code: number, character: string): void {
    this.held = character;
    this.executed = "";
    this.body = "";
    this.fate = "undecided";
    this.afterStrippedString = false;
    if (code === 0x1b) {
      this.state = "escape";
    } else if (code === 0x9b) {
      this.state = "csiEntry";
    } else if (code === 0x9d) {
      this.state = "oscString";
    } else if (code === 0x90) {
      this.state = "dcsEntry";
    } else {
      this.state = "sosPmApcString";
      this.decide(true);
    }
  }

  private readSequence(data: string, index: number): number {
    const stringEnd = this.fate === "undecided" ? undefined : STRING_END[this.state];
    if (stringEnd !== undefined) {
      stringEnd.lastIndex = index;
      const end = stringEnd.exec(data)?.index ?? data.length;
      if (end > index) {
        if (this.fate === "keep") this.emit(data.slice(index, end));
        return end;
      }
    }
    const code = data.charCodeAt(index);
    const character = data.charAt(index);
    if (isStringState(this.state)) {
      this.readStringByte(code, character);
    } else {
      this.readControlByte(code, character);
    }
    return index + 1;
  }

  // One byte of an escape or CSI sequence.
  private readControlByte(code: number, character: string): void {
    if (startsSequence(code)) {
      // xterm.js drops a sequence another one cuts short. History drops it too, so
      // that it cannot swallow what follows once that sequence is stripped.
      this.emit(this.executed);
      this.begin(code, character);
      return;
    }
    if (endsSequence(code)) return this.endControlSequence(character, true);
    if (isExecutable(code)) return this.run(character);
    if (code === 0x7f) return this.hold(character, false);
    if (code >= 0xa0) {
      // An error: xterm.js drops the sequence and the character with it, except in
      // a CSI it is already ignoring.
      if (this.state === "csiIgnore") return this.hold(character, false);
      return this.endControlSequence(character, false);
    }
    switch (this.state) {
      case "escape":
        if (code <= 0x2f) {
          this.hold(character, false);
          this.state = "escapeIntermediate";
        } else if (code === 0x5b) {
          this.hold(character, false);
          this.state = "csiEntry";
        } else if (code === 0x5d) {
          this.hold(character, false);
          this.state = "oscString";
        } else if (code === 0x50) {
          this.hold(character, false);
          this.state = "dcsEntry";
        } else if (code === 0x58 || code === 0x5e || code === 0x5f) {
          this.hold(character, false);
          this.state = "sosPmApcString";
          if (this.fate === "undecided") this.decide(true);
        } else {
          this.dispatchEscape(code, character);
        }
        return;
      case "escapeIntermediate":
        if (code <= 0x2f) return this.hold(character, false);
        return this.dispatchEscape(code, character);
      case "csiIgnore":
        if (code >= 0x40) return this.endControlSequence(character, false);
        return this.hold(character, false);
      default:
        if (code >= 0x40) return this.dispatchCsi(character);
        this.hold(character, true);
        this.state = nextCsiState(this.state, code);
    }
  }

  // One byte of an OSC, DCS, SOS, PM or APC string.
  private readStringByte(code: number, character: string): void {
    if (code === 0x1b) {
      const kept = this.endString();
      if (kept) this.closer = STRING_TERMINATOR;
      this.begin(code, character);
      this.afterStrippedString = !kept;
      return;
    }
    if (startsSequence(code)) {
      if (this.endString()) this.closer = CANCEL;
      this.begin(code, character);
      return;
    }
    if (code === 0x18 || code === 0x1a || code === 0x9c) return this.endStringWith(character);
    if (code >= 0x80 && code <= 0x9f) {
      // xterm.js abandons the string and runs the control as text.
      this.endString();
      this.emit(character);
      this.state = "ground";
      return;
    }
    switch (this.state) {
      case "oscString":
        if (code === 0x07) return this.endStringWith(character);
        return this.put(character, code >= 0x20);
      case "dcsPassthrough":
        return this.put(character, code !== 0x7f);
      case "dcsIgnore":
        return this.put(character, false);
      case "sosPmApcString":
        if (code >= 0xa0) return this.endStringWith(character);
        return this.put(character, false);
      default:
        if (code < 0x20 || code === 0x7f) return this.put(character, false);
        if (code >= 0xa0) return this.endStringWith(character);
        this.put(character, true);
        this.state = nextDcsState(this.state, code);
    }
  }

  // xterm.js runs the control and stays in the sequence.
  private run(character: string): void {
    if (this.fate === "strip") return this.emit(character);
    this.executed += character;
    this.hold(character, false);
  }

  private hold(character: string, inBody: boolean): void {
    if (this.fate !== "undecided") return;
    this.held += character;
    if (inBody) this.body += character;
    if (this.held.length <= MAX_HELD_LENGTH) return;
    if (isStringState(this.state)) return this.decide(true);
    // A control sequence this long is no query, and holding it has no end. History
    // drops it and keeps what xterm.js runs in it.
    this.emit(this.executed);
    this.fate = "strip";
    this.held = "";
    this.executed = "";
    this.body = "";
  }

  private put(character: string, inContent: boolean): void {
    if (this.fate === "keep") return this.emit(character);
    if (this.fate === "strip") return;
    this.hold(character, inContent);
    const decisionLength =
      this.state === "oscString" ? OSC_QUERY_PREFIX_LENGTH : DCS_QUERY_PREFIX_LENGTH;
    if (this.fate === "undecided" && this.body.length >= decisionLength) {
      this.decide(!this.isQuery());
    }
  }

  private decide(keep: boolean): void {
    this.fate = keep ? "keep" : "strip";
    this.emit(keep ? this.held : this.executed);
    this.held = "";
    this.executed = "";
  }

  private isQuery(): boolean {
    if (this.state === "oscString") return shouldStripOscSequence(this.body);
    if (this.state === "sosPmApcString") return false;
    return shouldStripDcsSequence(this.body);
  }

  private dispatchEscape(code: number, character: string): void {
    // ESC \ straight after a string is that string's terminator, and goes with it.
    const endsStrippedString = this.afterStrippedString && code === 0x5c && this.held === "\u001b";
    if (this.fate !== "strip" && !endsStrippedString) this.emit(this.held + character);
    this.state = "ground";
  }

  private dispatchCsi(character: string): void {
    if (this.fate !== "strip") {
      const strip = shouldStripCsiSequence(this.body, character);
      this.emit(strip ? this.executed : this.held + character);
    }
    this.state = "ground";
  }

  // The sequence ends on this byte, which xterm.js runs (CAN, SUB, a C1 control),
  // ignores (ST, or the final byte of an ignored CSI) or drops with it (an error).
  private endControlSequence(character: string, runs: boolean): void {
    if (this.fate !== "strip") {
      this.emit(this.held + character);
    } else if (runs) {
      this.emit(character);
    }
    this.state = "ground";
  }

  // Returns whether history keeps the string that ends here.
  private endString(): boolean {
    if (this.fate === "undecided") this.decide(!this.isQuery());
    return this.fate === "keep";
  }

  // The string ends on this byte, which goes with it.
  private endStringWith(character: string): void {
    if (this.endString()) this.emit(character);
    this.state = "ground";
  }
}
