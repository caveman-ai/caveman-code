// Ordinary-chat boundary: native imageView -> bounded events -> actual UI model and media.read.
import * as fs from "node:fs";
import * as path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import { CommandId, ThreadId } from "@caveman-app/protocol";
import * as CodexReplay from "@caveman-app/codex-app-server/replay";
import { readProviderReplayTranscript } from "@caveman-app/engine-testing/replayTranscript";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { expect, test } from "vitest";
import { CodexOrchestratorReplayHarness, layer as codexRegistry } from "../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import * as McpProviderSessions from "@caveman-app/engine-core/server/McpProviderSessions";
import { createReady, makeConfig, makeRepo, orchestratorOf, PROMPT, startRuntime, tempRoot, until } from "./testHarness.ts";

const modelModule = new URL("../../../../apps/web/src/state/transcript.ts", import.meta.url).href;
const { SessionModel } = await import(modelModule) as { SessionModel: new () => {
  apply(event: SessionEvent): void;
  snapshot(): { artifacts: ReadonlyArray<{ kind: string; src?: string }>; items: ReadonlyArray<{ kind: string; name?: string; verb?: string; status?: string }> };
} };

test("native image views stay structured, viewable and replayable; unfinished/invalid views expose no image", async () => {
  const root = tempRoot("sp-image-view-");
  const config = await makeConfig();
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMIWFDxHwAFFAJo4L9/vgAAAABJRU5ErkJggg==", "base64");
  const file = path.join(root, "viewed.png");
  fs.writeFileSync(file, bytes);
  const repo = makeRepo(root, { "README.md": "hello\n" });
  const raw = await Effect.runPromise(readProviderReplayTranscript(new URL("../orchestration-v2/testkit/fixtures/simple/codex_transcript.ndjson", import.meta.url)).pipe(Effect.provide(NodeServices.layer)));
  const threadId = "01a13ebb-87b9-7671-bc05-8d1ba7413b9c";
  const turnId = "01a13ebb-8815-75c2-9e99-dfc2aeaeb880";
  const views = [
    { id: "viewed", path: file, phases: ["started", "completed"] },
    { id: "completion-only", path: file, phases: ["completed"] },
    { id: "unfinished", path: file, phases: ["started"] },
    { id: "invalid", path: "//untrusted/image.png", phases: ["started", "completed"] },
  ];
  const entries = views.flatMap((view) => view.phases.map((phase) => ({ type: "emit_inbound" as const, label: `view/${view.id}/${phase}`, frame: {
    method: `item/${phase}`, params: { threadId, turnId, item: { type: "imageView", id: view.id, path: view.path },
      ...(phase === "started" ? { startedAtMs: 1792053843032 } : { completedAtMs: 1792053843048 }),
    },
  } })));
  const end = raw.entries.findIndex((e) => e.type === "emit_inbound" && e.label === "turn/completed");
  const generation = { type: "emit_inbound" as const, label: "generated/completed", frame: { method: "item/completed", params: {
    threadId, turnId, item: { type: "imageGeneration", id: "generated", status: "completed", result: bytes.toString("base64") }, completedAtMs: 1792053843048,
  } } };
  const transcript = await Effect.runPromise(CodexOrchestratorReplayHarness.decodeTranscript({ ...raw, entries: [...raw.entries.slice(0, end), ...entries, generation, ...raw.entries.slice(end)] }));
  const driver = await Effect.runPromise(CodexReplay.makeReplayDriver(transcript));
  const registry = codexRegistry({ transcript, driver, serverConfig: config }).pipe(Layer.provide(McpProviderSessions.layer), Layer.orDie);
  const runtime = await startRuntime(config, "fake-claude", undefined, { registry, realResourceCleanup: true });
  const client = connect(runtime.url, runtime.token);
  try {
    const workspace = await createReady(client, { request_id: "views", repo: { path: repo }, title: "Image views", engine: "codex", options: { model: "gpt-5-nano" } });
    for (const entry of transcript.entries) {
      const frame = entry.type === "expect_outbound" ? entry.frame as { method?: string; params?: object } : undefined;
      if (frame?.method === "turn/start") Object.assign(frame.params!, { cwd: workspace.root_path });
    }
    const events: SessionEvent[] = [];
    const model = new SessionModel();
    const attached = await client.attach(workspace.session_id, 0, (e) => { events.push(e); model.apply(e); });
    await client.call("turn.submit", { request_id: "view-turn", session_id: workspace.session_id, kind: "followup", input: { text: PROMPT } });
    await until(() => events.some((e) => e.type === "turn.done"), 30_000);
    expect((await Effect.runPromise(Ref.get(driver.state))).failure?.message).toBeUndefined();
    const ids = new Set(events.filter((e) => e.type === "tool.started" && e.payload.name === "view_image").map((e) => e.item_id));
    expect(ids.size).toBe(4);
    const done = events.filter((e): e is Extract<SessionEvent, { type: "tool.done" }> => e.type === "tool.done" && ids.has(e.item_id));
    expect(done).toHaveLength(4);
    expect(done.map((e) => e.payload.status).sort()).toEqual(["completed", "completed", "declined", "failed"]);
    const images = model.snapshot().artifacts.filter((a) => a.kind === "image");
    expect(images).toHaveLength(3);
    expect(images.slice(0, 2).map((a) => a.src)).toEqual([file, file]);
    const generated = images[2]!.src!;
    expect(path.dirname(generated)).toBe(config.attachmentsDir);
    expect(fs.readFileSync(generated)).toEqual(bytes);
    expect(model.snapshot().items.filter((i) => i.name === "view_image" && i.status === "done").map((i) => i.verb)).toEqual(["Viewed", "Viewed"]);
    const image = await client.call("media.read", { workspace_id: workspace.id, path: file });
    expect(Buffer.from(image.data, "base64")).toEqual(bytes);
    expect(done.find((e) => e.payload.status === "failed")?.payload.error).toBe("Image view has an invalid path.");
    const replayModel = new SessionModel();
    await attached.detach();
    const replay: SessionEvent[] = [];
    await client.attach(workspace.session_id, 0, (e) => { replay.push(e); replayModel.apply(e); });
    await until(() => replay.some((e) => e.type === "turn.done"));
    expect(replayModel.snapshot().artifacts).toEqual(model.snapshot().artifacts);
    // Drive the public orchestrator entry point used by the application's thread-delete action,
    // including its actual production layer wiring, event commit and asynchronous cleanup outbox.
    await Effect.runPromise(orchestratorOf(runtime).dispatch({ type: "thread.delete", commandId: CommandId.make("delete-view-images"), threadId: ThreadId.make(`caveman:${workspace.id}`) }));
    await until(() => !fs.existsSync(generated));
    expect(fs.readFileSync(file)).toEqual(bytes); // Deletion never removes the provider's viewed image.
  } finally {
    client.close();
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(config.baseDir, { recursive: true, force: true });
  }
}, 60_000);
