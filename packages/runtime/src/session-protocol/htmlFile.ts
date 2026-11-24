// HTML documents explicitly opened by the person, including agent output in
// /tmp. This is not a general host-file read: fs.read/fs.write stay contained.
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { expandHomePath } from "@caveman-app/engine-core/server/pathExpansion";
import { containedPath } from "./lifecycle.ts";

export const MAX_HTML_BYTES = 16 * 1024 * 1024;
export type HtmlFile =
  | { readonly kind: "html"; readonly path: string; readonly html: string }
  | { readonly kind: "missing" }
  | { readonly kind: "refused"; readonly message: string };

/** `refused` names what is never served (the runtime's own state); it reads as missing. */
export async function readHtmlFile(given: string, home: string, worktree: string, refused?: (real: string) => boolean): Promise<HtmlFile> {
  // UNC paths can send Windows credentials to a remote host merely by opening.
  if (!given || given.includes("\0") || /^[\\/]{2}/.test(given)) return { kind: "refused", message: "Not a local HTML file path." };
  const expanded = expandHomePath(given, home);
  if (!/\.html?$/i.test(expanded)) return { kind: "refused", message: "Only .html and .htm files can open as HTML." };
  if (!path.isAbsolute(expanded) && expanded.split(/[\\/]/).includes("..")) return { kind: "refused", message: "Relative HTML paths must stay inside the workspace." };
  const file = path.isAbsolute(expanded) ? expanded : containedPath(worktree, expanded);
  if (!file) return { kind: "refused", message: "Relative HTML paths must stay inside the workspace." };
  let handle: fs.FileHandle | undefined;
  try {
    const real = await fs.realpath(file);
    if (refused?.(real)) return { kind: "missing" };
    if (!/\.html?$/i.test(real) || real.split(path.sep).includes(".git")) return { kind: "refused", message: "The target is not an HTML document." };
    if (!path.isAbsolute(expanded)) {
      const root = await fs.realpath(worktree);
      const relative = path.relative(root, real);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return { kind: "refused", message: "Relative HTML paths must stay inside the workspace." };
    }
    const inspected = await fs.stat(real);
    if (!inspected.isFile()) return { kind: "refused", message: "That path is not a regular file." };
    // Bind validation to the opened inode. NOFOLLOW rejects a leaf symlink
    // swapped in after realpath; identity checks also catch parent swaps.
    handle = await fs.open(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== inspected.dev || stat.ino !== inspected.ino) return { kind: "refused", message: "The HTML file changed while opening. Try again." };
    if (await fs.realpath(real) !== real) return { kind: "refused", message: "The HTML path changed while opening. Try again." };
    if (stat.size > MAX_HTML_BYTES) return { kind: "refused", message: "HTML previews stop at 16 MB." };
    const chunks: Buffer[] = [];
    let length = 0;
    // Do not size the read from stat: an agent may still be writing. Always
    // reach EOF (under the cap), then refuse an unstable read rather than
    // returning a silently truncated document or half a script.
    while (length <= MAX_HTML_BYTES) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_HTML_BYTES + 1 - length));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, length);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      length += bytesRead;
    }
    if (length > MAX_HTML_BYTES) return { kind: "refused", message: "HTML previews stop at 16 MB." };
    // The size at open too: a write within one tick of the kernel's clock leaves mtime and ctime as they were.
    const after = await handle.stat();
    if (after.size !== length || stat.size !== length || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) return { kind: "refused", message: "The HTML file changed while reading. Try again." };
    const html = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length));
    if (html.includes("\0")) return { kind: "refused", message: "The HTML file contains binary data." };
    return { kind: "html", path: real, html };
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return { kind: "missing" };
    return { kind: "refused", message: error instanceof TypeError ? "The HTML file is not UTF-8 text." : "The HTML file could not be read." };
  } finally {
    await handle?.close();
  }
}
