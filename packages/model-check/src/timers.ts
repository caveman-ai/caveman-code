/**
 * A deterministic clock and timer queue for promise code (the client paths have no Effect). Zero-delay timers are
 * macrotasks and run when the system settles; delayed timers fire only when the checker advances the clock, so
 * "advance to the next timer" is an action like any other.
 */
import { settle } from "./gates.ts";

interface Timer {
  readonly id: number;
  readonly at: number;
  readonly every: number | undefined;
  readonly fn: () => void;
}

let installed: object | undefined;

export class VirtualTimers {
  private timers: Array<Timer> = [];
  private macrotasks: Array<Timer> = [];
  private nextId = 1;
  private activity = 0;
  now: number;

  constructor(start = 0) {
    this.now = start;
  }

  readonly setTimeout = (
    fn: (...args: Array<any>) => void,
    delay = 0,
    ...args: Array<any>
  ): number => this.schedule(() => fn(...args), delay, undefined);

  readonly setInterval = (
    fn: (...args: Array<any>) => void,
    delay = 0,
    ...args: Array<any>
  ): number => this.schedule(() => fn(...args), delay, Math.max(1, delay));

  readonly clearTimeout = (id: number | undefined): void => {
    this.timers = this.timers.filter((timer) => timer.id !== id);
    this.macrotasks = this.macrotasks.filter((timer) => timer.id !== id);
  };

  readonly clearInterval = this.clearTimeout;

  readonly dateNow = (): number => this.now;

  /** Delayed timers, earliest first. */
  pending(): ReadonlyArray<{ readonly id: number; readonly at: number }> {
    return this.timers.map(({ id, at }) => ({ id, at }));
  }

  nextAt(): number | undefined {
    return this.timers[0]?.at;
  }

  /** Moves the clock to the earliest timer, fires it and settles; false when no timer is pending. */
  async advanceToNext(): Promise<boolean> {
    const timer = this.timers.shift();
    if (timer === undefined) return false;
    this.now = Math.max(this.now, timer.at);
    this.fire(timer);
    await this.settle();
    return true;
  }

  /** Moves the clock forward, firing every timer that comes due in order, each one settled before the next. */
  async advanceBy(ms: number): Promise<void> {
    const until = this.now + ms;
    while (this.timers[0] !== undefined && this.timers[0].at <= until) await this.advanceToNext();
    this.now = until;
    await this.settle();
  }

  /** Runs macrotasks and microtasks until nothing is queued. Delayed timers do not fire. */
  async settle(): Promise<void> {
    await settle(() => {
      const task = this.macrotasks.shift();
      if (task) this.fire(task);
      return `${this.activity}:${this.macrotasks.length}`;
    });
  }

  /**
   * Points the globals at this queue; the returned function restores them. Throws while another install still owns
   * them: two clocks on the same globals each take the other's timers, and each restore puts back the other's.
   */
  install(): () => void {
    if (installed !== undefined) {
      throw new Error(
        "another VirtualTimers still owns the global timers: dispose its system first (a check its test timed out on keeps running until the next check or replay starts)",
      );
    }
    const owner = {};
    installed = owner;
    const g = globalThis as any;
    const saved = {
      setTimeout: g.setTimeout,
      clearTimeout: g.clearTimeout,
      setInterval: g.setInterval,
      clearInterval: g.clearInterval,
      now: Date.now,
    };
    g.setTimeout = this.setTimeout;
    g.clearTimeout = this.clearTimeout;
    g.setInterval = this.setInterval;
    g.clearInterval = this.clearInterval;
    Date.now = this.dateNow;
    return () => {
      if (installed !== owner) return;
      installed = undefined;
      g.setTimeout = saved.setTimeout;
      g.clearTimeout = saved.clearTimeout;
      g.setInterval = saved.setInterval;
      g.clearInterval = saved.clearInterval;
      Date.now = saved.now;
    };
  }

  private schedule(fn: () => void, delay: number, every: number | undefined): number {
    const timer: Timer = { id: this.nextId++, at: this.now + Math.max(0, delay), every, fn };
    this.activity++;
    if (delay <= 0) {
      this.macrotasks.push(timer);
    } else {
      this.timers.push(timer);
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
    }
    return timer.id;
  }

  private fire(timer: Timer): void {
    this.activity++;
    if (timer.every !== undefined) {
      const next: Timer = { ...timer, at: this.now + timer.every };
      this.timers.push(next);
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
    }
    timer.fn();
  }
}
