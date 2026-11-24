// The Artifact view of the side panel: this session's artifacts as a list
// (grouped, icon + name in white + meta in grey), and one artifact at full
// size with its own header (back, badge, name, meta; find, copy, expand,
// close). A file has a labelled "Rendered | Changes" (markdown) or
// "File | Changes" switch: markdown and newly created files open as the file
// itself, through the Files viewer (a document with its outline, or
// highlighted code with line numbers); edits to other files open on the change.
// A page an agent showed with html_render fills the panel, live.
import { Button } from "@caveman-app/ui/components/button";
import { Artifact as Frame, ArtifactAction, ArtifactActions, ArtifactBadge, ArtifactContent, ArtifactDescription, ArtifactHeader, ArtifactTitle } from "@caveman-app/ui/ai/artifact";
import { CodeBlock, CodeBlockContent } from "@caveman-app/ui/ai/code-block";
import { DiffRows } from "../../panels/diff/FileDiff.tsx";
import { parsePatch } from "../../panels/diff/parsePatch.ts";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon as HugeIcon, ArrowExpand01Icon, ArrowLeft01Icon, ArrowShrink02Icon, Cancel01Icon, Copy01Icon, LinkSquare02Icon, Search01Icon, Tick02Icon, FolderOpenIcon, Layers01Icon, Image01Icon, GitPullRequestIcon, FileDiffIcon } from "@caveman-app/ui/icons/huge";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import { useFileContent, useFilesVersion, useFileWriter, type FileState } from "../../panels/files/fileContent.tsx";
import { FindBar, isFindChord } from "../../panels/files/FindBar.tsx";
import { FileView } from "../../panels/files/FileView.tsx";
import { QuietButton, SurfaceEmpty } from "../../panels/chrome.tsx";
import { isMarkdownPath } from "../../panels/files/fileRefs.ts";
import { useReveal } from "../../panels/files/FileMenu.tsx";
import { resolveLink } from "../../panels/files/tree.ts";
import { openSurface } from "../../panels/store.ts";
import { usePanelWorkspace } from "../../panels/workspace.ts";
import type { Artifact, ArtifactKind } from "../../state/transcript-model.ts";
import { artifactIcon, Icon } from "../transcript/marks.tsx";
import { fileFromDiff, mergeFiles } from "../../state/transcript-artifacts.ts";
import { useArtifacts } from "./store.ts";
import { isAbsolutePath } from "../../state/workspace-paths.ts";
import { ChatGallery, type ImageArtifact, useOpenImage } from "../gallery/Gallery.tsx";
import { fromBase64, useImage } from "../../state/media.ts";
import { Skeleton } from "@caveman-app/ui/components/skeleton";
import { useNavigate } from "react-router";
import { prFromUrl } from "../../routes/review/model.ts";
import { openPr } from "../../routes/review/surface.tsx";
import { HtmlPage } from "../transcript/HtmlPage.tsx";

export interface ArtifactPanelProps {
  readonly sessionId: string;
  readonly workspaceId: string;
  /** The artifact shown; null shows the list. */
  readonly selected: string | null;
  readonly onSelect: (artifactId: string | null) => void;
  readonly onClose?: () => void;
  readonly maximized?: boolean;
  readonly onMaximize?: (maximized: boolean) => void;
}

export function ArtifactPanel({ sessionId, workspaceId, selected, onSelect, onClose, maximized, onMaximize }: ArtifactPanelProps) {
  const all = useArtifacts(sessionId);
  // One row per file and per PR; opening a file shows every change this chat made to it.
  const artifacts = useMemo(() => mergeFiles(all), [all]);
  const artifact = selected ? (artifacts.find((a) => a.id === selected) ?? all.find((a) => a.id === selected)) : undefined;
  return (
    // An image here opens the same viewer as in the chat, over all of the chat's images.
    <ChatGallery artifacts={all} workspaceId={workspaceId}>
      {artifact ? (
        <ArtifactDetail key={artifact.id} artifact={artifact} sessionId={sessionId} workspaceId={workspaceId} onBack={() => onSelect(null)} onClose={onClose} maximized={maximized} onMaximize={onMaximize} />
      ) : (
        <ArtifactList artifacts={artifacts} onSelect={onSelect} onClose={onClose} />
      )}
    </ChatGallery>
  );
}

// ---------------------------------------------------------------------- list

const GROUPS: ReadonlyArray<[string, ReadonlyArray<ArtifactKind>]> = [
  ["Files", ["file"]],
  ["Pages", ["page"]],
  ["Code", ["code"]],
  ["Tables", ["table"]],
  ["Images and screenshots", ["image", "browser"]],
  ["Command output", ["terminal"]],
  ["Pull requests", ["pr"]],
];

function ArtifactList({ artifacts, onSelect, onClose }: { artifacts: ReadonlyArray<Artifact>; onSelect: (id: string) => void; onClose?: (() => void) | undefined }) {
  const list = useRef<HTMLDivElement>(null);
  return (
    <Frame>
      <ArtifactHeader className="pl-3">
        <ArtifactTitle>
          Artifacts
          <ArtifactDescription>{artifacts.length || ""}</ArtifactDescription>
        </ArtifactTitle>
        {onClose ? (
          <ArtifactActions>
            <ArtifactAction label="Close" onClick={onClose}>
              <HugeIcon icon={Cancel01Icon} />
            </ArtifactAction>
          </ArtifactActions>
        ) : null}
      </ArtifactHeader>
      <ArtifactContent>
        {artifacts.length === 0 ? (
          <SurfaceEmpty icon={Layers01Icon} title="No artifacts yet" className="h-full">
            Files, pages, code, tables, images and links from this chat collect here.
          </SurfaceEmpty>
        ) : (
          <div
            ref={list}
            className="p-1.5"
            onKeyDown={(e) => {
              // Arrow keys walk the rows; one list, one tab stop per row.
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>("[data-artifact-row]") ?? [])];
              const i = rows.indexOf(document.activeElement as HTMLButtonElement);
              rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
              e.preventDefault();
            }}
          >
            {GROUPS.map(([label, kinds]) => {
              const rows = artifacts.filter((a) => kinds.includes(a.kind));
              if (!rows.length) return null;
              return (
                <section key={label} aria-label={label}>
                  <h3 className="px-2 pb-1 pt-2 text-[12px] text-muted-foreground">{label}</h3>
                  {[...rows].reverse().map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      data-artifact-row
                      onClick={() => onSelect(a.id)}
                      className="group/row flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left outline-none transition-colors duration-75 hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <span className="text-muted-foreground group-hover/row:text-foreground group-focus-visible/row:text-foreground">
                        <Icon icon={artifactIcon(a.kind, a.kind === "file" ? a : undefined)} />
                      </span>
                      <span className={cn("shrink-0 truncate text-[13px] text-foreground", (a.kind === "terminal" || a.kind === "file") && "max-w-[60%] font-mono text-[12.5px]")}>{a.title}</span>
                      <span className="min-w-0 truncate text-[13px] tabular-nums text-muted-foreground">{a.meta}</span>
                    </button>
                  ))}
                </section>
              );
            })}
          </div>
        )}
      </ArtifactContent>
    </Frame>
  );
}

// -------------------------------------------------------------------- detail

function ArtifactDetail({
  artifact,
  sessionId,
  workspaceId,
  onBack,
  onClose,
  maximized,
  onMaximize,
}: {
  artifact: Artifact;
  sessionId: string;
  workspaceId: string;
  onBack: () => void;
  onClose?: (() => void) | undefined;
  maximized?: boolean | undefined;
  onMaximize?: ((m: boolean) => void) | undefined;
}) {
  const { connection } = useRuntimeClient();
  const root = usePanelWorkspace()?.root_path;
  // Relative to the chat's folder already (the transcript publishes them so); fs.read can't take one outside it.
  const path = artifact.kind === "file" ? artifact.path : "";
  const outside = isAbsolutePath(path);
  const isMarkdown = artifact.kind === "file" && isMarkdownPath(artifact.path);
  // A new file's diff is the whole file: show it as the file, not as a wall of "+" lines.
  const created = artifact.kind === "file" && artifact.change === "created" && artifact.diff ? fileFromDiff(artifact.diff) : null;
  const [view, setView] = useState<"artifact" | "file">(isMarkdown || created !== null ? "file" : "artifact");
  const [find, setFind] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  // The file as it is now, refreshed as the agent edits it; only read while the file view shows.
  const { version, watch } = useFilesVersion(sessionId, connection);
  const read = useFileContent(workspaceId, path, undefined, artifact.kind === "file" && view === "file" && !outside ? version : null);
  const write = useFileWriter(workspaceId, path, undefined, read);
  // Markdown outside it (a plan, a memory) comes through media.read, the one host-path read.
  const hostMarkdown = useHostMarkdown(workspaceId, path, artifact.kind === "file" && view === "file" && outside && isMarkdown);
  // A created file that can't be read (deleted since, or no runtime) still shows what the agent wrote.
  const file: FileState =
    read.state.status !== "ready" && created !== null && (read.state.status === "error" || !connection || outside)
      ? { status: "ready", file: { path, encoding: "utf8", content: created, size: created.length, truncated: false } }
      : outside
        ? (hostMarkdown ?? { status: "error", message: "This file is outside the chat's folder, so it can't be opened here." })
        : read.state;


  const onLink = (href: string, event: MouseEvent<HTMLAnchorElement>) => {
    const target = resolveLink(path, href);
    if (target?.kind === "external" || target?.kind === "anchor") return;
    event.preventDefault();
    if (target?.kind === "file") openSurface(workspaceId, "file", { path: target.path, ...(target.line ? { line: target.line } : {}) });
  };

  const copyText = copyable(artifact, view === "file" && file.status === "ready" && file.file.encoding === "utf8" ? file.file.content : null);
  return (
    <Frame
      // A click in the artifact takes focus here, so ⌘F finds in it rather than in the chat.
      tabIndex={-1}
      className="outline-none"
      onKeyDown={(e) => {
        if (!isFindChord(e)) return;
        e.preventDefault();
        setFind(true);
      }}
    >
      <ArtifactHeader>
        <ArtifactAction label="All artifacts" onClick={onBack}>
          <HugeIcon icon={ArrowLeft01Icon} />
        </ArtifactAction>
        <ArtifactTitle className="min-w-0 flex-1">
          <ArtifactBadge>
            <Icon icon={artifactIcon(artifact.kind, artifact.kind === "file" ? artifact : undefined)} />
          </ArtifactBadge>
          <span className={cn("min-w-0 truncate", (artifact.kind === "file" || artifact.kind === "terminal") && "font-mono text-[12.5px]")}>{artifact.title}</span>
          <ArtifactDescription>{artifact.meta}</ArtifactDescription>
        </ArtifactTitle>
        <ArtifactActions>
          {/* A page is a sandboxed document of its own: the panel can't search inside it. */}
          {artifact.kind !== "page" ? (
            <ArtifactAction label="Find" pressed={find} onClick={() => setFind(!find)}>
              <HugeIcon icon={Search01Icon} />
            </ArtifactAction>
          ) : null}
          {/* The file itself, selected in Finder: only one in the chat's folder, the one place the host reveals. */}
          {artifact.kind === "file" && !outside ? <RevealAction workspaceId={workspaceId} path={path} /> : null}
          {copyText !== null ? <CopyAction text={copyText} /> : null}
          {artifact.kind === "pr" ? (
            <ArtifactAction label="Open on GitHub" onClick={() => window.open(artifact.url, "_blank", "noopener")}>
              <HugeIcon icon={LinkSquare02Icon} />
            </ArtifactAction>
          ) : null}
          {onMaximize ? (
            <ArtifactAction label={maximized ? "Restore" : "Expand"} onClick={() => onMaximize(!maximized)}>
              {maximized ? <HugeIcon icon={ArrowShrink02Icon} /> : <HugeIcon icon={ArrowExpand01Icon} />}
            </ArtifactAction>
          ) : null}
          {onClose ? (
            <ArtifactAction label="Close" onClick={onClose}>
              <HugeIcon icon={Cancel01Icon} />
            </ArtifactAction>
          ) : null}
        </ArtifactActions>
      </ArtifactHeader>
      {artifact.kind === "file" ? (
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-3 font-mono text-[12px] text-muted-foreground">
          <span className="min-w-0 truncate">{artifact.path}</span>
          {artifact.added !== null || artifact.removed !== null ? (
            <span className="ml-auto flex shrink-0 gap-1.5 tabular-nums">
              <span className="text-diff-add-ink">+{artifact.added ?? 0}</span>
              <span className="text-diff-del-ink">−{artifact.removed ?? 0}</span>
            </span>
          ) : null}
          <div role="group" aria-label="Show" className={cn("flex shrink-0 rounded-md bg-muted p-0.5 font-sans", artifact.added === null && artifact.removed === null ? "ml-auto" : "ml-2")}>
            {(["file", "artifact"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className={cn(
                  "h-6 rounded px-2 text-[12px] outline-none transition-colors duration-75 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  view === v ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {v === "artifact" ? "Changes" : isMarkdown ? "Rendered" : "File"}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {find ? <FindBar root={content} onClose={() => setFind(false)} label="Find in this artifact" /> : null}
      {artifact.kind === "page" ? (
        // At the panel's size, scrolling inside itself; Expand gives it the whole window.
        <div className="flex min-h-0 flex-1 flex-col">
          <HtmlPage workspaceId={workspaceId} page={artifact.page} fill />
        </div>
      ) : view === "file" && artifact.kind === "file" ? (
        // The Files viewer scrolls itself (a document keeps its outline rail in view).
        <div ref={content} className="flex min-h-0 flex-1 flex-col">
          <FileView workspaceId={workspaceId} root={root} path={path} state={file} mode="preview" wrap={false} revealLine={undefined} onLink={onLink} onRetry={read.retry} onWrite={file === read.state ? write : null} onMore={file === read.state ? read.more : null} version={version} />
        </div>
      ) : (
        <ArtifactContent ref={content}>
          <Body artifact={artifact} workspaceId={workspaceId} />
        </ArtifactContent>
      )}
      {artifact.kind === "file" && view === "file" ? watch : null}
    </Frame>
  );
}

/** The image at the panel's size; a click opens the viewer on it. */
function PanelImage({ artifact, workspaceId }: { artifact: ImageArtifact; workspaceId: string }) {
  const { state, retry } = useImage(artifact.src, workspaceId, artifact.itemId);
  const open = useOpenImage();
  return (
    <div className="grid min-h-full place-items-center p-4">
      {state.status === "loading" ? (
        <Skeleton className="aspect-[16/10] w-full max-w-md" />
      ) : state.status === "error" ? (
        <div role="alert" className="flex">
          <SurfaceEmpty icon={Image01Icon} title="Couldn't load this image" action={<QuietButton onClick={retry}>Try again</QuietButton>}>
            {state.message}
          </SurfaceEmpty>
        </div>
      ) : (
        <button
          type="button"
          disabled={!open}
          onClick={() => open?.(artifact.id)}
          aria-label={`Open ${artifact.title} in the viewer`}
          className="max-h-full max-w-full cursor-zoom-in rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <img src={state.url} alt={artifact.alt} referrerPolicy="no-referrer" className="block max-h-full max-w-full rounded-lg border border-border" />
        </button>
      )}
    </div>
  );
}

function Body({ artifact, workspaceId }: { artifact: Artifact; workspaceId: string }) {
  switch (artifact.kind) {
    case "code":
      return <FullCode code={artifact.code} language={artifact.language} />;
    case "terminal":
      return <FullCode code={artifact.output} language={null} destructive={artifact.status === "failed"} title={`$ ${artifact.command}`} />;
    case "file":
      return artifact.diff ? <FullCode code={artifact.diff} language={null} diff path={artifact.path} /> : <WorkspaceDiff path={artifact.path} workspaceId={workspaceId} />;
    case "table":
      return (
        <div className="p-4">
          <div className="overflow-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-[13px]">
              <thead className="sticky top-0 bg-muted">
                <tr>
                  {artifact.header.map((h, i) => (
                    <th key={i} className="h-8 whitespace-nowrap border-b border-border px-3 text-left text-[12px] font-medium text-muted-foreground">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {artifact.rows.map((r, i) => (
                  <tr key={i} className="transition-colors duration-75 hover:bg-accent/40">
                    {r.map((c, j) => (
                      <td key={j} className="h-8 border-b border-border px-3 tabular-nums">
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    case "image":
    case "browser":
      return <PanelImage artifact={artifact} workspaceId={workspaceId} />;
    case "pr":
      return <PrBody artifact={artifact} workspaceId={workspaceId} />;
    case "page":
      // Drawn by ArtifactDetail at the panel's full size, outside this scrolling body.
      return null;
  }
}

/** A pull request: its review opens in this panel when a project can read it (its host's page stays one click away). */
function PrBody({ artifact, workspaceId }: { artifact: Extract<Artifact, { kind: "pr" }>; workspaceId: string }) {
  const projects = useRuntimeSelector((v) => v.projects);
  const navigate = useNavigate();
  const pr = prFromUrl(artifact.url, projects);
  const host = (
    <a href={artifact.url} target="_blank" rel="noreferrer">
      Open on GitHub <HugeIcon icon={LinkSquare02Icon} className="size-3.5" />
    </a>
  );
  return (
    <div className="p-6">
      <div className="flex items-center gap-3">
        <ArtifactBadge className="size-8 [&_svg]:size-4">
          <Icon icon={GitPullRequestIcon} />
        </ArtifactBadge>
        <div className="min-w-0">
          <div className="text-[15px] text-foreground">Pull request #{artifact.number}</div>
          <div className="truncate text-[13px] text-muted-foreground">{artifact.repo}</div>
        </div>
      </div>
      <div className="mt-5 flex items-center gap-2">
        {pr ? (
          <>
            <Button onClick={() => openPr(navigate, workspaceId, pr)}>Review here</Button>
            <Button asChild variant="ghost">
              {host}
            </Button>
          </>
        ) : (
          <Button asChild>{host}</Button>
        )}
      </div>
      <div className="mt-3 break-all font-mono text-[12px] text-muted-foreground">{artifact.url}</div>
    </div>
  );
}

function FullCode({ code, language, diff = false, destructive = false, title, path }: { code: string; language: string | null; diff?: boolean; destructive?: boolean; title?: string; path?: string }) {
  if (diff) return <PatchView patch={code} path={path ?? ""} />;
  return (
    <div className="p-3">
      <CodeBlock variant={destructive ? "destructive" : "default"}>
        {title ? <div className="truncate border-b border-border px-3 py-2 font-mono text-[12px] text-muted-foreground">{title}</div> : null}
        <CodeBlockContent language={language} diff={diff} lineNumbers={!diff}>
          {code || " "}
        </CodeBlockContent>
      </CodeBlock>
    </div>
  );
}

/**
 * One file's change as the Changes tab draws it (FileDiff's rows: soft line tints, a 3px bar, numbers at 30% ink,
 * the code in its language's colours), never the raw patch with its git headers.
 */
function PatchView({ patch, path }: { patch: string; path: string }) {
  const lines = useMemo(() => parsePatch(patch), [patch]);
  const file = useMemo(() => ({ path, status: "modified" as const, additions: 0, deletions: 0, patch }), [path, patch]);
  if (lines.length === 0) return <SurfaceEmpty icon={FileDiffIcon} title="Nothing changed in this file" />;
  return (
    <div className="p-3">
      <div className="overflow-hidden rounded-[10px] border border-foreground/10 bg-foreground/[0.02] py-1">
        <DiffRows file={file} lines={lines} wrap={false} />
      </div>
    </div>
  );
}

/** A markdown file outside the chat's folder, read once through media.read; null when not asked for. */
function useHostMarkdown(workspaceId: string, path: string, enabled: boolean): FileState | null {
  const { client } = useRuntimeClient();
  const [state, setState] = useState<FileState>({ status: "loading" });
  useEffect(() => {
    if (!enabled || !client) return;
    let cancelled = false;
    setState({ status: "loading" });
    client
      .call("media.read", { workspace_id: workspaceId, path })
      .then((r) => {
        const content = new TextDecoder().decode(fromBase64(r.data));
        if (!cancelled) setState({ status: "ready", file: { path, encoding: "utf8", content, size: r.size, truncated: false } });
      })
      .catch((e: unknown) => !cancelled && setState({ status: "error", message: e instanceof Error ? e.message : String(e) }));
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, path, enabled]);
  return enabled ? state : null;
}

function WorkspaceDiff({ path, workspaceId }: { path: string; workspaceId: string }) {
  const { client } = useRuntimeClient();
  const [patch, setPatch] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    client
      ?.call("fs.diff", { workspace_id: workspaceId })
      .then((r) => !cancelled && setPatch(r.files.find((f) => f.path === path || path.endsWith(`/${f.path}`))?.patch ?? null))
      .catch(() => !cancelled && setPatch(null));
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, path]);
  if (patch === undefined) return <SurfaceEmpty title="Loading the change…" />;
  if (!patch)
    return (
      <SurfaceEmpty icon={FileDiffIcon} title="No diff for this file right now">
        The workspace has no change to it. Open the file to see it.
      </SurfaceEmpty>
    );
  return <FullCode code={patch} language={null} diff path={path} />;
}

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <ArtifactAction label={copied ? "Copied" : "Copy"} onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true), () => {})}>
      {copied ? <HugeIcon icon={Tick02Icon} className="text-success" /> : <HugeIcon icon={Copy01Icon} />}
    </ArtifactAction>
  );
}

function copyable(a: Artifact, file: string | null): string | null {
  if (file !== null) return file;
  switch (a.kind) {
    case "code":
      return a.code;
    case "terminal":
      return a.output;
    case "file":
      return a.diff;
    case "table":
      return [a.header, ...a.rows].map((r) => `| ${r.join(" | ")} |`).join("\n");
    case "pr":
      return a.url;
    default:
      return null;
  }
}

/** Reveal in Finder (File Explorer on Windows) for the artifact's file; nothing where the computer can't. */
function RevealAction({ workspaceId, path }: { workspaceId: string; path: string }) {
  const reveal = useReveal(workspaceId, path);
  if (!reveal) return null;
  return (
    <ArtifactAction label={reveal.label} onClick={reveal.run}>
      <HugeIcon icon={FolderOpenIcon} className={reveal.failed ? "text-destructive" : undefined} />
    </ArtifactAction>
  );
}
