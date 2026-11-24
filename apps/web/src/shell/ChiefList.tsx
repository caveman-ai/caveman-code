// The sidebar's Chiefs: the person's own, apart from their projects ("chiefs should be
// separate in the sidebar"), listed for clean mobile navigation, as a messenger lists its
// conversations: who, what they last said and when (docs/chief.md "Its screen").
import type { ChiefItem, ChiefProfile, ChiefVoice } from "@caveman-app/session-protocol";
import { ConfirmDialog } from "@caveman-app/ui/components/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@caveman-app/ui/components/dropdown-menu";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  Call02Icon,
  Delete02Icon,
  Icon,
  KanbanIcon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  PreferenceHorizontalIcon,
  UserGroupIcon,
} from "@caveman-app/ui/icons/huge";
import { menuDescription } from "@caveman-app/ui/components/menu";
import { cn } from "@caveman-app/ui/lib/cn";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { NavLink, useNavigate } from "react-router";
import { ChiefSprite } from "../components/ChiefSprite.tsx";
import { ago } from "../components/project-candidates.ts";
import { registerDropTarget, useDrag, type DragPayload } from "../panes/drag.ts";
import { announce, windowTabs } from "../panes/store.ts";
import { useChief } from "../state/chief.ts";
import { openItemCount, unsortedCount } from "../state/chief-model.ts";
import { chiefBoardPath, chiefPath, useChiefs, type ChiefLatest } from "../state/chiefs.ts";
import type { WorkspaceView } from "../state/model.ts";
import { useWebWindow } from "../state/runtime.tsx";
import { CHIEF_TEMPLATES, freeName, type ChiefTemplate } from "./chief-templates.ts";
import { iconButton } from "./sidebar-style.ts";
import { useTabNav, wantsNewTab } from "./tab-nav.ts";

const FOLDED_KEY = "caveman.sidebarChiefsFolded";
const NO_CHATS: ReadonlyArray<WorkspaceView> = [];

/**
 * Chiefs, above the projects: "Chiefs", then + (a blank Chief or a ready-made one, opened at its name) and ⋯ (every
 * Chief's settings, and folding the list, kept on this device). A row per Chief. A runtime from before several Chiefs,
 * or a window whose Chief lives on another computer, shows one row that leads to its page, which says where it is.
 */
export function ChiefsSection({ workspaces }: { workspaces: ReadonlyArray<WorkspaceView> }) {
  const chiefs = useChiefs();
  // The board is shared: any Chief's store holds every Chief's items, and the calls on this runtime.
  const board = useChief();
  const navigate = useNavigate();
  const [problem, setProblem] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [folded, setFoldedState] = useState(() => localStorage.getItem(FOLDED_KEY) === "1");
  const setFolded = (on: boolean) => {
    localStorage.setItem(FOLDED_KEY, on ? "1" : "0");
    setFoldedState(on);
  };
  // A blank Chief takes the runtime's defaults; a ready-made one its template's name (made free here: the runtime
  // refuses a taken one), character, role and soul.
  const make = (template?: ChiefTemplate) => {
    setProblem(null);
    setMaking(true);
    (template
      ? chiefs.create({
          name: freeName(
            template.name,
            chiefs.chiefs.map((c) => c.name),
          ),
          avatar: template.avatar,
          role: template.role,
          soul: template.soul,
        })
      : chiefs.create()
    )
      .then(
        (made) => navigate(`${chiefPath(made)}?settings=name`),
        (e: unknown) =>
          setProblem(`No Chief was made: ${e instanceof Error ? e.message : String(e)}`),
      )
      .finally(() => setMaking(false));
  };
  const web = useWebWindow();
  const away = board.status === "elsewhere" || (web !== null && board.client === null);
  const ready = !away && chiefs.status === "ready";
  const rows: ReadonlyArray<ChiefProfile | null> = ready
    ? chiefs.chiefs
    : chiefs.status === "absent" || away
      ? [null]
      : [];
  const homeName = chiefs.chiefs.find((c) => c.home)?.name;
  return (
    <section aria-labelledby="sidebar-chiefs" data-tour="chief" className="mt-1">
      {/* As tall as the Projects heading (ChatsHeader), in its type, so the two sections keep one rhythm. */}
      <div className="flex h-8 items-center gap-0.5 pl-2">
        <h2
          id="sidebar-chiefs"
          className="flex-1 text-[12px] font-medium text-[hsl(var(--subtle-foreground))]"
        >
          Chiefs
        </h2>
        {ready ? <NewChiefMenu making={making} onMake={make} /> : null}
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Chiefs options"
            className={cn(
              iconButton,
              "size-7 text-muted-foreground data-[state=open]:bg-sidebar-accent",
            )}
          >
            <Icon icon={MoreHorizontalIcon} className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[220px]">
            <DropdownMenuItem onSelect={() => setFolded(!folded)}>
              <Icon icon={folded ? ArrowDown01Icon : ArrowUp01Icon} />{" "}
              {folded ? "Show Chiefs" : "Hide Chiefs"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => navigate("/settings/chief")}>
              <Icon icon={PreferenceHorizontalIcon} /> Settings for every Chief
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {problem ? (
        <p role="alert" className="px-2 pb-1 text-[13px] leading-4 text-destructive">
          {problem}
        </p>
      ) : null}
      {folded ? null : rows.length === 0 && ready ? (
        <button
          type="button"
          onClick={() => make()}
          disabled={making}
          className="flex h-[28px] w-full items-center gap-1.5 rounded-lg pl-2 text-left text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <Icon icon={Add01Icon} className="size-3" />
          Make a Chief to hand work to
        </button>
      ) : (
        rows.map((c) => (
          <ChiefRow
            key={c?.id ?? "home"}
            chief={c}
            items={board.allItems}
            workspaces={away ? NO_CHATS : workspaces}
            working={c !== null && chiefs.working.has(c.id)}
            latest={c === null ? undefined : chiefs.latest.get(c.id)}
            heir={c === null || c.home ? undefined : homeName}
            onAttach={(chief, chat) =>
              void chiefs.attachChat(chief, chat.workspaceId).then(
                () => setProblem(null),
                (e: unknown) =>
                  setProblem(
                    `${chat.title} was not added: ${e instanceof Error ? e.message : String(e)}`,
                  ),
              )
            }
            voice={board.voice}
            onProblem={setProblem}
          />
        ))
      )}
    </section>
  );
}

/**
 * The section's +: a blank Chief first, then the ready-made ones (chief-templates.ts), each its character, its name
 * and what it covers. A pick goes to the new Chief's page, so the menu hands focus there, not back to +.
 */
function NewChiefMenu({
  making,
  onMake,
}: {
  making: boolean;
  onMake: (template?: ChiefTemplate) => void;
}) {
  const picked = useRef(false);
  const pick = (template?: ChiefTemplate) => {
    picked.current = true;
    onMake(template);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="New Chief"
        title="New Chief"
        disabled={making}
        className={cn(
          iconButton,
          "size-7 text-muted-foreground disabled:opacity-50 data-[state=open]:bg-sidebar-accent",
        )}
      >
        <Icon icon={Add01Icon} className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[300px]"
        onCloseAutoFocus={(e) => {
          if (picked.current) e.preventDefault();
          picked.current = false;
        }}
      >
        <DropdownMenuItem onSelect={() => pick()}>
          {/* In the characters' 24px slot, so every name starts on one edge. */}
          <span className="grid w-6 shrink-0 place-items-center">
            <Icon icon={Add01Icon} />
          </span>
          Blank Chief
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {CHIEF_TEMPLATES.map((t) => (
          <DropdownMenuItem key={t.id} onSelect={() => pick(t)}>
            <ChiefSprite avatar={t.avatar} />
            <span className="shrink-0">{t.name}</span>
            <span className={menuDescription}>{t.line}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A minute's tick, so "5m" turns into "6m" while the sidebar sits open. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

/**
 * A Chief as a messenger lists a conversation: its character in a grey square, its name with when it last spoke, and
 * under them "Working" while it thinks, else its last reply, else "No messages yet". The amber dot while a chat it
 * started, an item of its or a note it has not sorted waits on you. Filled while its page is in front; ⌘-click opens a
 * tab of its own. Hovered or focused, ⋯ takes the time's place. A chat dropped on it joins its board.
 */
function ChiefRow({
  chief,
  items,
  workspaces,
  working,
  latest,
  heir,
  voice,
  onProblem,
  onAttach,
}: {
  chief: ChiefProfile | null;
  items: ReadonlyArray<ChiefItem>;
  workspaces: ReadonlyArray<WorkspaceView>;
  working: boolean;
  latest: ChiefLatest | undefined;
  /** Where its open work goes when it is removed, when the runtime says (its home Chief); else "another Chief". */
  heir: string | undefined;
  /** Calls on this runtime; null: none. */
  voice: ChiefVoice | null;
  /** What went wrong with an action from its ⋯ menu, said under Chiefs. */
  onProblem: (problem: string | null) => void;
  onAttach: (chief: ChiefProfile, chat: DragPayload) => void;
}) {
  // Its own items (no chief_id: a one-Chief runtime's, the home Chief's), and the chats they started.
  const mine =
    chief === null
      ? items
      : items.filter((i) => (i.chief_id === undefined ? chief.home : i.chief_id === chief.id));
  const started = new Set(mine.flatMap((i) => i.workspace_ids));
  const asking = new Set(
    workspaces
      .filter((w) => w.state === "needs_input" && (chief === null || started.has(w.id)))
      .map((w) => w.id),
  );
  // An open item that needs you (a failed chat, a pull request to fix) or that it asked you about, unless one of its
  // chats already asks.
  const flagged = mine.filter(
    (i) =>
      i.state !== "done" &&
      i.state !== "dropped" &&
      (i.state === "needs_you" || i.asked !== undefined) &&
      !i.workspace_ids.some((id) => asking.has(id)),
  ).length;
  const waiting = asking.size + unsortedCount(mine) + flagged;
  const name = chief?.name ?? "Chief";
  const to = chief ? chiefPath(chief) : "/chief";
  const go = useTabNav();
  const inNewTab = (e: MouseEvent<HTMLElement>) => {
    if (!wantsNewTab(e)) return;
    e.preventDefault();
    go(windowTabs.openPage(to));
  };
  const now = useMinute();
  const when = latest ? ago(latest.at, now) : "";
  const line = working ? "Working" : (latest?.reply ?? "No messages yet");
  // A chat dragged from the sidebar onto it joins its board (panes/drag.ts).
  const row = useRef<HTMLDivElement>(null);
  const attach = useRef(onAttach);
  attach.current = onAttach;
  useEffect(
    () =>
      chief
        ? registerDropTarget(row.current!, {
            kind: "chief",
            id: chief.id,
            name: chief.name,
            onDrop: (p) => attach.current(chief, p),
          })
        : undefined,
    [chief],
  );
  const drag = useDrag();
  const dropHere = chief !== null && drag.target?.kind === "chief" && drag.target.id === chief.id;
  return (
    <div
      ref={row}
      className={cn(
        "group/chief relative mb-px rounded-lg",
        dropHere && "bg-target/10 ring-2 ring-inset ring-target",
      )}
    >
      <NavLink
        to={to}
        end
        onClick={inNewTab}
        onAuxClick={inNewTab}
        data-sidebar-row=""
        aria-label={`${name}${working ? ", working" : ""}${waiting > 0 ? `, ${waiting} need you` : ""}`}
        aria-description={working ? undefined : line}
        className={cn(
          "flex h-11 w-full items-center gap-2.5 rounded-lg pl-1.5 pr-2 text-left outline-none transition-colors duration-75",
          "text-sidebar-foreground hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          "aria-[current=page]:bg-sidebar-accent",
        )}
      >
        {/* Its character at 1x, every pixel whole, on a quiet square that keeps the club and ears inside it: standing,
            or working its rock while it thinks. */}
        <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-foreground/[0.06]">
          <ChiefSprite
            avatar={chief?.avatar ?? null}
            pose={working ? "working" : "idle"}
            animate={working}
          />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-[18px] text-sidebar-accent-foreground/90">
              {name}
            </span>
            {when ? (
              <span className="shrink-0 text-[11px] tabular-nums leading-[18px] text-[hsl(var(--subtle-foreground))] transition-opacity duration-75 group-hover/chief:opacity-0 group-focus-within/chief:opacity-0 group-has-[[data-state=open]]/chief:opacity-0">
                {when}
              </span>
            ) : null}
          </span>
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              className={cn(
                "min-w-0 flex-1 truncate text-[12px] leading-4 text-muted-foreground",
                working && "lucy-shimmer",
              )}
            >
              {line}
            </span>
            {waiting > 0 ? (
              <span
                aria-hidden
                title={`${waiting} need you`}
                className="size-2 shrink-0 rounded-full bg-warning"
              />
            ) : null}
          </span>
        </span>
      </NavLink>
      {chief ? (
        <div className="absolute right-1 top-1 opacity-0 transition-opacity duration-75 focus-within:opacity-100 group-hover/chief:opacity-100 has-[[data-state=open]]:opacity-100">
          <ChiefMenu
            chief={chief}
            openItems={openItemCount(mine)}
            heir={heir}
            voice={voice}
            onProblem={onProblem}
          />
        </div>
      ) : null}
    </div>
  );
}

/** A Chief's ⋯ menu: everything about it stays editable after it is made. Calls start on its page. */
function ChiefMenu({
  chief,
  openItems,
  heir,
  voice,
  onProblem,
}: {
  chief: ChiefProfile;
  openItems: number;
  heir: string | undefined;
  voice: ChiefVoice | null;
  onProblem: (problem: string | null) => void;
}) {
  const chiefs = useChiefs();
  const [asking, setAsking] = useState(false);
  const to = heir ?? "another Chief";
  const notes =
    openItems === 0
      ? ""
      : ` Its ${openItems === 1 ? "open item moves" : `${openItems} open items move`} to ${to}, which keeps watching their chats.`;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`${chief.name} options`}
          className={cn(iconButton, "size-6 data-[state=open]:bg-sidebar-accent")}
        >
          <Icon icon={MoreHorizontalIcon} className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[230px]">
          <ChiefMenuItems chief={chief} voice={voice} />
          {/* A runtime that gives each project a default Chief refuses to remove that one: no offer to. */}
          {chief.home || chief.project_default ? null : (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setAsking(true)}
                className="h-auto min-h-8 items-start py-1.5"
              >
                <Icon icon={Delete02Icon} className="mt-px" />
                <span className="min-w-0">
                  <span className="block truncate">Remove {chief.name}</span>
                  <span className="block text-[12px] text-muted-foreground">
                    {openItems === 0
                      ? "Its conversation is archived"
                      : `Its open items move to ${to}`}
                  </span>
                </span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Remove ${chief.name}?`}
        description={`Its conversation is archived and can't come back.${notes} The chats it started stay where they are.`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          onProblem(null);
          // Refused (the runtime is unreachable, say): said under Chiefs, where you are, not in a menu that has closed.
          chiefs
            .remove(chief.id)
            .catch((e: unknown) =>
              onProblem(`${chief.name} stays: ${e instanceof Error ? e.message : String(e)}`),
            );
        }}
      />
    </>
  );
}

/**
 * A Chief's own menu items: Settings, Rename, its board, the groups it manages (chief.manage), and a call (it starts
 * on its page).
 */
export function ChiefMenuItems({
  chief,
  voice,
}: {
  chief: ChiefProfile;
  voice: ChiefVoice | null;
}) {
  const navigate = useNavigate();
  const chiefs = useChiefs();
  const to = chiefPath(chief);
  const open = (settings: string) => navigate(`${to}?settings${settings}`);
  return (
    <>
      <DropdownMenuItem onSelect={() => open("")}>
        <Icon icon={PreferenceHorizontalIcon} /> Settings
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => open("=name")}>
        <Icon icon={PencilEdit02Icon} /> Rename
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => navigate(chiefBoardPath(chief))}>
        <Icon icon={KanbanIcon} /> Board
      </DropdownMenuItem>
      {/* The groups it manages (chief.manage, set from a group's ⋯ → Managed by): unticking one gives it up. */}
      {chief.topics?.length ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            value={chief.topics.length === 1 ? chief.topics[0] : `${chief.topics.length} groups`}
          >
            <Icon icon={UserGroupIcon} /> Manages
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-[220px]">
            {chief.topics.map((topic) => (
              <DropdownMenuCheckboxItem
                key={topic}
                checked
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={() =>
                  void chiefs.manage(topic, null).then(
                    () => announce(`${chief.name} no longer manages ${topic}.`),
                    (e: unknown) => announce(e instanceof Error ? e.message : String(e)),
                  )
                }
              >
                <span className="min-w-0 truncate">{topic}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : null}
      {voice === null ? null : voice.state === "no_key" ? (
        <DropdownMenuItem
          onSelect={() => navigate("/settings/chief")}
          className="h-auto min-h-8 items-start py-1.5"
        >
          <Icon icon={Call02Icon} className="mt-px" />
          <span className="min-w-0">
            <span className="block truncate">Call {chief.name}</span>
            <span className="block text-[12px] text-muted-foreground">
              Calls need Caveman credits or a {voice.engine_label} key
            </span>
          </span>
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem onSelect={() => navigate(`${to}?call`)}>
          <Icon icon={Call02Icon} /> <span className="truncate">Call {chief.name}</span>
        </DropdownMenuItem>
      )}
    </>
  );
}
