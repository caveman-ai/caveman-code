import { isHtmlFile } from "./browser/htmlFile.ts";
import { openSurface, type OpenOptions } from "./store.ts";

/** HTML opens as a page; a source-line link opens its source in the same browser tab. */
export function openFile(workspaceId: string, path: string, line?: number, options?: OpenOptions): string {
  return isHtmlFile(path)
    ? openSurface(workspaceId, "browser", { path, source: Boolean(line), ...(line ? { line } : {}) }, options)
    : openSurface(workspaceId, "file", { path, ...(line ? { line } : {}) }, options);
}
