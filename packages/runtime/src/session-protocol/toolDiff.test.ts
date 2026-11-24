// tool.diff against a real runtime (upstream #26304): an edit step's recorded change is read when it is opened,
// through the stand-in Claude CLI's Edit (its tool result carries the hunk, as the real CLI's does). Any other step
// answers not_found.
import * as fs from "node:fs";

import type { SessionEvent } from "@caveman-app/session-protocol";
import { connect } from "@caveman-app/session-protocol";
import { afterAll, beforeAll, expect, test } from "vitest";

import { createReady, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

const root = tempRoot("sp-tool-diff-");
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;

beforeAll(async () => {
  runtime = await startRuntime(await makeConfig(), "fake-claude");
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("an edit step's recorded change is read on demand; other steps have none", async () => {
  const repo = makeRepo(root, { "price.ts": "export const label = 'price';\nexport const price = 10;\n" });
  const workspace = await createReady(client, { request_id: "w-tool-diff", repo: { path: repo }, title: "tool diff", engine: "claude-agent", options: { model: MODEL } });
  const events: SessionEvent[] = [];
  await client.attach(workspace.session_id, 0, (e) => events.push(e));
  await client.call("turn.submit", { request_id: "t-tool-diff", session_id: workspace.session_id, kind: "followup", input: { text: "edit: price.ts price = 10 => price = 12" } });
  await until(() => events.some((e) => e.type === "turn.done"), 30_000);

  const started = events.find((e) => e.type === "tool.started" && (e.payload as { kind: string }).kind === "edit");
  expect(started?.item_id).toBeDefined();
  // The journal keeps the step's counts, never its patch.
  const done = events.find((e) => e.type === "tool.done" && e.item_id === started!.item_id);
  expect(JSON.stringify(done?.payload ?? {})).not.toContain("structuredPatch");

  const recorded = await client.call("tool.diff", { workspace_id: workspace.id, item_id: started!.item_id! });
  expect(recorded.path).toContain("price.ts");
  // The chat's folder comes with it: a client reads the step's absolute paths relative to it, wherever the chat runs.
  expect(recorded.root_path).toBe(workspace.root_path);
  // The CLI's structured patch, as the unified diff a client reads.
  expect(recorded.diff).toBe(
    `--- ${recorded.path}\n+++ ${recorded.path}\n@@ -2,1 +2,1 @@\n-export const price = 10;\n+export const price = 12;\n`,
  );

  const message = events.find((e) => e.type === "message.done");
  await expect(client.call("tool.diff", { workspace_id: workspace.id, item_id: message?.item_id ?? "nothing-here" })).rejects.toMatchObject({ error: { data: { reason: "not_found" } } });
});
