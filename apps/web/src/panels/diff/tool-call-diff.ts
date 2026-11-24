// One file-change step's recorded change (tool.diff) as Changes files. After
// upstream toolCallDiff (MIT, apps/web/src/lib/toolCallDiff.ts @ 441a4ebd65):
// engines record a full git patch, a bare hunk, or an added or deleted file's
// content, so each becomes a patch with a header; content an engine sent
// without any diff is shown as it was recorded. Our files come from our own
// patch reader (parsePatch.ts), not upstream renderer.

import type { Result } from "@caveman-app/session-protocol";
import { parsePatch, type DiffFile } from "./parsePatch.ts";

export type ToolCallRecord = Result<"tool.diff">;

const TRUNCATED = "\n… output truncated for transport";

function recorded(value: string | undefined): { text: string | undefined; truncated: boolean } {
  const truncated = value !== undefined && value.endsWith(TRUNCATED);
  return { text: truncated ? value.slice(0, -TRUNCATED.length) : value, truncated };
}

const header = (oldPath: string, newPath: string, operation: string | undefined) =>
  `diff --git ${JSON.stringify(`a/${oldPath}`)} ${JSON.stringify(`b/${newPath}`)}\n--- ${operation === "add" ? "/dev/null" : JSON.stringify(`a/${oldPath}`)}\n+++ ${operation === "delete" ? "/dev/null" : JSON.stringify(`b/${newPath}`)}\n`;

/** The step's patch with file headers, or the engine's text as it came when it is no patch at all. */
export function toolCallPatch(record: Pick<ToolCallRecord, "path" | "diff" | "changes">): string | undefined {
  let patch = record.diff;
  if (!patch) return patch;
  const change = record.changes?.[0];
  const rawFile = change?.operation === "add" || change?.operation === "delete";
  if (patch.startsWith("diff --git ") || patch.startsWith("--- ")) {
    if (!rawFile) return patch;
    // An added or deleted file's content can itself start like a patch: it is one only when every file it names was
    // recorded, all additions for an add and all deletions for a delete.
    const files = patchFiles(patch);
    const isPatch =
      files.length > 0 &&
      files.every((file) =>
        record.changes?.some((c) => {
          const at = c.path.replaceAll("\\", "/");
          const fits = c.operation === "add" ? file.deletions === 0 : c.operation === "delete" ? file.additions === 0 : true;
          return fits && (at === file.path || at.endsWith(`/${file.path}`));
        }),
      );
    if (isPatch) return patch;
  }
  // Codex can record an added or deleted file's contents, or bare hunks, instead of a whole patch.
  if (rawFile || !patch.trimStart().startsWith("@@ ")) {
    if (!rawFile) return patch;
    const lines = patch.split("\n");
    const endsInNewline = patch.endsWith("\n");
    if (endsInNewline) lines.pop();
    const added = change.operation === "add";
    const range = `1,${lines.length}`;
    patch = `@@ -${added ? "0,0" : range} +${added ? range : "0,0"} @@\n${lines.map((line) => `${added ? "+" : "-"}${line}`).join("\n")}\n${endsInNewline ? "" : "\\ No newline at end of file\n"}`;
  }
  const oldPath = change?.old_path ?? change?.path ?? record.path;
  const newPath = change?.path ?? record.path;
  return `${header(oldPath, newPath, change?.operation)}${patch.trimStart()}`;
}

export interface ToolCallDiff {
  /** The files the step's patch holds; empty when the engine recorded none. */
  readonly files: ReadonlyArray<DiffFile>;
  /** The engine's text when it is no patch (shown as is). */
  readonly unreadable: string | null;
  /** Content the engine recorded without a diff: before and/or after. */
  readonly content: ReadonlyArray<{ readonly label: string; readonly text: string }>;
  readonly truncated: boolean;
  /** Files the step changed that its patch leaves out. */
  readonly omitted: number;
}

/**
 * Claude Agent records an Edit or Write as its tool result, JSON: `structuredPatch` hunks with their real line
 * numbers, or a created file's `content`. Read as a patch here (upstream shows that text as it came).
 */
export function claudeResultPatch(text: string, path: string): string | undefined {
  if (!text.trimStart().startsWith("{")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const result = value as { filePath?: unknown; structuredPatch?: unknown; type?: unknown; content?: unknown };
  const file = typeof result.filePath === "string" ? result.filePath : path;
  const hunks = Array.isArray(result.structuredPatch) ? result.structuredPatch : [];
  const body = hunks.flatMap((h: unknown) => {
    const hunk = h as { oldStart?: unknown; oldLines?: unknown; newStart?: unknown; newLines?: unknown; lines?: unknown };
    const lines = Array.isArray(hunk.lines) ? hunk.lines.filter((l): l is string => typeof l === "string") : null;
    if (typeof hunk.oldStart !== "number" || typeof hunk.oldLines !== "number" || typeof hunk.newStart !== "number" || typeof hunk.newLines !== "number" || !lines) return [];
    return [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...lines];
  });
  if (body.length > 0) return `${header(file, file, undefined)}${body.join("\n")}\n`;
  if (result.type === "create" && typeof result.content === "string") {
    return toolCallPatch({ path: file, diff: result.content, changes: [{ operation: "add", path: file }] });
  }
  return undefined;
}

export function toolCallDiff(record: ToolCallRecord): ToolCallDiff {
  const diff = recorded(record.diff);
  const operation = record.changes?.[0]?.operation;
  const empty = diff.text === "" ? "" : undefined;
  const before = recorded(record.before ?? (operation === "delete" ? empty : undefined));
  const after = recorded(record.after ?? (operation === "add" ? empty : undefined));
  const claude = diff.text ? claudeResultPatch(diff.text, record.path) : undefined;
  const patch = claude ?? toolCallPatch({ ...record, ...(diff.text === undefined ? {} : { diff: diff.text }) });
  const files = patch ? patchFiles(patch) : [];
  return {
    files,
    unreadable: patch && files.length === 0 && patch.trim() ? patch : null,
    content: diff.text?.trim()
      ? []
      : [
          { label: "Recorded content before", text: before.text },
          { label: "Recorded content after", text: after.text },
        ].filter((entry): entry is { label: string; text: string } => entry.text !== undefined),
    truncated: diff.truncated || before.truncated || after.truncated,
    omitted: Math.max(0, (record.changes?.length ?? 0) - files.length),
  };
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
const QUOTED_OR_BARE = /("(?:[^"\\]|\\.)*"|\S+)/g;

/** A header path: quoted or bare, without its a/ or b/ side, a trailing timestamp, or null for /dev/null. */
function headerPath(raw: string): string | null {
  let s = raw.replace(/\t.*$/, "").trim();
  if (s.startsWith('"')) {
    try {
      s = JSON.parse(s) as string;
    } catch {
      s = s.slice(1, -1);
    }
  }
  if (s === "/dev/null") return null;
  return s.replace(/^[ab]\//, "");
}

interface Building {
  gitOld: string | null;
  gitNew: string | null;
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  body: string[];
}

/**
 * A unified or git patch, one or many files, as Changes files: each file's hunks only (what parsePatch reads), its
 * path, status and counts. A deleted "--- comment" inside a hunk stays content: hunks are read by their counts.
 */
export function patchFiles(patch: string): DiffFile[] {
  const out: DiffFile[] = [];
  let cur: Building | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  const flush = () => {
    if (!cur || cur.body.length === 0) return;
    const oldPath = cur.oldPath === undefined ? cur.gitOld : cur.oldPath;
    const newPath = cur.newPath === undefined ? cur.gitNew : cur.newPath;
    const path = newPath ?? oldPath;
    if (path === null) return;
    const body = cur.body.join("\n");
    let additions = 0;
    let deletions = 0;
    for (const line of parsePatch(body)) {
      if (line.kind === "add") additions++;
      else if (line.kind === "del") deletions++;
    }
    const status: DiffFile["status"] = oldPath === null ? "added" : newPath === null ? "deleted" : oldPath !== newPath ? "renamed" : "modified";
    out.push({ path, ...(status === "renamed" && oldPath ? { old_path: oldPath } : {}), status, additions, deletions, patch: `${body}\n` });
  };
  const start = (): Building => ({ gitOld: null, gitNew: null, oldPath: undefined, newPath: undefined, body: [] });
  for (const raw of patch.split("\n")) {
    if (cur && (oldLeft > 0 || newLeft > 0)) {
      const mark = raw[0];
      const inHunk = mark === "+" || mark === "-" || mark === " " || mark === "\\" || raw === "";
      if (inHunk) {
        if (mark === "+") newLeft--;
        else if (mark === "-") oldLeft--;
        else if (mark !== "\\") {
          oldLeft--;
          newLeft--;
        }
        cur.body.push(raw);
        continue;
      }
      // Anything else ends a short hunk; read it as a header below.
      oldLeft = newLeft = 0;
    }
    if (raw.startsWith("\\") && cur) {
      cur.body.push(raw);
      continue;
    }
    if (raw.startsWith("diff --git ")) {
      flush();
      cur = start();
      const paths = raw.slice("diff --git ".length).match(QUOTED_OR_BARE) ?? [];
      cur.gitOld = paths[0] ? headerPath(paths[0]) : null;
      cur.gitNew = paths[1] ? headerPath(paths[1]) : cur.gitOld;
      continue;
    }
    if (raw.startsWith("--- ")) {
      if (!cur || cur.body.length > 0 || cur.oldPath !== undefined) {
        flush();
        cur = start();
      }
      cur.oldPath = headerPath(raw.slice(4));
      continue;
    }
    if (raw.startsWith("+++ ") && cur && cur.body.length === 0) {
      cur.newPath = headerPath(raw.slice(4));
      continue;
    }
    const hunk = HUNK.exec(raw);
    if (hunk) {
      cur ??= start();
      cur.body.push(raw);
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
    }
  }
  flush();
  return out;
}

/** A recorded path as the chat's folder names it: an engine often records the absolute one. */
export function relativeTo(root: string | undefined, path: string): string {
  if (!root) return path;
  // macOS's /tmp and /var are /private/tmp and /private/var: an engine may record either spelling.
  const plain = (p: string) => p.replace(/^\/private(?=\/(?:tmp|var)\/)/, "");
  const base = plain(root.endsWith("/") ? root : `${root}/`);
  const at = plain(path);
  return at.startsWith(base) ? at.slice(base.length) : path;
}
