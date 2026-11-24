// upstream dynamic-tool projection returns raw contentItems and prefers MCP structuredContent.
// Capture imagegen content at the adapter boundary, before either can lose its images
// to the ordinary wire compactor. No changes to generic tool/detail image transport.
import * as fs from "node:fs/promises";
import type * as CodexSchema from "@caveman-app/codex-app-server/schema";
import { isImageGeneration, MAX_GENERATED_IMAGES, readGeneratedImagePaths } from "@caveman-app/shared/imageGeneration";
import { compactDynamicToolOutput } from "@caveman-app/shared/toolOutput";
import { storeGeneratedImage } from "../../generatedImage.ts";
import { imageMime, MAX_IMAGE_BYTES } from "../../session-protocol/mediaRead.ts";
import type { CodexDynamicToolProjection } from "./CodexAdapterV2.ts";

type Item = Extract<CodexSchema.V2ItemCompletedNotification__ThreadItem, { type: "dynamicToolCall" | "mcpToolCall" }>;
const MAX_BASE64 = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);
const RASTER = /^image\/(?:png|jpeg|gif|webp)$/i;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Validates the declared type and the bytes; remote URLs, SVG and type confusion fail closed. */
function imageData(block: Record<string, unknown>): string {
  let mime: unknown;
  let data: unknown;
  if (block.type === "inputImage") {
    const url = block.imageUrl;
    if (typeof url !== "string" || url.length > MAX_BASE64 + 64) throw new Error("Generated image has an invalid or oversized data URL.");
    const comma = url.indexOf(",");
    const header = url.slice(0, comma);
    if (comma < 0 || !/^data:image\/(?:png|jpeg|gif|webp);base64$/i.test(header)) throw new Error("Generated image must be an inline raster image.");
    mime = header.slice(5, -7).toLowerCase();
    data = url.slice(comma + 1);
  } else {
    const source = block.source === undefined ? undefined : record(block.source);
    if (source !== undefined && source.type !== "base64") throw new Error("Generated image must contain base64 raster data.");
    mime = source === undefined ? block.mimeType : source.media_type;
    data = source === undefined ? block.data : source.data;
  }
  if (typeof mime !== "string" || !RASTER.test(mime) || typeof data !== "string") throw new Error("Generated image must contain base64 raster data.");
  if (data.length > MAX_BASE64) throw new Error("Generated image is over 16 MB.");
  // storeGeneratedImage checks canonical base64 and the complete size/signature.
  // Check the declared MIME with only a short prefix, without a second full decode.
  if (imageMime("", Buffer.from(data.slice(0, 32), "base64")) !== mime.toLowerCase()) throw new Error("Generated image does not match its raster MIME type.");
  return data;
}

export async function persistCodexDynamicImages(
  projection: CodexDynamicToolProjection,
  item: Item,
  attachmentsDir: string,
  threadId: string,
): Promise<CodexDynamicToolProjection> {
  if (!isImageGeneration(projection.toolName)) return projection;
  const blocks = item.type === "dynamicToolCall" ? item.contentItems ?? [] : item.result?.content ?? [];
  const compact = { ...compactDynamicToolOutput(blocks), ...compactDynamicToolOutput(projection.output) };
  const raw = record(projection.output);
  // Only established compact metadata and bounded imagegen metadata survive. In
  // particular, never trust a server's saved_paths or arbitrary large text/URLs.
  const output = {
    ...compact,
    ...(typeof raw.revised_prompt === "string" ? { revised_prompt: raw.revised_prompt.slice(0, 2_048) } : {}),
    ...(typeof raw.transparent_background === "boolean" ? { transparent_background: raw.transparent_background } : {}),
    ...(typeof raw.error === "string" ? { error: raw.error.slice(0, 2_048) } : {}),
  };
  const failed = projection.status === "failed" || compact.isError === true || (item.type === "dynamicToolCall" && item.success === false);
  if (failed || projection.status !== "completed") {
    return { ...projection, ...(failed ? { status: "failed" } : {}), output: { ...output, ...(failed ? { isError: true } : {}) } };
  }
  const paths: string[] = [];
  try {
    // A generator returns a few images, not an unbounded content traversal.
    if (blocks.length > 32) throw new Error("Generated image output has too many content blocks.");
    for (const candidate of blocks) {
      const block = record(candidate);
      if (block.type !== "inputImage" && block.type !== "image") continue;
      paths.push(await storeGeneratedImage(attachmentsDir, threadId, imageData(block)));
      if (paths.length === MAX_GENERATED_IMAGES) break;
    }
    if (paths.length > 0 && readGeneratedImagePaths(paths) === undefined) throw new Error("Generated image references exceed the transport budget.");
    return { ...projection, output: { ...output, ...(paths.length ? { saved_paths: paths } : {}) } };
  } catch (cause) {
    // An invalid later block must not leave the earlier images orphaned.
    await Promise.all(paths.map((file) => fs.rm(file, { force: true })));
    return {
      ...projection,
      status: "failed",
      output: { ...output, isError: true, error: cause instanceof Error && !("code" in cause) ? cause.message : "Generated image could not be saved to the attachment store." },
    };
  }
}
