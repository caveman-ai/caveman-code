// Projects (project.list): the badge, the chooser behind every project
// dropdown, and Add a project. The dropdown lists your projects, then the
// repositories project.discover found (Claude and Codex history, code
// folders, your GitHub), and still takes a typed folder path, git URL or
// owner/name. Add a project has two ways in, one tab each: a folder on this
// computer (the desktop's folder picker, or a typed path in a browser, above
// the checkouts found here) and a GitHub repository (a link or owner/name,
// above your repositories). Picking a repository that is not a project yet
// adds it (a GitHub-only one is cloned, or linked to the checkout already here).
import type { Project, ProjectCandidate, Result } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { clickOrigin } from "@caveman-app/ui/components/dialog";
import { Input } from "@caveman-app/ui/components/input";
import { fadeEdges, useFadeEdges } from "@caveman-app/ui/components/menu";
import { Popover, PopoverContent, PopoverTrigger } from "@caveman-app/ui/components/popover";
import { BrandMark } from "@caveman-app/ui/icons/brand";
import { modalMotion, overlayMotion } from "@caveman-app/ui/motion";
import { cn } from "@caveman-app/ui/lib/cn";
import * as Dialog from "@radix-ui/react-dialog";
import { Add01Icon, Icon, RefreshCwIcon, Search01Icon, Tick02Icon, Folder01Icon, FolderOpenIcon } from "@caveman-app/ui/icons/huge";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject, type SyntheticEvent } from "react";
import { useSearchParams } from "react-router";
import { formatChord, isComposing } from "../panels/chrome.tsx";
import { pickableProjects } from "../state/model.ts";
import { requestId, useRuntimeClient, useRuntimeSelector } from "../state/runtime.tsx";
import { RepoMark } from "./ChiefRepos.tsx";
import { cloneWay, GH_LOGIN, type CloneWay } from "./clone-error.ts";
import { ago, answers, candidatesFor, candidateSections, parentLabel, parseAddQuery, readAddField, tildify, type AddFrom } from "./project-candidates.ts";
import { touchScreen } from "@caveman-app/ui/lib/touch";
import { resolvePastedPath } from "@caveman-app/shared/path";

/** A project's mark, as in the queue: GitHub's when it lives there, else a folder. */
export function ProjectBadge({ github, size = 14 }: { github: boolean; size?: number }) {
  return <RepoMark repo={{ github }} size={size} />;
}

/** Pick a project from the smart chooser. The trigger is the child (a heading's underlined name, a chip). */
export function ProjectPicker({ value, onChange, children }: { value: string | null; onChange: (id: string) => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // A pick hands focus on (the caller's composer, or Add a project); only then must closing not pull it back to the trigger.
  const handedOff = useRef(false);
  // Add a project hands focus back here when it closes without adding one.
  const trigger = useRef<HTMLElement | null>(null);
  const add = useAddProject((p) => onChange(p.id));
  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) {
            handedOff.current = false;
            trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }
          setOpen(next);
        }}
      >
        <PopoverTrigger asChild>{children}</PopoverTrigger>
        <PopoverContent
          align="start"
          collisionPadding={12}
          // Never taller than the room Radix measured; the list scrolls inside.
          className="flex max-h-[var(--radix-popover-content-available-height)] w-[440px] flex-col overflow-hidden p-0"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            if (!touchScreen()) input.current?.focus();
          }}
          onCloseAutoFocus={(e) => {
            if (handedOff.current) e.preventDefault();
            handedOff.current = false;
          }}
        >
          <ProjectChooser
            value={value}
            inputRef={input}
            onPicked={(p) => {
              handedOff.current = true;
              setOpen(false);
              onChange(p.id);
            }}
            onAdd={() => {
              handedOff.current = true;
              setOpen(false);
              add.start("folder", trigger.current);
            }}
          />
        </PopoverContent>
      </Popover>
      {add.dialog}
    </>
  );
}

/**
 * The chooser on a page rather than in a dropdown: the first run's project step (routes/onboarding). With
 * projects here it is the picker's list, its "Add a project" opening the dialog; with none yet it is Add a
 * project's two ways in, a folder on this computer or a GitHub repository.
 */
export function ProjectChooserPanel({ hasProjects, inputRef, onPicked }: { hasProjects: boolean; inputRef: RefObject<HTMLInputElement | null>; onPicked: (project: Project) => void }) {
  const [from, setFrom] = useState<AddFrom>("folder");
  const add = useAddProject(onPicked);
  // Inside the first run's Card (onboarding/parts.tsx), whose words start 15px in: its 1px edge, then this p-3.5. The
  // rows outdent by their own padding (-mx-2) to line up with the field above them.
  if (!hasProjects)
    return (
      <div className="flex min-h-0 flex-1 flex-col p-3.5">
        <AddProject from={from} onFrom={setFrom} inputRef={inputRef} onPicked={onPicked} />
      </div>
    );
  return (
    <>
      <ProjectChooser value={null} inputRef={inputRef} onPicked={onPicked} onAdd={() => add.start("folder")} />
      {add.dialog}
    </>
  );
}

/**
 * Add a project: a dialog with two ways in, a folder on this computer or a GitHub repository. `start()`
 * opens it on the folder tab (`start("github")` on GitHub). Closed without adding, it hands focus back to
 * `returnTo`, else to whatever had focus when it opened.
 */
export function useAddProject(onAdded: (project: Project) => void) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState<AddFrom>("folder");
  const input = useRef<HTMLInputElement>(null);
  // No Dialog.Trigger (several buttons open it), so Radix has nowhere to return focus: remember the opener.
  const opener = useRef<HTMLElement | null>(null);
  const picked = useRef(false);
  const dialog = (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className={`fixed inset-0 z-40 bg-black/50 ${overlayMotion}`} />
        <Dialog.Content
          aria-describedby={undefined}
          ref={clickOrigin}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            if (!touchScreen()) input.current?.focus();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (!picked.current) opener.current?.focus();
          }}
          className={`dashboard-scope fixed inset-x-0 top-[14vh] z-50 mx-auto flex w-[min(480px,calc(100vw-32px))] flex-col gap-3 overflow-hidden rounded-xl border border-border bg-popover p-4 shadow-overlay outline-none ${modalMotion}`}
        >
          <AddProject
            inDialog
            from={from}
            onFrom={setFrom}
            inputRef={input}
            onPicked={(p) => {
              picked.current = true;
              setOpen(false);
              onAdded(p);
            }}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
  // A click handler may pass its event straight in: anything but "github" opens on the folder tab.
  const start = (tab?: AddFrom | SyntheticEvent, returnTo?: HTMLElement | null) => {
    opener.current = returnTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    picked.current = false;
    setFrom(tab === "github" ? "github" : "folder");
    setOpen(true);
  };
  return { start, dialog };
}

type Discovered = Result<"project.discover">;

// The last answer, shown at once on the next open while a fresh one loads.
let lastDiscovered: Discovered | null = null;
/** How often, and how many times, to ask again while the runtime is still looking (its longer look takes up to 8.5 s). */
const SEARCH_AGAIN_MS = 1_000;
const SEARCH_TRIES = 12;

/** project.discover, stale-while-revalidate. A runtime without it answers with nothing to suggest. */
export function useDiscovered() {
  const { client } = useRuntimeClient();
  const [data, setData] = useState<Discovered | null>(lastDiscovered);
  const [scanning, setScanning] = useState(false);
  // The runtime answers with what it found so far while a longer look runs (`searching`): ask again shortly, a few times.
  const again = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tries = useRef(0);
  useEffect(() => () => clearTimeout(again.current), []);
  const load = (refresh: boolean) => {
    if (!client) return;
    clearTimeout(again.current);
    if (refresh) tries.current = 0;
    setScanning(true);
    client.call("project.discover", refresh ? { refresh } : {}).then(
      (r) => {
        lastDiscovered = r;
        setData(r);
        const more = r.searching === true && tries.current++ < SEARCH_TRIES;
        setScanning(more);
        if (more) again.current = setTimeout(() => load(false), SEARCH_AGAIN_MS);
      },
      () => {
        setData((d) => d ?? { candidates: [], clone_dir: "" });
        setScanning(false);
      },
    );
  };
  // Once per open, and again when the runtime reconnects.
  useEffect(() => load(false), [client]);
  // An earlier answer that found nothing (a scan the runtime starved) is not the last word while another scan runs.
  const loading = data === null || (scanning && data.candidates.length === 0);
  return { data, scanning, loading, rescan: () => load(true) };
}

export type AddParams = { path: string } | { url: string };

/**
 * project.create, one at a time. A clone can outlast the chooser: once it is closed, the project still lands in the
 * list but is not picked. `add` answers the project, or null when it failed (`error` says why) or another was running.
 * A failed clone also names its way out: `way` (sign in to GitHub, or try again) and `retry`, the same add again.
 */
export function useProjectCreate(onPicked: (project: Project) => void) {
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ error: string; key: string; params: AddParams } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const add = async (key: string, params: AddParams): Promise<Project | null> => {
    if (!client || busy) return null;
    setBusy(key);
    setFailed(null);
    try {
      const project = await client.call("project.create", { request_id: requestId(), ...params });
      await refresh();
      lastDiscovered = null;
      if (mounted.current) onPicked(project);
      return project;
    } catch (e) {
      if (mounted.current) setFailed({ error: e instanceof Error ? e.message : String(e), key, params });
      return null;
    } finally {
      if (mounted.current) setBusy(null);
    }
  };
  // Only a clone has a way out; a folder that would not add keeps its reason.
  const way: CloneWay | null = failed && "url" in failed.params ? cloneWay(failed.error) : null;
  const retry = () => {
    if (failed) void add(failed.key, failed.params);
  };
  return { add, busy, error: failed?.error ?? null, way, retry };
}

/** A failed add's reason, and under it the way out: gh auth login with Copy command, or Try again. */
function AddFailed({ error, way, retry, className }: { error: string; way: CloneWay | null; retry: () => void; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard.writeText(GH_LOGIN).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <p role="alert" className="whitespace-pre-wrap break-words text-[12px] leading-snug text-destructive">
        {error}
      </p>
      {way === "sign-in" ? (
        <>
          <p className="text-[12px] leading-snug text-muted-foreground">
            Sign in with <span className="font-mono">{GH_LOGIN}</span>, then try again.
          </p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={copy}>
              {copied ? "Copied" : "Copy command"}
            </Button>
            <Button size="sm" variant="ghost" onClick={retry}>
              Try again
            </Button>
          </div>
        </>
      ) : way === "retry" ? (
        <div>
          <Button size="sm" variant="secondary" onClick={retry}>
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}

type Row = {
  key: string;
  /** Its heading; rows of one section sit together. None: no heading. */
  section?: string;
  icon: ReactNode;
  label: string;
  /** Line two: where it lives. */
  detail: string;
  /** Right side: where it was found and how recently. */
  meta?: ReactNode;
  title?: string;
  selected?: boolean;
  run: () => void;
};

/** A candidate as a row: its mark (the tab's in Add a project), where it lives, and the add. */
function candidateRow(c: ProjectCandidate, section: string, icon: ReactNode, busy: string | null, cloneDir: string | null, add: (key: string, params: AddParams) => void): Row {
  const key = c.path ?? c.repository?.full_name ?? c.name;
  return {
    key,
    section,
    icon,
    label: c.name,
    detail:
      busy === key
        ? c.path
          ? "Adding…"
          : `Cloning into ${cloneDir ?? "your code folder"}…`
        : c.path
          ? [c.repository?.full_name, parentLabel(c.path)].filter(Boolean).join(" · ")
          : [c.repository?.full_name, c.private ? "private" : null].filter(Boolean).join(" · "),
    meta: <CandidateMeta candidate={c} />,
    title: whyFound(c),
    run: () => void add(key, c.path ? { path: c.path } : { url: c.repository!.clone_url }),
  };
}

/** The listbox's rows: grey section headings, two-line options, the active one lit. */
function ChooserRows({ uid, rows, active, setActive, busy, onActivate }: { uid: string; rows: ReadonlyArray<Row>; active: number; setActive: (i: number) => void; busy: string | null; onActivate: (i: number) => void }) {
  return rows.map((r, i) => (
    <div key={`${r.section ?? ""}:${r.key}`}>
      {r.section && (i === 0 || rows[i - 1]!.section !== r.section) ? <div className="px-2 pb-1 pt-2 text-[12px] text-muted-foreground">{r.section}</div> : null}
      <div
        id={`${uid}-${i}`}
        data-row={i}
        role="option"
        aria-selected={i === active}
        title={r.title}
        onPointerMove={() => i !== active && setActive(i)}
        onClick={() => onActivate(i)}
        className={cn("px-play-hover flex h-11 cursor-default items-center gap-2.5 rounded-md px-2 transition-colors duration-75", i === active && "bg-accent", busy !== null && busy !== r.key && "opacity-50")}
        data-active={i === active || undefined}
      >
        <span className={cn("grid size-[18px] shrink-0 place-items-center", i === active ? "text-foreground" : "text-muted-foreground")}>{r.icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-5 text-foreground">{r.label}</span>
          <span className={cn("block truncate text-[12px] leading-4 text-muted-foreground", busy === r.key && "lucy-shimmer")}>{r.detail}</span>
        </span>
        {r.meta}
        {r.selected ? <Icon icon={Tick02Icon} className="size-4 shrink-0 text-muted-foreground" /> : null}
      </div>
    </div>
  ));
}

/** Keeps the active row in view as the arrow keys walk it. */
function useActiveInView(list: RefObject<HTMLElement | null>, active: number) {
  // Block body: scrollIntoView returns a Promise in newer browsers, and an effect must not return one.
  useEffect(() => {
    list.current?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
}

const SUGGESTED_AT_REST = 6;
const GITHUB_AT_REST = 4;

/** The dropdown: your projects first, then a few repositories worth adding; Add a project at the foot. */
function ProjectChooser({ value, inputRef, onPicked, onAdd }: { value: string | null; inputRef: RefObject<HTMLInputElement | null>; onPicked: (project: Project) => void; onAdd: () => void }) {
  const projects = useRuntimeSelector((v) => v.projects);
  const here = useRuntimeSelector((v) => v.identity.computerWord);
  // Off line (asleep, suspended), the computer can't look: the list says so instead of looking forever.
  const online = useRuntimeSelector((v) => v.identity.computerOnline);
  const { data, scanning, loading: looking, rescan } = useDiscovered();
  const loading = looking && online;
  const { add, busy, error, way, retry } = useProjectCreate(onPicked);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const uid = useId();
  const cloneDir = data?.clone_dir ? tildify(data.clone_dir) : null;

  /** Nothing else is picked while an add or clone runs. */
  const activate = (i: number) => {
    if (busy === null) rows[i]?.run();
  };

  const rows = useMemo<Row[]>(() => {
    const q = query.trim();
    const out: Row[] = [];
    const parsed = parseAddQuery(q);
    const sections = candidateSections(data?.candidates ?? [], q);
    // Pinned projects first; archived ones only when already picked.
    const found = pickableProjects(projects, value).filter((p) => answers(q, { name: p.name, full_name: p.repository?.full_name, path: p.path }));

    // What the query itself names, unless a project or candidate already is that repository.
    if (parsed?.kind === "path")
      out.push({ key: "typed", section: "Add", icon: <Icon icon={Folder01Icon} className="size-4" />, label: "Add this folder", detail: parsed.path, run: () => void add("typed", { path: parsed.path }) });
    if (parsed?.kind === "url" && found.length === 0 && sections.length === 0)
      out.push({
        key: "typed",
        section: "Add",
        icon: <BrandMark name="github" />,
        label: `Clone ${parsed.fullName ?? parsed.url}`,
        detail: cloneDir ? `Into ${cloneDir}, or links the checkout already here` : "Links the checkout already here, or clones it",
        run: () => void add("typed", { url: parsed.url }),
      });

    for (const p of found)
      out.push({
        key: p.id,
        section: "Projects",
        icon: <ProjectBadge github={p.repository?.host === "github.com"} />,
        label: p.name,
        detail: [p.repository?.full_name, tildify(p.path)].filter(Boolean).join(" · "),
        selected: p.id === value,
        run: () => onPicked(p),
      });

    let suggested = 0;
    let github = 0;
    for (const { section, candidate: c } of sections) {
      if (!q && section === "Suggested" && ++suggested > SUGGESTED_AT_REST) continue;
      if (!q && section === "On GitHub" && ++github > GITHUB_AT_REST) continue;
      out.push(candidateRow(c, section, <ProjectBadge github={!c.path || c.repository?.host === "github.com"} />, busy, cloneDir, add));
    }
    return out;
  }, [query, data, projects, value, busy, cloneDir]);

  useEffect(() => setActive(0), [query]);
  useActiveInView(list, active);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(e)) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter" && !isComposing(e)) {
      e.preventDefault();
      activate(active);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* mx-3.5: the lens starts where the rows' marks do (the list's px-1.5, then a row's px-2). */}
      <div className="relative mx-3.5 flex h-11 shrink-0 items-center gap-2">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded
          aria-controls={`${uid}-list`}
          aria-activedescendant={rows[active] ? `${uid}-${active}` : undefined}
          aria-autocomplete="list"
          aria-label="Search projects and repositories"
          placeholder="Search projects"
          spellCheck={false}
          autoComplete="off"
          className="peer order-2 h-full min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
        />
        <Icon icon={Search01Icon} className="order-1 size-4 shrink-0 text-muted-foreground" />
        <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-border" />
        <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px origin-center scale-x-0 bg-target transition-transform duration-200 ease-swift peer-focus:scale-x-100" />
      </div>

      <div
        ref={list}
        id={`${uid}-list`}
        role="listbox"
        aria-label="Projects and repositories"
        aria-busy={loading || scanning}
        className="max-h-[360px] min-h-[96px] flex-1 overflow-y-auto overscroll-contain px-1.5 py-1.5 [mask-image:linear-gradient(to_bottom,black_calc(100%-16px),transparent)]"
      >
        <ChooserRows uid={uid} rows={rows} active={active} setActive={setActive} busy={busy} onActivate={activate} />
        {loading ? <Scanning label="Looking through your Claude and Codex history and code folders…" /> : null}
        {!loading && rows.length === 0 ? <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">{query.trim() ? `Nothing matches “${query.trim()}”.` : online ? "No projects yet." : `No projects yet, and ${here} is off line. Its repositories show here once it's back.`}</p> : null}
      </div>

      {error ? <AddFailed error={error} way={way} retry={retry} className="shrink-0 border-t border-border px-3 py-2" /> : null}

      <div className="flex h-10 shrink-0 items-center gap-1 border-t border-border px-1.5 text-[12px] text-muted-foreground">
        <button type="button" onClick={onAdd} disabled={busy !== null} className="flex h-7 items-center gap-2 rounded-md px-2 hover:bg-accent hover:text-foreground disabled:opacity-50">
          <Icon icon={Add01Icon} className="size-3.5" />
          Add a project…
        </button>
        <span className="flex-1" />
        <RescanButton scanning={scanning} onClick={rescan} />
      </div>
    </div>
  );
}

function RescanButton({ scanning, onClick, className }: { scanning: boolean; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={scanning}
      aria-label="Look for repositories again"
      title="Look for repositories again"
      className={cn("grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50", className)}
    >
      <Icon icon={RefreshCwIcon} className={cn("size-3.5", scanning && "animate-spin")} />
    </button>
  );
}

const FOLDER_MARK = <Icon icon={Folder01Icon} className="size-4 shrink-0" />;
const GITHUB_MARK = <BrandMark name="github" />;

/**
 * Add a project's two tabs. On this Mac: the desktop's folder picker (a path field in a browser; both take a
 * typed path), above the checkouts found here. GitHub: a link or owner/name to clone, above your repositories.
 * Each field also searches its list, and hands a link or path that belongs on the other tab across.
 */
const TITLE = "flex-1 text-[13px] font-medium leading-tight text-foreground";

/** `inDialog`: its heading names the dialog; first run shows it on the page, where a Dialog.Title would throw. */
function AddProject({ from, onFrom, inputRef, onPicked, inDialog = false }: { from: AddFrom; onFrom: (from: AddFrom) => void; inputRef: RefObject<HTMLInputElement | null>; onPicked: (project: Project) => void; inDialog?: boolean }) {
  const projects = useRuntimeSelector((v) => v.projects);
  // The computer it adds to: "this Mac" where the page runs on it, else its name (a phone driving a Mac, say).
  const here = useRuntimeSelector((v) => v.identity.computerWord);
  // Off line (asleep, suspended), it can neither look nor add; the list says so instead of looking forever.
  const online = useRuntimeSelector((v) => v.identity.computerOnline);
  const { data, scanning, loading: looking, rescan } = useDiscovered();
  const loading = looking && online;
  const { add, busy, error, way, retry } = useProjectCreate(onPicked);
  // One field per tab, so switching tabs never carries a path to GitHub or a link to this Mac.
  const [queries, setQueries] = useState<Record<AddFrom, string>>({ folder: "", github: "" });
  const query = queries[from];
  const field = readAddField(from, query);
  // Something typed to add: Enter adds it, so no row is lit until the arrow keys pick one.
  const typed = field.kind === "path" || field.kind === "url";
  const [active, setActive] = useState(typed ? -1 : 0);
  const list = useRef<HTMLDivElement>(null);
  const fade = useFadeEdges<HTMLDivElement>(list);
  const uid = useId();
  const pickFolder = window.cavemanDesktop?.pickFolder;
  const cloneDir = data?.clone_dir ? tildify(data.clone_dir) : null;

  const switchTo = (to: AddFrom, carry?: string) => {
    if (carry !== undefined) setQueries((q) => ({ ...q, [to]: carry }));
    onFrom(to);
    inputRef.current?.focus();
  };

  const submit = () => {
    if (field.kind === "path") void add("typed", { path: field.path });
    else if (field.kind === "url") void add("typed", { url: field.url });
  };

  const browse = async () => {
    if (busy !== null) return;
    const folder = await pickFolder?.();
    if (folder) await add("browse", { path: folder });
  };

  const rows = useMemo<Row[]>(() => {
    const q = query.trim();
    const out: Row[] = [];
    const mark = from === "folder" ? FOLDER_MARK : GITHUB_MARK;
    if (field.kind === "elsewhere")
      out.push(
        field.to === "github"
          ? { key: "elsewhere", icon: GITHUB_MARK, label: "Clone it from GitHub", detail: `That's a link, not a folder on ${here}`, run: () => switchTo("github", q) }
          : { key: "elsewhere", icon: FOLDER_MARK, label: `Add it as a folder on ${here}`, detail: "That's a path, not a GitHub link", run: () => switchTo("folder", q) },
      );
    // Searching shows what is a project already, so a name that finds nothing new still finds something.
    if (q)
      for (const p of projects) {
        if ((from === "github" && p.repository?.host !== "github.com") || !answers(q, { name: p.name, full_name: p.repository?.full_name, path: p.path })) continue;
        out.push({ key: p.id, section: "Already added", icon: mark, label: p.name, detail: [p.repository?.full_name, tildify(p.path)].filter(Boolean).join(" · "), run: () => onPicked(p) });
      }
    const section = from === "folder" ? `Found on ${here}` : "Your repositories";
    for (const c of candidatesFor(from, data?.candidates ?? [], q)) out.push(candidateRow(c, section, mark, busy, cloneDir, add));
    return out;
  }, [from, query, data, projects, busy, cloneDir, here]);

  useEffect(() => setActive(typed ? -1 : 0), [from, query]);
  useActiveInView(list, active);
  // The list grows as discovery answers: fade its edge once it scrolls, not only after the first scroll.
  useEffect(() => fadeEdges(list.current), [rows]);

  /** Nothing else is picked while an add or clone runs. */
  const activate = (i: number) => {
    if (busy === null) rows[i]?.run();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(e)) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(typed ? -1 : 0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter" && !isComposing(e)) {
      e.preventDefault();
      if (active >= 0 && rows[active]) activate(active);
      else submit();
    }
  };

  // ⌘O anywhere in the dialog opens the folder picker, from either tab.
  const onDialogKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "o" && (e.metaKey || e.ctrlKey) && pickFolder) {
      e.preventDefault();
      if (from !== "folder") onFrom("folder");
      void browse();
    }
  };

  const q = query.trim();
  const adding = busy === "typed" || busy === "browse";
  const action =
    from === "github" ? (
      <Button type="button" onClick={submit} disabled={field.kind !== "url" || busy !== null || !online}>
        {busy === "typed" ? "Cloning…" : "Clone"}
      </Button>
    ) : field.kind === "path" || !pickFolder ? (
      <Button type="button" onClick={submit} disabled={field.kind !== "path" || busy !== null || !online}>
        {adding ? "Adding…" : "Add"}
      </Button>
    ) : (
      <Button type="button" variant="secondary" onClick={() => void browse()} disabled={busy !== null} title={`Choose a folder (${formatChord("mod+o")})`}>
        <Icon icon={FolderOpenIcon} className="size-4" />
        {adding ? "Adding…" : "Choose…"}
      </Button>
    );
  const empty = !online
    ? `${here.charAt(0).toUpperCase()}${here.slice(1)} is off line, so nothing can be added to it now. What's on it shows here once it's back.`
    : from === "folder"
      ? q
        ? `Nothing found on ${here} matches “${q}”.`
        : `No repositories found on ${here} yet. ${pickFolder ? "Choose any folder to add it." : "Paste a folder's path to add it."}`
      : q
        ? `None of your repositories match “${q}”. Paste its link to clone it.`
        : "No GitHub repositories found. Paste a link to clone one.";

  return (
    <div className="flex min-h-0 flex-col gap-3" onKeyDown={onDialogKeyDown}>
      <div className="flex items-center gap-2">
        {inDialog ? <Dialog.Title className={TITLE}>Add a project</Dialog.Title> : <h2 className={TITLE}>Add a project</h2>}
        {/* -mr-[7px]: the glyph, not its 28px hover box, ends where the field's Add button and the rows' times do. */}
        <RescanButton scanning={scanning} onClick={rescan} className="-mr-[7px]" />
      </div>

      <SourceTabs uid={uid} from={from} here={here} onFrom={onFrom} onPicked={() => inputRef.current?.focus()} />

      <div role="tabpanel" id={`${uid}-panel`} aria-labelledby={`${uid}-tab-${from}`} className="flex min-h-0 flex-col gap-2">
        <div className="flex items-center gap-2">
          <Input
            ref={inputRef}
            value={query}
            // A path copied from Finder or Explorer comes quoted or escaped for a shell ('/a b', /a\ b, "C:\a b"): it reads
 // as that folder, not a search (upstream #28460).
            onChange={(e) => {
              const next = e.target.value;
              setQueries((all) => ({ ...all, [from]: from === "folder" ? resolvePastedPath(all[from], next) : next }));
            }}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded
            aria-controls={`${uid}-list`}
            aria-activedescendant={active >= 0 && rows[active] ? `${uid}-${active}` : undefined}
            aria-autocomplete="list"
            aria-label={from === "folder" ? "Folder path, or search" : "GitHub link or owner/name, or search"}
            placeholder={from === "folder" ? (pickFolder ? "Search, or paste a path" : "Paste a path, like ~/code/my-app") : "owner/repo, or a GitHub link"}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            className="min-w-0 flex-1 font-mono text-[12px] placeholder:font-sans"
          />
          {action}
        </div>
        {from === "github" ? (
          <p className="flex min-w-0 whitespace-pre text-[12px] leading-snug text-muted-foreground">
            <span className="shrink-0">Clones into </span>
            <span className="min-w-0 truncate" title={cloneDir ?? undefined}>
              {cloneDir ?? "your code folder"}
            </span>
            <span className="shrink-0">, or uses the copy already on {here}.</span>
          </p>
        ) : null}
        {error ? <AddFailed error={error} way={way} retry={retry} /> : null}

        <div
          ref={fade.ref}
          onScroll={fade.onScroll}
          id={`${uid}-list`}
          role="listbox"
          aria-label={from === "folder" ? `Repositories on ${here}` : "Your GitHub repositories"}
          aria-busy={loading || scanning}
          className="-mx-2 max-h-[min(360px,50vh)] overflow-y-auto overscroll-contain"
        >
          <ChooserRows uid={uid} rows={rows} active={active} setActive={setActive} busy={busy} onActivate={activate} />
          {/* Nothing here yet while the runtime still looks (a busy computer): looking, never "none found". */}
          {loading || (scanning && online && rows.length === 0 && !typed) ? <Scanning label={from === "folder" ? `Looking for repositories on ${here}…` : "Looking for your GitHub repositories…"} /> : null}
          {!loading && !(scanning && online) && (rows.length === 0 || !online) && !typed ? <p className="px-2 py-4 text-[12px] leading-snug text-muted-foreground">{empty}</p> : null}
        </div>
      </div>
    </div>
  );
}

/** On this Mac (or the driven computer's name) | GitHub: the settings kit's segmented look, as tabs over one panel. */
function SourceTabs({ uid, from, here, onFrom, onPicked }: { uid: string; from: AddFrom; here: string; onFrom: (from: AddFrom) => void; onPicked: () => void }) {
  const tabs: ReadonlyArray<{ value: AddFrom; label: string; icon: ReactNode }> = [
    { value: "folder", label: `On ${here}`, icon: FOLDER_MARK },
    { value: "github", label: "GitHub", icon: <BrandMark name="github" size={14} /> },
  ];
  const step = (e: KeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (tabs.findIndex((t) => t.value === from) + delta + tabs.length) % tabs.length;
    onFrom(tabs[next]!.value);
    (e.currentTarget.children[next] as HTMLElement | undefined)?.focus();
  };
  return (
    <div role="tablist" aria-label="Where the code is" onKeyDown={step} className="grid grid-cols-2 rounded-lg border border-border bg-background p-0.5">
      {tabs.map((t) => (
        <button
          key={t.value}
          id={`${uid}-tab-${t.value}`}
          type="button"
          role="tab"
          aria-selected={t.value === from}
          aria-controls={`${uid}-panel`}
          tabIndex={t.value === from ? 0 : -1}
          onClick={() => {
            onFrom(t.value);
            onPicked();
          }}
          className={cn(
            "flex h-7 items-center justify-center gap-2 rounded-md text-[12.5px] text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            t.value === from && "bg-secondary text-foreground",
          )}
        >
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Where it was found (vendor marks) and how recently it was active. */
export function CandidateMeta({ candidate: c }: { candidate: ProjectCandidate }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[12px] tabular-nums text-[hsl(var(--subtle-foreground))]">
      {c.sources.includes("claude") ? <BrandMark name="claude" size={14} /> : null}
      {c.sources.includes("codex") ? <BrandMark name="openai" size={14} className="text-muted-foreground" /> : null}
      {c.path ? null : <span className="rounded border border-border px-1.5 leading-[18px] text-muted-foreground">Clone</span>}
      {c.last_active_at ? <span className="ml-0.5 w-7 text-right">{ago(c.last_active_at)}</span> : null}
    </span>
  );
}

function whyFound(c: ProjectCandidate): string {
  const engines = [c.sources.includes("claude") ? "Claude" : null, c.sources.includes("codex") ? "Codex" : null].filter(Boolean).join(" and ");
  const parts = [
    c.sessions > 0 && engines ? `${c.sessions} ${engines} session${c.sessions === 1 ? "" : "s"} here` : null,
    c.sources.includes("folder") && !engines ? "Next to repositories you use" : null,
    c.path ? null : "On your GitHub, not on this computer yet",
    c.path ? tildify(c.path) : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

function Scanning({ label }: { label: string }) {
  return (
    <div aria-hidden>
      <div className="lucy-shimmer px-2 pb-1 pt-2 text-[12px] text-muted-foreground">{label}</div>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex h-11 items-center gap-2.5 px-2">
          <span className="size-[18px] rounded-[5px] bg-foreground/[0.06]" />
          <span className="flex flex-1 flex-col gap-1.5">
            <span className="h-2.5 rounded bg-foreground/[0.07]" style={{ width: `${32 + ((i * 17) % 30)}%` }} />
            <span className="h-2 rounded bg-foreground/[0.04]" style={{ width: `${48 + ((i * 11) % 24)}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

export const LAST_PROJECT = "caveman.lastProject";

/**
 * The project a page is about: `?project=`, else the one last picked (here or on Plugins), else the newest
 * chat's, else the first. `choose` remembers it. `inUrl` false (an empty split pane, one of several on a
 * page): the pick is this box's own, never `?project=`.
 */
export function useLastProject({ inUrl = true }: { inUrl?: boolean } = {}) {
  const projects = useRuntimeSelector((v) => v.projects);
  const workspaces = useRuntimeSelector((v) => v.workspaces);
  const [params, setParams] = useSearchParams();
  const [own, setOwn] = useState<string | null>(null);
  const wanted = (inUrl ? params.get("project") : own) ?? localStorage.getItem(LAST_PROJECT);
  const newest = [...workspaces].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).find((w) => projects.some((p) => p.id === w.projectId));
  const project = projects.find((p) => p.id === wanted) ?? projects.find((p) => p.id === newest?.projectId) ?? pickableProjects(projects)[0] ?? projects[0] ?? null;
  const choose = (id: string) => {
    localStorage.setItem(LAST_PROJECT, id);
    if (inUrl) setParams({ project: id }, { replace: true });
    else setOwn(id);
  };
  return { project, choose };
}
