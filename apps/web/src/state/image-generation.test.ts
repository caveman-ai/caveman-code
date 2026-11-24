import type { SessionEvent } from "@caveman-app/session-protocol";
import { describe, expect, test } from "vitest";
import { imagePrompt, isImageGeneration } from "./image-generation.ts";
import { SessionModel } from "./transcript.ts";

function generation(name: string, result?: unknown, status: "completed" | "failed" | "declined" = "completed") {
  const model = new SessionModel();
  const apply = (type: SessionEvent["type"], payload: unknown, cursor: number) => model.apply({ session_id: "images", item_id: "image1", turn_id: "turn1", cursor, type, payload, at: "2026-10-22T12:00:00Z" } as SessionEvent);
  apply("tool.started", { name, title: name, kind: "other", input: { prompt: "An orange moon" } }, 1);
  if (result !== undefined) apply("tool.done", { status, result, ...(status === "failed" ? { error: "Generation limit reached" } : {}) }, 2);
  return model.snapshot();
}

describe("native and MCP image generation through the transcript entry point", () => {
  test("saved_paths creates ordered generated-image artifacts without inline bytes", () => {
    const saved_paths = ["/tmp/first moon.png", "C:\\work\\second.webp"];
    for (const name of ["image_generation", "images.generate_image", "mcp__studio__generate_images"]) {
      const view = generation(name, { saved_paths, revised_prompt: "Revised" });
      expect(view.artifacts.map((a) => a.kind === "image" && a.src)).toEqual(saved_paths);
      expect(view.artifacts.map((a) => a.title)).toEqual(["Generated image 1", "Generated image 2"]);
      expect(generation(name, { saved_paths }, "failed").artifacts).toEqual([]);
    }
    expect(generation("ordinary_tool", { saved_paths }).artifacts).toEqual([]);
  });
  test("saved_paths cannot introduce network/active-media or over-budget artifacts", () => {
    for (const saved_paths of [["https://example.com/a.png"], ["//host/a.png"], ["/tmp/a.svg"], Array(9).fill("/tmp/a.png"), ["/" + "x".repeat(5_000) + ".png"]]) {
      expect(generation("images.generate_image", { saved_paths }).artifacts).toEqual([]);
    }
  });
  test.each(["image_generation", "imageGeneration", "generate_image", "generate_images", "imagegen", "mcp__art__generate_image", "art.image_gen"])("recognizes %s", (name) => {
    expect(isImageGeneration(name)).toBe(true);
    const view = generation(name);
    expect(view.items[0]).toMatchObject({ kind: "tool", verb: "Generating image", parts: [{ action: "image_generation", subject: "" }] });
    expect(view.artifacts).toEqual([]);
  });
  test.each(["read_image", "image_view", "not_image_generation", "imagegen/delete", "image_generation_extra", "browser_take_screenshot"])("does not reclassify %s", (name) => {
    expect(isImageGeneration(name)).toBe(false);
  });
  test.each(["/tmp/generated image.png", "C:\\work\\Moon.PNG", "output/art.webp"])("uses the native saved path %s, without duplicating base64", (saved_path) => {
    const view = generation("image_generation", { saved_path, result: "AAAA", revised_prompt: "A moon above a lake", transparent_background: true });
    expect(view.artifacts).toEqual([{ kind: "image", id: "image1:image:0", itemId: "image1", title: "Generated image", meta: "Generated image", src: saved_path, alt: "Generated image", line: null }]);
    expect(view.items[0]).toMatchObject({ verb: "Generated image", status: "done" });
  });
  test("supports older Codex servers' base64 PNG output", () => {
    expect(generation("image_generation", { result: "iVBORw0KGgo=\n" }).artifacts[0]).toMatchObject({ src: "data:image/png;base64,iVBORw0KGgo=" });
  });
  test("supports multiple raster MCP image blocks without interpreting SVG", () => {
    const view = generation("mcp__art__generate_image", { content: [
      { type: "image", mimeType: "image/png", data: "AAAA" },
      { type: "image", mimeType: "image/jpeg", data: "BBBB" },
      { type: "image", mimeType: "image/svg+xml", data: "<svg/>" },
    ] });
    expect(view.artifacts.map((a) => a.title)).toEqual(["Generated image 1", "Generated image 2"]);
    expect(view.artifacts.map((a) => a.kind === "image" && a.src)).toEqual(["data:image/png;base64,AAAA", "data:image/jpeg;base64,BBBB"]);
  });
  test.each(["failed", "declined"] as const)("a %s generation exposes no misleading image", (status) => {
    const view = generation("image_generation", { result: "AAAA" }, status);
    expect(view.artifacts).toEqual([]);
    expect(view.items[0]).toMatchObject({ status: status === "declined" ? "denied" : "failed" });
  });
  test.each([{}, { result: "<svg onload=evil()/>" }, { result: "https://example.com/x.png" }, { saved_path: "/tmp/secret.txt" }])("invalid or empty results do not create broken image artifacts: %j", (result) => {
    expect(generation("image_generation", result).artifacts).toEqual([]);
  });
  test("dynamic Codex inputImage blocks reach generated cards, raster-only and capped", () => {
    const data = "data:image/png;base64,iVBORw0KGgo=";
    const result = Array.from({ length: 12 }, () => ({ type: "inputImage", imageUrl: data }));
    const images = generation("image_generation", result).artifacts;
    expect(images).toHaveLength(8);
    expect(images[0]).toMatchObject({ kind: "image", src: data });
    expect(generation("image_generation", [{ type: "inputImage", imageUrl: "data:image/svg+xml;base64,AAAA" }]).artifacts).toEqual([]);
  });
  test("failure labels never say an image was generated", () => {
    expect(generation("image_generation", {}, "failed").items[0]).toMatchObject({ verb: "Image generation failed" });
    expect(generation("image_generation", {}, "declined").items[0]).toMatchObject({ verb: "Cancelled image generation" });
  });
  test("prefers the engine's revised prompt and falls back to the request", () => {
    expect(imagePrompt({ input: { prompt: " Request " }, result: { revised_prompt: " Revised " } })).toBe("Revised");
    expect(imagePrompt({ input: { prompt: " Request " }, result: null })).toBe("Request");
    expect(imagePrompt({ input: {}, result: {} })).toBeNull();
  });
});
