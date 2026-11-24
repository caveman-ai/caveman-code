// turn.submit's inline attachments land in upstream attachment store, where the engine adapters read them.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import { PNG as PNGImage } from "pngjs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { INLINE_IMAGE_MAX_BYTES, inlineAttachmentData, readChatImage, storeTurnAttachments } from "./attachments.ts";
import { makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

// A 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("storeTurnAttachments", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-attach-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("writes each attachment under the thread's own id, where the engines look", () => {
    const stored = storeTurnAttachments(dir, "caveman:abc", [
      { type: "image", name: "dot.png", mime_type: "image/PNG", data: PNG },
      { type: "file", name: "notes.md", mime_type: "text/markdown", data: Buffer.from("# hi\n").toString("base64") },
    ]);
    expect(stored.attachments.map((a) => [a.type, a.name, a.mimeType, a.sizeBytes])).toEqual([
      ["image", "dot.png", "image/png", Buffer.from(PNG, "base64").length],
      ["file", "notes.md", "text/markdown", 5],
    ]);
    for (const attachment of stored.attachments) {
      expect(attachment.id).toMatch(/^caveman-abc-[0-9a-f-]{36}-(png|md)$/);
      expect(fs.existsSync(resolveAttachmentPath({ attachmentsDir: dir, attachment })!)).toBe(true);
    }
    expect(stored.paths).toHaveLength(2);
    expect(fs.readFileSync(stored.paths[1]!, "utf8")).toBe("# hi\n");
    // Small images ride in the journal; files and large images do not.
    expect(inlineAttachmentData(dir, stored.attachments[0])).toBe(PNG);
    expect(inlineAttachmentData(dir, stored.attachments[1])).toBeUndefined();
    expect(inlineAttachmentData(dir, { ...stored.attachments[0], sizeBytes: INLINE_IMAGE_MAX_BYTES + 1 })).toBeUndefined();
  });

  test("attachment.read serves this chat's and its fork sources' images by id, by their bytes; any other id reads as missing", async () => {
    const stored = storeTurnAttachments(dir, "caveman:own", [
      { type: "image", name: "big.png", mime_type: "image/png", data: PNG },
      { type: "file", name: "fake.png", mime_type: "text/plain", data: Buffer.from("not an image").toString("base64") },
    ]);
    const [image, file] = stored.attachments.map((a) => a.id);
    const own = await readChatImage({ attachmentsDir: dir, attachmentId: image!, threadIds: ["caveman:own"] });
    expect(own.kind === "image" && [own.mime, own.bytes.toString("base64")]).toEqual(["image/png", PNG]);
    // A fork reads the images of the chat it came from.
    expect((await readChatImage({ attachmentsDir: dir, attachmentId: image!, threadIds: ["caveman:fork", "caveman:own"] })).kind).toBe("image");
    expect(await readChatImage({ attachmentsDir: dir, attachmentId: image!, threadIds: ["caveman:other"] })).toEqual({ kind: "missing" });
    expect((await readChatImage({ attachmentsDir: dir, attachmentId: file!, threadIds: ["caveman:own"] })).kind).toBe("refused");
    expect(await readChatImage({ attachmentsDir: dir, attachmentId: "../../etc/passwd", threadIds: ["caveman:own"] })).toEqual({ kind: "missing" });
  });

  test("an image no model takes as one (SVG, BMP) goes as a file, opened by its path", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64");
    const stored = storeTurnAttachments(dir, "caveman:svg", [
      { type: "image", name: "diagram.svg", mime_type: "image/svg+xml", data: svg },
      { type: "image", name: "old.bmp", mime_type: "image/bmp", data: "Qk0=" },
      { type: "image", name: "dot.webp", mime_type: "image/webp", data: PNG },
    ]);
    expect(stored.attachments.map((a) => [a.type, a.name, a.mimeType])).toEqual([
      ["file", "diagram.svg", "image/svg+xml"],
      ["file", "old.bmp", "image/bmp"],
      ["image", "dot.webp", "image/webp"],
    ]);
    expect(stored.paths[0]!.endsWith(".svg")).toBe(true);
  });

  test("a pasted SVG without an extension keeps one, so the agent knows what it opens (T3 #21355)", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64");
    const stored = storeTurnAttachments(dir, "caveman:svg-paste", [
      { type: "file", name: "Pasted image", mime_type: "image/svg+xml", data: svg },
      { type: "file", name: "logo", mime_type: "application/octet-stream", data: svg },
    ]);
    expect(stored.attachments.map((a) => [a.type, a.name])).toEqual([
      ["file", "Pasted image.svg"],
      ["file", "logo"],
    ]);
    expect(stored.paths[0]!.endsWith(".svg")).toBe(true);
  });

  test("refuses what an engine cannot take, before writing anything", () => {
    const before = fs.readdirSync(dir).length;
    const big = Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64");
    expect(() => storeTurnAttachments(dir, "t", [{ type: "image", name: "x.txt", mime_type: "text/plain", data: "aGk=" }])).toThrow(/as an image but is text\/plain/);
    expect(() => storeTurnAttachments(dir, "t", [{ type: "file", name: "empty.txt", mime_type: "text/plain", data: "" }])).toThrow(/empty/);
    expect(() => storeTurnAttachments(dir, "t", [{ type: "image", name: "huge.png", mime_type: "image/png", data: big }])).toThrow(/cannot be attached/);
    const many = Array.from({ length: 101 }, (_, i) => ({ type: "file" as const, name: `f${i}.txt`, mime_type: "text/plain", data: "aGk=" }));
    expect(() => storeTurnAttachments(dir, "t", many)).toThrow(/up to 100/);
    expect(fs.readdirSync(dir).length).toBe(before);
    expect(storeTurnAttachments(dir, "t", [])).toEqual({ attachments: [], paths: [] });
  });
});

describe("turn.submit with attachments on a real Claude adapter", () => {
  let root: string;
  let runtime: Awaited<ReturnType<typeof startRuntime>>;
  let client: ReturnType<typeof connect>;
  beforeAll(async () => {
    root = tempRoot("sp-attach-it-");
    runtime = await startRuntime(await makeConfig(), "fake-claude");
    client = connect(runtime.url, runtime.token);
  });
  afterAll(async () => {
    client.close();
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("the engine gets the image as image content and the file by its path; the chat shows the image", async () => {
    const w = await client.call("workspace.create", { request_id: "attach", repo: { path: makeRepo(root, { "README.md": "hi\n" }) }, engine: "claude-agent", options: { model: MODEL, access: "full" } });
    const events: Array<SessionEvent> = [];
    await client.attach(w.session_id, 0, (e) => events.push(e));
    await client.call("turn.submit", {
      request_id: "attach-1",
      session_id: w.session_id,
      kind: "followup",
      input: {
        text: "look",
        attachments: [
          { type: "image", name: "dot.png", mime_type: "image/png", data: PNG },
          { type: "file", name: "notes.md", mime_type: "text/markdown", data: Buffer.from("# hi\n").toString("base64") },
        ],
      },
    });
    await until(() => events.some((e) => e.type === "turn.done"), 30_000);
    const user = events.find((e) => e.type === "message.done" && e.payload.role === "user");
    expect(user?.type === "message.done" && user.payload).toMatchObject({
      text: "look",
      attachments: [
        { type: "image", name: "dot.png", mime_type: "image/png", data: PNG },
        { type: "file", name: "notes.md", mime_type: "text/markdown", data: "" },
      ],
    });
    const answer = events.flatMap((e) => (e.type === "message.done" && e.payload.role === "assistant" ? [e.payload.text] : [])).at(-1) ?? "";
    expect(answer).toMatch(/\[Attached file "notes\.md" is saved at: [^\]]+-md\.md\]/);
    expect(answer).toContain(`images=1 image/png:${Buffer.from(PNG, "base64").length}`);
    expect(events.find((e) => e.type === "turn.done")?.payload).toEqual({ status: "completed" });

    // An image that is not one is refused with the reason, and no turn starts.
    await expect(
      client.call("turn.submit", { request_id: "attach-2", session_id: w.session_id, kind: "followup", input: { text: "x", attachments: [{ type: "image", name: "a.txt", mime_type: "text/plain", data: "aGk=" }] } }),
    ).rejects.toMatchObject({ error: { data: { reason: "invalid_params" } } });
  });

  test("an attached screenshot over a transcript page's budget reads back whole, as chat_read's images view takes it", async () => {
    const w = await client.call("workspace.create", { request_id: "attach-page", repo: { path: makeRepo(root, { "README.md": "hi\n" }) }, engine: "claude-agent", options: { model: MODEL, access: "full" } });
    const events: Array<SessionEvent> = [];
    await client.attach(w.session_id, 0, (e) => events.push(e));
    // A real 300x300 PNG of noise: about 270 KB, which deflate cannot shrink, so its base64 is far over a 64 KiB page.
    const shot = new PNGImage({ width: 300, height: 300 });
    shot.data = Buffer.from(randomBytes(300 * 300 * 4).map((value, i) => (i % 4 === 3 ? 255 : value)));
    const data = PNGImage.sync.write(shot, { colorType: 2 }).toString("base64");
    expect(data.length).toBeGreaterThan(256 * 1024);
    await client.call("turn.submit", {
      request_id: "attach-page-1",
      session_id: w.session_id,
      kind: "followup",
      input: { text: "look at this screenshot", attachments: [{ type: "image", name: "shot.png", mime_type: "image/png", data }] },
    });
    await until(() => events.some((e) => e.type === "turn.done"), 30_000);
    // Paged back from the head at chat_read's page size, as its images view reads (outsideAgent/bridge.ts PAGE_BYTES).
    let before: number | undefined;
    let attached: string | undefined;
    for (let pages = 0; attached === undefined && pages < 10; pages++) {
      const digest = await client.call("workspace.digest", { workspace_id: w.id, transcript: { ...(before !== undefined ? { before } : {}), max_bytes: 64 * 1024 } });
      const message = digest.transcript!.events.find((e) => e.type === "message.done" && e.payload.role === "user");
      if (message?.type === "message.done") attached = message.payload.attachments?.[0]?.data;
      before = digest.transcript!.from;
    }
    expect(attached?.length).toBe(data.length);
    expect(attached === data).toBe(true);
  });

  test("an image over the inline cap comes by its id, and only its own chat reads it back (attachment.read)", async () => {
    const make = (id: string) => client.call("workspace.create", { request_id: id, repo: { path: makeRepo(root, { "README.md": "hi\n" }) }, engine: "claude-agent", options: { model: MODEL, access: "full" } });
    const [w, other] = [await make("attach-big"), await make("attach-big-other")];
    const events: Array<SessionEvent> = [];
    await client.attach(w.session_id, 0, (e) => events.push(e));
    // A real 800x800 PNG of noise: about 2.5 MB, over INLINE_IMAGE_MAX_BYTES.
    const shot = new PNGImage({ width: 800, height: 800 });
    shot.data = Buffer.from(randomBytes(800 * 800 * 4).map((value, i) => (i % 4 === 3 ? 255 : value)));
    const bytes = PNGImage.sync.write(shot, { colorType: 2 });
    expect(bytes.length).toBeGreaterThan(INLINE_IMAGE_MAX_BYTES);
    await client.call("turn.submit", { request_id: "attach-big-1", session_id: w.session_id, kind: "followup", input: { text: "big", attachments: [{ type: "image", name: "big.png", mime_type: "image/png", data: bytes.toString("base64") }] } });
    await until(() => events.some((e) => e.type === "turn.done"), 30_000);
    const user = events.find((e) => e.type === "message.done" && e.payload.role === "user");
    const attachment = user?.type === "message.done" ? user.payload.attachments?.[0] : undefined;
    expect(attachment).toMatchObject({ type: "image", name: "big.png", data: "", id: expect.stringMatching(/-png$/) });
    const read = await client.call("attachment.read", { workspace_id: w.id, attachment_id: attachment!.id! });
    expect([read.mime_type, read.size, read.data === bytes.toString("base64")]).toEqual(["image/png", bytes.length, true]);
    await expect(client.call("attachment.read", { workspace_id: other.id, attachment_id: attachment!.id! })).rejects.toMatchObject({ error: { data: { reason: "not_found" } } });
  });

  test("a new chat's first message names its large image by id too, and the engine still gets it", async () => {
    const shot = new PNGImage({ width: 800, height: 800 });
    shot.data = Buffer.from(randomBytes(800 * 800 * 4).map((value, i) => (i % 4 === 3 ? 255 : value)));
    const bytes = PNGImage.sync.write(shot, { colorType: 2 });
    const w = await client.call("workspace.create", {
      request_id: "attach-first",
      repo: { path: makeRepo(root, { "README.md": "hi\n" }) },
      engine: "claude-agent",
      options: { model: MODEL, access: "full" },
      task: { text: "first", attachments: [{ type: "image", name: "big.png", mime_type: "image/png", data: bytes.toString("base64") }, { type: "image", name: "dot.png", mime_type: "image/png", data: PNG }] },
    });
    const events: Array<SessionEvent> = [];
    await client.attach(w.session_id, 0, (e) => events.push(e));
    await until(() => events.some((e) => e.type === "turn.done"), 30_000);
    const users = events.filter((e) => e.type === "message.done" && e.payload.role === "user");
    expect(users).toHaveLength(1);
    const [big, dot] = users[0]?.type === "message.done" ? (users[0].payload.attachments ?? []) : [];
    expect(big).toMatchObject({ name: "big.png", data: "", id: expect.stringMatching(/-png$/) });
    expect(dot).toEqual({ type: "image", name: "dot.png", mime_type: "image/png", data: PNG });
    expect((await client.call("attachment.read", { workspace_id: w.id, attachment_id: big!.id! })).size).toBe(bytes.length);
    const answer = events.flatMap((e) => (e.type === "message.done" && e.payload.role === "assistant" ? [e.payload.text] : [])).at(-1) ?? "";
    expect(answer).toContain(`images=2 image/png:${bytes.length}`);
  });

  test("a document reaches the engine with the text read out of it", async () => {
    const w = await client.call("workspace.create", { request_id: "attach-doc", repo: { path: makeRepo(root, { "README.md": "hi\n" }) }, engine: "claude-agent", options: { model: MODEL, access: "full" } });
    const events: Array<SessionEvent> = [];
    await client.attach(w.session_id, 0, (e) => events.push(e));
    const rtf = String.raw`{\rtf1 Violet crates: 19}`;
    await client.call("turn.submit", {
      request_id: "attach-doc-1",
      session_id: w.session_id,
      kind: "followup",
      input: { text: "read", attachments: [{ type: "file", name: "cargo.rtf", mime_type: "application/rtf", data: Buffer.from(rtf).toString("base64") }] },
    });
    await until(() => events.some((e) => e.type === "turn.done"), 30_000);
    const answer = events.flatMap((e) => (e.type === "message.done" && e.payload.role === "assistant" ? [e.payload.text] : [])).at(-1) ?? "";
    const pattern = /\[Attached file "cargo\.rtf" is saved at: ([^\]]+-rtf\.rtf) \(text extracted to: ([^)]+)\)\]/;
    expect(answer).toMatch(pattern);
    const attached = pattern.exec(answer);
    expect(attached?.[2]).toBe(`${attached?.[1]}.txt`);
    expect(fs.readFileSync(attached![2]!, "utf8")).toContain("Violet crates: 19");
  });
});
