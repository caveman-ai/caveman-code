// One file's body, by type: code and text, markdown (a document to read, or
// its source), images, CSV/TSV as a small table, binary and too-big notices, a
// quiet skeleton while it loads and an error with Retry. Reads go through
// fs.read (fileContent.ts). Formats and caps ,
// apps/web/src/components/files/DelimitedTablePreview.tsx,
// ReadOnlySourcePreview.tsx @ ab3a3cd1).

import { Skeleton } from "@caveman-app/ui/components/skeleton";
import { CodeView } from "@caveman-app/ui/markdown/CodeView";
import { MarkdownDocument } from "@caveman-app/ui/markdown/MarkdownDocument";
import { Mermaid } from "@caveman-app/ui/markdown/Mermaid";
import { cn } from "@caveman-app/ui/lib/cn";
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { fromBase64 } from "../../state/media.ts";
import { useRuntimeClient } from "../../state/runtime.tsx";
import { QuietButton, SurfaceEmpty } from "../chrome.tsx";
import { pressRun } from "../terminal/run.ts";
import { CodePath, FileRefsContext, useFileRefActions } from "./FileChip.tsx";
import { IMAGE_MAX, useFileContent, type FileState, type Read } from "./fileContent.tsx";
import { fileKind, fontType, formatBytes, imageType, mediaType, parseDelimited, resolveLink } from "./tree.ts";
import { File01Icon } from "@caveman-app/ui/icons/huge";

export type ViewMode = "preview" | "source";

export interface FileViewProps {
  readonly workspaceId: string;
  /** The absolute worktree root (This Mac only): absolute paths under it in a document open as files. */
  readonly root: string | undefined;
  readonly path: string;
  /** The ref the file was read at, for the images a document shows. */
  readonly gitRef?: string | undefined;
  readonly state: FileState;
  readonly mode: ViewMode;
  readonly wrap: boolean;
  /** Scroll to and flash this line (code and source views). */
  readonly revealLine: number | undefined;
  readonly onLink: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
  readonly onRetry: () => void;
  /** Writes the file (a document's ticked checkbox); null leaves it read-only. */
  readonly onWrite?: ((content: string) => void) | null | undefined;
  /** Shows the next window of a large text file (useFileContent's `more`); null when there is none. */
  readonly onMore?: (() => void) | null | undefined;
  /** The workspace's file version (agent edits): a document's images read again when it moves. */
  readonly version?: number | null | undefined;
}

export function FileView({ workspaceId, root, path, gitRef, state, mode, wrap, revealLine, onLink, onRetry, onWrite, onMore, version }: FileViewProps) {
  if (state.status === "loading") return <BodySkeleton />;
  if (state.status === "error") {
    return (
      <SurfaceEmpty title="Couldn't open this file" action={<QuietButton onClick={onRetry}>Retry</QuietButton>}>
        {describeError(state.message)}
      </SurfaceEmpty>
    );
  }
  const { file } = state;
  const kind = fileKind(path);
  const banner = file.truncated ? <TruncatedBanner content={file.content} size={file.size} encoding={file.encoding} onMore={onMore ?? null} /> : null;

  if (kind === "image") {
    if (file.truncated) return <SurfaceEmpty title="Image too large to preview">{formatBytes(file.size)}; previews stop at {formatBytes(IMAGE_MAX)}.</SurfaceEmpty>;
    const type = file.mime_type?.startsWith("image/") ? file.mime_type : imageType(path);
    const src = file.encoding === "base64" ? `data:${type};base64,${file.content}` : `data:${type};charset=utf-8,${encodeURIComponent(file.content)}`;
    return <ImageView src={src} path={path} size={file.size} />;
  }
  if ((kind === "media" || kind === "font") && file.encoding === "base64") {
    if (file.truncated) return <SurfaceEmpty title="Too large to preview">{formatBytes(file.size)}; previews stop at {formatBytes(IMAGE_MAX)}.</SurfaceEmpty>;
    return kind === "media" ? <MediaView data={file.content} type={mediaType(path)} path={path} size={file.size} /> : <FontView data={file.content} type={fontType(path)} path={path} size={file.size} />;
  }
  if (file.encoding === "base64") return <SurfaceEmpty icon={File01Icon} title="Binary file">{formatBytes(file.size)}. It can't be shown as text.</SurfaceEmpty>;
  if (file.size === 0) return <SurfaceEmpty icon={File01Icon} title="Empty file">This file has no content yet.</SurfaceEmpty>;
  if (kind === "diagram" && mode === "preview" && !file.truncated) {
    // A .mmd or .mermaid file drawn as its diagram (T3 #21362); Source shows the text.
    return (
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <Mermaid source={file.content} className="my-0 border-0 bg-transparent p-0" />
      </div>
    );
  }
  if (kind === "table" && mode === "preview") {
    return (
      <>
        {banner}
        <TableView text={file.content} delimiter={path.toLowerCase().endsWith(".tsv") ? "\t" : ","} name={path} />
      </>
    );
  }
  return (
    <>
      {banner}
      {kind === "markdown" && mode === "preview" ? (
        <Document workspaceId={workspaceId} root={root} path={path} gitRef={gitRef} source={file.content} onLink={onLink} onWrite={file.truncated ? null : (onWrite ?? null)} version={version ?? null} />
      ) : (
        <CodeView code={file.content} path={path} wrap={wrap} revealLine={revealLine} className="min-h-0 flex-1" />
      )}
    </>
  );
}

function describeError(message: string): string {
  if (/ENOENT|no such file|not.?found/i.test(message)) return "There is no file at this path. It may have been moved or deleted.";
  if (/outside/i.test(message)) return "That path is outside the workspace.";
  if (/EISDIR|is a directory/i.test(message)) return "That path is a folder.";
  return message;
}

// ------------------------------------------------------------ the document

/**
 * A markdown file to read (MarkdownDocument), wired to the workspace: inline
 * code that names a file opens it, images by path load from the workspace.
 * Code (and markdown source) go through CodeView, chunked so a big file never blocks.
 */
function Document({
  workspaceId,
  root,
  path,
  gitRef,
  source,
  onLink,
  onWrite,
  version,
}: {
  workspaceId: string;
  root: string | undefined;
  path: string;
  gitRef: string | undefined;
  source: string;
  onLink: FileViewProps["onLink"];
  onWrite: ((content: string) => void) | null;
  version: number | null;
}) {
  const refs = useFileRefActions(workspaceId, root);
  const { client } = useRuntimeClient();
  return (
    <FileRefsContext.Provider value={refs}>
    <MarkdownDocument
      source={source}
      onLink={onLink}
      onChange={onWrite ?? undefined}
      onRun={(command) => pressRun(client, workspaceId, command)}
      inlineCode={(text) => <CodePath text={text} root={root} workspaceId={workspaceId} />}
      image={(src, alt) => {
        const target = resolveLink(path, src);
        return target?.kind === "file" ? <WorkspaceImage workspaceId={workspaceId} path={target.path} gitRef={gitRef} alt={alt} version={version} /> : <span className="text-muted-foreground">{alt}</span>;
      }}
    />
    </FileRefsContext.Provider>
  );
}

/** An image a document shows by path, read from the workspace (and cached with the other reads). */
function WorkspaceImage({ workspaceId, path, gitRef, alt, version }: { workspaceId: string; path: string; gitRef: string | undefined; alt: string; version: number | null }) {
  const { connection } = useRuntimeClient();
  // An agent that redraws an image the document shows: it reads again with the document's other files (T3 #18647).
  const { state } = useFileContent(workspaceId, path, gitRef, version ?? connection);
  if (fileKind(path) !== "image" || state.status === "error" || (state.status === "ready" && state.file.truncated)) return <span className="text-muted-foreground">{alt || path}</span>;
  if (state.status === "loading") return <span role="status" aria-label={`Loading ${alt || path}`} className="inline-block h-40 w-full max-w-md animate-pulse rounded-[7px] bg-muted align-top" />;
  const { file } = state;
  const type = file.mime_type?.startsWith("image/") ? file.mime_type : imageType(path);
  const src = file.encoding === "base64" ? `data:${type};base64,${file.content}` : `data:${type};charset=utf-8,${encodeURIComponent(file.content)}`;
  return <img src={src} alt={alt} decoding="async" className="inline-block max-h-[32rem] max-w-full rounded-[7px] border border-border object-contain" />;
}

// ------------------------------------------------------------- the others

function TruncatedBanner({ content, size, encoding, onMore }: { content: string; size: number; encoding: Read["encoding"]; onMore: (() => void) | null }) {
  const bytes = useMemo(() => (encoding === "base64" ? Math.floor((content.length * 3) / 4) : new TextEncoder().encode(content).length), [content, encoding]);
  // The view draws only the lines near the viewport (CodeView), so a file read on and on stays quick to scroll.
  const next = Math.min(size - bytes, 1024 * 1024);
  return (
    <div role="note" className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-[12px] text-muted-foreground">
      <span className="min-w-0 flex-1">Showing the first {formatBytes(bytes)} of {formatBytes(size)}.</span>
      {onMore ? (
        <button type="button" onClick={onMore} className="shrink-0 rounded px-1.5 py-0.5 text-foreground outline-none transition-colors duration-75 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
          Show the next {formatBytes(next)}
        </button>
      ) : null}
    </div>
  );
}

function BodySkeleton() {
  return (
    <div role="status" aria-label="Loading file" className="min-h-0 flex-1 space-y-2.5 px-4 pt-4 animate-in fade-in-0 fill-mode-backwards delay-150 duration-200">
      {[38, 64, 52, 0, 72, 46, 58, 30].map((w, i) => (w ? <Skeleton key={i} className="h-3" style={{ width: `${w}%` }} /> : <div key={i} className="h-3" />))}
    </div>
  );
}

function ImageView({ src, path, size }: { src: string; path: string; size: number }) {
  const [actual, setActual] = useState(false);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  // A decode error belongs to these bytes, not to the file tab: edits can replace its src in place.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (failedSrc === src) return <SurfaceEmpty title="Couldn't show this image">{formatBytes(size)}. The browser can't decode it.</SurfaceEmpty>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn("min-h-0 flex-1 overflow-auto", actual ? "" : "grid place-items-center p-6")}>
        <button
          type="button"
          aria-pressed={actual}
          aria-label={actual ? "Fit the image to the panel" : "Show the image at actual size"}
          onClick={() => setActual((a) => !a)}
          className={cn(
            "rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            actual ? "m-6 cursor-zoom-out" : "grid max-h-full max-w-full cursor-zoom-in place-items-center",
          )}
        >
          <img
            src={src}
            alt={path}
            draggable={false}
            onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => setFailedSrc(src)}
            className={cn("block select-none rounded-sm ring-1 ring-border", actual ? "max-w-none" : "max-h-full max-w-full object-contain")}
          />
        </button>
      </div>
      <div className="flex h-8 shrink-0 items-center gap-2 border-t border-border px-3 text-[12px] tabular-nums text-muted-foreground">
        {dims ? (
          <span>
            {dims.w} × {dims.h}
          </span>
        ) : null}
        <span>{formatBytes(size)}</span>
        <span className="ml-auto">{actual ? "Actual size" : "Fit"}</span>
      </div>
    </div>
  );
}

function TableView({ text, delimiter, name }: { text: string; delimiter: "," | "\t"; name: string }) {
  const table = useMemo(() => parseDelimited(text, delimiter), [text, delimiter]);
  const [header, ...body] = table.rows;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {table.moreRows || table.moreCols ? (
        <div role="note" className="shrink-0 border-b border-border px-3 py-1.5 text-[12px] text-muted-foreground">
          Showing the first {table.moreRows ? "200 rows" : "rows"}
          {table.moreCols ? " and 30 columns" : ""}. Source has the rest.
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <table aria-label={name} className="min-w-full border-separate border-spacing-0 text-[12.5px]">
          {header ? (
            <thead className="sticky top-0 z-10">
              <tr>
                {header.map((cell, i) => (
                  <th key={i} scope="col" className="max-w-80 whitespace-pre-wrap break-words border-b border-border bg-background px-3 py-1.5 text-left align-bottom font-medium text-foreground">
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {body.map((row, r) => (
              <tr key={r} className="hover:bg-accent/50">
                {row.map((cell, c) => (
                  <td key={c} className="max-w-80 whitespace-pre-wrap break-words border-b border-border px-3 py-1.5 align-top tabular-nums text-secondary-foreground">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A file's bytes (fs.read's base64) as a blob URL for as long as it shows. */
function useBlobUrl(data: string, type: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const blob = new Blob([fromBase64(data)], { type });
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [data, type]);
  return url;
}

/** Audio or video in the workspace, played in the viewer (T3 #21363). */
function MediaView({ data, type, path, size }: { data: string; type: string; path: string; size: number }) {
  const url = useBlobUrl(data, type);
  const [failed, setFailed] = useState<string | null>(null);
  if (url && failed === url) return <SurfaceEmpty title="Couldn't play this file">{formatBytes(size)}. The browser can't play {type}.</SurfaceEmpty>;
  const audio = type.startsWith("audio/");
  return (
    <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-6">
      <div className={cn("flex w-full flex-col items-center gap-3", audio ? "max-w-md" : "max-w-3xl")}>
        {url ? (
          audio ? (
            <audio controls preload="metadata" src={url} aria-label={baseNameOf(path)} onError={() => setFailed(url)} className="w-full" />
          ) : (
            <video controls preload="metadata" src={url} aria-label={baseNameOf(path)} onError={() => setFailed(url)} className="max-h-[70vh] w-full rounded-lg border border-border bg-black" />
          )
        ) : null}
        <span className="text-[12px] tabular-nums text-muted-foreground">{formatBytes(size)}</span>
      </div>
    </div>
  );
}

const FONT_SAMPLE = "The quick brown fox jumps over the lazy dog";
let fontFaces = 0;

/** A font in the workspace, set in a few sizes (T3 #21362). Loaded as a FontFace under its own name, gone when the view goes. */
function FontView({ data, type, path, size }: { data: string; type: string; path: string; size: number }) {
  const [family, setFamily] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const name = `caveman-preview-${++fontFaces}`;
    const face = new FontFace(name, fromBase64(data));
    let live = true;
    setFailed(false);
    face.load().then(
      () => {
        if (!live) return;
        document.fonts.add(face);
        setFamily(name);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
      document.fonts.delete(face);
    };
  }, [data, type]);
  if (failed) return <SurfaceEmpty title="Couldn't load this font">{formatBytes(size)}. The browser can't read it.</SurfaceEmpty>;
  return (
    <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
      <p className="mb-4 text-[12px] text-muted-foreground">
        {baseNameOf(path)} · {formatBytes(size)}
      </p>
      {family ? (
        <div className="space-y-4 text-foreground" style={{ fontFamily: `"${family}"` }}>
          <p className="text-[40px] leading-tight">Aa Bb Cc 0123</p>
          {[32, 22, 16, 13].map((px) => (
            <p key={px} className="leading-snug" style={{ fontSize: px }}>
              {FONT_SAMPLE}
            </p>
          ))}
          <p className="text-[16px] leading-relaxed">ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 !?&amp;@#%(){}[]</p>
        </div>
      ) : (
        <BodySkeleton />
      )}
    </div>
  );
}

const baseNameOf = (path: string) => path.split(/[\\/]/).pop() ?? path;
