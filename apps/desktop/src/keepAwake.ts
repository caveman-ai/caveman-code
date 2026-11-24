// "Keep this Mac awake while chats work" (Settings > General): while a chat
// works on this Mac, idle sleep waits, so a long run or a night of agents is
// not frozen halfway. Idle sleep only: the display still sleeps, and closing
// the lid still sleeps the Mac. Off unless the person turns it on (a laptop's
// battery is theirs to spend). Codex ("Prevent sleep while running") and
// Claude Desktop ("Keep computer awake") offer the same. Electron-free: main
// passes powerSaveBlocker in.
import { readFileSync } from "node:fs";
import { runsHere, type ChatState } from "./quitGuard.ts";
import { writeFileStaged } from "./stagedWrite.ts";

/** Electron's powerSaveBlocker, the part used here. */
export interface Blocker {
  start(type: "prevent-app-suspension"): number;
  stop(id: number): void;
}

/**
 * How often main looks again while it holds idle sleep off. Only then: the remote rule's window (device.awake) ends
 * without any event to say so. Otherwise main looks when a chat starts or stops working here (WorkingSet), when power
 * changes, and when the setting does.
 */
export const KEEP_AWAKE_POLL_MS = 20_000;

/**
 * The chats working on this Mac, kept from the runtime's workspace.changed. `update` says whether the set changed: a
 * chat started or stopped (a remote device's turn starts one too). Most workspace.changed (a title, a streamed reply's
 * progress) change nothing here and cost no call.
 */
export class WorkingSet {
  private readonly ids = new Set<string>();

  update(chat: ChatState & { readonly id: string }): boolean {
    const runs = runsHere(chat);
    if (runs === this.ids.has(chat.id)) return false;
    if (runs) this.ids.add(chat.id);
    else this.ids.delete(chat.id);
    return true;
  }

  /** A reconnect may have missed events: start again from what the next look finds. */
  clear(): void {
    this.ids.clear();
  }
}

export class KeepAwake {
  private id: number | null = null;
  private readonly blocker: Blocker;

  constructor(blocker: Blocker) {
    this.blocker = blocker;
  }

  get holding(): boolean {
    return this.id !== null;
  }

  /** Holds idle sleep off while `working`, lets it go otherwise. */
  set(working: boolean): void {
    if (working && this.id === null) this.id = this.blocker.start("prevent-app-suspension");
    else if (!working && this.id !== null) {
      this.blocker.stop(this.id);
      this.id = null;
    }
  }
}

/**
 * Whether idle sleep waits now: chats work and the person turned that on, or another device drives this Mac (the
 * runtime's device.awake, under Settings.keep_awake_remote) while it runs on power (DESIGN S13). Never while quitting.
 */
export function holdAwake(input: { readonly quitting: boolean; readonly keepAwakeOn: boolean; readonly workingChats: number; readonly remoteWanted: boolean; readonly onBattery: boolean }): boolean {
  if (input.quitting) return false;
  return (input.keepAwakeOn && input.workingChats > 0) || (input.remoteWanted && !input.onBattery);
}

/** The person's choice in <userData>/power.json; off when unset or unreadable. */
export function readKeepAwake(file: string): boolean {
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { keepAwake?: unknown }).keepAwake === true;
  } catch {
    return false;
  }
}

export function writeKeepAwake(file: string, on: boolean): void {
  writeFileStaged(file, `${JSON.stringify({ keepAwake: on })}\n`);
}
