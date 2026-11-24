// A Claude Agent chat whose turn starts native subagents (Claude's Agent tool), replayed from the
// recorded `subagent` fixture through the real runtime: T3 keeps each subagent's steps in a
// provider-native child thread, and the chat's session journals them under the subagent's row
// (parent_item_id), so its tool calls and result show inside it. The chat lists its native
// subagents (Workspace.subagents) for the sidebar.
import * as fs from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind } from "@caveman-app/protocol";
import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import { makeProviderReplayGate } from "@caveman-app/engine-testing/replayGate";
import { readProviderReplayTranscript } from "@caveman-app/engine-testing/replayTranscript";
import * as Effect from "effect/Effect";
import { afterAll, expect, test } from "vitest";

import { ClaudeOrchestratorReplayHarness } from "../orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import { SUBAGENT_PROMPT } from "../orchestration-v2/testkit/fixtures/shared.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "../orchestration-v2/testkit/ReplayRuntimeInstructions.ts";
import { makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

const root = tempRoot("sp-native-subagents-");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const transcript = await Effect.runPromise(
  readProviderReplayTranscript(new URL("../orchestration-v2/testkit/fixtures/subagent/claude_transcript.ndjson", import.meta.url)).pipe(
    Effect.provide(NodeServices.layer),
    Effect.flatMap((raw) =>
      ClaudeOrchestratorReplayHarness.decodeTranscript(materializeReplayTranscriptRuntimeInstructions(raw, { driver: ProviderDriverKind.make("claudeAgent"), model: MODEL })),
    ),
  ),
);

test("a native subagent's steps and result are journaled inside its row, and the chat lists it", async () => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const runtime = await startRuntime(await makeConfig(), transcript, makeProviderReplayGate([]));
  const client = connect(runtime.url, runtime.token);
  try {
    const lead = await client.call("workspace.create", { request_id: "lead", repo: { path: repo }, title: "Lead", engine: "claude-agent", options: { model: MODEL } });
    const events: Array<SessionEvent> = [];
    await client.attach(lead.session_id, 0, (e) => events.push(e));
    await client.call("turn.submit", { request_id: "t1", session_id: lead.session_id, kind: "followup", input: { text: SUBAGENT_PROMPT } });
    await until(() => events.some((e) => e.type === "turn.done"), 30_000);
    const turn = events.find((e) => e.type === "turn.started")!.turn_id;

    const started = events.filter((e) => e.type === "subagent.started");
    expect(started.map((e) => e.payload)).toEqual([
      { title: "Read package.json", agent: "claude-agent" },
      { title: "Read tsconfig.json", agent: "claude-agent" },
    ]);
    for (const [subagent, content] of [
      [started[0]!, "claude-read-only-fixture"],
      [started[1]!, "ES2022"],
    ] as const) {
      const inside = events.filter((e) => e.parent_item_id === subagent.item_id);
      // Its own Read, opened after the row and closed, then its result; never its prompt as a person's message.
      expect(inside.map((e) => e.type)).toEqual(["tool.started", "tool.done", "message.done", "message.done"]);
      expect(inside[0]).toMatchObject({ payload: { name: "Read" } });
      expect(inside[0]!.cursor).toBeGreaterThan(subagent.cursor);
      expect(inside.every((e) => e.turn_id === turn)).toBe(true);
      // The CLI first ends it with a summary, then with its full result: the correction goes out on the same items.
      expect(inside.at(-1)).toMatchObject({ type: "message.done", payload: { role: "assistant" } });
      expect((inside.at(-1)!.payload as { text: string }).text).toContain(content);
      const done = events.filter((e) => e.type === "subagent.done" && e.item_id === subagent.item_id);
      expect((done.at(-1)!.payload as { summary?: string }).summary).toContain(content);
    }
    // The child threads' own turns, titles and checkpoints never reach the chat.
    expect(events.filter((e) => e.type === "turn.started" || e.type === "turn.done")).toHaveLength(2);
    expect(events.some((e) => e.type === "message.done" && e.payload.role === "user" && e.parent_item_id !== undefined)).toBe(false);

    const listed = await client.call("workspace.get", { workspace_id: lead.id });
    expect(listed.title).toBe("Lead");
    // A subagent ends when its first subagent.done lands (the later correction keeps that time).
    const endedAt = (itemId: string | undefined) => events.find((e) => e.type === "subagent.done" && e.item_id === itemId)!.at;
    expect(listed.subagents).toEqual([
      { item_id: started[0]!.item_id, title: "Read package.json", agent: "claude-agent", status: "completed", started_at: started[0]!.at, ended_at: endedAt(started[0]!.item_id) },
      { item_id: started[1]!.item_id, title: "Read tsconfig.json", agent: "claude-agent", status: "completed", started_at: started[1]!.at, ended_at: endedAt(started[1]!.item_id) },
    ]);
    // What the chat is at (Workspace.activity): its own turn ended, and its subagents' turns never counted; its latest
    // answer is the lead's own summary, never a subagent's result.
    expect(listed.activity).toEqual({ last_outcome: "completed", turn_ended_at: expect.any(String), last_reply: expect.stringMatching(/^Both subagents completed in parallel!/) });
  } finally {
    client.close();
    await runtime.close();
  }
}, 60_000);
