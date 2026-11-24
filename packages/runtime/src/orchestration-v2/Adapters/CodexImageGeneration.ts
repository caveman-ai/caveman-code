import type * as CodexSchema from "@caveman-app/codex-app-server/schema";
import { isBoundedImagePath, storeGeneratedImage } from "../../generatedImage.ts";

/** Native Codex output, kept structured for the existing dynamic-tool transport. */
export interface CodexImageGenerationOutput {
  readonly saved_path?: string;
  readonly result?: string;
  readonly revised_prompt?: string;
  readonly transparent_background?: boolean;
  readonly error?: string;
}

/** Internal tool item: native image statuses are strings, unlike Codex's other tools. */
export interface CodexImageGenerationToolItem {
  readonly id: string;
  readonly type: "imageGeneration";
  readonly status: "inProgress" | "completed" | "failed";
  readonly arguments: { readonly revised_prompt?: string };
  readonly output?: CodexImageGenerationOutput;
}

type NativeImageGenerationItem = Extract<
  CodexSchema.V2ItemStartedNotification__ThreadItem | CodexSchema.V2ItemCompletedNotification__ThreadItem,
  { readonly type: "imageGeneration" }
>;

/**
 * Net-new native support (not ported from T3). Reuse dynamic-tool tracking and
 * finalization; never read a saved path here or duplicate its potentially huge base64.
 */
export function codexImageGenerationToolItem(
  item: NativeImageGenerationItem,
  completed: boolean,
): CodexImageGenerationToolItem {
  const savedPath = item.savedPath?.trim() ? item.savedPath : undefined;
  // An image in Codex's attachment store has a file id and no inline bytes.
  const result =
    savedPath === undefined && "result" in item && item.result.length > 0 ? item.result : undefined;
  const prompt = item.revisedPrompt ? { revised_prompt: item.revisedPrompt } : {};
  const terminal = completed || item.status === "completed";
  let error: string | undefined;
  if (item.failure != null) {
    // The generated schema currently has one failure variant, not a message field.
    error = `Image generation usage limit exceeded (${item.failure.limitId}).`;
    if (item.failure.resetsAt != null) {
      error += ` Resets at ${item.failure.resetsAt} (Unix seconds).`;
    }
  } else if (/^(failed|error|cancelled|canceled|interrupted|incomplete)$/i.test(item.status)) {
    error = `Image generation failed (${item.status}).`;
  } else if (terminal && savedPath === undefined && result === undefined) {
    error = "Image generation completed without an image.";
  }
  const status = error !== undefined ? "failed" : terminal ? "completed" : "inProgress";
  return {
    id: item.id,
    type: "imageGeneration",
    status,
    arguments: prompt,
    ...(status === "inProgress" ? {} : {
      output: {
        ...(savedPath === undefined ? {} : { saved_path: savedPath }),
        ...(result === undefined ? {} : { result }),
        ...prompt,
        ...(item.transparentBackground == null ? {} : { transparent_background: item.transparentBackground }),
        ...(error === undefined ? {} : { error }),
      },
    }),
  };
}

/** Handler boundary: no legacy inline bytes may reach adapter events or persistence. */
export async function persistCodexImageGenerationToolItem(
  item: CodexImageGenerationToolItem,
  attachmentsDir: string,
  threadId: string,
): Promise<CodexImageGenerationToolItem> {
  if (item.output === undefined) return item;
  const { result, saved_path, ...metadata } = item.output;
  try {
    if (saved_path !== undefined) {
      if (!isBoundedImagePath(saved_path)) throw new Error("Generated image has an invalid saved path.");
      return { ...item, output: { ...metadata, saved_path } };
    }
    if (result === undefined || item.status === "failed") return { ...item, output: metadata };
    const file = await storeGeneratedImage(attachmentsDir, threadId, result);
    return { ...item, output: { ...metadata, saved_path: file } };
  } catch (cause) {
    return {
      ...item,
      status: "failed",
      output: { ...metadata, error: cause instanceof Error && !("code" in cause) ? cause.message : "Generated image could not be saved to the attachment store." },
    };
  }
}
