// The page an agent showed in a chat with `html_render`, for a client to draw.
// The tool stores each page as a thread attachment, its theme bootstrap
// already in its head (htmlRender/HtmlRender.ts). A chat reads only pages its
// own thread published, or one a chat it was forked from did: its transcript
// carries those.
import * as fs from "node:fs/promises";
import {
  parseAttachmentFileExtension,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPathById,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import { MAX_HTML_BYTES } from "./htmlFile.ts";

export type HtmlRenderPage =
  | { readonly kind: "html"; readonly html: string }
  | { readonly kind: "missing" }
  | { readonly kind: "refused"; readonly message: string };

export async function readHtmlRenderPage(input: {
  readonly attachmentsDir: string;
  readonly attachmentId: string;
  /** The chat's thread first, then each thread it was forked from. */
  readonly threadIds: ReadonlyArray<string>;
}): Promise<HtmlRenderPage> {
  const segment = parseThreadSegmentFromAttachmentId(input.attachmentId);
  if (segment === null || parseAttachmentFileExtension(input.attachmentId) !== "html") {
    return { kind: "refused", message: "Not an HTML page id." };
  }
  // Not this chat's page: answered as missing, so an id never says whether another chat has it.
  if (!input.threadIds.some((id) => toSafeThreadAttachmentSegment(id) === segment))
    return { kind: "missing" };
  const file = resolveAttachmentPathById({
    attachmentsDir: input.attachmentsDir,
    attachmentId: input.attachmentId,
  });
  if (file === null) return { kind: "missing" };
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return { kind: "missing" };
    if (stat.size > MAX_HTML_BYTES)
      return { kind: "refused", message: "This page is larger than 16 MB." };
    return { kind: "html", html: await fs.readFile(file, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
}
