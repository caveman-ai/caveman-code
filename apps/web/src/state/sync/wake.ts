// What wakes a sleeping Cloud computer from a device, beside a send (Cloud wakes a computer for a call queued for it):
// the person typing in one of its chats, or opening something of a chat that needs the computer (its changes, its pull
// request). A window, a phone or a chat that is merely open wakes nothing, and a computer put to sleep stays asleep.
// Bounded like Cloud bounds it (one per computer per 30 s, five per device per minute), so a device never floods it; a
// Mac cannot be woken from here and is never asked.
import type { CloudApi } from "./cloud-api.ts";

export type WakeReason = "typing" | "open";

const PER_COMPUTER_MS = 30_000;
const PER_DEVICE = 5;
const DEVICE_WINDOW_MS = 60_000;

export class WakeHints {
  private readonly lastByComputer = new Map<string, number>();
  private sent: number[] = [];
  private readonly api: Pick<CloudApi, "wakeHint">;
  private readonly now: () => number;

  constructor(api: Pick<CloudApi, "wakeHint">, now: () => number = Date.now) {
    this.api = api;
    this.now = now;
  }

  /**
   * Asks Cloud to wake `computerId`, unless one was asked within the bounds. True when a hint went out. `refused`: Cloud
   * would not take it, or could not be reached (what an opening's one line says).
   */
  hint(computerId: string, reason: WakeReason, refused?: () => void): boolean {
    const now = this.now();
    if (now - (this.lastByComputer.get(computerId) ?? Number.NEGATIVE_INFINITY) < PER_COMPUTER_MS) return false;
    this.sent = this.sent.filter((at) => now - at < DEVICE_WINDOW_MS);
    if (this.sent.length >= PER_DEVICE) return false;
    this.lastByComputer.set(computerId, now);
    this.sent.push(now);
    // A hint is a hint: Cloud refusing it (a limit, a computer gone) changes nothing here but the caller's line.
    void this.api.wakeHint(computerId, reason).catch(() => refused?.());
    return true;
  }
}
