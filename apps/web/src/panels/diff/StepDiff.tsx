// One file-change step's own diff in the Changes surface (upstream #26304):
// what that edit recorded, read with tool.diff when it opens, rather than the
// checkout's changes. It reads no repository, so it works for a step whose
// file has changed since, or one outside the chat's folder. "All changes"
// goes back to the checkout's.

import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, RefreshCwIcon, TextWrapIcon, FileDiffIcon } from "@caveman-app/ui/icons/huge";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRuntimeClient } from "../../state/runtime.tsx";
import { formerRoot } from "../../state/sync/chats-view.ts";
import { BarButton, QuietButton, SurfaceBar, SurfaceEmpty } from "../chrome.tsx";
import { openSurface } from "../store.ts";
import { usePanelWorkspace } from "../workspace.ts";
import { FileDiff } from "./FileDiff.tsx";
import { LARGE_LINES, patchLines, type DiffFile } from "./parsePatch.ts";
import { relativeTo, toolCallDiff, type ToolCallRecord } from "./tool-call-diff.ts";
import { arriveMotion } from "@caveman-app/ui/motion";

export function StepDiff({ workspaceId, item }: { workspaceId: string; item: string }) {
  const { client } = useRuntimeClient();
  const workspace = usePanelWorkspace();
  // A moved chat's step ran in this Mac's checkout of it: the path still reads by its place in the chat's folder.
  const panelRoot = workspace?.root_path ?? formerRoot(workspace) ?? undefined;
  const [record, setRecord] = useState<ToolCallRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [wrap, setWrap] = useState(() => localStorage.getItem("caveman.diff.wrap") !== "0");
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!client) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const res = await client.call("tool.diff", { workspace_id: workspaceId, item_id: item });
      if (n !== seq.current) return;
      setRecord(res);
      setError(null);
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [client, workspaceId, item]);

  useEffect(() => {
    setRecord(null);
    setError(null);
    setChosen(new Map());
    void load();
  }, [load]);

  const diff = useMemo(() => (record ? toolCallDiff(record) : null), [record]);
  // Engines often record the absolute path; the chat's own files read by their place in its folder, on the computer
  // that recorded the step (a chat on another computer has no root_path here).
  const root = record?.root_path ?? panelRoot;
  const files = useMemo<ReadonlyArray<DiffFile>>(
    () => diff?.files.map((f) => ({ ...f, path: relativeTo(root, f.path), ...(f.old_path ? { old_path: relativeTo(root, f.old_path) } : {}) })) ?? [],
    [diff, root],
  );
  const path = record ? relativeTo(root, record.path) : null;
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const setCollapsed = useCallback((p: string, collapsed: boolean) => setChosen((c) => new Map(c).set(p, collapsed)), []);
  const open = useCallback((p: string) => openSurface(workspaceId, "file", { path: p }), [workspaceId]);
  const toggleWrap = () => {
    localStorage.setItem("caveman.diff.wrap", wrap ? "0" : "1");
    setWrap(!wrap);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SurfaceBar className="gap-2 pl-3">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-[13px]">
          <span className="shrink-0 font-medium text-foreground">One edit</span>
          {path ? (
            <span className="min-w-0 truncate text-[12px] text-muted-foreground">
              <span className="font-mono" title={record?.path}>
                {path}
              </span>
              {files.length > 0 ? (
                <span className="tabular-nums">
                  <span className="ml-1.5 text-diff-add-ink">+{additions}</span> <span className="text-diff-del-ink">−{deletions}</span>
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <BarButton label="Refresh" onClick={() => void load()}>
            <Icon icon={RefreshCwIcon} className={cn(loading && "animate-spin")} />
          </BarButton>
          {files.length > 0 ? (
            <BarButton label={wrap ? "Don't wrap lines" : "Wrap lines"} pressed={wrap} onClick={toggleWrap}>
              <Icon icon={TextWrapIcon} />
            </BarButton>
          ) : null}
          <QuietButton className="ml-1" onClick={() => openSurface(workspaceId, "diff", {})}>
            All changes
          </QuietButton>
        </div>
      </SurfaceBar>

      {!diff ? (
        error ? (
          <SurfaceEmpty title="Couldn't load this edit" action={<QuietButton onClick={() => void load()}>Retry</QuietButton>}>
            {error}
          </SurfaceEmpty>
        ) : null
      ) : (
        <div className={cn("flex min-h-0 flex-1 flex-col", arriveMotion)}>
          {diff.truncated || diff.omitted > 0 ? (
            <p className="shrink-0 border-b border-border bg-secondary/40 px-3 py-1.5 text-[12px] text-muted-foreground">
              {diff.omitted > 0 ? `This edit changed ${diff.omitted + files.length} files; its recorded patch leaves out ${diff.omitted}. ` : null}
              {diff.truncated ? "The recorded change was too long to send whole: its end is cut." : null}
            </p>
          ) : null}
          {files.length > 0 ? (
            <div data-diff-scroller className="relative min-h-0 min-w-0 flex-1 overflow-y-auto">
              {files.map((f) => (
                <FileDiff key={f.path} file={f} collapsed={chosen.get(f.path) ?? patchLines(f) > LARGE_LINES} eager wrap={wrap} onToggle={setCollapsed} onOpen={open} />
              ))}
            </div>
          ) : diff.content.length > 0 || diff.unreadable !== null ? (
            <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
              <p className="text-[12.5px] text-muted-foreground">
                {diff.unreadable !== null ? "The engine recorded this edit in a form that isn't a diff:" : "The engine recorded the file's content without a diff."}
              </p>
              {diff.unreadable !== null ? <Recorded text={diff.unreadable} wrap={wrap} /> : null}
              {diff.content.map(({ label, text }) => (
                <div key={label} className="space-y-1">
                  <p className="text-[12px] text-[hsl(var(--subtle-foreground))]">{label}</p>
                  <Recorded text={text === "" ? "Empty content." : text} wrap={wrap} />
                </div>
              ))}
            </div>
          ) : (
            <SurfaceEmpty icon={FileDiffIcon} title="Nothing recorded for this edit">
              The engine kept no diff or content for it. All changes shows what the chat's files hold now.
            </SurfaceEmpty>
          )}
        </div>
      )}
    </div>
  );
}

function Recorded({ text, wrap }: { text: string; wrap: boolean }) {
  return <pre className={cn("overflow-auto rounded-md border border-border bg-secondary/30 p-2 font-mono text-[12px] leading-[18px] text-foreground/90", wrap && "whitespace-pre-wrap break-words")}>{text}</pre>;
}
