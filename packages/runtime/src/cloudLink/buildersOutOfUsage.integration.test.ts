// Out of usage under a lead's builders (finding P8, SPEC §8.6), on a real Cloud computer's runtime with the
// stand-in Claude CLI: one builder's plan refuses, and the lead's builders stop together at their next tool boundary
// with one note on the lead; they start again together when the window resets. No amount of money is in any session.
import * as fs from "node:fs";
import * as path from "node:path";

import type { SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import { afterEach, expect, test } from "vitest";

import { RESUME_TEXT, usedUpNote } from "../session-protocol/builders.ts";
import { createReady, makeRepo, MODEL, tempRoot, until } from "../session-protocol/testHarness.ts";
import { builderKit, gitIn, userTexts } from "./builders.kit.ts";
import { startTestCloud } from "./testCloud.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const { startTools, githubWith, checkoutOf, computerRuntime, delegate } = builderKit(cleanups);

test("the one note names the plan that is used up and when it resets, never an amount", () => {
  const now = Date.parse("2026-11-09T20:00:00Z");
  const claude = { engine: "claude-agent" };
  expect(usedUpNote("2026-11-09T23:08:00Z", now, "Europe/Amsterdam", claude)).toEqual({
    title: "Your Claude plan is used up until Nov 10, 12:08 AM.",
    body: "Your agents pause and carry on then.",
  });
  expect(usedUpNote("2026-11-09T22:08:00Z", now, "UTC", claude).title).toBe(
    "Your Claude plan is used up until 10:08 PM UTC.",
  );
  expect(
    usedUpNote("2026-11-09T23:08:00Z", now, "Europe/Amsterdam", { engine: "codex" }).title,
  ).toBe("Your ChatGPT plan is used up until Nov 10, 12:08 AM.");
  expect(
    usedUpNote("2026-11-09T23:08:00Z", now, "Europe/Amsterdam", { engine: "caveman" }).title,
  ).toBe("Your Caveman plan is used up until Nov 10, 12:08 AM.");
  // A refusal that named no reset, or one already past.
  expect(usedUpNote(undefined, now, undefined, claude)).toEqual({
    title: "Your Claude plan is used up.",
    body: "Your agents pause and carry on when it resets.",
  });
  expect(usedUpNote("2026-11-09T19:00:00Z", now, undefined, claude).title).toBe(
    "Your Claude plan is used up.",
  );
  // Builders on several agents: those on the plan that ran out pause, the others keep working (and, when it is the
  // lead's own plan, their results reach it at the reset).
  expect(
    usedUpNote("2026-11-09T23:08:00Z", now, "UTC", {
      engine: "codex",
      across: { stops: true, lead: false },
    }).body,
  ).toBe("Your agents on Codex pause and carry on then. The others keep working.");
  expect(
    usedUpNote("2026-11-09T23:08:00Z", now, "UTC", {
      engine: "claude-agent",
      across: { stops: true, lead: true },
    }).body,
  ).toBe(
    "Your agents on Claude Agent pause and carry on then. The others keep working and report back then.",
  );
  expect(
    usedUpNote(null, now, "UTC", { engine: "claude-agent", across: { stops: false, lead: true } })
      .body,
  ).toBe("Your agents keep working and report back when it resets.");
  for (const said of [
    usedUpNote("2026-11-09T23:08:00Z", now, "UTC", claude),
    usedUpNote(null, now, undefined, claude),
  ])
    expect(`${said.title} ${said.body}`).not.toMatch(/[$€£¥]|\d\s?%|credit/i);
});

test.skipIf(process.platform === "win32")(
  "a plan that refuses one builder stops the lead's builders together at their next tool boundary, with one note on the lead; they start again together at the reset",
  async () => {
    const cloud = await startTestCloud();
    cleanups.push(cloud.close);
    await startTools();
    process.env.CAVEMAN_COMPUTER_CPUS = "16";
    process.env.CAVEMAN_COMPUTER_MEMORY_GIB = "64";
    cleanups.push(
      () => (
        delete process.env.CAVEMAN_COMPUTER_CPUS,
        delete process.env.CAVEMAN_COMPUTER_MEMORY_GIB
      ),
    );
    cloud.state.gitBackend = githubWith(
      makeRepo(tempRoot("usage-source-"), { "README.md": "widgets\n" }),
    );
    const computer = await computerRuntime(
      cloud,
      checkoutOf(cloud.state.gitBackend, "usage-"),
      "usage",
    );
    const { client, builders } = computer;
    const lead = await createReady(client, {
      request_id: "lead",
      repo: { url: "https://github.com/acme/widgets" },
      title: "Lead",
      engine: "claude-agent",
      options: { model: MODEL },
    });
    const leadEvents: Array<SessionEvent> = [];
    await client.attach(lead.session_id, 0, (event) => leadEvents.push(event));
    const watch = async (workspaceId: string) => {
      const workspace = await client.call("workspace.get", { workspace_id: workspaceId });
      const events: Array<SessionEvent> = [];
      await client.attach(workspace.session_id, 0, (event) => events.push(event));
      return { workspace, events };
    };
    const tree = async () => Effect.runPromise(builders.tree(`caveman:${lead.id}`));

    // Three builders. One is mid-tool (a command that takes four seconds, then writes a file), one is thinking, and one
    // works a moment and then meets the plan's refusal: its window resets in twelve seconds.
    const RESET_S = 12;
    const tool = await delegate(builders, lead, "tool", "In a tool", {
      task: "sh: sleep 4 && echo finished > tool-ran.txt\nhold: 120000",
    });
    const thinking = await delegate(builders, lead, "thinking", "Thinking", {
      task: "hold: 120000",
    });
    const toolChat = await watch(tool!.workspaceId);
    const thinkingChat = await watch(thinking!.workspaceId);
    // The tool has started before the refusal lands.
    await until(() => toolChat.events.some((e) => e.type === "tool.started"), 30_000);
    const refusedAt = Date.now();
    const refused = await delegate(builders, lead, "refused", "Refused", {
      task: `limit: ${RESET_S}`,
    });
    const refusedChat = await watch(refused!.workspaceId);
    const chats = [toolChat, thinkingChat, refusedChat];
    const stopped = (chat: { events: Array<SessionEvent> }) =>
      chat.events.filter((e) => e.type === "turn.done");

    // ---- together: every builder's turn has ended, none as a result its lead is told of.
    await until(() => chats.every((chat) => stopped(chat).length >= 1), 60_000);
    // The one that was mid-tool stopped after its tool finished, not in it: what the tool wrote is there, whole.
    const worktrees = new Map(
      gitIn(computer.checkout)("worktree", "list", "--porcelain")
        .split("\n\n")
        .map((entry) => [
          /^branch refs\/heads\/(.+)$/m.exec(entry)?.[1] ?? "",
          /^worktree (.+)$/m.exec(entry)?.[1] ?? "",
        ]),
    );
    expect(
      fs.readFileSync(path.join(worktrees.get(toolChat.workspace.branch)!, "tool-ran.txt"), "utf8"),
    ).toBe("finished\n");
    const toolDone = toolChat.events.find((e) => e.type === "tool.done")!;
    expect(stopped(toolChat)[0]!.cursor).toBeGreaterThan(toolDone.cursor);
    expect(stopped(toolChat)[0]!.payload).toMatchObject({ status: "interrupted" });
    expect(stopped(thinkingChat)[0]!.payload).toMatchObject({ status: "interrupted" });
    expect(stopped(refusedChat)[0]!.payload).toMatchObject({
      status: "failed",
      failure: { class: "usage_limit" },
    });
    // Paused, each still holding its place: none failed, none finished.
    await until(
      async () =>
        (await Effect.runPromise(builders.status(tool!.workspaceId)))?.state === "running",
      10_000,
    );
    expect((await tree()).running).toBe(3);

    // ---- one note on the lead, for all three: used up, and until when. No turn of the lead's, no result of a builder's.
    const notes = () =>
      leadEvents
        .filter((e) => e.type === "notification")
        .map((e) => (e.type === "notification" ? e.payload : undefined)!);
    await until(
      () => notes().some((n) => n.title.startsWith("Your Claude plan is used up")),
      10_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const usedUp = notes().filter((n) => n.title.startsWith("Your Claude plan is used up"));
    expect(usedUp).toHaveLength(1);
    expect(usedUp[0]!.title).toMatch(/^Your Claude plan is used up until \d{1,2}:\d\d [AP]M/);
    expect(usedUp[0]!.body).toBe("Your agents pause and carry on then.");
    expect(userTexts(leadEvents).filter((text) => text.includes("[Builder "))).toEqual([]);
    expect(leadEvents.filter((e) => e.type === "turn.started")).toEqual([]);

    // ---- at the reset they start again together: each is told to carry on, within one sweep of each other.
    const resumed = (chat: { events: Array<SessionEvent> }) =>
      chat.events.find(
        (e) =>
          e.type === "message.done" && e.payload.role === "user" && e.payload.text === RESUME_TEXT,
      );
    await until(() => chats.every((chat) => resumed(chat) !== undefined), 60_000);
    const at = chats.map((chat) => Date.parse(resumed(chat)!.at));
    // Not before the window reset, and all in the same few seconds.
    expect(Math.min(...at)).toBeGreaterThanOrEqual(refusedAt + RESET_S * 1000 - 1_500);
    expect(Math.max(...at) - Math.min(...at)).toBeLessThan(6_000);
    // The refused one, continued, finishes; its result goes to its lead now, as any builder's does.
    await until(
      () =>
        userTexts(leadEvents).some((text) =>
          text.startsWith('[Builder "Refused" finished its turn'),
        ),
      60_000,
    );
    // Still one note about the plan: the reset added none.
    expect(notes().filter((n) => /plan/i.test(n.title))).toHaveLength(1);

    // ---- no amount of money anywhere, in any session's journal: a currency sign followed by digits. Every session
    // on the computer, each read whole from its first event.
    const sessions = (await client.call("workspace.list", {})).workspaces;
    expect(sessions.map((w) => w.id).sort()).toEqual(
      [lead.id, ...chats.map((chat) => chat.workspace.id)].sort(),
    );
    const journals = [leadEvents, ...chats.map((chat) => chat.events)];
    expect(journals.reduce((sum, events) => sum + events.length, 0)).toBeGreaterThan(40);
    for (const events of journals)
      for (const event of events) expect(JSON.stringify(event)).not.toMatch(/[$€£¥]\s?\d/);
  },
  300_000,
);
