import type { Workspace } from "@caveman-app/session-protocol";
import { afterEach, expect, test } from "vitest";
import {
  dismissTidy,
  runTidy,
  tidyBusy,
  tidyGone,
  tidyNotice,
  undoTidy,
  type TidyPort,
} from "./tidy-sweep.ts";

const DONE_AT = "2026-11-05T10:00:00.000Z";

/** A runtime that archives and restores; `keeps` whether its restore honours keep_done, as one from after it does. */
function runtime(
  over: { keeps?: boolean; restoreFails?: ReadonlySet<string>; doneFails?: boolean } = {},
) {
  const calls: string[] = [];
  const said: string[] = [];
  const port: TidyPort = {
    archive: async (id) => void calls.push(`archive ${id}`),
    restore: async (id, keepDone) => {
      calls.push(`restore ${id}${keepDone ? " keep_done" : ""}`);
      if (over.restoreFails?.has(id)) throw new Error(`${id} has no branch`);
      return {
        id,
        ...(keepDone && over.keeps !== false ? { inbox: { done_at: DONE_AT } } : {}),
      } as unknown as Workspace;
    },
    markDone: async (id) => {
      calls.push(`done ${id}`);
      if (over.doneFails) throw new Error("the runtime is busy");
    },
    refresh: async () => undefined,
    announce: (text) => void said.push(text),
  };
  return { port, calls, said };
}

const chat = (id: string, doneAt: string | null = null) => ({
  id,
  inbox: { doneAt, snoozedUntil: null, snoozedAt: null, pinnedAt: null },
});
const settled = () => new Promise<void>((done) => setTimeout(done, 10));
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await settled();
  expect(ok()).toBe(true);
};

afterEach(async () => {
  await until(() => !tidyBusy());
  dismissTidy();
});

test("the sweep and its Undo bar are the module's, not a sidebar's: nothing mounted, the bar is there and Undo works", async () => {
  const { port, calls, said } = runtime();
  const sweep = runTidy(port, [chat("lead"), chat("agent", DONE_AT)]);
  // At once, before anything is archived: the bar, and both rows gone from the lists.
  expect(tidyNotice()).toMatchObject({ text: "Archived 2 chats", undo: "offered" });
  await sweep;
  expect(tidyGone().size).toBe(0);
  expect(tidyNotice()).toMatchObject({ text: "Archived 2 chats", undo: "offered" });
  expect(said).toEqual(["Archived 2 chats."]);

  undoTidy();
  expect(tidyNotice()).toMatchObject({ text: "Restoring…", undo: "running" });
  await until(() => tidyNotice() === null);
  // The lead first, then its agent; the done one back done from when it was, never marked done again from now.
  expect(calls).toEqual([
    "archive lead",
    "archive agent",
    "restore lead",
    "restore agent keep_done",
  ]);
  expect(said.at(-1)).toBe("Restored 2 chats.");
});

test("Undo on a runtime from before keep_done marks the done chats done again; a mark that fails leaves them restored, never 'stayed archived'", async () => {
  const { port, calls, said } = runtime({ keeps: false, doneFails: true });
  await runTidy(port, [chat("a", DONE_AT), chat("b")]);
  undoTidy();
  await until(() => !tidyBusy());
  expect(calls).toEqual(["archive a", "archive b", "restore a keep_done", "done a", "restore b"]);
  // Both are back: the bar goes, and what was said names the Done shelf.
  expect(tidyNotice()).toBeNull();
  expect(said.at(-1)).toBe("Restored 2 chats; 1 left the Done shelf: the runtime is busy");
});

test("a chat that could not be restored is the one the bar says stayed archived", async () => {
  const { port, said } = runtime({ restoreFails: new Set(["b"]) });
  await runTidy(port, [chat("a"), chat("b")]);
  undoTidy();
  await until(() => !tidyBusy());
  expect(tidyNotice()).toMatchObject({
    text: "1 chat stayed archived",
    why: "b has no branch",
    undo: "over",
  });
  expect(said.at(-1)).toBe("1 chat could not be restored: b has no branch");
});

test("Undo while it still archives stops at the next chat and restores only what it took", async () => {
  const { port, calls } = runtime();
  const sweep = runTidy(port, [chat("a"), chat("b"), chat("c")]);
  undoTidy();
  await sweep;
  await until(() => tidyNotice() === null);
  expect(calls).toEqual([]);
  // A second press while one runs is ignored: its Undo is never replaced under it.
  const again = runtime();
  const first = runTidy(again.port, [chat("x")]);
  await runTidy(again.port, [chat("y")]);
  await first;
  expect(again.calls).toEqual(["archive x"]);
});
