// What Cloud says of a Cloud computer's life in every heartbeat reply (CONTRACT §5.1 of
// docs/): when it will ask for a stop if nothing changes, until when the computer is
// paid for, and the stop it wants now. The link reads it (link.ts, the one place a heartbeat reply is read) and the
// session layer parks on it (parking.ts).

/** Why Cloud wants the computer down. */
export type StopReason = "idle" | "usage" | "lease" | "update" | "owner" | "funding";

/** A stop Cloud wants: the computer goes down once the runtime says `parked: id`, or at `deadline`. */
export interface Stop {
  readonly id: string;
  readonly reason: StopReason | (string & {});
  /** On Cloud's clock. */
  readonly deadline: number;
}

export interface Lifecycle {
  /** When Cloud will ask for a stop if nothing changes (idle, unpaid); null: it will not. */
  readonly sleepAt: number | null;
  /** The end of the lease the computer runs on; null: none. */
  readonly fundedUntil: number | null;
  /** The stop Cloud wants now; null: none, and one it named before was called off. */
  readonly stop: Stop | null;
}

const time = (value: unknown) => {
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? null : at;
};

/**
 * A heartbeat reply's lifecycle. A Cloud from before it names none of the fields: no stop, as it never asks for one. A
 * stop without an id cannot be answered (`parked` names it), so it is none either.
 */
export function readLifecycle(body: unknown): Lifecycle {
  const reply = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const raw =
    reply.stop !== null && typeof reply.stop === "object"
      ? (reply.stop as Record<string, unknown>)
      : undefined;
  const stop: Stop | null =
    raw !== undefined && typeof raw.id === "string" && raw.id !== ""
      ? {
          id: raw.id,
          reason: typeof raw.reason === "string" ? raw.reason : "idle",
          deadline: time(raw.deadline) ?? Number.POSITIVE_INFINITY,
        }
      : null;
  return { sleepAt: time(reply.sleep_at), fundedUntil: time(reply.funded_until), stop };
}
