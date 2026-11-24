import * as fs from "node:fs/promises";
import fsNative from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import * as DateTime from "effect/DateTime";
import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@caveman-app/protocol";

import { isBoundedImagePath, storeGeneratedImage } from "./generatedImage.ts";
import { MAX_IMAGE_BYTES, readImageFile } from "./session-protocol/mediaRead.ts";
import { persistCodexImageGenerationToolItem } from "./orchestration-v2/Adapters/CodexImageGeneration.ts";
import { projectTurnItemForWire } from "./orchestration-v2/WireProjection.ts";
import { accessOf, ownerOnly } from "./testUtils/ownerOnly.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMIWFDxHwAFFAJo4L9/vgAAAABJRU5ErkJggg==";
const now = DateTime.makeUnsafe("2026-06-28T00:00:00.000Z");
const tool: OrchestrationV2TurnItem = {
  type: "dynamic_tool", id: TurnItemId.make("image"), threadId: ThreadId.make("thread"),
  runId: null, nodeId: null, providerThreadId: null, providerTurnId: null, nativeItemRef: null, parentItemId: null,
  ordinal: 1, status: "completed", title: null, toolName: "image_generation", input: {},
  startedAt: now, completedAt: now, updatedAt: now,
};

describe("native image storage and bounded wire references", () => {
  test("writes a raster under a minted safe filename, with private permissions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "native-image-store-"));
    try {
      const item = await persistCodexImageGenerationToolItem({
        type: "imageGeneration", id: "../../malicious\\id", status: "completed", arguments: {},
        output: { result: png, revised_prompt: "pixel art", transparent_background: false },
      }, dir, "../../thread/../../escape");
      expect(item.status).toBe("completed");
      expect(item.output).not.toHaveProperty("result");
      const file = item.output!.saved_path!;
      expect(path.dirname(file)).toBe(dir);
      expect(path.basename(file)).not.toMatch(/[\\/]|\.\./);
      expect(accessOf(file)).toBe(ownerOnly(0o600));
      const image = await readImageFile(file);
      expect(image.kind).toBe("image");
      if (image.kind === "image") expect(image.bytes).toEqual(Buffer.from(png, "base64"));
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  test("an exclusive-open collision never removes or overwrites the pre-existing file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "native-image-collision-"));
    const originalOpen = fsNative.promises.open;
    const sentinel = Buffer.from("another caller's existing file");
    let target = "";
    try {
      fsNative.promises.open = async (...args) => {
        if (typeof args[0] === "string" && path.dirname(args[0]) === dir) {
          target = args[0];
          // Another writer wins the race. The real filesystem rejects our wx open.
          await fs.writeFile(target, sentinel, { flag: "wx" });
        }
        return originalOpen(...args);
      };
      syncBuiltinESMExports();
      await expect(storeGeneratedImage(dir, "thread", png)).rejects.toMatchObject({ code: "EEXIST" });
      expect(await fs.readFile(target)).toEqual(sentinel);
    } finally {
      fsNative.promises.open = originalOpen;
      syncBuiltinESMExports();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses malformed base64, text/SVG, and decoded/encoded oversize before creating files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "native-image-refuse-"));
    try {
      for (const [data, error] of [
        ["", "invalid base64"], [png + "!", "invalid base64"],
        [Buffer.from("not an image").toString("base64"), "supported raster"],
        [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64"), "supported raster"],
        // MAX+1 has the same encoded length as MAX: enforce the decoded limit too.
        [Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64"), "over 16 MB"],
        ["A".repeat(4 * Math.ceil(MAX_IMAGE_BYTES / 3) + 4), "over 16 MB"],
      ]) {
        await expect(storeGeneratedImage(dir, "thread", data!)).rejects.toThrow(error);
        const failed = await persistCodexImageGenerationToolItem({
          type: "imageGeneration", id: "item", status: "completed", arguments: {}, output: { result: data! },
        }, dir, "thread");
        expect(failed.status).toBe("failed");
        expect(failed.output).not.toHaveProperty("result");
        expect(failed.output?.error).toContain(error);
      }
      expect(await fs.readdir(dir)).toEqual([]);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  test("prefers a native path without reading it or decoding a huge unused result, and reports write failures", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "native-image-write-"));
    const blocked = path.join(dir, "not-a-directory");
    try {
      await fs.writeFile(blocked, "not a directory");
      const item = { type: "imageGeneration" as const, id: "x", status: "completed" as const, arguments: {}, output: { saved_path: "/not/read.png", result: "A".repeat(32 * 1024 * 1024) } };
      expect((await persistCodexImageGenerationToolItem(item, blocked, "thread")).output).toEqual({ saved_path: "/not/read.png" });
      const failed = await persistCodexImageGenerationToolItem({ ...item, output: { result: png } }, blocked, "thread");
      expect(failed.status).toBe("failed");
      expect(failed.output).toEqual({ error: "Generated image could not be saved to the attachment store." });
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  test("keeps only bounded native metadata through repeated wire projection, never arbitrary output or base64", () => {
    const output = { saved_path: "/tmp/native.png", revised_prompt: "🦖".repeat(100_000), transparent_background: false, error: "quota ".repeat(100_000), result: "A".repeat(10 * 1024 * 1024), extra: { secret: "not-allowed" } };
    const projected = projectTurnItemForWire({ ...tool, status: "failed", output });
    const metadata = projected.type === "dynamic_tool" ? projected.output as Record<string, unknown> : {};
    expect(metadata.saved_path).toBe(output.saved_path);
    expect(metadata.transparent_background).toBe(false);
    expect(metadata.isError).toBe(true);
    expect(Buffer.byteLength(metadata.revised_prompt as string)).toBeLessThan(8_256);
    expect(Buffer.byteLength(metadata.error as string)).toBeLessThan(2_112);
    expect(metadata).not.toHaveProperty("result");
    expect(metadata).not.toHaveProperty("extra");
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(16_384);
    expect(projectTurnItemForWire(projected)).toEqual(projected);
    expect(projectTurnItemForWire({ ...tool, toolName: "other", output: { saved_path: "/tmp/native.png" } })).not.toHaveProperty("output");
  });

  test("rejects oversized paths whole, null bytes and credential-leaking network shares", async () => {
    for (const file of ["", " ", "x".repeat(4097), "🦖".repeat(1025), "/tmp/a\0.png", "//host/share.png", "\\\\host\\share.png", " //host/share.png"]) {
      expect(isBoundedImagePath(file)).toBe(false);
      expect(projectTurnItemForWire({ ...tool, output: { saved_path: file } })).not.toHaveProperty("output");
      const failed = await persistCodexImageGenerationToolItem({ type: "imageGeneration", id: "x", status: "completed", arguments: {}, output: { saved_path: file } }, "/unused", "thread");
      expect(failed.status).toBe("failed");
      expect(failed.output).toEqual({ error: "Generated image has an invalid saved path." });
    }
    expect(isBoundedImagePath("/tmp/normal.png")).toBe(true);
  });
});
