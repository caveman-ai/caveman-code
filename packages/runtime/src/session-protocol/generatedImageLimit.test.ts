// Verify the declared 16 MiB boundary over the actual bounded stream and authenticated media RPC.
import * as fs from "node:fs";
import * as path from "node:path";
import { crc32 } from "node:zlib";
import { createHash } from "node:crypto";
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
import { MAX_IMAGE_BYTES } from "./mediaRead.ts";
import { createReady, makeConfig, makeRepo, orchestratorOf, PROMPT, startRuntime, tempRoot, until } from "./testHarness.ts";

function iconAtLimit(): Buffer {
  const icon = fs.readFileSync(new URL("../../../../apps/desktop/resources/icon.png", import.meta.url));
  expect(icon.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(icon.subarray(-8, -4).toString()).toBe("IEND");
  // A legal private ancillary PNG chunk changes file size, never the source artwork or pixel stream.
  const data = Buffer.alloc(MAX_IMAGE_BYTES - icon.length - 12);
  const body = Buffer.concat([Buffer.from("caVe"), data]);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body));
  const bytes = Buffer.concat([icon.subarray(0, -12), length, body, checksum, icon.subarray(-12)]);
  expect(bytes.length).toBe(MAX_IMAGE_BYTES);
  for (let i = 8; i < bytes.length;) {
    const size = bytes.readUInt32BE(i);
    expect(crc32(bytes.subarray(i + 4, i + 8 + size))).toBe(bytes.readUInt32BE(i + 8 + size));
    i += size + 12;
  }
  return bytes;
}

test("a real repository PNG at 16 MiB survives native persistence/media transport; 16 MiB + 1 is rejected", async () => {
  const root = tempRoot("sp-image-limit-");
  const config = await makeConfig();
  const bytes = iconAtLimit();
  const data = bytes.toString("base64");
  const repo = makeRepo(root, { "README.md": "hello\n" });
  const raw = await Effect.runPromise(readProviderReplayTranscript(new URL("../orchestration-v2/testkit/fixtures/simple/codex_transcript.ndjson", import.meta.url)).pipe(Effect.provide(NodeServices.layer)));
  const threadId = "01a13ebb-87b9-7671-bc05-8d1ba7413b9c";
  const turnId = "01a13ebb-8815-75c2-9e99-dfc2aeaeb880";
  const entries = [data, Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64")].map((result, i) => ({ type: "emit_inbound" as const, label: `image-limit/${i}`, frame: { method: "item/completed", params: {
    threadId, turnId, item: { type: "imageGeneration", id: `limit-${i}`, status: "completed", result }, completedAtMs: 1792053843048,
  } } }));
  const end = raw.entries.findIndex((e) => e.type === "emit_inbound" && e.label === "turn/completed");
  const transcript = await Effect.runPromise(CodexOrchestratorReplayHarness.decodeTranscript({ ...raw, entries: [...raw.entries.slice(0, end), ...entries, ...raw.entries.slice(end)] }));
  const driver = await Effect.runPromise(CodexReplay.makeReplayDriver(transcript));
  const registry = codexRegistry({ transcript, driver, serverConfig: config }).pipe(Layer.provide(McpProviderSessions.layer), Layer.orDie);
  const runtime = await startRuntime(config, "fake-claude", undefined, { registry, realResourceCleanup: true });
  const dropped: string[] = [];
  const listenerWarnings: string[] = [];
  const onWarning = (warning: Error) => { if (warning.name === "MaxListenersExceededWarning") listenerWarnings.push(warning.message); };
  process.on("warning", onWarning);
  const client = connect(runtime.url, runtime.token, (state, error) => { if (state === "closed") dropped.push(String(error)); });
  try {
    const workspace = await createReady(client, { request_id: "image-limit", repo: { path: repo }, title: "Image limit", engine: "codex", options: { model: "gpt-5-nano" } });
    for (const entry of transcript.entries) {
      const frame = entry.type === "expect_outbound" ? entry.frame as { method?: string; params?: object } : undefined;
      if (frame?.method === "turn/start") Object.assign(frame.params!, { cwd: workspace.root_path });
    }
    const events: SessionEvent[] = [];
    await client.attach(workspace.session_id, 0, (e) => events.push(e));
    await client.call("turn.submit", { request_id: "limit-turn", session_id: workspace.session_id, kind: "followup", input: { text: PROMPT } });
    await until(() => events.some((e) => e.type === "turn.done"), 30_000);
    const imageIds = new Set(events.filter((e) => e.type === "tool.started" && e.payload.name === "image_generation").map((e) => e.item_id));
    const done = events.filter((e): e is Extract<SessionEvent, { type: "tool.done" }> => e.type === "tool.done" && imageIds.has(e.item_id));
    expect(done).toHaveLength(2);
    expect(done[0]!.payload.status).toBe("completed");
    expect(done[1]!.payload).toMatchObject({ status: "failed", error: "Generated image is over 16 MB." });
    const file = (done[0]!.payload.result as { saved_path: string }).saved_path;
    expect(path.dirname(file)).toBe(config.attachmentsDir);
    expect(fs.statSync(file).size).toBe(MAX_IMAGE_BYTES);
    const image = await client.call("media.read", { workspace_id: workspace.id, path: file });
    const received = Buffer.from(image.data, "base64");
    expect(received.length).toBe(MAX_IMAGE_BYTES);
    expect(createHash("sha256").update(received).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(image.mime_type).toBe("image/png");
    // The gallery accepts eight images. Concurrent maximum-size reads must be
    // paced, not overflow the outbox and trigger an endless reconnect/retry loop.
    const expectedHash = createHash("sha256").update(bytes).digest("hex");
    const hashes = await Promise.all(Array.from({ length: 8 }, async () => {
      const next = await client.call("media.read", { workspace_id: workspace.id, path: file });
      return createHash("sha256").update(Buffer.from(next.data, "base64")).digest("hex");
    }));
    expect(hashes).toEqual(Array(8).fill(expectedHash));
    expect(dropped).toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(listenerWarnings).toEqual([]);
    expect(JSON.stringify(events).length).toBeLessThan(32_768);
    expect(fs.readdirSync(config.attachmentsDir)).toHaveLength(1);
    await Effect.runPromise(orchestratorOf(runtime).dispatch({ type: "thread.delete", commandId: CommandId.make("delete-limit-image"), threadId: ThreadId.make(`caveman:${workspace.id}`) }));
    await until(() => !fs.existsSync(file));
  } finally {
    process.off("warning", onWarning);
    client.close();
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(config.baseDir, { recursive: true, force: true });
  }
}, 60_000);
