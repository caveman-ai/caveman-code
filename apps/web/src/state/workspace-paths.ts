// Paths as the chat shows them and as fs.read takes them: relative to the
// chat's own folder (Workspace.root_path). Engines often name files by their
// absolute path (Claude Agent's Read and Edit, Codex's file changes), which is
// noise on screen and which fs.read refuses (WorkspacePath is relative).
import { isWindowsAbsolutePath, workspaceRelativeFilePath } from "@caveman-app/shared/path";
import type { Artifact } from "./transcript-model.ts";

const trim = (root: string) => root.replace(/[/\\]+$/, "");
// macOS reaches /tmp, /var and /etc through /private: an engine may report either spelling.
const unprivate = (path: string) => path.replace(/^\/private(?=\/(?:tmp|var|etc)(?:\/|$))/, "");

/** A path's last name: "retry.go" for "src/retry.go". */
export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** `path` relative to `root` when it lies inside it ("." for the root itself); any other path as it was. */
export function workspacePath(path: string, root: string | null | undefined): string {
  if (!root) return path;
  // A Windows folder takes either separator and any case; the relative path uses `/`, as fs.read does.
  if (isWindowsAbsolutePath(root)) return workspaceRelativeFilePath(path, root) ?? path;
  const base = unprivate(trim(root));
  if (!base) return path;
  const abs = unprivate(path);
  if (abs === base) return ".";
  return abs.startsWith(`${base}/`) ? abs.slice(base.length + 1) : path;
}

/** Words that name paths ("a.ts, b.ts", "retry in /…/src"): every path inside the chat's folder relative to it. */
export function workspaceText(text: string, root: string | null | undefined): string {
  const base = root ? trim(root) : "";
  if (!base) return text;
  if (isWindowsAbsolutePath(base)) {
    // A Windows folder takes either separator and any case, as workspacePath reads it.
    const folder = [...base].map((c) => (c === "/" || c === "\\" ? "[/\\\\]" : c.replace(/[.*+?^${}()|[\]]/g, "\\$&"))).join("");
    if (new RegExp(`^${folder}$`, "i").test(text)) return ".";
    return text.replace(new RegExp(`${folder}[/\\\\]`, "gi"), "");
  }
  if (text === base) return ".";
  // macOS's /tmp and /var are /private/tmp and /private/var: an engine may record either spelling of the folder.
  const plain = base.replace(/^\/private(?=\/(?:tmp|var)\/)/, "");
  const spellings = /^\/(?:tmp|var)\//.test(plain) ? [`/private${plain}/`, `${plain}/`] : [`${base}/`];
  return spellings.reduce((t, s) => t.split(s).join(""), text);
}

/** An absolute path (POSIX or a Windows drive): one the chat's folder cannot read as given. */
export const isAbsolutePath = (path: string) => /^([/\\]|[A-Za-z]:[/\\])/.test(path);

/** A path outside the chat's folder (a host path an engine wrote to): no workspace call (fs.read, editor.open) takes it. */
export const outsideWorkspace = (path: string, root: string | null | undefined) => isAbsolutePath(workspacePath(path, root));

// A streamed token hands the transcript the same artifacts again: each one, and each list, keeps the copy it got the
// last time, so the rows they are props of see the same value and skip their render (upstream #27420).
const movedFiles = new WeakMap<Artifact, { readonly root: string; readonly out: Artifact }>();
const movedLists = new WeakMap<ReadonlyArray<Artifact>, { readonly root: string; readonly out: ReadonlyArray<Artifact> }>();

/** The artifacts with each file's path relative to the chat's folder: the same array when none changed, and the same copy for the same list. */
export function withWorkspacePaths(artifacts: ReadonlyArray<Artifact>, root: string | null | undefined): ReadonlyArray<Artifact> {
  if (!root) return artifacts;
  const kept = movedLists.get(artifacts);
  if (kept?.root === root) return kept.out;
  let changed = false;
  const out = artifacts.map((a) => {
    if (a.kind !== "file") return a;
    const moved = movedFiles.get(a);
    if (moved?.root === root) {
      changed = true;
      return moved.out;
    }
    const path = workspacePath(a.path, root);
    if (path === a.path) return a;
    changed = true;
    const copy = { ...a, path };
    movedFiles.set(a, { root, out: copy });
    return copy;
  });
  const result = changed ? out : artifacts;
  movedLists.set(artifacts, { root, out: result });
  return result;
}

/** Two artifact lists hold the same artifacts, in order. */
export function sameArtifacts(a: ReadonlyArray<Artifact>, b: ReadonlyArray<Artifact>): boolean {
  return a === b || (a.length === b.length && a.every((x, i) => x === b[i]));
}
