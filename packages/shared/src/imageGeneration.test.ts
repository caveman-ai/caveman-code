import { describe, expect, test } from "vitest";
import { isImageGeneration, MAX_GENERATED_IMAGES, readGeneratedImagePaths } from "./imageGeneration.ts";

describe("bounded generated-image references", () => {
  test("keeps eight whole paths in order, including Windows and spaces", () => {
    const paths = ["C:\\work\\first.PNG", "/tmp/a moon.webp", ...Array.from({ length: 6 }, (_, i) => `/tmp/${i}.png`)];
    expect(paths).toHaveLength(MAX_GENERATED_IMAGES);
    expect(readGeneratedImagePaths(paths)).toEqual(paths);
    expect(readGeneratedImagePaths(paths)).not.toBe(paths);
  });
  test.each([
    null, [], "x.png", Array(9).fill("/tmp/a.png"), [42], [""], ["/tmp/bad\0.png"],
    ["https://example.com/a.png"], ["file:///etc/a.png"], ["data:image/png;base64,AAAA.png"],
    ["//server/share/a.png"], ["\\\\server\\share\\a.png"], ["/tmp/a.svg"],
    ["/" + "x".repeat(4_096) + ".png"], ["/" + "月".repeat(1_400) + ".png"],
    Array(8).fill("/" + "x".repeat(1_100) + ".png"),
  ])("rejects malformed, network, active-media and over-budget references (%#)", (paths) => {
    expect(readGeneratedImagePaths(paths)).toBeUndefined();
  });
  test("the shared classifier is specific to generation, including MCP/dynamic namespaces", () => {
    for (const name of ["image_generation", "images.generate_image", "mcp__studio__generate_images", "art/imageGeneration", "imagegen"]) expect(isImageGeneration(name)).toBe(true);
    for (const name of ["imageView", "view_image", "image_generation_extra", "browser.screenshot", "my_generate_image"]) expect(isImageGeneration(name)).toBe(false);
  });
});
