// Quitting stops the runtime, and with it every chat working on this Mac
// (their engines run in its process group). So a quit while chats work asks
// first, once, with "Don't ask again"; a quit with nothing running, an
// update's quit, a shutdown, SIGINT/SIGTERM or the smoke test never asks. upstream guards ⌘Q
// too (window/QuitHold.ts: hold to quit); this asks only when there is work to
// lose. Electron-free, so it tests without Electron; main.ts asks.
import { readFileSync } from "node:fs";
import { writeFileStaged } from "./stagedWrite.ts";

/** What quitting can lose: a chat on this Mac whose engine is running. Cloud computers keep going without the app. */
export interface ChatState {
  readonly status: string;
  readonly computer: { readonly kind: string };
}

const RUNNING = new Set(["starting", "working", "waiting"]);

export const runsHere = (chat: ChatState): boolean => RUNNING.has(chat.status) && chat.computer.kind === "this_mac";

export const workingHere = (chats: ReadonlyArray<ChatState>): number => chats.filter(runsHere).length;

export const quitQuestion = (working: number) => ({
  message: working === 1 ? "A chat is still working" : `${working} chats are still working`,
  detail: `Quitting Caveman Code stops ${working === 1 ? "it" : "them"} on this Mac. Chats on Cloud computers keep going.`,
});

/** The person's "Don't ask again", in <userData>/quit.json. */
export function askBeforeQuit(file: string): boolean {
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { ask?: unknown }).ask !== false;
  } catch {
    return true;
  }
}

export function stopAsking(file: string): void {
  writeFileStaged(file, `${JSON.stringify({ ask: false })}\n`);
}

export const QUIT_SIGNALS = ["SIGINT", "SIGTERM"] as const;
export type QuitSignal = (typeof QUIT_SIGNALS)[number];

/**
 * SIGINT and SIGTERM (Ctrl-C on `pnpm dev`, `kill`, a process manager) quit without the question: nobody is at the
 * window to answer it, and the app stayed open with the dialog up. `quit` runs once, however many signals follow, as
 * upstream quitFromSignal (app/DesktopLifecycle.ts). Not on Windows, where Node only emulates them.
 */
export function onQuitSignal(target: { on(signal: QuitSignal, listener: () => void): unknown }, platform: NodeJS.Platform, quit: (signal: QuitSignal) => void): void {
  if (platform === "win32") return;
  let received = false;
  for (const signal of QUIT_SIGNALS)
    target.on(signal, () => {
      if (received) return;
      received = true;
      quit(signal);
    });
}
