// Settings as the person sees them while saves are in flight: what the runtime
// last confirmed, with every unanswered settings.set patch laid over it in the
// order it was made. A control moves the moment it is used; a refused save
// takes back only its own patch; a poll that answers mid-save never undoes a
// change the runtime has not confirmed yet.

import type { Params, Settings } from "@caveman-app/session-protocol";

export type SettingsPatch = Params<"settings.set">["settings"];

export class SettingsSaves {
  private confirmed: Settings | null;
  private readonly pending: Array<{ readonly id: number; readonly patch: SettingsPatch }> = [];
  private next = 0;
  /** Counts saves begun and answered: a settings.get asked before it last moved may predate a save. */
  private moves = 0;

  /** `confirmed`: Settings the runtime already said (the desktop's launch snapshot), else null until a poll says them. */
  constructor(confirmed: Settings | null = null) {
    this.confirmed = confirmed;
  }

  /** What to show: the confirmed Settings with each pending patch over it (a patch replaces whole keys, as settings.set does). */
  view(): Settings | null {
    if (!this.confirmed) return null;
    return this.pending.reduce<Settings>((s, p) => ({ ...s, ...p.patch }) as Settings, this.confirmed);
  }

  /** A settings.get about to be sent: hand its answer to polled with this. */
  asking(): number {
    return this.moves;
  }

  /**
   * The answer to a settings.get sent at `asked`. Ignored when a save was unanswered then, or began or was answered
   * since: it may predate that save. True when it was taken.
   */
  polled(settings: Settings, asked: number): boolean {
    if (asked !== this.moves || this.pending.length > 0) return false;
    this.confirmed = settings;
    return true;
  }

  /** A patch about to be sent: shown from now on. */
  begin(patch: SettingsPatch): number {
    const id = ++this.next;
    this.moves++;
    this.pending.push({ id, patch });
    return id;
  }

  /** settings.set answered with the whole Settings after its patch. */
  succeed(id: number, settings: Settings): void {
    this.drop(id);
    this.confirmed = settings;
  }

  /** settings.set refused or never answered: its patch stops showing, later ones stay. */
  fail(id: number): void {
    this.drop(id);
  }

  get saving(): boolean {
    return this.pending.length > 0;
  }

  private drop(id: number): void {
    this.moves++;
    const at = this.pending.findIndex((p) => p.id === id);
    if (at >= 0) this.pending.splice(at, 1);
  }
}

/**
 * A settings.set still out on the computer the window switched away from (RuntimeProvider's saveSettings). Whatever
 * became of it there, the Settings on screen are another computer's now, so nothing reports it among them.
 */
export class SaveLeftBehind extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "SaveLeftBehind";
  }
}

/** The line Settings shows when a save fails: what failed, and that the control is back to the saved value. */
export function saveFailure(cause: unknown): string {
  const why = cause instanceof Error ? cause.message.trim() : typeof cause === "string" ? cause.trim() : "";
  return why ? `Couldn't save that change: ${why.replace(/\.$/, "")}. It's back to what was saved.` : "Couldn't save that change. It's back to what was saved.";
}
