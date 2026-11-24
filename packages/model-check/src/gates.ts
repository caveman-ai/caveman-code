/**
 * Gates: the checker's handle on a concurrent system's schedule. A caller that reaches a gate parks until the checker
 * releases it, so the parked gates are the enabled actions and releasing one is a step. Gates belong in test doubles
 * and wrappers (a fake transport, a wrapped SQL client, a scripted adapter), never in production code.
 */

interface Parked {
  readonly name: string;
  readonly release: () => void;
}

export class GateQueue {
  private waiting: Array<Parked> = [];
  /** Grows on every park and release, so a settle loop can tell that something moved. */
  activity = 0;

  /** Parks until released. The returned function withdraws the gate: an interrupted fiber must not be released later. */
  parkUnsafe(name: string, release: () => void): () => void {
    const entry: Parked = { name, release };
    this.waiting.push(entry);
    this.activity++;
    return () => {
      const at = this.waiting.indexOf(entry);
      if (at >= 0) this.waiting.splice(at, 1);
    };
  }

  park(name: string): Promise<void> {
    return new Promise((resolve) => {
      this.parkUnsafe(name, resolve);
    });
  }

  /** Parked gate names in arrival order. Two callers parked on one name release in arrival order. */
  parked(): ReadonlyArray<string> {
    return this.waiting.map((entry) => entry.name);
  }

  /** Releases the earliest gate with this name; false when nobody is parked there. */
  release(name: string): boolean {
    const at = this.waiting.findIndex((entry) => entry.name === name);
    if (at < 0) return false;
    const [entry] = this.waiting.splice(at, 1);
    this.activity++;
    entry!.release();
    return true;
  }

  /** One fair round: releases every gate parked right now, first in first out. Gates parked by the released callers wait for the next round. */
  releaseAll(): Array<string> {
    const round = this.waiting;
    this.waiting = [];
    this.activity += round.length;
    for (const entry of round) entry.release();
    return round.map((entry) => entry.name);
  }
}

const realSetImmediate = globalThis.setImmediate;

/** One turn of the real event loop: every microtask and every macrotask queued before it has run. */
export const macrotask = (): Promise<void> => new Promise((resolve) => realSetImmediate(resolve));

/**
 * Runs the event loop until the system is quiet: `fingerprint` has not changed for `quietTurns` consecutive turns.
 * Time never passes; sleeping callers stay asleep and parked callers stay parked.
 */
export const settle = async (fingerprint: () => string, quietTurns = 2): Promise<void> => {
  let last = fingerprint();
  let quiet = 0;
  while (quiet < quietTurns) {
    await macrotask();
    const now = fingerprint();
    if (now === last) quiet++;
    else {
      last = now;
      quiet = 0;
    }
  }
};

/** Fails the k-th statement after arming: a fault as an action. Call `hit` at every statement boundary. */
export class FaultPlan {
  private remaining: number | undefined;
  statements = 0;

  arm(statement: number): void {
    this.remaining = statement;
  }

  /** Statements left before the armed fault fires; undefined when disarmed. Part of the observation. */
  get pending(): number | undefined {
    return this.remaining;
  }

  hit(): void {
    this.statements++;
    if (this.remaining === undefined) return;
    this.remaining--;
    if (this.remaining > 0) return;
    this.remaining = undefined;
    throw new FaultError(this.statements);
  }
}

export class FaultError extends Error {
  readonly statement: number;
  constructor(statement: number) {
    super(`injected fault at statement ${statement}`);
    this.name = "FaultError";
    this.statement = statement;
  }
}
