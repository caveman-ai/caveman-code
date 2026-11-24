import { beforeEach, expect, test } from "vitest";
import { getPanel, resetPanels, setTabIdentity, updateTab, type Tab } from "../store.ts";
import { pressRun } from "./run.ts";

const W = "w1";
beforeEach(() => {
  resetPanels();
  // surfaces.tsx: a command has one tab.
  setTabIdentity("terminal", (p) => (p.command ? `run:${p.command}` : "shell"));
});

/** The workspace's computer: each term.open starts a new terminal. */
function computer() {
  const opened: string[] = [];
  const closed: string[] = [];
  const client = {
    call: async (method: string, p: { command?: string; terminal_id?: string }) => {
      if (method === "term.open") return { terminal_id: `T${opened.push(p.command!)}` };
      if (method === "term.close") closed.push(p.terminal_id!);
      return {};
    },
  };
  return { client: client as never, opened, closed };
}

const tab = () => getPanel(W).tabs.find((t): t is Tab<"terminal"> => t.kind === "terminal")!;
const settle = () => new Promise((r) => setTimeout(r, 0));

test("pressing Run on a shell block again ends the last run and starts the command anew", async () => {
  const { client, opened, closed } = computer();
  pressRun(client, W, "pnpm test");
  await settle();
  // The tab's surface starts a command it was opened on without a terminal, and records it.
  if (!tab().params.terminalId) updateTab(W, tab().id, { params: { terminalId: "T1" } });
  expect(tab().params).toEqual({ command: "pnpm test", terminalId: "T1" });
  // It exits ("Exited with code 0"), and the person presses Run again.
  pressRun(client, W, "pnpm test");
  await settle();
  // The tab shows a new terminal (TerminalSurface's reveal shows a terminalId it isn't showing), not the old exit.
  expect({ terminalId: tab().params.terminalId, closed, opened: opened.length }).toEqual({
    terminalId: "T2",
    closed: ["T1"],
    opened: 2,
  });
  expect(getPanel(W).tabs).toHaveLength(1);
});

test("pressing Run while not connected brings the last run forward, so no second copy starts beside it once connected", async () => {
  const { client, opened, closed } = computer();
  pressRun(client, W, "pnpm dev");
  await settle();
  expect(tab().params.terminalId).toBe("T1");
  // The connection drops while the server runs, and the person presses Run: nothing can end T1 now.
  pressRun(null, W, "pnpm dev");
  // The tab keeps T1, so once connected it attaches to it instead of starting the command again beside it.
  expect(tab().params).toEqual({ command: "pnpm dev", terminalId: "T1" });
  // Connected again, a press ends T1 and starts it anew.
  pressRun(client, W, "pnpm dev");
  await settle();
  expect({ terminalId: tab().params.terminalId, closed, opened: opened.length }).toEqual({
    terminalId: "T2",
    closed: ["T1"],
    opened: 2,
  });
});

test("pressing Run while not connected on a command that never ran opens its tab, which starts it once connected", () => {
  pressRun(null, W, "pnpm test");
  expect(tab().params).toEqual({ command: "pnpm test" });
  expect(tab().params.terminalId).toBeUndefined();
});
