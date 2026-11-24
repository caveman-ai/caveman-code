import { expect, test } from "vitest";
import { codexImageViewToolItem } from "./CodexImageView.ts";

test.each(["/tmp/image.png", "output/image.webp", "C:\\art\\moon.jpg"])("native image reads retain their bounded path: %s", (path) => {
  for (const completed of [false, true]) {
    expect(codexImageViewToolItem({ type: "imageView", id: "image", path }, completed)).toEqual({
      id: "image", type: "dynamicToolCall", tool: "view_image", arguments: { path }, status: completed ? "completed" : "inProgress",
    });
  }
});

test.each(["", "  ", "//server/secret.png", "\\\\server\\secret.png", "/tmp/a\0.png", "a".repeat(4097), "😀".repeat(1500)])("invalid image view paths never enter tool input", (path) => {
  const tool = codexImageViewToolItem({ type: "imageView", id: "view", path }, true);
  expect(tool).toMatchObject({ status: "failed", arguments: {}, success: false, contentItems: [{ type: "inputText", text: "Image view has an invalid path." }] });
});
