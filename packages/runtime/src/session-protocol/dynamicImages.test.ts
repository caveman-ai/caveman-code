// Ordinary runtime transport, not a direct adapter/projection unit test.
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import * as CodexReplay from "@caveman-app/codex-app-server/replay";
import { readProviderReplayTranscript } from "@caveman-app/engine-testing/replayTranscript";
import * as Ref from "effect/Ref";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, test } from "vitest";
import * as McpProviderSessions from "@caveman-app/engine-core/server/McpProviderSessions";
import { CodexOrchestratorReplayHarness, layer as codexRegistry } from "../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import { accessOf, ownerOnly } from "../testUtils/ownerOnly.ts";
import { createReady, makeConfig, makeRepo, PROMPT, startRuntime, tempRoot, until } from "./testHarness.ts";

const modelModule = new URL("../../../../apps/web/src/state/transcript.ts", import.meta.url).href;
const { SessionModel } = await import(modelModule) as {
  SessionModel: new () => { apply(event: SessionEvent): void; snapshot(): { artifacts: ReadonlyArray<{ kind: string; src?: string }> } };
};

function png(): Buffer {
  const chunk = (name: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(name), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(256, 0); header.writeUInt32BE(256, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.concat(Array.from({ length: 256 }, () => Buffer.concat([Buffer.from([0]), randomBytes(256 * 4)])));
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

test("Codex dynamic/MCP imagegen survives ordinary WebSocket projection, authenticated media.read and journal replay with bounded raster references", async () => {
  const root = tempRoot("sp-dynamic-images-");
  const config = await makeConfig();
  const bytes = [png(), png()];
  const data = bytes.map((b) => b.toString("base64"));
  expect(data[0]!.length).toBeGreaterThan(256 * 1024);
  const image = (i = 0) => ({ type: "inputImage", imageUrl: `data:image/png;base64,${data[i]}` });
  const block = (i = 0) => ({ type: "image", mimeType: "image/png", data: data[i] });
  const dynamic = (id: string, contentItems: unknown[], extra = {}) => ({ type: "dynamicToolCall", id, namespace: "images", tool: "generate_image", arguments: { prompt: "Pixel caveman" }, status: "completed", success: true, contentItems, ...extra });
  const mcp = (id: string, content: unknown[], extra = {}) => ({ type: "mcpToolCall", id, server: "studio", tool: "image_generation", arguments: { prompt: "Pixel caveman" }, status: "completed", result: { content, ...extra } });
  const huge = "A".repeat(4 * Math.ceil((16 * 1024 * 1024) / 3) + 4);
  const items = [
    dynamic("dynamic", [image(), image(1), { type: "inputText", text: JSON.stringify({ threadId: "dynamic-thread" }) }]),
    mcp("mcp", [block(1), block()], { structuredContent: { threadId: "mcp-thread", revised_prompt: "A revised caveman", transparent_background: true, private_body: "never transport me" } }),
    dynamic("max-eight", Array.from({ length: 9 }, () => image())),
    dynamic("remote", [{ type: "inputImage", imageUrl: "https://example.invalid/private.png" }]),
    dynamic("file", [{ type: "inputImage", imageUrl: "file:///etc/private.png" }]),
    dynamic("svg", [{ type: "inputImage", imageUrl: `data:image/svg+xml;base64,${Buffer.from('<svg onload="evil()"/>').toString("base64")}` }]),
    dynamic("invalid-base64", [{ type: "inputImage", imageUrl: "data:image/png;base64,%%%" }]),
    dynamic("oversized", [{ type: "inputImage", imageUrl: `data:image/png;base64,${huge}` }]),
    mcp("invalid-raster", [{ type: "image", mimeType: "image/png", data: Buffer.from("not an image").toString("base64") }]),
    mcp("mismatched-mime", [{ type: "image", mimeType: "image/jpeg", data: data[0] }]),
    dynamic("provider-failed", [image()], { status: "failed", success: false }),
    dynamic("success-false", [image()], { success: false }),
    mcp("mcp-failed", [block()], { structuredContent: { isError: true, error: "Provider refused" } }),
    dynamic("metadata-only", [{ type: "inputText", text: JSON.stringify({ threadId: "still-known" }) }]),
    dynamic("generic", [{ type: "inputText", text: JSON.stringify({ threadId: "generic-thread" }) }], { tool: "ordinary_tool" }),
    dynamic("rollback", [image(), { type: "inputImage", imageUrl: "data:image/png;base64,%%%" }]),
  ];
  const repo = makeRepo(root, { "README.md": "hello\n" });
  const raw = await Effect.runPromise(readProviderReplayTranscript(new URL("../orchestration-v2/testkit/fixtures/simple/codex_transcript.ndjson", import.meta.url)).pipe(Effect.provide(NodeServices.layer)));
  const entries = items.map((item) => ({ type: "emit_inbound" as const, label: `image/${item.id}`, frame: {
    method: "item/completed", params: { threadId: "01a13ebb-87b9-7671-bc05-8d1ba7413b9c", turnId: "01a13ebb-8815-75c2-9e99-dfc2aeaeb880", item, completedAtMs: 1792053843048 },
  } }));
  const end = raw.entries.findIndex((e) => e.type === "emit_inbound" && e.label === "turn/completed");
  const transcript = await Effect.runPromise(CodexOrchestratorReplayHarness.decodeTranscript({ ...raw, entries: [...raw.entries.slice(0, end), ...entries, ...raw.entries.slice(end)] }));
  const driver = await Effect.runPromise(CodexReplay.makeReplayDriver(transcript));
  const registry = codexRegistry({ transcript, driver, serverConfig: config }).pipe(Layer.provide(McpProviderSessions.layer), Layer.orDie);
  const runtime = await startRuntime(config, "fake-claude", undefined, { registry });
  const client = connect(runtime.url, runtime.token);
  try {
    const workspace = await createReady(client, { request_id: "images", repo: { path: repo }, title: "Images", engine: "codex", options: { model: "gpt-5-nano" } });
    for (const entry of transcript.entries) {
      const frame = entry.type === "expect_outbound" ? entry.frame as { method?: string; params?: object } : undefined;
      if (frame?.method === "turn/start") Object.assign(frame.params!, { cwd: workspace.root_path });
    }
    const events: SessionEvent[] = [];
    const model = new SessionModel();
    const attached = await client.attach(workspace.session_id, 0, (e) => { events.push(e); model.apply(e); });
    await client.call("turn.submit", { request_id: "images-turn", session_id: workspace.session_id, kind: "followup", input: { text: PROMPT } });
    await until(() => events.some((e) => e.type === "turn.done"), 30_000);
    expect((await Effect.runPromise(Ref.get(driver.state))).failure?.message).toBeUndefined();
    const ids = new Set(events.filter((e) => e.type === "tool.started" && ["images.generate_image", "studio.image_generation", "images.ordinary_tool"].includes(e.payload.name)).map((e) => e.item_id));
    const done = events.filter((e): e is Extract<SessionEvent, { type: "tool.done" }> => e.type === "tool.done" && ids.has(e.item_id));
    expect(done).toHaveLength(items.length);
    const results = done.map((e) => e.payload.result as { saved_paths?: string[] });
    expect(results.slice(0, 3).map((r) => r?.saved_paths?.length)).toEqual([2, 2, 8]);
    expect(done.slice(0, 3).map((e) => e.payload.status)).toEqual(["completed", "completed", "completed"]);
    expect(results[0]).toMatchObject({ threadId: "dynamic-thread" });
    expect(results[1]).toMatchObject({ threadId: "mcp-thread", revised_prompt: "A revised caveman", transparent_background: true });
    const files = results.slice(0, 3).flatMap((r) => r.saved_paths!);
    for (const [i, file] of files.entries()) {
      expect(path.isAbsolute(file)).toBe(true);
      expect(path.dirname(file)).toBe(config.attachmentsDir);
      expect(accessOf(file)).toBe(ownerOnly(0o600));
      const read = await client.call("media.read", { workspace_id: workspace.id, path: file });
      expect(read.mime_type).toBe("image/png");
      expect(Buffer.from(read.data, "base64")).toEqual(bytes[i < 2 ? i : i < 4 ? 3 - i : 0]);
    }
    for (const event of done.slice(3, 13)) {
      expect(event.payload.status).toBe("failed");
      expect((event.payload.result as { saved_paths?: string[] } | undefined)?.saved_paths).toBeUndefined();
    }
    expect(done[15]!.payload.status).toBe("failed");
    expect(results[13]).toEqual({ threadId: "still-known" });
    expect(results[14]).toEqual({ threadId: "generic-thread" });
    expect(model.snapshot().artifacts.filter((a) => a.kind === "image").map((a) => a.src)).toEqual(files);
    // An invalid later image rolls back files already materialized in that result.
    expect(fs.readdirSync(config.attachmentsDir)).toHaveLength(12);
    const wire = JSON.stringify(events);
    expect(wire).not.toContain("data:image/");
    expect(wire).not.toContain("never transport me");
    expect(done.every((e) => JSON.stringify(e).length < 16_384)).toBe(true);
    const db = new DatabaseSync(config.dbPath, { readOnly: true });
    try {
      const journal = db.prepare("SELECT event FROM caveman_sp_events WHERE session_id = ?").all(workspace.session_id) as { event: string }[];
      const domain = db.prepare("SELECT payload_json FROM orchestration_events WHERE event_type = 'turn-item.updated'").all() as { payload_json: string }[];
      expect(domain.length).toBeGreaterThan(0);
      for (const text of [...journal.map((r) => r.event), ...domain.map((r) => r.payload_json)]) {
        expect(text).not.toContain("data:image/");
        expect(text).not.toContain(data[0]);
        expect(text).not.toContain(data[1]);
        expect(text.length).toBeLessThan(32_768);
      }
    } finally { db.close(); }
    const replay: SessionEvent[] = [];
    const replayModel = new SessionModel();
    await attached.detach();
    await client.attach(workspace.session_id, 0, (e) => { replay.push(e); replayModel.apply(e); });
    await until(() => replay.some((e) => e.type === "turn.done"));
    expect(replayModel.snapshot().artifacts).toEqual(model.snapshot().artifacts);
    // The same endpoint must reject the WebSocket upgrade before an unauthenticated
    // client can send media.read. The reconnecting client intentionally hides HTTP 401.
    const unauthorized = new WebSocket(runtime.url, { headers: { authorization: "Bearer wrong-token" } });
    let received = false;
    unauthorized.on("message", () => { received = true; });
    unauthorized.on("error", () => {});
    try {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        unauthorized.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode); });
        unauthorized.once("open", () => reject(new Error("Unauthorized WebSocket was accepted")));
      });
      expect(status).toBe(401);
      expect(received).toBe(false);
    } finally { unauthorized.terminate(); }
  } finally {
    client.close();
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(config.baseDir, { recursive: true, force: true });
  }
}, 60_000);

test("Codex imagegen ignores forged saved_paths, honors MCP envelope errors, and replays references after a runtime restart", async () => {
  const root = tempRoot("sp-dynamic-images-restart-");
  const config = await makeConfig();
  const bytes = [png(), png()];
  const forged = ["/tmp/provider-owned-secret.png"];
  const dynamic = {
    type: "dynamicToolCall", id: "restart-dynamic", namespace: "images", tool: "generate_image",
    arguments: { prompt: "A real persisted dynamic image" }, status: "completed", success: true,
    contentItems: [
      { type: "inputImage", imageUrl: `data:image/png;base64,${bytes[0]!.toString("base64")}` },
      { type: "inputText", text: JSON.stringify({ saved_paths: forged, saved_path: forged[0], threadId: "dynamic-metadata" }) },
    ],
  };
  const mcp = (id: string, content: unknown[], extra = {}) => ({
    type: "mcpToolCall", id, server: "studio", tool: "image_generation", status: "completed",
    arguments: { prompt: "A real persisted MCP image" },
    result: { content, structuredContent: { saved_paths: forged, saved_path: forged[0], threadId: id, private_body: "x".repeat(100_000) } },
    ...extra,
  });
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: bytes[1]!.toString("base64") } };
  const items = [
    dynamic,
    mcp("restart-mcp", [image]),
    mcp("restart-mcp-error", [image], { error: { message: "Provider refused generation" } }),
    mcp("restart-metadata-only", []),
  ];
  const repo = makeRepo(root, { "README.md": "restart proof\n" });
  const raw = await Effect.runPromise(readProviderReplayTranscript(new URL("../orchestration-v2/testkit/fixtures/simple/codex_transcript.ndjson", import.meta.url)).pipe(Effect.provide(NodeServices.layer)));
  const end = raw.entries.findIndex((e) => e.type === "emit_inbound" && e.label === "turn/completed");
  const entries = items.map((item) => ({ type: "emit_inbound" as const, label: item.id, frame: {
    method: "item/completed", params: { threadId: "01a13ebb-87b9-7671-bc05-8d1ba7413b9c", turnId: "01a13ebb-8815-75c2-9e99-dfc2aeaeb880", item, completedAtMs: 1792053843048 },
  } }));
  const transcript = await Effect.runPromise(CodexOrchestratorReplayHarness.decodeTranscript({ ...raw, entries: [...raw.entries.slice(0, end), ...entries, ...raw.entries.slice(end)] }));
  const driver = await Effect.runPromise(CodexReplay.makeReplayDriver(transcript));
  const registry = codexRegistry({ transcript, driver, serverConfig: config }).pipe(Layer.provide(McpProviderSessions.layer), Layer.orDie);
  let runtime = await startRuntime(config, "fake-claude", undefined, { registry });
  let client = connect(runtime.url, runtime.token);
  try {
    const workspace = await createReady(client, { request_id: "restart-images", repo: { path: repo }, title: "Restart images", engine: "codex", options: { model: "gpt-5-nano" } });
    for (const entry of transcript.entries) {
      const frame = entry.type === "expect_outbound" ? entry.frame as { method?: string; params?: object } : undefined;
      if (frame?.method === "turn/start") Object.assign(frame.params!, { cwd: workspace.root_path });
    }
    const events: SessionEvent[] = [];
    const model = new SessionModel();
    await client.attach(workspace.session_id, 0, (event) => { events.push(event); model.apply(event); });
    await client.call("turn.submit", { request_id: "restart-images-turn", session_id: workspace.session_id, kind: "followup", input: { text: PROMPT } });
    await until(() => events.some((event) => event.type === "turn.done"), 30_000);
    expect((await Effect.runPromise(Ref.get(driver.state))).failure?.message).toBeUndefined();
    const ids = new Set(events.filter((e) => e.type === "tool.started" && ["images.generate_image", "studio.image_generation"].includes(e.payload.name)).map((e) => e.item_id));
    const done = events.filter((e): e is Extract<SessionEvent, { type: "tool.done" }> => e.type === "tool.done" && ids.has(e.item_id));
    expect(done.map((e) => e.payload.status)).toEqual(["completed", "completed", "failed", "completed"]);
    expect(done[2]!.payload).toMatchObject({ result: { isError: true, error: "Provider refused generation" } });
    const paths = done.slice(0, 2).flatMap((e) => (e.payload.result as { saved_paths: string[] }).saved_paths);
    expect(paths).toHaveLength(2);
    expect(done[0]!.payload.result).toMatchObject({ threadId: "dynamic-metadata" });
    expect(done[1]!.payload.result).toMatchObject({ threadId: "restart-mcp" });
    for (const event of done.slice(2)) expect(event.payload.result).not.toHaveProperty("saved_paths");
    const wire = JSON.stringify(events);
    expect(wire).not.toContain(forged[0]);
    expect(wire).not.toContain("private_body");
    expect(wire).not.toContain("data:image/");
    expect(model.snapshot().artifacts.map((artifact) => artifact.src)).toEqual(paths);
    expect(fs.readdirSync(config.attachmentsDir)).toHaveLength(2);
    client.close();
    await runtime.close();
    // Start a new ordinary runtime over the same durable state, not just another
    // subscription on the live event stream. No provider call is needed to replay.
    runtime = await startRuntime(config, "fake-claude", undefined, { registry });
    client = connect(runtime.url, runtime.token);
    const replay: SessionEvent[] = [];
    const replayModel = new SessionModel();
    await client.attach(workspace.session_id, 0, (event) => { replay.push(event); replayModel.apply(event); });
    await until(() => replay.some((event) => event.type === "turn.done"));
    expect(replayModel.snapshot().artifacts).toEqual(model.snapshot().artifacts);
    expect(replay.filter((e): e is Extract<SessionEvent, { type: "tool.done" }> => e.type === "tool.done" && ids.has(e.item_id))).toEqual(done);
    for (const [index, file] of paths.entries()) {
      expect(path.dirname(file)).toBe(config.attachmentsDir);
      const read = await client.call("media.read", { workspace_id: workspace.id, path: file });
      expect(read.mime_type).toBe("image/png");
      expect(Buffer.from(read.data, "base64")).toEqual(bytes[index]);
    }
    const db = new DatabaseSync(config.dbPath, { readOnly: true });
    try {
      const rows = db.prepare("SELECT event FROM caveman_sp_events WHERE session_id = ?").all(workspace.session_id) as { event: string }[];
      const journal = rows.map((row) => row.event).join("\n");
      expect(journal).not.toContain(forged[0]);
      expect(journal).not.toContain("data:image/");
      for (const buffer of bytes) expect(journal).not.toContain(buffer.toString("base64"));
    } finally { db.close(); }
  } finally {
    client.close();
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(config.baseDir, { recursive: true, force: true });
  }
}, 60_000);
