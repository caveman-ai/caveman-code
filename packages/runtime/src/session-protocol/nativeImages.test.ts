// Full ordinary-chat regression: native Codex notifications -> adapter ->
// EventSink's bounded stream -> Session Protocol journal/WebSocket -> UI model.
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import * as CodexReplay from "@caveman-app/codex-app-server/replay";
import * as Ref from "effect/Ref";
import { readProviderReplayTranscript } from "@caveman-app/engine-testing/replayTranscript";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, test } from "vitest";

// Runtime's tsc has no JSX/DOM libraries. Load the real, pure client fold at
// runtime without pulling the web app's type-only UI imports into its project.
const modelModule = new URL("../../../../apps/web/src/state/transcript.ts", import.meta.url).href;
const { SessionModel } = await import(modelModule) as {
  SessionModel: new () => { apply(event: SessionEvent): void; snapshot(): { artifacts: ReadonlyArray<{ kind: string; src?: string }> } };
};
import { CodexOrchestratorReplayHarness, layer as codexRegistry } from "../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import * as McpProviderSessions from "@caveman-app/engine-core/server/McpProviderSessions";
import { accessOf, ownerOnly } from "../testUtils/ownerOnly.ts";
import { createReady, makeConfig, makeRepo, PROMPT, startRuntime, tempRoot, until } from "./testHarness.ts";

/** A real PNG, including scanline filters, zlib stream and chunk checksums. */
function png(): Buffer {
  const chunk = (name: string, data: Buffer) => {
    const typeAndData = Buffer.concat([Buffer.from(name), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(typeAndData));
    return Buffer.concat([length, typeAndData, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(256, 0); header.writeUInt32BE(256, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.concat(Array.from({ length: 256 }, () => Buffer.concat([Buffer.from([0]), randomBytes(256 * 4)])));
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

test("native images survive bounded projection in ordinary chats, stay usable via media.read and replay without inline bytes", async () => {
  const root = tempRoot("sp-native-images-");
  const config = await makeConfig();
  const bytes = png();
  const data = bytes.toString("base64");
  expect(data.length).toBeGreaterThan(256 * 1024);
  const savedPath = path.join(root, "native-saved.png");
  fs.writeFileSync(savedPath, bytes);
  const repo = makeRepo(root, { "README.md": "hello\n" });
  const raw = await Effect.runPromise(readProviderReplayTranscript(new URL("../orchestration-v2/testkit/fixtures/simple/codex_transcript.ndjson", import.meta.url)).pipe(Effect.provide(NodeServices.layer)));
  const threadId = "01a13ebb-87b9-7671-bc05-8d1ba7413b9c";
  const turnId = "01a13ebb-8815-75c2-9e99-dfc2aeaeb880";
  const prompt = "A transparent pixel caveman";
  const images = [
    { id: "saved", savedPath, result: data, revisedPrompt: prompt, transparentBackground: true },
    { id: "../../outside/\\untrusted-id", result: data, revisedPrompt: prompt, transparentBackground: false },
    { id: "completion-only", result: data },
    { id: "completed-on-start", result: data },
    { id: "quota", result: "", failure: { type: "usageLimitExceeded", limitId: "image_generation", resetsAt: 1782623000 } },
    { id: "invalid-bytes", result: Buffer.from("not an image").toString("base64") },
  ];
  const entries = images.flatMap((item) => {
    const phases = item.id === "completion-only" ? ["completed"] : item.id === "completed-on-start" ? ["started"] : ["started", "completed"];
    return phases.map((phase) => ({ type: "emit_inbound" as const, label: `image/${item.id}/${phase}`, frame: {
      method: `item/${phase}`, params: { threadId, turnId,
        item: phase === "started" && item.id !== "completed-on-start" ? { type: "imageGeneration", id: item.id, status: "in_progress", result: "" } : { type: "imageGeneration", status: "completed", ...item },
        ...(phase === "started" ? { startedAtMs: 1792053843032 } : { completedAtMs: 1792053843048 }),
      },
    } }));
  });
  const end = raw.entries.findIndex((e) => e.type === "emit_inbound" && e.label === "turn/completed");
  const transcript = await Effect.runPromise(CodexOrchestratorReplayHarness.decodeTranscript({ ...raw, entries: [...raw.entries.slice(0, end), ...entries, ...raw.entries.slice(end)] }));
  const driver = await Effect.runPromise(CodexReplay.makeReplayDriver(transcript));
  const registry = codexRegistry({ transcript, driver }).pipe(Layer.provide(McpProviderSessions.layer), Layer.orDie);
  const runtime = await startRuntime(config, "fake-claude", undefined, { registry });
  const client = connect(runtime.url, runtime.token);
  const stored: string[] = [];
  try {
    const workspace = await createReady(client, { request_id: "images", repo: { path: repo }, title: "Images", engine: "codex", options: { model: "gpt-5-nano" } });
    // The recorded turn's cwd is the actual workspace, not a replay wildcard.
    for (const entry of transcript.entries) {
      const frame = entry.type === "expect_outbound" ? entry.frame as { method?: string; params?: object } : undefined;
      if (frame?.method === "turn/start") Object.assign(frame.params!, { cwd: workspace.root_path });
    }
    const events: SessionEvent[] = [];
    const model = new SessionModel();
    const attached = await client.attach(workspace.session_id, 0, (e) => { events.push(e); model.apply(e); });
    await client.call("turn.submit", { request_id: "images-turn", session_id: workspace.session_id, kind: "followup", input: { text: PROMPT } });
    await until(() => events.some((e) => e.type === "turn.done"), 30_000);
    const ids = new Set(events.filter((e) => e.type === "tool.started" && e.payload.name === "image_generation").map((e) => e.item_id));
    const done = events.filter((e): e is Extract<SessionEvent, { type: "tool.done" }> => e.type === "tool.done" && ids.has(e.item_id));
    const replayState = await Effect.runPromise(Ref.get(driver.state));
    expect(replayState.failure?.message).toBeUndefined();
    expect(done, JSON.stringify(events, null, 2)).toHaveLength(6);
    expect(done.slice(0, 4).map((e) => e.payload.status)).toEqual(["completed", "completed", "completed", "completed"]);
    expect(done[0]!.payload.result).toEqual({ saved_path: savedPath, revised_prompt: prompt, transparent_background: true });
    expect(done[1]!.payload.result).toMatchObject({ revised_prompt: prompt, transparent_background: false });
    for (const event of done.slice(0, 4)) {
      const file = (event.payload.result as { saved_path: string }).saved_path;
      expect(path.isAbsolute(file)).toBe(true);
      if (file !== savedPath) {
        stored.push(file);
        expect(path.basename(path.dirname(file))).toBe("attachments");
        expect(path.basename(file)).not.toMatch(/outside|untrusted|\.\./);
        expect(accessOf(file)).toBe(ownerOnly(0o600));
      }
      const image = await client.call("media.read", { workspace_id: workspace.id, path: file });
      expect(image.mime_type).toBe("image/png");
      expect(Buffer.from(image.data, "base64")).toEqual(bytes);
    }
    expect(done[4]!.payload).toMatchObject({ status: "failed", error: "Image generation usage limit exceeded (image_generation). Resets at 1782623000 (Unix seconds)." });
    expect(done[5]!.payload).toMatchObject({ status: "failed", error: "Generated image is not a supported raster image." });
    const artifacts = model.snapshot().artifacts.filter((a) => a.kind === "image");
    expect(artifacts.map((a) => a.src)).toEqual(done.slice(0, 4).map((e) => (e.payload.result as { saved_path: string }).saved_path));
    expect(JSON.stringify(events)).not.toContain(data);
    expect(done.every((e) => JSON.stringify(e).length < 16_384)).toBe(true);
    const db = new DatabaseSync(config.dbPath, { readOnly: true });
    try {
      const journal = db.prepare("SELECT event FROM caveman_sp_events WHERE session_id = ?").all(workspace.session_id) as { event: string }[];
      expect(journal.every((row) => !row.event.includes(data))).toBe(true);
      const domain = db.prepare("SELECT payload_json FROM orchestration_events WHERE event_type = 'turn-item.updated'").all() as { payload_json: string }[];
      expect(domain.length).toBeGreaterThan(0);
      expect(domain.every((row) => !row.payload_json.includes(data))).toBe(true);
    } finally { db.close(); }
    // Reattach to the durable journal, not the adapter: references and artifacts survive.
    const replay: SessionEvent[] = [];
    const replayModel = new SessionModel();
    await attached.detach();
    await client.attach(workspace.session_id, 0, (e) => { replay.push(e); replayModel.apply(e); });
    await until(() => replay.some((e) => e.type === "turn.done"));
    expect(replayModel.snapshot().artifacts).toEqual(model.snapshot().artifacts);
  } finally {
    client.close();
    await runtime.close();
    for (const file of stored) fs.rmSync(file, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(config.baseDir, { recursive: true, force: true });
  }
}, 60_000);
