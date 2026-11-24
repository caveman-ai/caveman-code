// Resolve chat paths using the real directory listing, shared by code spans and clicks.
// A batch of identifiers in one answer makes one request per parent, not one per span.
import type { Client } from "@caveman-app/session-protocol/client";
import type { FileRef } from "./fileRefs.ts";
import { baseName, dirName, type Entry } from "./tree.ts";

type ListingClient = Pick<Client, "call">;
const listings = new WeakMap<ListingClient, Map<string, { at: number; entries: Promise<ReadonlyArray<Entry>> }>>();
const TTL = 5_000;

/** What `path` is in the workspace (from its parent's listing, cached a moment); null when nothing is there. */
async function entryType(client: ListingClient, workspaceId: string, path: string): Promise<Entry["type"] | null> {
  let cache = listings.get(client);
  if (!cache) listings.set(client, (cache = new Map()));
  const parent = dirName(path);
  const key = `${workspaceId}:${parent}`;
  let known = cache.get(key);
  if (!known || Date.now() - known.at >= TTL) {
    for (const [k, v] of cache) if (Date.now() - v.at >= TTL) cache.delete(k);
    const entries = client.call("fs.list", { workspace_id: workspaceId, path: parent, include_ignored: true }).then((r) => r.entries);
    known = { at: Date.now(), entries };
    cache.set(key, known);
    // A disconnected runtime must not leave an unhandled rejection or a sticky failed lookup.
    void entries.catch(() => { if (cache.get(key) === known) cache.delete(key); });
  }
  try {
    return (await known.entries).find((e) => e.path === path)?.type ?? null;
  } catch {
    return null;
  }
}

export async function isDirectory(client: ListingClient, workspaceId: string, path: string): Promise<boolean> {
  return (await entryType(client, workspaceId, path)) === "dir";
}

/**
 * In a project that is a folder inside its repository (`/repo/apps/web`), agents name files from the repository's
 * root (`apps/web/src/a.ts`): the path without the folder's own trailing names that it repeats, else null.
 * upstream (MIT, apps/web/src/workspaceBasenameLookup.ts @ 10b6779a2d, #14510).
 */
export function stripRepeatedWorkspacePrefix(relativePath: string, root: string): string | null {
  if (/^([/\\]|[A-Za-z]:[/\\])/.test(relativePath)) return null;
  const pathSegments = relativePath.split(/[\\/]+/);
  const rootSegments = root.split(/[\\/]+/).filter(Boolean);
  const fold = /^[A-Za-z]:[\\/]/.test(root) ? (segment: string | undefined) => segment?.toLowerCase() : (segment: string | undefined) => segment;
  for (let count = Math.min(rootSegments.length, pathSegments.length - 1); count > 0; count--) {
    const prefix = rootSegments.slice(-count);
    if (prefix.every((segment, index) => fold(segment) === fold(pathSegments[index]))) return pathSegments.slice(count).join("/") || null;
  }
  return null;
}

/**
 * A bare file name prefers this chat's touched files; explicit folder paths never search for a namesake. A path that
 * repeats the folder's own names (`apps/web/src/a.ts` in `/repo/apps/web`) means the one under it, when only that is there.
 */
export async function resolveReference(client: ListingClient | null, workspaceId: string, target: FileRef, known: ReadonlyArray<string> = [], root?: string | null): Promise<FileRef> {
  let path = target.path;
  if (target.directory) return target;
  const stripped = client && root ? stripRepeatedWorkspacePrefix(path, root) : null;
  if (client && stripped !== null && (await entryType(client, workspaceId, path)) === null) {
    const type = await entryType(client, workspaceId, stripped);
    if (type === "dir" && !target.line) return { path: stripped, directory: true };
    if (type !== null) return { ...target, path: stripped };
  }
  if (client && !target.line && await isDirectory(client, workspaceId, path)) return { path, directory: true };
  if (!path.includes("/")) {
    const touched = known.findLast((p) => baseName(p) === path);
    if (touched) path = touched;
    else if (client) {
      try {
        const { paths } = await client.call("fs.search", { workspace_id: workspaceId, query: path, limit: 50 });
        path = paths.filter((p) => baseName(p) === path).sort((a, b) => a.length - b.length)[0] ?? path;
      } catch { /* The viewer explains an unavailable path. */ }
    }
  }
  return { ...target, path };
}
