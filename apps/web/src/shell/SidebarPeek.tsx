import { menuSurface } from "@caveman-app/ui/components/menu";
import { EffortPip, EngineLogo, engineBrand, shortModel } from "@caveman-app/ui/components/runner-badge";
import { BrandMark } from "@caveman-app/ui/icons/brand";
import { COMPUTER_KIND_ICON } from "@caveman-app/ui/icons/names";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, AlarmClockIcon, Comment01Icon, Folder01Icon, GitBranchIcon, LinkSquare02Icon, SourceCodeIcon } from "@caveman-app/ui/icons/huge";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { StatusMark } from "../components/StatusMark.tsx";
import { tildify } from "../lib/paths.ts";
import { short } from "../panels/agents/states.ts";
import { ChatPrMarks, PrMark } from "../routes/review/parts.tsx";
import { wakeLabel } from "../state/inbox-state.ts";
import { chatStage, engineLine, rowAge, type ChatStatus, type SidebarFolder, type WorkspaceView } from "../state/model.ts";
import { runnerFor } from "../state/runner.ts";
import { useLoadedTurn, useRuntimeClient, useRuntimeSelector } from "../state/runtime.tsx";
import { Glyph, FolderGlyph } from "@caveman-app/ui/icons/Glyph";

/** Rest this long on a row before its card opens; once one is open, the next row's opens at once (a tooltip run). */
const OPEN_MS = 500;
/** How long after a card closes the next still opens at once. */
const WARM_MS = 400;
/** Grace for the pointer crossing the gap between two rows. */
const CLOSE_MS = 80;
/** Between the sidebar's edge and the card. */
const GAP = 6;

/**
 * The card a sidebar row shows on hover or keyboard focus (upstream ThreadHoverCard): a chat's title in full, what
 * it waits on or is doing, then where it lives and who runs it; a project's chats, path and repository. One card for
 * the whole sidebar: rows only carry `data-peek="chat:<id>"` or `"project:<id>"`, and this listens on the sidebar,
 * so a row costs nothing until it is rested on. Pressing a row, scrolling, Escape or a drag closes it, and it stays
 * shut on that row until the pointer leaves it. It never takes the pointer: it is a glance, the row's own menu acts.
 */
export function SidebarPeek({
  root,
  workspaces,
  folders,
  statuses,
}: {
  root: RefObject<HTMLElement | null>;
  workspaces: ReadonlyArray<WorkspaceView>;
  folders: ReadonlyArray<SidebarFolder>;
  statuses: ReadonlyMap<string, ChatStatus | null>;
}) {
  // `edge`: the sidebar's right side, where the card goes.
  const [shown, setShown] = useState<{ readonly anchor: HTMLElement; readonly warm: boolean; readonly edge: number } | null>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let open: HTMLElement | null = null;
    let closedAt = 0;
    let pressed: HTMLElement | null = null;
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      clearTimeout(openTimer);
      clearTimeout(closeTimer);
    };
    const show = (anchor: HTMLElement) => {
      clear();
      const warm = open !== null || Date.now() - closedAt < WARM_MS;
      open = anchor;
      setShown({ anchor, warm, edge: el.getBoundingClientRect().right });
    };
    const hide = () => {
      clear();
      if (!open) return;
      open = null;
      closedAt = Date.now();
      setShown(null);
    };
    const peekOf = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>("[data-peek]") : null);
    const over = (e: PointerEvent) => {
      // A held button is a press or a drag; touch has no hover.
      if (e.pointerType === "touch" || e.buttons !== 0) return;
      const anchor = peekOf(e.target);
      if (!anchor || anchor === pressed) return;
      if (anchor === open) return void clearTimeout(closeTimer);
      clearTimeout(openTimer);
      if (open || Date.now() - closedAt < WARM_MS) show(anchor);
      else openTimer = setTimeout(() => show(anchor), OPEN_MS);
    };
    const out = (e: PointerEvent) => {
      const from = peekOf(e.target);
      if (!from || peekOf(e.relatedTarget) === from) return;
      if (from === pressed) pressed = null;
      clearTimeout(openTimer);
      if (open) closeTimer = setTimeout(hide, CLOSE_MS);
    };
    const down = (e: PointerEvent) => {
      pressed = peekOf(e.target);
      hide();
    };
    // The keyboard gets the same card, on the row it walks to; a click's focus does not open one.
    const focusIn = (e: FocusEvent) => {
      const anchor = peekOf(e.target);
      if (anchor && anchor !== open && e.target instanceof Element && e.target.matches(":focus-visible")) show(anchor);
    };
    const focusOut = (e: FocusEvent) => {
      if (open && peekOf(e.relatedTarget) !== open && !open.matches(":hover")) hide();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !open) return;
      // Shut while the pointer stays on it; a card the keyboard opened leaves the row's hover alone.
      if (open.matches(":hover")) pressed = open;
      hide();
    };
    el.addEventListener("pointerover", over);
    el.addEventListener("pointerout", out);
    el.addEventListener("pointerdown", down);
    el.addEventListener("focusin", focusIn);
    el.addEventListener("focusout", focusOut);
    // Capture: the sidebar's lists scroll, not the sidebar.
    el.addEventListener("scroll", hide, true);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", hide);
    window.addEventListener("resize", hide);
    return () => {
      clear();
      el.removeEventListener("pointerover", over);
      el.removeEventListener("pointerout", out);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("focusin", focusIn);
      el.removeEventListener("focusout", focusOut);
      el.removeEventListener("scroll", hide, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", hide);
      window.removeEventListener("resize", hide);
    };
  }, [root]);
  if (!shown || !shown.anchor.isConnected) return null;
  const [kind, ...rest] = (shown.anchor.dataset.peek ?? "").split(":");
  const id = rest.join(":");
  let body: ReactNode = null;
  if (kind === "chat") {
    const workspace = workspaces.find((w) => w.id === id);
    const project = folders.find((f) => f.rows.some((r) => r.workspace.id === id || r.children.some((c) => c.id === id)))?.project ?? null;
    if (workspace) body = <ChatPeek workspace={workspace} status={statuses.get(id) ?? null} project={project?.name ?? null} />;
  } else if (kind === "project") {
    const folder = folders.find((f) => f.project.id === id);
    if (folder) body = <ProjectPeek folder={folder} statuses={statuses} />;
  }
  if (!body) return null;
  return createPortal(
    <PeekCard anchor={shown.anchor} edge={shown.edge} warm={shown.warm}>
      {body}
    </PeekCard>,
    document.body,
  );
}

/**
 * The card beside the sidebar, its first line level with the row's: the row's middle meets the title's, then it is
 * kept inside the window. Placed before paint, so it never jumps. Cold, it grows from the row (the tooltip entrance);
 * warm, from one row to the next, it just moves.
 */
function PeekCard({ anchor, edge, warm, children }: { anchor: HTMLElement; edge: number; warm: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const card = ref.current;
    if (!card) return;
    const row = anchor.getBoundingClientRect();
    // TITLE_MIDDLE: the card's top padding plus half the title's line.
    const top = row.top + Math.min(row.height, ROW) / 2 - TITLE_MIDDLE;
    card.style.top = `${Math.round(Math.max(8, Math.min(top, window.innerHeight - 8 - card.offsetHeight)))}px`;
    card.style.left = `${Math.round(edge + GAP)}px`;
  });
  return (
    <div
      ref={ref}
      aria-hidden
      className={cn(
        menuSurface,
        "pointer-events-none fixed w-[288px] px-3 pb-2.5 pt-2.5",
        !warm && "origin-left animate-in fade-in-0 zoom-in-[0.97] slide-in-from-left-1 duration-150 ease-snap motion-reduce:animate-none",
      )}
    >
      {children}
    </div>
  );
}

/** A one-line row's height (WorkspaceRow, ProjectFolder); a taller row (the queue's) is met at its first line. */
const ROW = 38;
/** pt-2.5 and half the title's 18px line. */
const TITLE_MIDDLE = 10 + 9;

function Header({ title, at }: { title: string; at: string | null }) {
  const [now] = useState(Date.now);
  return (
    <div className="flex items-start gap-3">
      <p className="line-clamp-2 min-w-0 flex-1 text-[13.5px] font-medium leading-[18px] text-foreground [overflow-wrap:anywhere]">{title}</p>
      {at ? <span className="shrink-0 text-[12px] leading-[18px] tabular-nums text-[hsl(var(--subtle-foreground))]">{ago(rowAge(at, now))}</span> : null}
    </div>
  );
}

function ago(age: string): string {
  return age === "now" || age === "" ? "now" : `${age} ago`;
}

/** One line of the card: a 16px icon column every line shares, so icons and text each start on one edge. */
function Line({ icon, children, className }: { icon: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-5 min-w-0 items-start gap-2 text-[12.5px] leading-5 text-secondary-foreground", className)}>
      <span className="flex h-5 w-4 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
      {children}
    </div>
  );
}

/**
 * A chat: what it needs from you or is doing comes first, under its title, since that is why you look; then the
 * project, the computer, the branch (with its pull request) and who runs it. Lines with nothing to say are left out.
 */
function ChatPeek({ workspace: w, status, project }: { workspace: WorkspaceView; status: ChatStatus | null; project: string | null }) {
  const { client } = useRuntimeClient();
  const engines = useRuntimeSelector((v) => v.engines);
  const wire = useRuntimeSelector((v) => v.raw.get(w.id)?.runner);
  const turn = useLoadedTurn(client, w.sessionId);
  const runner = runnerFor(engines, { engine: w.engine.id, model: turn?.model, effort: turn?.effort, runner: wire });
  const model = shortModel(runner.modelLabel, runner.model);
  const engine = runner.engineLabel ?? w.engine.label;
  const snoozed = w.inbox?.snoozedUntil;
  return (
    <>
      <Header title={w.title} at={w.updatedAt} />
      {status ? <Now status={status} /> : null}
      <div className="mt-2.5 flex flex-col gap-0.5">
        {project ? (
          <Line icon={<FolderGlyph open={false} />}>
            <span className="min-w-0 truncate">{project}</span>
          </Line>
        ) : null}
        <Line icon={<Glyph name={COMPUTER_KIND_ICON[w.computer.kind] ?? "computer-vpc"} />}>
          <span className="min-w-0 truncate">{w.computer.label}</span>
        </Line>
        {w.branch ? (
          <Line icon={<Icon icon={GitBranchIcon} className="size-3.5" />}>
            <span className="min-w-0 truncate font-mono text-[12px]">{w.branch}</span>
            {w.sources ? null : <ChatPrMarks workspace={w} projectId={null} className="ml-auto mt-0.5" />}
          </Line>
        ) : null}
        {/* A chat in several sources: each one under the branch they share, with its own pull request. */}
        {w.sources?.map((s) => (
          <Line key={s.name} icon={<Icon icon={SourceCodeIcon} className="size-3.5" />}>
            <span className="min-w-0 truncate">{s.name}</span>
            {s.pullRequest ? <PrMark pr={s.pullRequest} projectId={null} source={{ name: s.name }} className="ml-auto mt-0.5" /> : null}
          </Line>
        ))}
        <Line icon={<EngineLogo engine={runner.engine} size={engineBrand(runner.engine) ? 14 : 16} />}>
          {model ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate">{model}</span>
              {runner.effort ? <EffortPip effort={runner.effort} className="h-[10px] text-muted-foreground" /> : null}
              <span className="truncate text-muted-foreground">· {engineLine(w, engine)}</span>
            </span>
          ) : (
            <span className="min-w-0 truncate">
              {engine}
              {w.startedBy ? <span className="text-muted-foreground"> · {w.startedBy}</span> : null}
            </span>
          )}
        </Line>
        {snoozed ? (
          <Line icon={<Icon icon={AlarmClockIcon} className="size-3.5" />}>
            <span className="min-w-0 truncate">Snoozed, wakes in {wakeLabel(snoozed)}</span>
          </Line>
        ) : null}
      </div>
    </>
  );
}

/** Its status in words, right under the title: the ask (three lines, it is why you look), a turn's clock and steps, a failure in red. */
function Now({ status }: { status: ChatStatus }) {
  const tone = status.action ? "text-warning" : status.id === "failed" ? "text-destructive" : "text-foreground";
  const ran = status.id === "working" && status.since ? Date.now() - Date.parse(status.since) : 0;
  const detail = [ran >= 60_000 ? short(ran) : null, status.detail].filter(Boolean).join(" · ");
  return (
    <Line icon={<StatusMark status={status} compact />} className="mt-1.5">
      <span className={cn("min-w-0 [overflow-wrap:anywhere]", status.action ? "line-clamp-3" : "line-clamp-2")}>
        <span className={cn("font-medium", tone)}>{status.label}</span>
        {/* An ask is the thing to read; a turn's clock and steps are only about it. */}
        {detail ? <span className={status.action ? undefined : "text-muted-foreground"}> · {detail}</span> : null}
      </span>
    </Line>
  );
}

/** A project: how many chats and which of them want you, then where it is on disk and its repository. */
function ProjectPeek({ folder, statuses }: { folder: SidebarFolder; statuses: ReadonlyMap<string, ChatStatus | null> }) {
  const { project, rows } = folder;
  const { needs, atWork, newest } = projectTally(folder, statuses);
  const repo = project.repository;
  return (
    <>
      <Header title={project.name} at={newest} />
      <div className="mt-2.5 flex flex-col gap-0.5">
        <Line icon={<Icon icon={Comment01Icon} className="size-3.5" />}>
          <span className="min-w-0 truncate">
            {rows.length === 0 ? (
              <span className="text-muted-foreground">No chats yet</span>
            ) : (
              <>
                {rows.length} {rows.length === 1 ? "chat" : "chats"}
                {needs > 0 ? <span className="text-warning"> · {needs} {needs === 1 ? "needs" : "need"} you</span> : null}
                {atWork > 0 ? <span className="text-muted-foreground"> · {atWork} at work</span> : null}
              </>
            )}
          </span>
        </Line>
        {project.path ? (
          <Line icon={<Icon icon={Folder01Icon} className="size-3.5" />}>
            <span className="min-w-0 truncate">{fitPath(tildify(project.path))}</span>
          </Line>
        ) : null}
        {repo ? (
          <Line icon={repo.host === "github.com" ? <BrandMark name="github" size={14} /> : <Icon icon={LinkSquare02Icon} className="size-3.5" />}>
            <span className="min-w-0 truncate">{repo.host === "github.com" ? repo.full_name : `${repo.host}/${repo.full_name}`}</span>
          </Line>
        ) : null}
      </div>
    </>
  );
}

/**
 * A project's chats as its card counts them, every number over the same chats (the folder's leads), by the queue's
 * stages (model.ts chatStage): one that needs you, itself or one of its agents; one at work, which a lead waiting on
 * its agents is.
 * Exported for its test.
 */
export function projectTally(folder: SidebarFolder, statuses: ReadonlyMap<string, ChatStatus | null>): { needs: number; atWork: number; newest: string | null } {
  let needs = 0;
  let atWork = 0;
  let newest: string | null = null;
  for (const { workspace, children } of folder.rows) {
    const chat = [workspace, ...children];
    if (chat.some((w) => chatStage(statuses.get(w.id) ?? null, w) === "needs")) needs++;
    else if (chatStage(statuses.get(workspace.id) ?? null, workspace) === "working") atWork++;
    for (const w of chat) if (newest === null || w.updatedAt > newest) newest = w.updatedAt;
  }
  return { needs, atWork, newest };
}

/** A long path with its middle folders folded, so its own folder always shows: ~/…/GitHub/caveman. Exported for its test. */
export function fitPath(path: string, max = 36): string {
  if (path.length <= max) return path;
  const sep = path.includes("/") ? "/" : "\\";
  const parts = path.split(sep);
  const head = parts[0] ?? "";
  let tail = parts[parts.length - 1] ?? "";
  for (let i = parts.length - 2; i > 0; i--) {
    const next = `${parts[i]}${sep}${tail}`;
    if (head.length + next.length + 3 > max) break;
    tail = next;
  }
  return `${head}${sep}…${sep}${tail}`;
}
