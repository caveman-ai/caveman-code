import type * as CodexSchema from "@caveman-app/codex-app-server/schema";
import { isBoundedImagePath } from "../../generatedImage.ts";

/** Native image reads share ordinary tool tracking, interruption and the authenticated media viewer. */
export function codexImageViewToolItem(
  item: Extract<CodexSchema.V2ItemCompletedNotification__ThreadItem, { readonly type: "imageView" }>,
  completed: boolean,
): Extract<CodexSchema.V2ItemCompletedNotification__ThreadItem, { readonly type: "dynamicToolCall" }> {
  const valid = isBoundedImagePath(item.path);
  return {
    id: item.id,
    type: "dynamicToolCall",
    tool: "view_image",
    arguments: valid ? { path: item.path } : {},
    status: valid ? completed ? "completed" : "inProgress" : "failed",
    ...(valid ? {} : { success: false, contentItems: [{ type: "inputText", text: "Image view has an invalid path." }] }),
  };
}
