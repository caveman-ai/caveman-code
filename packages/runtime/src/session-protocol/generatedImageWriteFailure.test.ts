// Real filesystem short writes through the runtime, not just the persistence helper.
import fs from "node:fs";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ThreadId } from "@caveman-app/protocol";
import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import * as CodexReplay from "@caveman-app/codex-app-server/replay";
import { readProviderReplayTranscript } from "@caveman-app/engine-testing/replayTranscript";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, test } from "vitest";
import * as McpProviderSessions from "@caveman-app/engine-core/server/McpProviderSessions";
import { CodexOrchestratorReplayHarness, layer as codexRegistry } from "../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import { createReady, makeConfig, makeRepo, orchestratorOf, PROMPT, startRuntime, tempRoot, until } from "./testHarness.ts";

test("partial native, dynamic and MCP image writes leave no orphan, while a successful image remains usable until public deletion", async () => {
  const root = tempRoot("sp-image-write-failure-");
  const config = await makeConfig();
  const bytes = fs.readFileSync(new URL("../../../../apps/desktop/resources/icon.png", import.meta.url));
  expect(bytes.length).toBeGreaterThan(2048);
  const data = bytes.toString("base64");
  const repo = makeRepo(root, { "README.md": "hello\n" });
  const items = [
    { type: "imageGeneration", id: "native-failed", status: "completed", result: data },
    { type: "dynamicToolCall", id: "dynamic-failed", namespace: "images", tool: "generate_image", arguments: {}, status: "completed", success: true, contentItems: Array.from({ length: 2 }, () => ({ type: "inputImage", imageUrl: `data:image/png;base64,${data}` })) },
    { type: "mcpToolCall", id: "mcp-failed", server: "studio", tool: "image_generation", arguments: {}, status: "completed", result: { content: Array.from({ length: 2 }, () => ({ type: "image", mimeType: "image/png", data })) } },
    { type: "imageGeneration", id: "native-success", status: "completed", result: data },
  ];
  const raw = await Effect.runPromise(readProviderReplayTranscript(new URL("../orchestration-v2/testkit/fixtures/simple/codex_transcript.ndjson", import.meta.url)).pipe(Effect.provide(NodeServices.layer)));
  const entries = items.map((item) => ({ type: "emit_inbound" as const, label: `write-failure/${item.id}`, frame: { method: "item/completed", params: {
    threadId: "01a13ebb-87b9-7671-bc05-8d1ba7413b9c", turnId: "01a13ebb-8815-75c2-9e99-dfc2aeaeb880", item, completedAtMs: 1792053843048,
  } } }));
  const end = raw.entries.findIndex((e) => e.type === "emit_inbound" && e.label === "turn/completed");
  const transcript = await Effect.runPromise(CodexOrchestratorReplayHarness.decodeTranscript({ ...raw, entries: [...raw.entries.slice(0, end), ...entries, ...raw.entries.slice(end)] }));
  const driver = await Effect.runPromise(CodexReplay.makeReplayDriver(transcript));
  const registry = codexRegistry({ transcript, driver, serverConfig: config }).pipe(Layer.provide(McpProviderSessions.layer), Layer.orDie);
  const runtime = await startRuntime(config, "fake-claude", undefined, { registry, realResourceCleanup: true });
  const client = connect(runtime.url, runtime.token);
  const originalOpen = fs.promises.open;
  const originalWrite = fs.promises.writeFile;
  const handles = new WeakMap<object, string>();
  let writes = 0;
  let shortWrites = 0;
  try {
    const workspace = await createReady(client, { request_id: "write-failure", repo: { path: repo }, engine: "codex", options: { model: "gpt-5-nano" } });
    for (const entry of transcript.entries) {
      const frame = entry.type === "expect_outbound" ? entry.frame as { method?: string; params?: object } : undefined;
      if (frame?.method === "turn/start") Object.assign(frame.params!, { cwd: workspace.root_path });
    }
    // Track exclusively opened handles as well as the old path-based API. The
    // fault writes real bytes, then rejects just like ENOSPC/EFBIG after creation.
    fs.promises.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (typeof args[0] === "string") handles.set(handle, args[0]);
      return handle;
    };
    fs.promises.writeFile = async (file, content, options) => {
      const target = typeof file === "string" ? file : typeof file === "object" && file !== null ? handles.get(file) : undefined;
      if (target !== undefined && path.dirname(target) === config.attachmentsDir && target.endsWith(".png") && Buffer.isBuffer(content)) {
        writes += 1;
        // Fail the native image, then the second image in each multi-image call.
        if ([1, 3, 5].includes(writes)) {
          await originalWrite(file, content.subarray(0, 2048), options);
          shortWrites += 1;
          throw Object.assign(new Error("file too large, write"), { code: "EFBIG" });
        }
      }
      return originalWrite(file, content, options);
    };
    syncBuiltinESMExports();
    const events: SessionEvent[] = [];
    await client.attach(workspace.session_id, 0, (event) => events.push(event));
    await client.call("turn.submit", { request_id: "write-failure-turn", session_id: workspace.session_id, kind: "followup", input: { text: PROMPT } });
    await until(() => events.some((event) => event.type === "turn.done"), 30_000);
    fs.promises.open = originalOpen;
    fs.promises.writeFile = originalWrite;
    syncBuiltinESMExports();
    expect(shortWrites).toBe(3);
    const ids = new Set(events.filter((e) => e.type === "tool.started" && ["image_generation", "images.generate_image", "studio.image_generation"].includes(e.payload.name)).map((e) => e.item_id));
    const done = events.filter((e): e is Extract<SessionEvent, { type: "tool.done" }> => e.type === "tool.done" && ids.has(e.item_id));
    expect(done.map((e) => e.payload.status)).toEqual(["failed", "failed", "failed", "completed"]);
    for (const event of done.slice(0, 3)) {
      expect(event.payload.result).not.toHaveProperty("saved_path");
      expect(event.payload.result).not.toHaveProperty("saved_paths");
    }
    const file = (done[3]!.payload.result as { saved_path: string }).saved_path;
    // Neither short writes nor the earlier successful members of failed groups
    // survive. The only remaining file is the final successful native image.
    expect(fs.readdirSync(config.attachmentsDir)).toEqual([path.basename(file)]);
    const image = await client.call("media.read", { workspace_id: workspace.id, path: file });
    expect(Buffer.from(image.data, "base64")).toEqual(bytes);
    await Effect.runPromise(orchestratorOf(runtime).dispatch({ type: "thread.delete", commandId: CommandId.make("delete-after-write-failure"), threadId: ThreadId.make(`caveman:${workspace.id}`) }));
    await until(() => !fs.existsSync(file));
    expect(fs.readdirSync(config.attachmentsDir)).toEqual([]);
  } finally {
    fs.promises.open = originalOpen;
    fs.promises.writeFile = originalWrite;
    syncBuiltinESMExports();
    client.close();
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(config.baseDir, { recursive: true, force: true });
  }
}, 60_000);
