// An automation's File tab: its YAML, and the agent files it uses, in a light editor (a textarea over the app's one
// Shiki) with live check: 250 ms after typing stops, automation.check reads the unsaved text and its problems mark
// their lines and fill the list beside it; a problem's line:col jumps there. ⌘S saves (automation.file_write), ⌘↩
// runs (through Run now's form when it asks for an issue or inputs). A Project file also goes onto a branch and a pull
// request from here, once it has no errors.
import type { AutomationDiagnostic, AutomationExplanation } from "@caveman-app/session-protocol";
import { CODE_THEME } from "@caveman-app/ui/ai/code-block";
import { languageFromPath, useHighlightedCode } from "@caveman-app/ui/ai/highlight";
import { Button } from "@caveman-app/ui/components/button";
import { Keycap } from "@caveman-app/ui/components/menu";
import { FileTypeIcon } from "@caveman-app/ui/icons/file-type";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, Alert02Icon, Cancel01Icon, CancelCircleIcon, CheckmarkCircle02Icon } from "@caveman-app/ui/icons/huge";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties } from "react";
import { useSearchParams } from "react-router";
import { requestId, useRuntimeSelector } from "../../state/runtime.tsx";
import { useActions } from "./actions.tsx";
import { fileKey, LIST, message, patch, refresh, useAgentTypes, useFileText } from "./data.ts";
import { agentPath, agentsUsed, checkoutOf, needsForm, offsetOf, problemCounts, problemsWord, withSchemaLine, type Automation } from "./model.ts";
import { formatChord, isComposing, keysText } from "../../panels/chrome.tsx";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

const CHECK_MS = 250;
const LINE_PX = 20;

type Buffer = { saved: string; text: string };

/** The open files once the write of `sent` (on disk as `written`) answers: what was typed meanwhile stays, unsaved. */
export function savedBuffers(buffers: Readonly<Record<string, Buffer>>, path: string, sent: string, written: string): Record<string, Buffer> {
  const now = buffers[path]?.text;
  return { ...buffers, [path]: { saved: written, text: now === undefined || now === sent ? written : now } };
}

export function FileTab({ automation: a, explanation, onDirty }: { automation: Automation; explanation: AutomationExplanation | undefined; onDirty?: (dirty: boolean) => void }) {
  const client = useRuntimeSelector((v) => v.client);
  const actions = useActions();
  const main = a.path!;
  const [open, setOpen] = useState<string[]>([main]);
  const [active, setActive] = useState(main);
  const [buffers, setBuffers] = useState<Record<string, Buffer>>({});
  const file = useFileText(checkoutOf(a), active);
  const types = useAgentTypes(a.project_id);
  const editor = useRef<EditorHandle>(null);
  const [, setParams] = useSearchParams();

  // A file's text, once read, is the buffer's saved copy; edits never get replaced by a later read.
  useEffect(() => {
    if (file.value !== undefined) setBuffers((b) => (b[active] ? b : { ...b, [active]: { saved: file.value!, text: file.value! } }));
  }, [file.value, active]);

  const buffer = buffers[active];
  const dirty = Object.entries(buffers).filter(([, b]) => b.text !== b.saved).map(([path, b]) => ({ path, text: b.text }));
  const dirtyKey = JSON.stringify(dirty);
  // The page asks before leaving, and keeps this tab open under the others, while it holds edits.
  const anyDirty = dirty.length > 0;
  useEffect(() => {
    onDirty?.(anyDirty);
  }, [anyDirty, onDirty]);

  // Live check over the unsaved text; only the newest answer counts.
  const [diagnostics, setDiagnostics] = useState<ReadonlyArray<AutomationDiagnostic> | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    if (!client) return;
    const n = ++seq.current;
    const timer = setTimeout(() => {
      setChecking(true);
      client
        .call("automation.check", { project_id: checkoutOf(a), ...(dirty.length > 0 ? { files: dirty } : {}) })
        .then(
          (r) => n === seq.current && (setDiagnostics(r.diagnostics), setCheckError(null)),
          (e) => n === seq.current && setCheckError(message(e)),
        )
        .finally(() => n === seq.current && setChecking(false));
    }, CHECK_MS);
    return () => clearTimeout(timer);
    // dirtyKey is the unsaved text; the rest is fixed for this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, dirtyKey, a.id]);

  // The agents it uses, and where each comes from: a project file opens here; the rest are not files of this repo.
  const agents = useMemo(() => {
    // explain needs a file that loads; until it does, the steps the list read say which agents it names.
    const used = explanation ? agentsUsed(explanation) : [...new Set((a.steps ?? []).flatMap((st) => (st.agent ? [st.agent] : [])))].map((name) => ({ name }) as { name: string; from?: string });
    return used.map((g) => {
      const t = types.value?.find((x) => x.name === g.name);
      const source = t?.source ?? (g.from === "built-in" ? "builtin" : g.from ? "project" : undefined);
      return { name: g.name, source, path: source === "project" ? (t?.path ?? (g.from?.startsWith("agents/") ? `.caveman/${g.from}` : agentPath(g.name))) : null };
    });
  }, [explanation, types.value, a.steps]);
  const mine = new Set([main, ...open, ...agents.flatMap((g) => (g.path ? [g.path] : []))]);
  const problems = (diagnostics ?? []).filter((d) => mine.has(d.path)).sort((x, y) => (x.path === main ? -1 : 0) - (y.path === main ? -1 : 0) || x.path.localeCompare(y.path) || x.line - y.line);
  const here = problems.filter((d) => d.path === active);
  const counts = problemCounts(problems);

  const openFile = (path: string, at?: { line: number; column: number }) => {
    setOpen((o) => (o.includes(path) ? o : [...o, path]));
    setActive(path);
    if (at) requestAnimationFrame(() => requestAnimationFrame(() => editor.current?.jump(at.line, at.column)));
  };
  const closeFile = (path: string) => {
    setOpen((o) => o.filter((p) => p !== path));
    if (active === path) setActive(main);
  };

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // ⌘S and ⌘↩ reach save() while one is out (only the button waits): saves run one at a time, each writing the newest text.
  const latest = useRef(buffers);
  latest.current = buffers;
  const chain = useRef<Promise<boolean>>(Promise.resolve(true));
  const save = (): Promise<boolean> => {
    const next = chain.current.then(async () => {
      const unsaved = Object.entries(latest.current).filter(([, b]) => b.text !== b.saved);
      if (!client || unsaved.length === 0) return true;
      setSaving(true);
      setSaveError(null);
      try {
        for (const [path, b] of unsaved) {
          const text = withSchemaLine(path, b.text);
          await client.call("automation.file_write", { request_id: requestId(), project_id: checkoutOf(a), path, text });
          latest.current = savedBuffers(latest.current, path, b.text, text);
          setBuffers((cur) => savedBuffers(cur, path, b.text, text));
          patch<string>(fileKey(checkoutOf(a), path), () => text);
        }
        refresh(client, LIST);
        refresh(client, `explain:${a.id}`);
        return true;
      } catch (e) {
        setSaveError(message(e));
        return false;
      } finally {
        setSaving(false);
      }
    });
    chain.current = next;
    return next;
  };
  const run = async () => {
    if (!(await save())) return;
    // A run that asks for an issue or inputs goes through Run now's form, in the header.
    if (needsForm(a)) setParams((p) => (p.set("run", "1"), p), { replace: true });
    else void actions.runNow(a);
  };
  const [pr, setPr] = useState<"idle" | "busy">("idle");
  // Saved files only (the button waits for Save): the automation and the project agents it names, as on disk.
  const commit = async () => {
    setPr("busy");
    await actions.openPr(a);
    setPr("idle");
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-4">
      <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex h-10 items-center gap-1 border-b border-border/70 pl-1.5 pr-2">
          <div role="tablist" aria-label="Open files" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
            {open.map((path) => {
              const b = buffers[path];
              const changed = b && b.text !== b.saved;
              const errors = (diagnostics ?? []).filter((d) => d.path === path && d.severity === "error").length;
              return (
                <span
                  key={path}
                  role="tab"
                  aria-selected={active === path}
                  tabIndex={0}
                  onClick={() => setActive(path)}
                  onKeyDown={(e) => e.key === "Enter" && setActive(path)}
                  title={path}
                  className={cn(
                    "group/tab flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md pl-2 pr-1.5 font-mono text-[12px] outline-none transition-colors duration-75 focus-visible:ring-2 focus-visible:ring-ring",
                    active === path ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <FileTypeIcon path={path} className="size-3.5" />
                  <span className={cn(errors > 0 && "text-destructive")}>{path.split("/").pop()}</span>
                  {changed ? <span aria-label="unsaved" className="size-1.5 rounded-full bg-foreground/70" /> : null}
                  {path !== main ? (
                    <button
                      type="button"
                      aria-label={`Close ${path}`}
                      onClick={(e) => (e.stopPropagation(), closeFile(path))}
                      className="grid size-4 place-items-center rounded opacity-0 hover:bg-foreground/10 group-hover/tab:opacity-100 focus-visible:opacity-100"
                    >
                      <Icon icon={Cancel01Icon} className="size-3" strokeWidth={2} />
                    </button>
                  ) : null}
                </span>
              );
            })}
          </div>
          <Button size="sm" variant={dirty.length > 0 ? "default" : "ghost"} disabled={saving || dirty.length === 0} onClick={() => void save()} title={dirty.length > 0 ? `Save (${formatChord("mod+s")})` : "Saved"}>
            {saving ? "Saving…" : dirty.length > 0 ? "Save" : "Saved"}
          </Button>
          {a.scope === "project" ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={pr === "busy" || dirty.length > 0 || counts.errors > 0}
              onClick={() => void commit()}
              title={dirty.length > 0 ? "Save first" : counts.errors > 0 ? "Fix its errors first: a file with errors never runs" : "Commit the file on its own branch and open a pull request"}
            >
              <Glyph name="artifact-pr" className="size-3.5" />
              {pr === "busy" ? "Opening…" : "Commit and open PR"}
            </Button>
          ) : null}
        </div>
        {saveError ? <p className="border-b border-border/70 bg-destructive/[0.06] px-4 py-2 text-[12.5px] text-destructive">{saveError}</p> : null}
        {buffer ? (
          <CodeEditor
            ref={editor}
            key={active}
            path={active}
            value={buffer.text}
            onChange={(text) => setBuffers((b) => ({ ...b, [active]: { ...b[active]!, text } }))}
            diagnostics={here}
            onSave={() => void save()}
            onRun={() => void run()}
          />
        ) : file.error ? (
          <p className="px-4 py-6 text-[13px] text-destructive">{file.error}</p>
        ) : (
          <EditorSkeleton />
        )}
        <div className="flex h-8 items-center gap-3 border-t border-border/70 px-3 text-[11.5px] text-[hsl(var(--subtle-foreground))]">
          <span className="truncate font-mono">{active}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <Keycap>{formatChord("mod+s")}</Keycap> save
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <Keycap>{keysText("⌘↩", "mod+enter")}</Keycap> run
          </span>
        </div>
      </div>

      <aside className="flex flex-col gap-4">
        <section className="overflow-hidden rounded-xl border border-border bg-card">
          <h3 className="flex h-10 items-center gap-2 border-b border-border/70 px-3.5 text-[13px] font-medium text-foreground">
            Problems
            <span className={cn("ml-auto flex items-center gap-1.5 text-[12px] font-normal", counts.errors > 0 ? "text-destructive" : counts.warnings > 0 ? "text-warning" : "text-success")}>
              {checking ? <span className="lucy-shimmer text-muted-foreground">Checking</span> : checkError ? <span className="text-destructive">Check failed</span> : diagnostics === null ? null : problemsWord(problems)}
            </span>
          </h3>
          {checkError ? <p className="px-3.5 py-3 text-[12.5px] text-destructive">{checkError}</p> : null}
          {diagnostics !== null && problems.length === 0 && !checkError ? (
            <p className="flex items-center gap-2 px-3.5 py-3 text-[12.5px] text-muted-foreground">
              <Icon icon={CheckmarkCircle02Icon} className="size-3.5 text-success" strokeWidth={2} />
              Check finds nothing. It runs as you type.
            </p>
          ) : null}
          <ul className="max-h-[360px] overflow-y-auto">
            {problems.map((d, i) => (
              <li key={`${d.path}:${d.line}:${d.column}:${d.code}:${i}`}>
                <button
                  type="button"
                  onClick={() => openFile(d.path, d)}
                  className="flex w-full items-start gap-2 border-t border-border/50 px-3.5 py-2.5 text-left outline-none transition-colors duration-75 first:border-t-0 hover:bg-accent/40 focus-visible:bg-accent/50"
                >
                  {d.severity === "error" ? <Icon icon={CancelCircleIcon} className="mt-0.5 size-3.5 shrink-0 text-destructive" strokeWidth={2} aria-label="error" /> : <Icon icon={Alert02Icon} className="mt-0.5 size-3.5 shrink-0 text-warning" strokeWidth={2} aria-label="warning" />}
                  <span className="min-w-0">
                    <span className="block text-[12.5px] leading-[18px] text-foreground">{d.message}</span>
                    <span className="mt-0.5 block font-mono text-[11px] text-[hsl(var(--subtle-foreground))]">
                      {d.path === active ? "" : `${d.path.split("/").pop()} `}
                      {d.line}:{d.column} · {d.code}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="overflow-hidden rounded-xl border border-border bg-card">
          <h3 className="flex h-10 items-center border-b border-border/70 px-3.5 text-[13px] font-medium text-foreground">Agents it uses</h3>
          {agents.length === 0 ? (
            <p className="px-3.5 py-3 text-[12.5px] text-muted-foreground">{explanation || a.steps ? "None: every step has its own prompt." : "They show once the file checks clean."}</p>
          ) : (
            <ul>
              {agents.map((g) => (
                <li key={g.name}>
                  <button
                    type="button"
                    disabled={!g.path}
                    onClick={() => g.path && openFile(g.path)}
                    className="flex w-full items-center gap-2.5 border-t border-border/50 px-3.5 py-2 text-left outline-none transition-colors duration-75 first:border-t-0 enabled:hover:bg-accent/40 focus-visible:bg-accent/50"
                  >
                    <Glyph name="tool-subagent" className="text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-foreground">{g.name}</span>
                      <span className="block truncate text-[11.5px] text-muted-foreground">
                        {g.path ?? (g.source === "builtin" ? "built in" : g.source === "user" ? "yours, in ~/.caveman/agents" : g.source === "plugin" ? "from a plugin" : "not found")}
                      </span>
                    </span>
                    {g.path ? <span className="text-[11.5px] text-[hsl(var(--subtle-foreground))]">Open</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}

function EditorSkeleton() {
  return (
    <div aria-busy aria-label="Reading the file" className="flex flex-col gap-2 px-14 py-4">
      {[62, 40, 78, 30, 55, 70, 22, 48].map((w, i) => (
        <span key={i} className="block h-3 rounded bg-foreground/[0.05]" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

export interface EditorHandle {
  jump: (line: number, column: number) => void;
}

/**
 * The editor: a transparent textarea over the highlighted text, so typing is the browser's own (undo, IME, selection)
 * and colour comes from the app's one Shiki. A problem tints its line, marks the gutter and says itself at the line's end.
 */
// ponytail: re-highlights from the edit on; fine for automation-sized files. Upgrade: CodeMirror when files grow.
export const CodeEditor = forwardRef<EditorHandle, { path: string; value: string; onChange: (text: string) => void; diagnostics: ReadonlyArray<AutomationDiagnostic>; onSave: () => void; onRun?: () => void }>(
  function CodeEditor({ path, value, onChange, diagnostics, onSave, onRun }, ref) {
    const lines = useHighlightedCode(value, languageFromPath(path));
    const area = useRef<HTMLTextAreaElement>(null);
    const pre = useRef<HTMLPreElement>(null);
    const byLine = useMemo(() => {
      const m = new Map<number, AutomationDiagnostic[]>();
      for (const d of diagnostics) m.set(d.line, [...(m.get(d.line) ?? []), d]);
      return m;
    }, [diagnostics]);
    const count = value.split("\n").length;

    useImperativeHandle(ref, () => ({
      jump: (line, column) => {
        const ta = area.current;
        if (!ta) return;
        const at = offsetOf(ta.value, line, column);
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(at, at);
        (pre.current?.children[line - 1] as HTMLElement | undefined)?.scrollIntoView({ block: "center", behavior: "smooth" });
      },
    }));

    const insert = (text: string) => {
      // execCommand keeps the browser's undo stack; the fallback edits the value.
      if (!document.execCommand("insertText", false, text)) {
        const ta = area.current!;
        const { selectionStart: s, selectionEnd: e } = ta;
        onChange(ta.value.slice(0, s) + text + ta.value.slice(e));
        requestAnimationFrame(() => ta.setSelectionRange(s + text.length, s + text.length));
      }
    };

    return (
      <div className="relative flex overflow-x-auto font-mono text-[12.5px] leading-[20px]" style={CODE_THEME as CSSProperties}>
        <div aria-hidden className="sticky left-0 z-10 shrink-0 select-none bg-card py-3 pl-2 pr-2.5 text-right tabular-nums text-[hsl(var(--subtle-foreground))]">
          {Array.from({ length: count }, (_, i) => {
            const ds = byLine.get(i + 1);
            const error = ds?.some((d) => d.severity === "error");
            return (
              <div key={i} className="flex h-5 items-center justify-end gap-1.5" title={ds?.map((d) => d.message).join("\n")}>
                <span className={cn("size-[6px] rounded-[1px]", !ds ? "invisible" : error ? "bg-destructive" : "bg-warning")} />
                <span className={cn("min-w-[2ch]", ds && (error ? "text-destructive" : "text-warning"))}>{i + 1}</span>
              </div>
            );
          })}
        </div>
        <div className="relative flex-1">
          <pre ref={pre} aria-hidden className="pointer-events-none m-0 min-h-[420px] whitespace-pre py-3 pl-2 pr-8 [tab-size:2]">
            {lines.map((line, i) => {
              const ds = byLine.get(i + 1);
              const error = ds?.some((d) => d.severity === "error");
              return (
                <div key={i} className={cn("-ml-2 h-5 pl-2", ds && (error ? "bg-destructive/[0.09]" : "bg-warning/[0.09]"))}>
                  {line}
                  {ds ? <span className={cn("ml-6 font-sans text-[11.5px]", error ? "text-destructive/90" : "text-warning")}>{ds[0]!.message}</span> : "​"}
                </div>
              );
            })}
          </pre>
          <textarea
            ref={area}
            aria-label={`Edit ${path}`}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (isComposing(e)) return;
              const mod = e.metaKey || e.ctrlKey;
              if (mod && e.key === "s") {
                e.preventDefault();
                onSave();
              } else if (mod && e.key === "Enter" && onRun) {
                e.preventDefault();
                onRun();
              } else if (e.key === "Tab" && !e.shiftKey && !mod) {
                e.preventDefault();
                insert("  ");
              } else if (e.key === "Enter" && !mod && !e.shiftKey) {
                // Keep the line's indent, one level deeper after a colon.
                const ta = e.currentTarget;
                const start = ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1;
                const line = ta.value.slice(start, ta.selectionStart);
                const indent = /^\s*/.exec(line)![0] + (/:\s*$/.test(line) ? "  " : "");
                e.preventDefault();
                insert(`\n${indent}`);
              }
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            wrap="off"
            style={{ height: Math.max(420, count * LINE_PX + 24) }}
            className="absolute inset-x-0 top-0 resize-none overflow-hidden whitespace-pre bg-transparent py-3 pl-2 pr-8 text-transparent caret-foreground outline-none [font:inherit] [tab-size:2] selection:bg-foreground/15"
          />
        </div>
      </div>
    );
  },
);
