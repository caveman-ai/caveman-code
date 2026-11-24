// A Claude Agent chat that searches the web, replayed from the recorded `web_search` fixture through the
// real runtime: the search reaches the client as one web_search row titled by its query, and its sources
// as `{ title, url }` (docs/ "In the transcript").
import * as fs from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind } from "@caveman-app/protocol";
import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import { makeProviderReplayGate } from "@caveman-app/engine-testing/replayGate";
import { readProviderReplayTranscript } from "@caveman-app/engine-testing/replayTranscript";
import * as Effect from "effect/Effect";
import { afterAll, expect, test } from "vitest";

import { ClaudeOrchestratorReplayHarness } from "../orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import { WEB_SEARCH_PROMPT } from "../orchestration-v2/testkit/fixtures/shared.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "../orchestration-v2/testkit/ReplayRuntimeInstructions.ts";
import { makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

const root = tempRoot("sp-web-search-");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const transcript = await Effect.runPromise(
  readProviderReplayTranscript(new URL("../orchestration-v2/testkit/fixtures/web_search/claude_transcript.ndjson", import.meta.url)).pipe(
    Effect.provide(NodeServices.layer),
    Effect.flatMap((raw) =>
      ClaudeOrchestratorReplayHarness.decodeTranscript(materializeReplayTranscriptRuntimeInstructions(raw, { driver: ProviderDriverKind.make("claudeAgent"), model: MODEL })),
    ),
  ),
);

test("Claude's WebSearch reaches the chat as a search titled by its query, with its sources as titles and addresses", async () => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const runtime = await startRuntime(await makeConfig(), transcript, makeProviderReplayGate([]));
  const client = connect(runtime.url, runtime.token);
  try {
    const chat = await client.call("workspace.create", { request_id: "w", repo: { path: repo }, title: "Tickets", engine: "claude-agent", options: { model: MODEL } });
    const events: Array<SessionEvent> = [];
    await client.attach(chat.session_id, 0, (e) => events.push(e));
    await client.call("turn.submit", { request_id: "t1", session_id: chat.session_id, kind: "followup", input: { text: WEB_SEARCH_PROMPT } });
    await until(() => events.some((e) => e.type === "turn.done"), 30_000);

    const web = events.filter((e) => e.type === "tool.started" && e.payload.kind === "web");
    expect(web.map((e) => e.payload)).toEqual([
      { name: "web_search", title: "FIFA World Cup 2026 ticket pricing", kind: "web", input: { queries: ["FIFA World Cup 2026 ticket pricing"] } },
    ]);
    const done = events.find((e): e is Extract<SessionEvent, { type: "tool.done" }> => e.type === "tool.done" && e.item_id === web[0]!.item_id);
    expect(done?.payload.status).toBe("completed");
    const sources = (done?.payload.result ?? []) as ReadonlyArray<Record<string, unknown>>;
    expect(sources.length).toBeGreaterThan(1);
    expect(sources[0]).toEqual({ title: "Tickets - FIFA World Cup 2026™", url: "https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/tickets" });
    // Only a title and an http(s) address each, every address once.
    for (const source of sources) {
      expect(Object.keys(source).every((key) => key === "title" || key === "url")).toBe(true);
      expect(String(source.url)).toMatch(/^https?:\/\//);
    }
    expect(new Set(sources.map((s) => s.url)).size).toBe(sources.length);
  } finally {
    client.close();
    await runtime.close();
  }
}, 60_000);
