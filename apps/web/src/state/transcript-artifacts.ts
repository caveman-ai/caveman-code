// Artifacts: everything in a transcript that opens in the side panel. Pulled
// from items, never from the wire: fenced code, GFM tables and images in
// markdown (keyed by their 1-based source line, which the renderer sees as
// node positions too), PR links, file edits and creates with their mini diff,
// command output, browser screenshots, pages shown with html_render, image
// attachments and the images in a builder's result.
// Results are cached per item object, so a streaming snapshot only rescans
// the item that changed.

import { fenceAfter, type Fence } from "@caveman-app/ui/ai/fence";
import { fenceTitle, languageName } from "@caveman-app/ui/ai/highlight";
import { markdownImages, normalizeImageLinks } from "@caveman-app/ui/ai/markdown-images";
import { readGeneratedImagePaths } from "@caveman-app/shared/imageGeneration";
import { plainCommand } from "./tool-actions.ts";
import { isImageGeneration } from "./image-generation.ts";
import { pageOf } from "./html-render.ts";
import { attachmentSrc, type Artifact, type AttachmentView, type ToolItem, type TranscriptItem } from "./transcript-model.ts";
import { basename } from "./workspace-paths.ts";

const cache = new WeakMap<object, ReadonlyArray<Artifact>>();
/** A builder's item is a new object every snapshot (transcript.ts freeze), so its result's images are kept by id and text. */
const summaries = new Map<string, { readonly summary: string; readonly found: ReadonlyArray<Artifact> }>();

/** Every artifact in transcript order (subagents included). `previous` comes back when nothing changed. */
export function extractArtifacts(items: ReadonlyArray<TranscriptItem>, previous: ReadonlyArray<Artifact> = []): ReadonlyArray<Artifact> {
  const out: Artifact[] = [];
  collect(items, out);
  return out.length === previous.length && out.every((a, i) => a === previous[i]) ? previous : out;
}

function collect(items: ReadonlyArray<TranscriptItem>, out: Artifact[]): void {
  for (const item of items) {
    if (item.kind === "subagent") {
      collect(item.items, out);
      if (!item.summary) continue;
      let kept = summaries.get(item.id);
      if (kept?.summary !== item.summary) summaries.set(item.id, (kept = { summary: item.summary, found: fromItem(item) }));
      out.push(...kept.found);
      continue;
    }
    let found = cache.get(item);
    if (!found) {
      found = fromItem(item);
      cache.set(item, found);
    }
    out.push(...found);
  }
}

/** Artifacts of one item. */
export function fromItem(item: TranscriptItem): ReadonlyArray<Artifact> {
  switch (item.kind) {
    case "user":
      return attachments(item.id, item.attachments);
    case "assistant":
      return [...fromMarkdown(item.id, item.text), ...attachments(item.id, item.attachments)];
    case "tool":
      return fromTool(item);
    case "subagent":
      // A delegated builder's result (shown under its line) is often its proof: the screenshots it took.
      return item.summary && item.workspaceId !== null ? fromMarkdown(item.id, item.summary).filter((a) => a.kind === "image") : [];
    default:
      return [];
  }
}

function attachments(itemId: string, list: ReadonlyArray<AttachmentView> | undefined): Artifact[] {
  return (list ?? [])
    // A large image comes by its store id, read when shown; one from an older journal came with neither: no card.
    .flatMap((a, i): Artifact[] => {
      const src = a.type !== "image" ? null : a.data !== "" ? dataUrl(a.mime_type, a.data) : a.id ? attachmentSrc(a.id) : null;
      return src === null ? [] : [{ kind: "image", id: `${itemId}:attachment:${i}`, itemId, title: a.name, meta: "Image", src, alt: a.name, line: null }];
    });
}

// ------------------------------------------------------------------ markdown

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)(.*)$/;
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const PR = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;

/** Code blocks, tables, images and PR links in one markdown string. */
export function fromMarkdown(itemId: string, raw: string): Artifact[] {
  const out: Artifact[] = [];
  const prs = new Set<string>();
  // The renderer reads the same normalized text (response.tsx), so lines and images agree.
  const text = normalizeImageLinks(raw);
  const lines = text.split("\n");
  // Images anywhere in prose, table cells included (the renderer draws none of them in the text), at their line.
  const images = Map.groupBy(markdownImages(text), (m) => m.line);
  const imagesOn = (from: number, to: number) => {
    for (let n = from; n <= to; n++) {
      for (const m of images.get(n) ?? []) {
        out.push({ kind: "image", id: `${itemId}:image:${m.line}:${m.column}`, itemId, title: m.alt || basename(m.src), meta: "Image", src: m.src, alt: m.alt, line: m.line });
      }
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      const [, indent, marks, lang, rest] = fence;
      const close = new RegExp(`^\\s*${marks![0] === "`" ? "`" : "~"}{${marks!.length},}\\s*$`);
      let j = i + 1;
      while (j < lines.length && !close.test(lines[j]!)) j++;
      const strip = new RegExp(`^ {0,${indent!.length}}`);
      const code = lines.slice(i + 1, j).map((l) => l.replace(strip, "")).join("\n");
      const title = fenceTitle(rest ?? "") ?? languageName(lang || null);
      out.push({ kind: "code", id: `${itemId}:code:${i + 1}`, itemId, title, meta: plural(code ? code.split("\n").length : 0, "line"), language: lang || null, code, line: i + 1 });
      i = j;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && DELIMITER.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      const header = cells(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j]!.includes("|") && lines[j]!.trim()) rows.push(cells(lines[j++]!));
      out.push({ kind: "table", id: `${itemId}:table:${i + 1}`, itemId, title: header[0] ? `Table: ${header.join(", ")}` : "Table", meta: `${plural(header.length, "column")}, ${plural(rows.length, "row")}`, header, rows, line: i + 1 });
      imagesOn(i + 1, j);
      i = j - 1;
      continue;
    }
    imagesOn(i + 1, i + 1);
    for (const m of line.matchAll(PR)) {
      if (prs.has(m[0])) continue;
      prs.add(m[0]);
      out.push({ kind: "pr", id: `${itemId}:pr:${m[1]}#${m[2]}`, itemId, title: `Pull request #${m[2]}`, meta: m[1]!, url: m[0], repo: m[1]!, number: Number(m[2]) });
    }
  }
  return out;
}

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
}

// --------------------------------------------------------------------- tools

const CREATE_TOOL = /^(write|create|create_?file|write_?file|new_?file)$/i;

/** Whether a tool call creates a file (by its name); the reducer uses it for the verb too. */
export function isCreateTool(name: string): boolean {
  return CREATE_TOOL.test(name);
}

/** The file artifact of a tool call's `index`th file: its first keeps the one-file id, so a row's link never moves. */
export const fileArtifactId = (toolId: string, index = 0): string => (index === 0 ? `${toolId}:file` : `${toolId}:file:${index}`);

const VIEWED_IMAGE = /\.(?:png|jpe?g|webp|gif|avif)$/i;

function fromTool(tool: ToolItem): Artifact[] {
  const input = record(tool.input);
  const result = record(tool.result);
  // A page shown with html_render: its result names the stored page, never a file of the workspace.
  const page = pageOf(tool);
  if (page) return [{ kind: "page", id: `${tool.id}:page`, itemId: tool.id, title: page.title, meta: "Page", page }];
  // An image an agent looked at: Codex's view_image, or a read of an image file (Claude Agent's Read), whose
  // result carries no image of its own; the chat shows the file it read.
  if (tool.name === "view_image" || (tool.icon === "read" && tool.command === null && VIEWED_IMAGE.test(str(input.file_path) ?? str(input.path) ?? ""))) {
    const path = str(input.path) ?? str(input.file_path);
    return tool.status === "done" && path && VIEWED_IMAGE.test(path)
      ? [{ kind: "image", id: `${tool.id}:image:0`, itemId: tool.id, title: basename(path), meta: "Viewed image", src: path, alt: basename(path), line: null }] : [];
  }
  if (isImageGeneration(tool.name)) {
    if (tool.status !== "done") return [];
    const path = str(result.saved_path) ?? str(result.savedPath);
    const raw = str(result.result)?.replace(/\s/g, "");
    // Native Codex prefers a saved file; older app servers return PNG bytes instead.
    const native = path && /\.(?:png|jpe?g|webp|gif|avif)$/i.test(path) ? [path]
      : raw && /^[a-z0-9+/]+={0,2}$/i.test(raw) ? [dataUrl("image/png", raw)] : [];
    const sources = readGeneratedImagePaths(result.saved_paths) ?? (native.length ? native : toolImages(tool.result));
    return sources.map((src, i) => ({ kind: "image", id: `${tool.id}:image:${i}`, itemId: tool.id, title: sources.length > 1 ? `Generated image ${i + 1}` : "Generated image", meta: "Generated image", src, alt: "Generated image", line: null }));
  }
  // A patch over several files: one per file it left (a deleted one has nothing to open), in its order. Its line
  // counts are the whole patch's, so no file claims them.
  if (tool.files && tool.files.length > 0) {
    return tool.files.flatMap((f, i): Artifact[] => {
      if (f.status === "deleted") return [];
      const change = f.status === "added" ? "created" : "edited";
      const meta = f.status === "added" ? "Created" : f.status === "renamed" && f.oldPath !== null ? `Moved from ${basename(f.oldPath)}` : "Edited";
      return [{ kind: "file", id: fileArtifactId(tool.id, i), itemId: tool.id, title: basename(f.path), meta, path: f.path, change, added: null, removed: null, diff: null, status: tool.status }];
    });
  }
  // A shell command that writes or deletes files says so, but has no diff of its own to show.
  if ((tool.icon === "edit" || tool.icon === "create") && tool.command === null) {
    // The subject is the workspace-relative path fs.read takes; engines' inputs often carry the absolute one.
    const relative = tool.subject && !/^([/\\]|\w:)/.test(tool.subject) ? tool.subject : null;
    const path = relative ?? str(input.file_path) ?? str(input.path) ?? str(input.filePath) ?? str(result.path) ?? tool.subject;
    const diff = toolDiff(input, result, tool.icon === "create");
    const counts = diff ? countDiff(diff) : null;
    const added = tool.added ?? counts?.added ?? null;
    const removed = tool.removed ?? counts?.removed ?? null;
    const change = tool.icon === "create" ? "created" : "edited";
    const meta = change === "created" ? `Created${added !== null ? `, ${plural(added, "line")}` : ""}` : added !== null || removed !== null ? `+${added ?? 0} −${removed ?? 0}` : "Edited";
    return [{ kind: "file", id: fileArtifactId(tool.id), itemId: tool.id, title: basename(path), meta, path, change, added, removed, diff, status: tool.status }];
  }
  // Screenshots: a browser tool's own shape, then image blocks any tool returned (a Playwright or preview capture).
  const shots = toolImages(tool.result);
  const own = tool.icon === "browser" ? (image(result) ?? image(record(result.screenshot))) : null;
  if (own && !shots.includes(own)) shots.unshift(own);
  if (shots.length) {
    return shots.map((src, i) =>
      tool.icon === "browser"
        ? { kind: "browser", id: i === 0 ? `${tool.id}:browser` : `${tool.id}:browser:${i}`, itemId: tool.id, title: tool.subject || "Browser", meta: "Screenshot", src, alt: tool.subject }
        : { kind: "image", id: `${tool.id}:image:${i}`, itemId: tool.id, title: tool.subject || "Screenshot", meta: "Screenshot", src, alt: tool.subject, line: null },
    );
  }
  if ((tool.command !== null || tool.icon === "run") && tool.output.trim()) {
    const n = tool.output.replace(/\n$/, "").split("\n").length;
    const state = tool.status === "failed" ? "Failed" : tool.status === "running" ? "Running" : "Output";
    const command = tool.command ?? tool.subject;
    return [{ kind: "terminal", id: `${tool.id}:terminal`, itemId: tool.id, title: plainCommand(command), meta: `${state}, ${plural(n, "line")}`, command, output: tool.output, status: tool.status }];
  }
  return [];
}

/** A diff from the shapes engines send: Claude Edit/MultiEdit/Write, a unified patch, Codex's diff. */
export function toolDiff(input: Record<string, unknown>, result: Record<string, unknown>, created: boolean): string | null {
  const patch = str(input.patch) ?? str(input.diff) ?? str(result.patch) ?? str(result.diff) ?? str(result.unified_diff);
  if (patch) return patch.replace(/\n$/, "");
  const pairs: Array<[string, string]> = [];
  if (typeof input.old_string === "string" && typeof input.new_string === "string") pairs.push([input.old_string, input.new_string]);
  if (Array.isArray(input.edits)) for (const e of input.edits) { const r = record(e); if (typeof r.old_string === "string" && typeof r.new_string === "string") pairs.push([r.old_string, r.new_string]); }
  if (pairs.length) return pairs.map(([a, b]) => [...prefixed(a, "-"), ...prefixed(b, "+")].join("\n")).join("\n@@\n");
  const content = str(input.content) ?? str(input.file_text);
  if (content !== null && created) return prefixed(content, "+").join("\n");
  return null;
}

function prefixed(text: string, mark: "+" | "-"): string[] {
  return text === "" ? [] : text.replace(/\n$/, "").split("\n").map((l) => mark + l);
}

export function countDiff(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) added++;
    else if (l.startsWith("-") && !l.startsWith("---")) removed++;
  }
  return { added, removed };
}

/**
 * One entry per file path (the last call that touched it, at its place,
 * counts summed, diffs joined) and one per PR URL; everything else as is.
 */
export function mergeFiles(list: ReadonlyArray<Artifact>): Artifact[] {
  const out = new Map<string, Artifact>();
  for (const a of list) {
    const key = a.kind === "file" ? `file:${a.path}` : a.kind === "pr" ? `pr:${a.url}` : a.id;
    const prev = out.get(key);
    out.delete(key);
    if (a.kind === "file" && prev?.kind === "file") {
      // Counts no call reported stay unknown: "Edited", never "+0 −0".
      const counted = [prev.added, prev.removed, a.added, a.removed].some((n) => n !== null);
      const added = counted ? (prev.added ?? 0) + (a.added ?? 0) : null;
      const removed = counted ? (prev.removed ?? 0) + (a.removed ?? 0) : null;
      const created = prev.change === "created";
      const lines = counted ? `+${added} −${removed}` : null;
      const meta = created ? (lines ? `Created, ${lines}` : "Created") : (lines ?? "Edited");
      out.set(key, { ...a, change: created ? "created" : a.change, added, removed, meta, diff: [prev.diff, a.diff].filter(Boolean).join("\n@@\n") || null });
    } else out.set(key, a);
  }
  return [...out.values()];
}

export type FileArtifact = Extract<Artifact, { kind: "file" }>;

/**
 * Each turn_end's files, as its own steps edited or created them (its subagents' included), merged per path:
 * what a turn changed when no checkpoint saw it (files outside the chat's folder, an engine without checkpoints).
 */
export function turnEdits(items: ReadonlyArray<TranscriptItem>, artifacts: ReadonlyArray<Artifact>): Map<string, FileArtifact[]> {
  const byItem = new Map<string, Artifact[]>();
  for (const a of artifacts) if (a.kind === "file") byItem.set(a.itemId, [...(byItem.get(a.itemId) ?? []), a]);
  const out = new Map<string, FileArtifact[]>();
  let turn: Artifact[] = [];
  const take = (list: ReadonlyArray<TranscriptItem>) => {
    for (const item of list) {
      if (item.kind === "subagent") take(item.items);
      turn.push(...(byItem.get(item.id) ?? []));
    }
  };
  for (const item of items) {
    if (item.kind !== "turn_end") take([item]);
    else {
      // A finished turn keeps the list it had while a later one streams: its row gets the same `edited` and skips its render.
      const kept = keptTurnEdits.get(item);
      const files = kept && sameList(kept.from, turn) ? kept.files : mergeFiles(turn).filter((a): a is FileArtifact => a.kind === "file");
      if (kept?.files !== files) keptTurnEdits.set(item, { from: turn, files });
      if (files.length) out.set(item.id, files);
      turn = [];
    }
  }
  return out;
}
const keptTurnEdits = new WeakMap<TranscriptItem, { readonly from: ReadonlyArray<Artifact>; readonly files: FileArtifact[] }>();
const sameList = <T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The first `n` changed lines, for the card's mini diff. */
export function diffPreview(diff: string, n = 4): string[] {
  return diff.split("\n").filter((l) => (l.startsWith("+") && !l.startsWith("+++")) || (l.startsWith("-") && !l.startsWith("---"))).slice(0, n);
}

/** A tool shows a screenshot or a few frames; more would only flood the chat (packages/shared toolOutput.ts keeps 8 too). */
const MAX_TOOL_IMAGES = 8;
const RASTER = /^image\/(png|jpe?g|gif|webp)$/i;

/**
 * Images a tool returned inline, as data URLs: MCP `{ type: "image", data, mimeType }` blocks or
 * Claude's `{ type: "image", source: { type: "base64", media_type, data } }`, alone, in a list or in
 * an MCP result's `content`. Raster only, the rule packages/shared/src/toolOutput.ts keeps.
 */
export function toolImages(value: unknown): string[] {
  const content = record(value).content;
  const blocks = Array.isArray(value) ? value : Array.isArray(content) ? content : [value];
  const out: string[] = [];
  for (const block of blocks) {
    const b = record(block);
    if (b.type === "inputImage") {
      // Codex dynamic tools return inputImage blocks, not MCP's type:image blocks.
      // Keep the same raster-only data-URL boundary as inline MCP results.
      const url = str(b.imageUrl);
      if (url && /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/\s]+={0,2}$/i.test(url)) out.push(url);
      if (out.length === MAX_TOOL_IMAGES) break;
      continue;
    }
    if (b.type !== "image") continue;
    const source = b.source === undefined ? null : record(b.source);
    if (source && source.type !== "base64") continue;
    const mime = str(source ? source.media_type : b.mimeType);
    const data = str(source ? source.data : b.data);
    if (!mime || !RASTER.test(mime) || !data) continue;
    out.push(dataUrl(mime.toLowerCase(), data));
    if (out.length === MAX_TOOL_IMAGES) break;
  }
  return out;
}

function image(r: Record<string, unknown>): string | null {
  const data = str(r.data) ?? str(r.image_base64);
  const mime = str(r.mime_type) ?? str(r.mimeType) ?? "image/png";
  if (data) return data.startsWith("data:") ? data : dataUrl(mime, data);
  const nested = record(r.image);
  if (Object.keys(nested).length) return image(nested);
  const url = str(r.url);
  return url?.startsWith("data:image/") ? url : null;
}

// ------------------------------------------------------------------- helpers

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function dataUrl(mime: string, data: string): string {
  return `data:${mime};base64,${data}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------- docs

/** The "+" lines of a created file's diff, without the markers: the file as written. */
export function fileFromDiff(diff: string): string {
  return diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n");
}

const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** A markdown document's title (front matter `title:`, else its first heading) and its opening words, for a doc card. */
export function docSummary(md: string): { title: string | null; excerpt: string | null } {
  let body = md;
  let title: string | null = null;
  const fm = FRONT_MATTER.exec(md);
  if (fm) {
    title = /^title\s*:\s*["']?(.+?)["']?\s*$/m.exec(fm[1]!)?.[1] ?? null;
    body = md.slice(fm[0].length);
  }
  const lines = body.split(/\r?\n/);
  let excerpt: string[] = [];
  // Read as the renderer reads it (fence.ts): a fence in a doc's example is the example's text.
  let fence: Fence | null = null;
  for (let i = 0; i < lines.length && excerpt.length < 6; i++) {
    const line = lines[i]!;
    const open = fence;
    fence = fenceAfter(open, line);
    if (open || fence) {
      if (excerpt.length) break;
      continue;
    }
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    const setext = !heading && line.trim() && /^(=+|-+)\s*$/.test(lines[i + 1] ?? "") && !excerpt.length;
    if (heading || setext) {
      if (excerpt.length) break;
      title ??= plainInline(heading ? heading[1]! : line.trim());
      if (setext) i++;
      continue;
    }
    if (!line.trim()) {
      if (excerpt.length) break;
      continue;
    }
    // Prose only: a table, a list, a quote marker or HTML opens no excerpt.
    if (!excerpt.length && /^\s*([|<]|[-*+]\s|\d+[.)]\s|---|\*\*\*)/.test(line)) continue;
    excerpt.push(line.replace(/^\s*>\s?/, "").trim());
  }
  const text = plainInline(excerpt.join(" "));
  return { title: title || null, excerpt: text ? (text.length > 280 ? `${text.slice(0, 279).trimEnd()}…` : text) : null };
}

/** Inline markdown as the words it shows: links and images by their text, no emphasis or code marks. */
function plainInline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|~~|`)(?=\S)([^]*?\S)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}
