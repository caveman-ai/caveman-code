// What one Session Protocol connection still has to send, bounded however slowly its client reads.
//
// The socket's own buffer takes frames only up to a high-water mark (the writer waits for it to drain);
// past that, frames wait here, where they can still be merged or dropped:
// - a pushed state (a workspace, the Chief's board, engine.list's answer) replaces the same state still
//   waiting, so a slow client gets the latest one, once;
// - a terminal's output joins the output of that terminal still waiting, one frame however many chunks;
//   when one terminal has more waiting than `terminalMax`, it is dropped and a `term.resync` is sent
//   instead: the client re-attaches the terminal for its scrollback, and nothing more of that terminal
//   is queued for it until it does;
// - everything else (replies, a session's events) waits in order. When the whole queue passes `max`,
//   the client is too far behind to catch up frame by frame: the writer closes the connection, and the
//   client reconnects, re-attaches each session from the last cursor it has, and re-attaches its
//   terminals, as after any drop.
// This is upstream idea for its own transport (3284143b45 bounded terminal output for slow clients,
// 94827737ea coalesced queued shell updates), applied to ours.
import * as Effect from "effect/Effect";

export interface OutboxLimits {
  /** Bytes waiting in all past which the connection is closed. */
  readonly max: number;
  /** Bytes of one terminal's output waiting past which that terminal is resynced. */
  readonly terminalMax: number;
}

// media.read allows a 16 MiB raster: its base64 JSON reply is just over 21 MiB.
// Keep a finite queue large enough for one such reply; media reads are paced/serialized
// by the server so a gallery cannot enqueue several large replies at once.
export const DEFAULT_OUTBOX_LIMITS: OutboxLimits = { max: 32 * 1024 * 1024, terminalMax: 256 * 1024 };

type Entry =
  | { readonly kind: "frame"; frame: string; readonly key: string | undefined; dropped: boolean }
  | { readonly kind: "term"; readonly terminalId: string; data: string; dropped: boolean };

const sizeOf = (entry: Entry) => (entry.kind === "frame" ? entry.frame.length : entry.data.length + 64);

const termOutputFrame = (terminalId: string, data: string) =>
  JSON.stringify({ jsonrpc: "2.0", method: "term.output", params: { terminal_id: terminalId, data } });
const termResyncFrame = (terminalId: string) => JSON.stringify({ jsonrpc: "2.0", method: "term.resync", params: { terminal_id: terminalId } });

export interface OutboxStats {
  /** Bytes waiting now. */
  readonly bytes: number;
  /** Most bytes that ever waited at once. */
  readonly peakBytes: number;
  /** Frames waiting now. */
  readonly frames: number;
  /** Frames a newer state or more output took the place of. */
  readonly merged: number;
  /** Terminal resyncs sent instead of output. */
  readonly resyncs: number;
}

export class Outbox {
  private queue: Array<Entry> = [];
  private head = 0;
  private bytes = 0;
  private peak = 0;
  private live = 0;
  private merged = 0;
  private resyncs = 0;
  /** The waiting entry of each pushed state. */
  private readonly latest = new Map<string, Entry>();
  /** Each terminal's output entry still open to more output. */
  private readonly openTerm = new Map<string, Extract<Entry, { kind: "term" }>>();
  /** Bytes of each terminal's output waiting. */
  private readonly termBytes = new Map<string, number>();
  /** Terminals a resync was queued for: their output is not queued until the client re-attaches. */
  private readonly resyncing = new Set<string>();
  /** Called once when more than `limits.max` waits (server.ts closes the connection). */
  onOverflow: (() => void) | undefined;
  private wake: (() => void) | undefined;
  private readonly drainWaiters: Array<{ readonly below: number; readonly resume: () => void }> = [];
  private closed = false;

  readonly limits: OutboxLimits;

  constructor(limits: OutboxLimits = DEFAULT_OUTBOX_LIMITS) {
    this.limits = limits;
  }

  /** A frame that must arrive, in order: a reply, a session's events. */
  push(frame: string): void {
    this.append({ kind: "frame", frame, key: undefined, dropped: false });
  }

  /** A state the client only needs the newest of: replaces the same `key` still waiting. */
  pushLatest(key: string, frame: string): void {
    const previous = this.latest.get(key);
    if (previous !== undefined) this.drop(previous);
    const entry: Entry = { kind: "frame", frame, key, dropped: false };
    this.latest.set(key, entry);
    this.append(entry);
  }

  /** Output of one terminal: joins its output still waiting; past `terminalMax`, the terminal is resynced. */
  pushTerminalOutput(terminalId: string, data: string): void {
    if (data === "" || this.resyncing.has(terminalId)) return;
    // Counted before it is queued: a writer waiting takes a new entry at once, and releasing it subtracts this.
    const waiting = (this.termBytes.get(terminalId) ?? 0) + data.length;
    this.termBytes.set(terminalId, waiting);
    const open = this.openTerm.get(terminalId);
    if (open !== undefined && !open.dropped) {
      open.data += data;
      this.grow(data.length);
      this.merged += 1;
    } else {
      const entry: Extract<Entry, { kind: "term" }> = { kind: "term", terminalId, data, dropped: false };
      this.openTerm.set(terminalId, entry);
      this.append(entry);
    }
    if ((this.termBytes.get(terminalId) ?? 0) > this.limits.terminalMax) this.resync(terminalId);
  }

  /** A terminal frame that ends its output (term.exit): output after it is a new frame. */
  pushTerminalFrame(terminalId: string, frame: string): void {
    this.openTerm.delete(terminalId);
    this.push(frame);
  }

  /** The client re-attached the terminal: its output is queued again. */
  resumeTerminal(terminalId: string): void {
    this.resyncing.delete(terminalId);
  }

  /** The client is too far behind to catch up frame by frame. */
  get overflowed(): boolean {
    return this.bytes > this.limits.max;
  }

  /** Frames waiting (screencasts skip a frame while more than a few wait). */
  size(): number {
    return this.live;
  }

  stats(): OutboxStats {
    return { bytes: this.bytes, peakBytes: this.peak, frames: this.live, merged: this.merged, resyncs: this.resyncs };
  }

  /** The next frame to write, waiting for one. */
  readonly take: Effect.Effect<string> = Effect.callback<string>((resume) => {
    const frame = this.shift();
    if (frame !== undefined) return resume(Effect.succeed(frame));
    this.wake = () => {
      const next = this.shift();
      if (next === undefined) return;
      this.wake = undefined;
      resume(Effect.succeed(next));
    };
    return Effect.sync(() => {
      this.wake = undefined;
    });
  });

  /** Waits until at most `bytes` wait: a producer that can pace itself (a backlog read) does. */
  awaitBelow(bytes: number): Effect.Effect<void> {
    return Effect.callback<void>((resume) => {
      if (this.closed || this.bytes <= bytes) return resume(Effect.void);
      const waiter = { below: bytes, resume: () => resume(Effect.void) };
      this.drainWaiters.push(waiter);
      return Effect.sync(() => {
        const at = this.drainWaiters.indexOf(waiter);
        if (at >= 0) this.drainWaiters.splice(at, 1);
      });
    });
  }

  /** The connection ended: nothing more is queued and every waiter goes on. */
  close(): void {
    this.closed = true;
    this.queue = [];
    this.head = 0;
    this.bytes = 0;
    this.live = 0;
    this.latest.clear();
    this.openTerm.clear();
    this.termBytes.clear();
    for (const waiter of this.drainWaiters.splice(0)) waiter.resume();
  }

  private resync(terminalId: string): void {
    this.resyncing.add(terminalId);
    // Releasing bytes resumes drain waiters synchronously: one can append and compact this.queue.
    // Walk a stable snapshot so every old terminal entry is dropped, even across that compaction.
    for (const entry of this.queue.slice(this.head)) {
      if (entry.kind === "term" && entry.terminalId === terminalId) this.drop(entry);
    }
    this.openTerm.delete(terminalId);
    this.termBytes.delete(terminalId);
    this.resyncs += 1;
    this.append({ kind: "frame", frame: termResyncFrame(terminalId), key: undefined, dropped: false });
  }

  private append(entry: Entry): void {
    if (this.closed) return;
    // A stalled writer never shifts tombstones. Bound their metadata as well as the live payloads.
    const pending = this.queue.length - this.head;
    if (pending > 1024 && pending > this.live * 2) {
      this.queue = this.queue.slice(this.head).filter((queued) => !queued.dropped);
      this.head = 0;
    }
    this.queue.push(entry);
    this.live += 1;
    this.grow(sizeOf(entry));
    this.wake?.();
  }

  private grow(bytes: number): void {
    this.bytes += bytes;
    if (this.bytes > this.peak) this.peak = this.bytes;
    if (this.bytes > this.limits.max && this.onOverflow !== undefined) {
      const overflow = this.onOverflow;
      this.onOverflow = undefined;
      overflow();
    }
  }

  private drop(entry: Entry): void {
    if (entry.dropped) return;
    entry.dropped = true;
    this.live -= 1;
    this.merged += 1;
    this.release(entry);
    // Accounting alone does not release the string: the queue can retain this tombstone indefinitely.
    if (entry.kind === "frame") entry.frame = "";
    else entry.data = "";
  }

  private release(entry: Entry): void {
    this.bytes -= sizeOf(entry);
    if (entry.kind === "frame") {
      if (entry.key !== undefined && this.latest.get(entry.key) === entry) this.latest.delete(entry.key);
    } else {
      if (this.openTerm.get(entry.terminalId) === entry) this.openTerm.delete(entry.terminalId);
      const waiting = (this.termBytes.get(entry.terminalId) ?? 0) - entry.data.length;
      if (waiting > 0) this.termBytes.set(entry.terminalId, waiting);
      else this.termBytes.delete(entry.terminalId);
    }
    if (this.drainWaiters.length > 0) {
      for (let at = this.drainWaiters.length - 1; at >= 0; at--) {
        const waiter = this.drainWaiters[at]!;
        if (this.bytes <= waiter.below) {
          this.drainWaiters.splice(at, 1);
          waiter.resume();
        }
      }
    }
  }

  private shift(): string | undefined {
    while (this.head < this.queue.length) {
      const entry = this.queue[this.head]!;
      this.queue[this.head] = undefined as never;
      this.head += 1;
      if (this.head > 1024 && this.head * 2 > this.queue.length) {
        this.queue = this.queue.slice(this.head);
        this.head = 0;
      }
      if (entry.dropped) continue;
      this.live -= 1;
      this.release(entry);
      return entry.kind === "frame" ? entry.frame : termOutputFrame(entry.terminalId, entry.data);
    }
    return undefined;
  }
}
