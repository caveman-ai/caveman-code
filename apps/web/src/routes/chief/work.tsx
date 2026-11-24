// The Chief's Work tab: its board beside its conversation, in the Chief's own side panel, as the approved prototype
// draws it (chief-v7). The panel's bar switches List, Board and Library (WorkBar); under it there is only the work.
// Each piece of work is its number (CH-12), its title and the mark of where it stands, with who runs it and where;
// work with several chats has them nested under it. A chat opens in a tab of its own, a review guide or a change
// set's contract in this panel. Pinned: the Chief's panel always has it. Registered on import (Chief.tsx).
import type { ChiefItem, PrDetail } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { Checkbox } from "@caveman-app/ui/components/checkbox";
import { ConfirmDialog } from "@caveman-app/ui/components/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@caveman-app/ui/components/dropdown-menu";
import { MarkdownDocument } from "@caveman-app/ui/markdown/MarkdownDocument";
import { StateMark } from "@caveman-app/ui/icons/PixelIcon";
import { COMPUTER_KIND_ICON } from "@caveman-app/ui/icons/names";
import { cn } from "@caveman-app/ui/lib/cn";
import {
  Icon,
  ArrowDown01Icon,
  ArrowUpRight01Icon,
  BubbleChatAddIcon,
  Cancel01Icon,
  CheckListIcon,
  CheckmarkCircle02Icon,
  Comment01Icon,
  CrownIcon,
  FileTextIcon,
  Folder01Icon,
  GitMergeIcon,
  GitPullRequestIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PencilEdit02Icon,
  PlayIcon,
  Refresh01Icon,
  Search01Icon,
  Clock01Icon,
  Target02Icon,
  type IconSvgElement,
} from "@caveman-app/ui/icons/huge";
import { Fragment, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { EngineMark } from "../../components/transcript/marks.tsx";
import { useLongPress } from "../../lib/long-press.ts";
import { isComposing, SurfaceEmpty } from "../../panels/chrome.tsx";
import { defineSurface, type SurfaceProps } from "../../panels/registry.ts";
import { openSurface, updateTab } from "../../panels/store.ts";
import { announce, windowTabs } from "../../panes/store.ts";
import { CustomSnoozeDialog } from "../../shell/InboxItems.tsx";
import { ChatMenuItems, keepRenameFocus } from "../../shell/Sidebar.tsx";
import { useChief } from "../../state/chief.ts";
import type { PullRequestView, WorkspaceView } from "../../state/model.ts";
import { requestId, useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import { Notices, settingsPath, useActions } from "../automations/actions.tsx";
import { LIST, message, patch, refresh, useAutomations } from "../automations/data.ts";
import { isDraft, type Automation } from "../automations/model.ts";
import { METHOD_LABEL } from "../review/model.ts";
import { foundWords, routineRows, whenWords } from "./routines-model.ts";
import "../review/surface.tsx";
import { WorkRowShowing } from "./showing.tsx";
import { previewChats, proofImages } from "./showing-model.ts";
import { actionOfKey, blockedByFixedBase, chatToOpen, WORK_ACTIONS, workActions, workProject, type WorkAction } from "./work-actions.ts";
import { baseFixed, lineParts, onlyBaseFailing, prStatus, prTone, reviewHint, untrackedChats, WORK_GROUPS, workDocs, workGroups, workKey, workNote, workPullRequest, type Work, type WorkDoc, type WorkGroup } from "./work-model.ts";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

export type WorkView = "list" | "board" | "library";

declare module "../../panels/store.ts" {
  interface SurfaceParams {
    /** A Chief's work (absent: the home Chief's), as a list, a board or a library. */
    "chief-work": { chief_id?: string | undefined; view?: WorkView | undefined };
    /** One of a Chief's documents: a change set's contract. */
    "chief-doc": { chief_id?: string | undefined; change_set_id: string };
  }
}

const VIEWS: ReadonlyArray<{ readonly id: WorkView; readonly label: string }> = [
  { id: "list", label: "List" },
  { id: "board", label: "Board" },
  { id: "library", label: "Library" },
];

/** List, Board, Library: in the panel's bar, drawn as its tabs are. */
function WorkBar({ workspaceId, tab }: SurfaceProps<"chief-work">) {
  const view = tab.params.view ?? "list";
  return (
    <div role="radiogroup" aria-label="Show the work as" className="flex items-center gap-0.5">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          type="button"
          role="radio"
          aria-checked={view === v.id}
          onClick={() => updateTab(workspaceId, tab.id, { params: { view: v.id } })}
          className={cn(
            "flex h-7 items-center rounded-md px-2.5 text-[13px] outline-none transition-colors duration-75 focus-visible:ring-2 focus-visible:ring-ring",
            view === v.id ? "bg-foreground/[0.08] text-foreground" : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
          )}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ marks

/**
 * Where a piece of work stands, as one mark everywhere it is named (the list, the board, the Chief's sentences):
 * waiting on you in amber, under way turning, blocked a stop, ready to merge a green half-filled ring, for review a
 * half-filled ring, queued a dashed ring, done a green tick.
 */
export function WorkMark({ group, className }: { group: WorkGroup; className?: string }) {
  if (group === "working")
    return (
      <span className={cn("inline-grid place-items-center", className)}>
        <StateMark name="state-working" animate />
      </span>
    );
  if (group === "needs") return <Glyph name="state-needs-you" className={cn("text-warning", className)} />;
  if (group === "done") return <Glyph name="state-done" className={cn("text-success", className)} />;
  if (group === "blocked") return <Glyph name="state-stopped" className={cn("text-muted-foreground", className)} />;
  return (
    <span className={cn("inline-grid place-items-center", className)}>
      <span
        aria-hidden
        className={cn(
          "block size-3 rounded-full border-[1.5px]",
          group === "ready"
            ? "border-success bg-[linear-gradient(90deg,hsl(var(--success))_50%,transparent_50%)]"
            : group === "review"
              ? "border-foreground bg-[linear-gradient(90deg,hsl(var(--foreground))_50%,transparent_50%)]"
              : "border-dashed border-muted-foreground",
        )}
      />
    </span>
  );
}

const CHAT_GROUP: Record<WorkspaceView["state"], WorkGroup> = {
  needs_input: "needs",
  working: "working",
  queued: "queued",
  completed: "done",
  failed: "needs",
  archived: "done",
};

/** A chip at a row's end (the kit's outline, rounded as its controls are): a count, a pull request, a hand raised. */
function Chip({ tone, children, title }: { tone?: "warn" | "pr" | undefined; children: ReactNode; title?: string | undefined }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-[12px] tabular-nums",
        tone === "warn" ? "border-warning/40 text-warning" : tone === "pr" ? "border-success/35 text-success" : "border-input text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/** Who runs a chat and where: its engine's mark and its computer. */
function Who({ chat }: { chat: WorkspaceView }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[12px] text-muted-foreground" title={`${chat.engine.label} on ${chat.computer.label}`}>
      <EngineMark engine={chat.engine.id} className="size-4 shrink-0" />
      <Glyph name={COMPUTER_KIND_ICON[chat.computer.kind] ?? "computer-this-mac"} className="shrink-0" />
      {chat.computer.label}
    </span>
  );
}

/** A pull request at a glance: its number, then where it stands (merged, CI failing, changes requested, CI passing...). */
export function PrChip({ chat, pr: given }: { chat?: WorkspaceView; pr?: PullRequestView | undefined }) {
  const pr = given ?? chat?.pullRequest;
  if (!pr) return null;
  const status = prStatus(pr);
  return (
    <Chip tone={prTone(pr)} title={pr.url}>
      #{pr.number}
      {status ? ` · ${status}` : ""}
    </Chip>
  );
}

// ------------------------------------------------------------------ moves

/**
 * What the Work tab's rows and cards reach: open a chat (in a tab of its own), open a document here, start an item, and
 * the list's actions (work-actions.ts) on one piece of work or several: Mark done and Re-run CI take a selection; and put a chat of yours on this
 * Chief's board.
 */
export interface Moves {
  readonly openChat: (workspaceId: string) => void;
  readonly openDoc: (doc: WorkDoc) => void;
  readonly start: (item: ChiefItem) => void;
  /** The Chief's workspace: its screenshots are read with it (showing.tsx). */
  readonly chiefWorkspaceId: string;
  readonly act: (action: WorkAction, works: ReadonlyArray<Work>) => void;
  /** chief.attach: the chat joins this board as work under way; rejects with the runtime's reason. */
  readonly attach: (chat: WorkspaceView) => Promise<void>;
  /** The person's edit of a mission (chief.items.update), shown at once and put back if the runtime refuses. */
  readonly mission: (work: Work, patch: MissionPatch) => void;
}

/** What the person sets of a mission from its menu: what proves it done (empty clears it) and its check-in pace (null: never). */
export interface MissionPatch {
  readonly done_when?: string;
  readonly check_in?: "day" | "week" | null;
}

/** The item as the patch leaves it: a cleared field is gone, as the runtime sends it. */
const withMission = (item: ChiefItem, patch: MissionPatch): ChiefItem => {
  const { done_when, check_in, ...rest } = item;
  const proof = patch.done_when ?? done_when;
  const pace = patch.check_in === undefined ? check_in : patch.check_in;
  return { ...rest, ...(proof ? { done_when: proof } : {}), ...(pace ? { check_in: pace } : {}) };
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** "CH-26", "CH-26 and CH-24", "3 items": what a line about them names. */
const named = (works: ReadonlyArray<Work>) => (works.length === 1 ? (works[0]!.id ?? works[0]!.title) : works.length === 2 ? `${works[0]!.id ?? "one"} and ${works[1]!.id ?? "another"}` : `${works.length} items`);

function useMoves(workspaceId: string, chiefId: string | undefined, merge: (work: Work) => void): Moves {
  const navigate = useNavigate();
  const { client, items, setItems, profile } = useChief(chiefId);
  const openChat = (id: string) => navigate(windowTabs.openChat(id));
  /** Done or dropped, shown at once; put back as it was if the runtime refuses. */
  const finish = (works: ReadonlyArray<Work>, state: "done" | "dropped") => {
    if (!client || works.length === 0) return;
    const ids = new Set(works.map((w) => w.item.id));
    const before = items;
    setItems(items.map((i) => (ids.has(i.id) ? { ...i, state } : i)));
    void Promise.all(works.map((w) => client.call("chief.items.update", { request_id: requestId(), item_id: w.item.id, state }))).then(
      () => announce(`${state === "done" ? "Marked done" : "Dropped"}: ${named(works)}`),
      (e: unknown) => {
        setItems(before);
        announce(`Did not ${state === "done" ? "mark it done" : "drop it"}: ${errorText(e)}`);
      },
    );
  };
  const rerun = (works: ReadonlyArray<Work>) => {
    const targets = works.flatMap((w) => (w.pr && workProject(w) ? [{ work: w, pr: w.pr, project: workProject(w)! }] : []));
    if (!client || targets.length === 0) return;
    void Promise.allSettled(
      targets.map((t) => client.call("pr.rerun", { request_id: requestId(), project_id: t.project, number: t.pr.number, ...(baseFixed(t.pr) ? { update_branch: true } : {}) })),
    ).then((results) => {
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const why = results.flatMap((r) => (r.status === "rejected" ? [errorText(r.reason)] : []));
      announce(
        ok > 0
          ? `Re-running CI on ${ok === 1 ? `#${targets[results.findIndex((r) => r.status === "fulfilled")]!.pr.number}` : `${ok} pull requests`}${why.length > 0 ? `; ${why.length} could not: ${why[0]}` : ""}`
          : `Did not re-run CI: ${why[0] ?? "nothing to re-run"}`,
      );
    });
  };
  return {
    openChat,
    openDoc: (doc) =>
      doc.kind === "guide"
        ? openSurface(workspaceId, "pr", { project_id: doc.projectId, number: doc.number })
        : openSurface(workspaceId, "chief-doc", { chief_id: chiefId, change_set_id: doc.changeSetId }),
    start: (item) => void client?.call("chief.start", { request_id: requestId(), item_ids: [item.id] }).catch(() => undefined),
    chiefWorkspaceId: workspaceId,
    act: (action, works) => {
      const one = works[0];
      if (!one) return;
      if (action === "done" || action === "drop") return finish(works, action === "done" ? "done" : "dropped");
      if (action === "rerun") return rerun(works);
      if (action === "merge") return merge(one);
      if (action === "openChat") {
        const chat = chatToOpen(one.chats);
        if (chat) openChat(chat.id);
        return;
      }
      // Open pull request: in the app's own review, in this panel; a pull request no project here holds, on its host.
      const project = workProject(one);
      if (one.pr && project) openSurface(workspaceId, "pr", { project_id: project, number: one.pr.number });
      else if (one.pr) window.open(one.pr.url, "_blank", "noopener");
    },
    attach: async (chat) => {
      if (!client) throw new Error("Not connected to a runtime");
      await client.call("chief.attach", { request_id: requestId(), workspace_id: chat.id, ...(profile ? { chief_id: profile.id } : {}) });
      announce(`Added ${chat.title} to ${profile?.name ?? "the Chief"}'s board.`);
    },
    mission: (work, patch) => {
      if (!client) return;
      const before = items;
      setItems(items.map((i) => (i.id === work.item.id ? withMission(i, patch) : i)));
      void client.call("chief.items.update", { request_id: requestId(), item_id: work.item.id, ...patch }).catch((e: unknown) => {
        setItems(before);
        announce(`Did not change ${named([work])}: ${errorText(e)}`);
      });
    },
  };
}

/**
 * Merge, only ever by the person's click and their yes here: it reads the pull request first (who may merge it, its
 * target branch, conflicts), then asks with its number and the branch it lands on. A protected branch whose rules aren't
 * met is said in the question; the host still has the last word. Merged, its item is done at once.
 */
export function MergeConfirm({ work, chiefId, onClose }: { work: Work; chiefId: string | undefined; onClose: () => void }) {
  const { client } = useChief(chiefId);
  const [detail, setDetail] = useState<PrDetail | null>(null);
  const pr = work.pr;
  const project = workProject(work);
  useEffect(() => {
    if (!client || !pr || !project) return onClose();
    let live = true;
    client.call("pr.get", { project_id: project, number: pr.number }).then(
      (d) => {
        if (!live) return;
        const refusal = !d.can.merge
          ? `You can't merge #${d.number}: it takes write access on ${d.repo}.`
          : d.state !== "open"
            ? `#${d.number} is ${d.state}: there is nothing to merge.`
            : d.mergeable === "conflicting"
              ? `#${d.number} conflicts with ${d.base_branch}: resolve that first.`
              : null;
        if (refusal) {
          announce(refusal);
          onClose();
        } else setDetail(d);
      },
      (e: unknown) => {
        if (!live) return;
        announce(`Could not read #${pr.number}: ${errorText(e)}`);
        onClose();
      },
    );
    return () => {
      live = false;
    };
    // One read per pull request asked about.
  }, [client, project, pr?.number]);
  if (!detail || !client || !project) return null;
  const method = detail.can.merge_methods[0] ?? "squash";
  const failing = detail.checks_list.some((c) => c.status === "failed");
  const notes = [
    `${detail.head_branch} into ${detail.base_branch} on ${detail.repo}.`,
    failing ? (onlyBaseFailing(pr) ? `Its checks fail only where ${detail.base_branch}'s do.` : "Some of its checks fail.") : "",
    detail.mergeable === "blocked" ? `The protected branch ${detail.base_branch} has rules not yet met, so GitHub may refuse.` : "",
  ];
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={`${METHOD_LABEL[method]} #${detail.number} into ${detail.base_branch}?`}
      description={notes.filter(Boolean).join(" ")}
      confirmLabel={METHOD_LABEL[method]}
      destructive={failing && !onlyBaseFailing(pr)}
      onConfirm={() => {
        onClose();
        void client.call("pr.merge", { request_id: requestId(), project_id: project, number: detail.number, method }).then(
          () => {
            announce(`Merged #${detail.number} into ${detail.base_branch}`);
            // The runtime closes it too once it sees the merge; the person shouldn't wait the minute for that.
            void client.call("chief.items.update", { request_id: requestId(), item_id: work.item.id, state: "done" }).catch(() => undefined);
          },
          (e: unknown) => announce(`Did not merge #${detail.number}: ${errorText(e)}`),
        );
      }}
    />
  );
}

function WorkSurface({ workspaceId, tab }: SurfaceProps<"chief-work">) {
  return <WorkContent workspaceId={workspaceId} chiefId={tab.params.chief_id} view={tab.params.view ?? "list"} />;
}

/** Shared live work for the Chief's panel and its standalone board page. */
export function WorkContent({ workspaceId, chiefId, view }: { workspaceId: string; chiefId: string | undefined; view: WorkView }) {
  const chief = useChief(chiefId);
  const workspaces = useRuntimeSelector((v) => v.workspaces);
  const local = useRuntimeSelector((v) => v.raw);
  const projects = useRuntimeSelector((v) => v.projects);
  const [merging, setMerging] = useState<Work | null>(null);
  const moves = useMoves(workspaceId, chiefId, setMerging);
  const key = workKey(chief.profile);
  const groups = workGroups(chief.items, workspaces, chief.changeSets, key);
  const projectName = (id: string | null) => projects.find((p) => p.id === id)?.name ?? null;
  const name = chief.profile?.name ?? "the Chief";
  // Every board's items, not only this Chief's: a chat is on one board at most.
  const loose = chief.status === "ready" ? untrackedChats(workspaces, local, chief.allItems, chief.profile?.project_ids ?? []) : [];
  // Folded until asked for, and kept open here: the first chat added turns the empty board into the list.
  const [untrackedOpen, setUntrackedOpen] = useState(false);
  const untracked = loose.length > 0 ? <Untracked chats={loose} name={name} moves={moves} projectName={projectName} open={untrackedOpen} onToggle={() => setUntrackedOpen((o) => !o)} /> : null;
  const routines = view === "library" || chief.status !== "ready" ? null : <Routines chief={chief.profile} routines={chief.routines} />;
  if (groups.length === 0)
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-auto [scrollbar-gutter:stable]">
        <div className="flex-none">{routines}</div>
        <SurfaceEmpty icon={CrownIcon} title="Nothing on the board" {...(untracked ? { className: "flex-none" } : {})}>
          Tell {name} what needs doing. Each piece of work shows here, with the chats doing it.
        </SurfaceEmpty>
        {untracked}
      </div>
    );
  return (
    <div className="min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable]">
      {/* On the Board it stays in view while the columns scroll sideways. */}
      {view === "board" ? <div className="sticky left-0 w-full max-w-[560px]">{routines}</div> : routines}
      {view === "list" ? <WorkList groups={groups} moves={moves}>{untracked}</WorkList> : view === "board" ? <WorkBoard groups={groups} moves={moves} /> : <Library groups={groups} moves={moves} projectName={projectName} />}
      {merging ? <MergeConfirm key={merging.item.id} work={merging} chiefId={chiefId} onClose={() => setMerging(null)} /> : null}
    </div>
  );
}

// ------------------------------------------------------------------ list

const ACTION_ICON: Record<WorkAction, IconSvgElement> = {
  merge: GitMergeIcon,
  rerun: Refresh01Icon,
  openPr: GitPullRequestIcon,
  openChat: ArrowUpRight01Icon,
  done: CheckmarkCircle02Icon,
  drop: Cancel01Icon,
};
const ACTION = new Map(WORK_ACTIONS.map((a) => [a.id, a]));
/** What the selection bar offers several pieces of work at once. */
const BULK: ReadonlyArray<WorkAction> = ["done", "rerun"];
/** Whether this render is in a page (not a server render): the List's menu anchors on the page itself. */
const noSubscribe = () => () => undefined;
const onClient = () => true;
const onServer = () => false;

/**
 * The list: a section per group (WORK_GROUPS), Done folded. Each row's hover buttons and right-click menu offer what
 * can be done to it (work-actions.ts); with a row focused, its keys do the same (M, R, P, O, D, ⌫; X selects, ↑↓ move,
 * Esc clears); `children` (Untracked) go under the bands. A selection (X, the box, ⌘- or Shift-click) takes Mark done and Re-run CI to all of it at once.
 */
export function WorkList({ groups, moves, children }: { groups: ReturnType<typeof workGroups>; moves: Moves; children?: ReactNode }) {
  const [closed, setClosed] = useState<ReadonlySet<WorkGroup>>(() => new Set(["done"]));
  const toggle = (id: WorkGroup) => setClosed((s) => (s.has(id) ? new Set([...s].filter((g) => g !== id)) : new Set([...s, id])));
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; work: Work } | null>(null);
  const [snoozing, setSnoozing] = useState<WorkspaceView | null>(null);
  // The item whose done-when line is a field (its menu's Set done when…); the menu leaves focus there as it closes.
  const [editing, setEditing] = useState<string | null>(null);
  const toField = useRef(false);
  const mounted = useSyncExternalStore(noSubscribe, onClient, onServer);
  const list = useRef<HTMLDivElement>(null);
  const all = groups.flatMap((g) => g.work);
  const byId = new Map(all.map((w) => [w.item.id, w]));
  // Only what is still on the list stays selected.
  const chosen = [...selected].flatMap((id) => byId.get(id) ?? []);
  const select = (id: string) => setSelected((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  /** An action from a row: on the selection when the row is part of it (bulk actions only), else on the row. */
  const run = (action: WorkAction, work: Work) => {
    const targets = BULK.includes(action) && selected.has(work.item.id) ? chosen.filter((w) => workActions(w).includes(action)) : [work];
    moves.act(action, targets);
    if (targets.length > 1) setSelected(new Set());
  };
  const stale = blockedByFixedBase(all);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = e.target instanceof HTMLElement ? e.target : null;
    const work = row?.dataset.workRow ? byId.get(row.dataset.workRow) : undefined;
    if (!row || !work) return;
    const rows = [...(list.current?.querySelectorAll<HTMLElement>("[data-work-row]") ?? [])];
    const at = rows.indexOf(row);
    const step = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
    if (step !== 0 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      rows[Math.min(rows.length - 1, Math.max(0, at + step))]?.focus();
      return;
    }
    if (e.key === "x" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      select(work.item.id);
      return;
    }
    if (e.key === "Escape" && selected.size > 0) {
      e.preventDefault();
      setSelected(new Set());
      return;
    }
    const action = actionOfKey(e.key, { meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey });
    if (!action || !workActions(work).includes(action)) return;
    e.preventDefault();
    run(action, work);
  };
  return (
    <div ref={list} className="pb-6 pt-1" onKeyDown={onKeyDown}>
      {chosen.length > 0 ? (
        <div role="toolbar" aria-label="Selected work" className="sticky top-0 z-10 mx-3 mt-2 flex h-10 items-center gap-1.5 rounded-[9px] border border-border bg-card px-2.5 text-[13px] shadow-sm">
          <span className="mr-auto tabular-nums text-foreground">{chosen.length} selected</span>
          {BULK.map((id) => {
            const can = chosen.filter((w) => workActions(w).includes(id));
            const a = ACTION.get(id)!;
            return (
              <Button key={id} size="sm" variant="ghost" disabled={can.length === 0} onClick={() => (moves.act(id, can), setSelected(new Set()))} title={`${a.label} (${a.keyLabel})`}>
                <Icon icon={ACTION_ICON[id]} className="size-3.5" />
                {a.label}
                {can.length > 0 && can.length < chosen.length ? <span className="tabular-nums text-muted-foreground">{can.length}</span> : null}
              </Button>
            );
          })}
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} title="Clear the selection (Esc)">
            Clear
          </Button>
        </div>
      ) : null}
      {stale.length > 0 ? (
        <div className="mx-3 mt-2 flex items-center gap-2.5 rounded-[9px] border border-border px-3 py-2 text-[13px] text-muted-foreground">
          <Icon icon={Refresh01Icon} className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            CI on {stale[0]!.pr!.base_ci!.base} is green again. {stale.length === 1 ? "One pull request" : `${stale.length} pull requests`} failed only on its old failures.
          </span>
          <Button size="sm" variant="secondary" onClick={() => moves.act("rerun", stale)} title="Bring the fix into each and run its CI again">
            Re-run {stale.length === 1 ? "it" : `all ${stale.length}`}
          </Button>
        </div>
      ) : null}
      {WORK_GROUPS.map(({ id, label }) => {
        const work = groups.find((x) => x.group === id)?.work ?? [];
        if (work.length === 0) return null;
        const shut = closed.has(id);
        return (
          <section key={id} className="mx-3 mb-0.5 mt-2">
            <button
              type="button"
              aria-expanded={!shut}
              onClick={() => toggle(id)}
              className="flex h-[38px] w-full items-center gap-2.5 rounded-[9px] bg-foreground/[0.035] px-2.5 text-left text-[13.5px] font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon icon={ArrowDown01Icon} className={cn("size-3 shrink-0 text-[hsl(var(--subtle-foreground))] transition-transform duration-150 ease-snap", shut && "-rotate-90")} />
              <WorkMark group={id} className="w-4 shrink-0" />
              {label}
              <span className="font-normal tabular-nums text-[hsl(var(--subtle-foreground))]">{work.length}</span>
            </button>
            {shut ? null : (
              <div className="mt-0.5">
                {work.map((w) => (
                  <WorkRow
                    key={w.item.id}
                    work={w}
                    moves={moves}
                    run={run}
                    selected={selected.has(w.item.id)}
                    selecting={selected.size > 0}
                    onSelect={() => select(w.item.id)}
                    onMenu={(x, y) => setMenu({ x, y, work: w })}
                    editing={editing === w.item.id}
                    onEdited={(text, byKey) => {
                      setEditing(null);
                      if (text !== null) moves.mission(w, { done_when: text });
                      // Ended by a key: back on its row, for the list's keys.
                      if (byKey) requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-work-row="${CSS.escape(w.item.id)}"]`)?.focus());
                    }}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
      {children}
      <DropdownMenu open={menu !== null} onOpenChange={(o) => !o && setMenu(null)} modal={false}>
        {/* At the pointer, from the page's own layer: placed inside the panel's scroller, the menu opened past the
            window's edge. Mounted on the client only (a server render has no page). */}
        {mounted
          ? createPortal(
              <DropdownMenuTrigger asChild>
                <span aria-hidden className="pointer-events-none fixed size-0" style={menu ? { left: menu.x, top: menu.y } : { left: -9999, top: -9999 }} />
              </DropdownMenuTrigger>,
              document.body,
            )
          : null}
        <DropdownMenuContent align="start" sideOffset={2} className="w-[230px]" onCloseAutoFocus={(e) => keepRenameFocus(e, toField)}>
          {menu ? (
            <WorkMenuItems
              work={menu.work}
              label={(id, a) => (BULK.includes(id) && selected.has(menu.work.item.id) && chosen.length > 1 ? `${a} (${chosen.length})` : a)}
              run={(id) => run(id, menu.work)}
              onDoneWhen={() => {
                toField.current = true;
                setEditing(menu.work.item.id);
              }}
              mission={(patch) => moves.mission(menu.work, patch)}
              onSnooze={setSnoozing}
            />
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {snoozing ? <CustomSnoozeDialog workspace={snoozing} open onOpenChange={(o) => !o && setSnoozing(null)} /> : null}
    </div>
  );
}

const CHECK_IN = { day: "Daily", week: "Weekly", never: "Never" } as const;

/**
 * A piece of work's menu, the List row's (a right-click) and the Board card's (its ⋯ or a right-click) alike: what can
 * be done to it (work-actions.ts), then its mission's own lines, Set done when… and Check in, then its one chat's own
 * menu. `label` names an action as the List does (how many of a selection it takes).
 */
function WorkMenuItems({
  work,
  label = (_id, a) => a,
  run,
  onDoneWhen,
  mission,
  onSnooze,
}: {
  work: Work;
  label?: (id: WorkAction, label: string) => string;
  run: (action: WorkAction) => void;
  /** Set done when…: the card's or row's line becomes a field in place. */
  onDoneWhen: () => void;
  mission: (patch: MissionPatch) => void;
  onSnooze: (chat: WorkspaceView) => void;
}) {
  const { client } = useRuntimeClient();
  const actions = workActions(work);
  const chat = work.chats.length === 1 ? work.chats[0]! : null;
  // Done and dropped work has nothing left to prove and is never looked in on.
  const open = work.item.state !== "done" && work.item.state !== "dropped";
  const pace = work.item.check_in ?? "never";
  return (
    <>
      {actions.map((id, i) => {
        const a = ACTION.get(id)!;
        // Finishing it sits apart from moving its pull request on.
        const apart = id === "done" && i > 0 && actions[i - 1] !== "done";
        return (
          <Fragment key={id}>
            {apart ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem onSelect={() => run(id)}>
              <Icon icon={ACTION_ICON[id]} /> {label(id, a.label)}
              <DropdownMenuShortcut>{a.keyLabel}</DropdownMenuShortcut>
            </DropdownMenuItem>
          </Fragment>
        );
      })}
      {open ? (
        <>
          {actions.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onSelect={onDoneWhen}>
            <Icon icon={Target02Icon} /> Set done when…
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger value={CHECK_IN[pace]}>
              <Icon icon={Clock01Icon} /> Check in
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-[160px]">
              <DropdownMenuRadioGroup
                value={pace}
                onValueChange={(v) => {
                  const next = v === "day" || v === "week" ? v : null;
                  if (next !== (work.item.check_in ?? null)) mission({ check_in: next });
                }}
              >
                {(["day", "week", "never"] as const).map((p) => (
                  <DropdownMenuRadioItem key={p} value={p}>
                    {CHECK_IN[p]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </>
      ) : null}
      {chat ? (
        <>
          {actions.length > 0 || open ? <DropdownMenuSeparator /> : null}
          {/* The chat's own menu, the one the chat list and the queue show (Sidebar ChatMenuItems). */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Icon icon={Comment01Icon} /> Chat
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-[210px]">
              <ChatMenuItems
                workspace={chat}
                onRename={null}
                onCustomSnooze={() => onSnooze(chat)}
                onArchive={
                  chat.state === "working" || !client
                    ? null
                    : () =>
                        void client.call("workspace.archive", { request_id: requestId(), workspace_id: chat.id }).then(
                          () => announce(`Archived ${chat.title}`),
                          (e: unknown) => announce(errorText(e)),
                        )
                }
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </>
      ) : null}
    </>
  );
}

/** What proves a mission done, as one muted line under its title, clipped; the whole of it in its tooltip. */
function DoneWhen({ text, className }: { text: string; className?: string }) {
  return (
    <span data-done-when="" title={`Done when ${text}`} className={cn("block truncate text-[12px] leading-4 text-muted-foreground", className)}>
      Done when {text}
    </span>
  );
}

/**
 * Set done when…: the line as a field in place, as Rename puts one in a row. Enter or leaving it saves (empty clears
 * it); Escape keeps what it was. `onDone` gets the new text only when it changed, and `byKey` when Enter or Escape
 * ended it, so focus goes back where the person was.
 */
function DoneWhenField({ value, onDone, className }: { value: string; onDone: (text: string | null, byKey: boolean) => void; className?: string }) {
  const settled = useRef(false);
  const settle = (text: string | null, byKey = false) => {
    if (settled.current) return;
    settled.current = true;
    onDone(text === null || text === value ? null : text, byKey);
  };
  // What is typed so far, and the latest settle: a board update that moves the item to another group unmounts the
  // field mid-edit (no blur comes), and what was typed still saves. Unchanged, nothing does.
  const typed = useRef(value);
  const latest = useRef(settle);
  latest.current = settle;
  useEffect(
    () => () => {
      const text = typed.current.trim();
      if (text !== value.trim()) latest.current(text);
    },
    // The value it opened with: only an unmount reads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  return (
    <input
      autoFocus
      defaultValue={value}
      onChange={(e) => {
        typed.current = e.currentTarget.value;
      }}
      aria-label="Done when"
      placeholder="What proves it done"
      maxLength={280}
      onFocus={(e) => e.currentTarget.select()}
      // The row or card under it opens its chat on a click and acts on its keys: these are the field's own.
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        // An input method's Enter picks its candidate and its Escape cancels the composition: neither ends the edit.
        if (isComposing(e)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          settle(e.currentTarget.value.trim(), true);
        }
        if (e.key === "Escape") {
          e.preventDefault();
          settle(null, true);
        }
      }}
      onBlur={(e) => settle(e.currentTarget.value.trim())}
      className={cn("h-6 w-full min-w-0 rounded-md border border-ring/60 bg-background px-1.5 text-[12px] text-foreground outline-none", className)}
    />
  );
}

/** One of the list's bands: its title folds it (its mark, its label, its count), its rows under it while open. */
function Band({ mark, label, count, open, onToggle, children }: { mark: ReactNode; label: string; count: number; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className="mx-3 mb-0.5 mt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex h-[38px] w-full items-center gap-2.5 rounded-[9px] bg-foreground/[0.035] px-2.5 text-left text-[13.5px] font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon icon={ArrowDown01Icon} className={cn("size-3 shrink-0 text-[hsl(var(--subtle-foreground))] transition-transform duration-150 ease-snap", !open && "-rotate-90")} />
        <span className="grid w-4 shrink-0 place-items-center">{mark}</span>
        {label}
        <span className="font-normal tabular-nums text-[hsl(var(--subtle-foreground))]">{count}</span>
      </button>
      {open ? <div className="mt-0.5">{children}</div> : null}
    </section>
  );
}

/**
 * Untracked, folded under the work: your own chats under way in this Chief's projects that no Chief's board follows
 * (work-model.ts `untrackedChats`). Add puts one on this board in one click (chief.attach): the Chief hears its updates
 * from then and can steer and answer it, and it moves up into the work as the board says so. The row opens the chat.
 */
function Untracked({
  chats,
  name,
  moves,
  projectName,
  open,
  onToggle,
}: {
  chats: ReadonlyArray<WorkspaceView>;
  name: string;
  moves: Moves;
  projectName: (id: string | null) => string | null;
  open: boolean;
  onToggle: () => void;
}) {
  // Added and not yet off the list (the board's update is on its way); a refusal puts its Add back.
  const [adding, setAdding] = useState<ReadonlySet<string>>(() => new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const add = (chat: WorkspaceView) => {
    setProblem(null);
    setAdding((s) => new Set([...s, chat.id]));
    moves.attach(chat).catch((e: unknown) => {
      setAdding((s) => new Set([...s].filter((id) => id !== chat.id)));
      const why = `${chat.title} was not added: ${e instanceof Error ? e.message : String(e)}`;
      setProblem(why);
      announce(why);
    });
  };
  return (
    <Band mark={<Icon icon={BubbleChatAddIcon} className="size-3.5 text-muted-foreground" />} label="Untracked" count={chats.length} open={open} onToggle={onToggle}>
      {problem ? <p className="px-2.5 pb-1 pt-1.5 text-[12px] leading-4 text-destructive">{problem}</p> : null}
      {chats.map((chat) => {
        const busy = adding.has(chat.id);
        const project = projectName(chat.projectId);
        return (
          <Row
            key={chat.id}
            mark={<WorkMark group={CHAT_GROUP[chat.state]} />}
            id={null}
            title={chat.title}
            hint={chat.detail ?? undefined}
            opens
            onOpen={() => moves.openChat(chat.id)}
            tail={
              <>
                {project ? <span className="max-w-[140px] truncate text-[12px] text-[hsl(var(--subtle-foreground))]">{project}</span> : null}
                <span title={chat.engine.label} className="inline-flex">
                  <EngineMark engine={chat.engine.id} className="size-4 shrink-0" />
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  aria-label={`Add ${chat.title} to ${name}'s board`}
                  title={`Add to ${name}'s board: ${name} hears its updates and can steer and answer it`}
                  // The row opens the chat on a click, Enter or Space: this button's own stay its own.
                  onClick={(e) => {
                    e.stopPropagation();
                    add(chat);
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  {busy ? "Adding" : "Add"}
                </Button>
              </>
            }
          />
        );
      })}
    </Band>
  );
}

/** One piece of work, and under it the chats doing it when there is more than one. */
function WorkRow({
  work,
  moves,
  run,
  selected,
  selecting,
  onSelect,
  onMenu,
  editing,
  onEdited,
}: {
  work: Work;
  moves: Moves;
  run: (action: WorkAction, work: Work) => void;
  selected: boolean;
  selecting: boolean;
  onSelect: () => void;
  onMenu: (x: number, y: number) => void;
  /** Its done-when line is a field (its menu's Set done when…). */
  editing: boolean;
  onEdited: (text: string | null, byKey: boolean) => void;
}) {
  const only = work.chats.length === 1 ? work.chats[0]! : null;
  const several = work.chats.length > 1;
  const pr = work.pr;
  // What it waits on, as its card sums it up (workNote): the tooltip, never the raw report.
  const note = workNote(work, pr);
  const asked = note ? [note.label, note.summary].filter(Boolean).join(": ") : work.reason;
  const canStart = work.chats.length === 0 && (work.item.state === "queued" || work.item.state === "proposed");
  const actions = workActions(work);
  const hold = useLongPress(onMenu);
  const proof = work.item.done_when;
  return (
    <>
      <Row
        workId={work.item.id}
        label={`${work.id ? `${work.id} ` : ""}${work.title}, ${WORK_GROUPS.find((g) => g.id === work.group)?.label ?? ""}${work.reason ? `: ${work.reason}` : ""}${proof ? `. Done when ${proof}` : ""}`}
        mark={<WorkMark group={work.group} />}
        id={work.id}
        title={work.title}
        hint={asked ?? work.waiting ?? undefined}
        waiting={work.waiting ?? undefined}
        under={editing ? <DoneWhenField value={proof ?? ""} onDone={onEdited} className="mt-0.5" /> : proof ? <DoneWhen text={proof} /> : null}
        wide={editing}
        select={{ checked: selected, visible: selecting, onChange: onSelect }}
        onOpen={(e) => {
          // ⌘-, Ctrl- or Shift-click picks it, to act on several at once.
          if (e && (e.metaKey || e.ctrlKey || e.shiftKey)) return onSelect();
          if (only) moves.openChat(only.id);
        }}
        // While its line is a field, the row is not a button around it.
        opens={only !== null && !editing}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(e.clientX, e.clientY);
        }}
        hold={hold}
        actions={actions.map((id) => {
          const a = ACTION.get(id)!;
          return (
            <Button
              key={id}
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={a.label.replace("…", "")}
              title={`${a.label} (${a.keyLabel})`}
              onClick={(e) => {
                e.stopPropagation();
                run(id, work);
              }}
              className="size-6 text-muted-foreground hover:text-foreground"
            >
              <Icon icon={ACTION_ICON[id]} className="size-3.5" />
            </Button>
          );
        })}
        tail={
          <>
          {/* The chip slot: its screenshots small, and Open preview (showing.tsx). */}
          <WorkRowShowing images={proofImages(work.item)} previews={previewChats(work.item, work.chats)} chiefWorkspaceId={moves.chiefWorkspaceId} />
          {several ? (
            <Chip tone={work.group === "needs" ? "warn" : undefined}>
              {work.done} of {work.chats.length}
              {work.group === "needs" ? " · needs you" : ""}
            </Chip>
          ) : only ? (
            <>
              <PrChip pr={pr} />
              <span className="contents group-hover:hidden group-focus-within:hidden">
                <Who chat={only} />
              </span>
            </>
          ) : canStart ? (
            <button
              type="button"
              onClick={(e) => (e.stopPropagation(), moves.start(work.item))}
              className="h-6 rounded-md px-2 text-[12px] text-muted-foreground opacity-0 outline-none transition-opacity duration-75 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 touch:opacity-100"
            >
              Start
            </button>
          ) : work.reason && work.group === "blocked" ? (
            <Chip>{work.reason}</Chip>
          ) : null}
          </>
        }
      />
      {several
        ? work.chats.map((chat, i) => (
            <Row
              key={chat.id}
              kid={i < work.chats.length - 1 ? "mid" : "last"}
              mark={<WorkMark group={CHAT_GROUP[chat.state]} />}
              id={null}
              title={chat.title}
              onOpen={() => moves.openChat(chat.id)}
              opens
              tail={
                <>
                  <PrChip chat={chat} />
                  <Who chat={chat} />
                </>
              }
            />
          ))
        : null}
    </>
  );
}

/**
 * A row as the prototype's: its mark, its number, its title, then what runs it at the end. A nested chat (`kid`) hangs
 * off its work on a thin elbow; `mid` continues the line to the next one. A piece of work's row (`workId`) is focusable
 * for the list's keys, has a box to select it (shown on hover, or while anything is selected) and shows its `actions`
 * on hover or focus, in place of who runs it.
 */
function Row({
  workId,
  label,
  mark,
  id,
  title,
  hint,
  waiting,
  under,
  wide = false,
  onOpen,
  opens,
  tail,
  kid,
  select,
  actions,
  onContextMenu,
  hold,
}: {
  workId?: string;
  label?: string;
  mark: ReactNode;
  id: string | null;
  title: string;
  hint?: string | undefined;
  waiting?: string | undefined;
  /** A line of its own under the title and what it waits on: a mission's done-when, or the field that sets it. */
  under?: ReactNode;
  /** The title's column takes the row's room, for a field under it. */
  wide?: boolean;
  onOpen: (e?: MouseEvent) => void;
  opens: boolean;
  tail: ReactNode;
  kid?: "mid" | "last";
  select?: { checked: boolean; visible: boolean; onChange: () => void };
  actions?: ReactNode;
  onContextMenu?: (e: MouseEvent) => void;
  hold?: ReturnType<typeof useLongPress>;
}) {
  // A row with its own actions (a routine's) is reachable by keyboard too: they show while it has focus.
  const grouped = workId !== undefined || actions !== undefined;
  const focusable = opens || grouped;
  return (
    <div
      role={opens ? "button" : grouped ? "group" : undefined}
      aria-label={label}
      aria-selected={select ? select.checked : undefined}
      data-work-row={workId}
      tabIndex={focusable ? 0 : undefined}
      title={hint}
      onClick={(e) => onOpen(e)}
      onContextMenu={onContextMenu}
      {...hold}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && opens && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "group relative flex min-h-9 items-center gap-2.5 rounded-[7px] px-2.5 py-1 outline-none transition-colors duration-75 hover:bg-accent/70 focus-visible:bg-accent/70",
        opens && "cursor-pointer",
        select?.checked && "bg-accent/50",
        kid && "ml-[22px] before:absolute before:-left-2.5 before:-top-1.5 before:h-6 before:w-[9px] before:rounded-bl-md before:border-b before:border-l before:border-input before:content-['']",
        kid === "mid" && "after:absolute after:-bottom-1.5 after:-left-2.5 after:top-[18px] after:border-l after:border-input after:content-['']",
      )}
    >
      {select ? (
        <Checkbox
          aria-label={`Select ${id ?? title}`}
          checked={select.checked}
          onCheckedChange={select.onChange}
          onClick={(e) => e.stopPropagation()}
          tabIndex={-1}
          className={cn("-ml-1 size-3.5 transition-opacity duration-75", select.checked || select.visible ? "opacity-100" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100")}
        />
      ) : null}
      <span className="grid w-4 shrink-0 place-items-center">{mark}</span>
      {id ? <span className="w-11 shrink-0 text-[12.5px] tabular-nums text-[hsl(var(--subtle-foreground))]">{id}</span> : null}
      <span className={cn("min-w-0 text-[13.5px] text-foreground", wide && "flex-1")}>
        <span className="block truncate">{title}</span>
        {waiting ? <span className="block truncate text-[12px] leading-4 text-muted-foreground" title={waiting}>{waiting}</span> : null}
        {under}
      </span>
      <span className={cn("min-w-1.5 flex-1", wide && "hidden")} />
      {actions ? <span className="hidden shrink-0 items-center gap-0.5 group-focus-within:flex group-hover:flex">{actions}</span> : null}
      <span className="flex shrink-0 items-center gap-2">{tail}</span>
    </div>
  );
}

// ------------------------------------------------------------------ routines

/**
 * Routines, at the top of the List and the Board: the project's automations that report to its Chief (an output
 * `chief:`), each with its schedule, its last day, and what its last run found. Pause, Run now and Edit act as the
 * Automations page's do: Run now opens its input form there when it asks for one, Edit its file. A Me routine a chat
 * wrote in its worktree is listed too; its Turn on adds it to the project. Open until folded; nothing with no routine.
 */
/** On, but its schedule waits for the person to turn it on again: its file changed what it may do, or was never allowed. */
const asksYes = (a: Automation) => a.enabled && /^Turn it on again/.test(a.triggers_off_reason ?? "");

function Routines({ chief, routines }: { chief: ReturnType<typeof useChief>["profile"]; routines: ReturnType<typeof useChief>["routines"] }) {
  const list = useAutomations();
  const client = useRuntimeSelector((v) => v.client);
  const navigate = useNavigate();
  const { startRun, install } = useActions();
  const [open, setOpen] = useState(true);
  const rows = routineRows(list.value ?? [], routines, chief);
  if (rows.length === 0) return null;
  const now = Date.now();
  const setEnabled = async (a: Automation, enabled: boolean) => {
    if (!client) return announce("Not connected to a runtime.");
    const flip = (on: boolean) => patch<ReadonlyArray<Automation>>(LIST, (all) => all.map((x) => (x.id === a.id ? { ...x, enabled: on } : x)));
    flip(enabled);
    try {
      await client.call("automation.set_enabled", { request_id: requestId(), id: a.id, enabled });
      refresh(client, LIST);
    } catch (e) {
      flip(!enabled);
      announce(`Couldn't ${enabled ? "resume" : "pause"} ${a.title}: ${message(e)}`);
    }
  };
  const runNow = async (a: Automation) => {
    if (!client) return announce("Not connected to a runtime.");
    try {
      await client.call("automation.run", { request_id: requestId(), id: a.id });
      refresh(client, LIST);
      announce(`Running ${a.title}`);
    } catch (e) {
      announce(`Couldn't run ${a.title}: ${message(e)}`);
    }
  };
  const action = (label: string, icon: IconSvgElement, run: () => void) => (
    <Button
      key={label}
      type="button"
      size="icon-sm"
      variant="ghost"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        run();
      }}
      className="size-6 text-muted-foreground hover:text-foreground"
    >
      <Icon icon={icon} className="size-3.5" />
    </Button>
  );
  return (
    <Band mark={<Icon icon={Clock01Icon} className="size-3.5 text-muted-foreground" />} label="Routines" count={rows.length} open={open} onToggle={() => setOpen((o) => !o)}>
      {/* What Turn on on a draft did, as the Automations pages say it. */}
      <Notices />
      {rows.map((row) => {
        const a = row.automation;
        const found = foundWords(row, now);
        const running = (a.runs_running ?? 0) > 0;
        const draft = isDraft(a);
        return (
          <Row
            key={a.id}
            label={`${a.title}, routine${draft ? ", draft" : a.enabled ? "" : ", paused"}: ${found.text}`}
            mark={running ? <StateMark name="state-working" animate /> : <Icon icon={Clock01Icon} className={cn("size-3.5", found.tone === "news" || found.tone === "off" ? "text-warning" : found.tone === "failed" ? "text-destructive" : "text-muted-foreground")} />}
            id={null}
            title={a.title}
            hint={row.last?.summary}
            waiting={running ? "Running" : found.text}
            opens={false}
            onOpen={() => undefined}
            actions={[
              // Resume in words, as on its Automations page: never a second play mark beside Run now. A file a chat
              // wrote or changed waits for the person's yes (the runtime says "Turn it on again"): Turn on gives it.
              // One a chat wrote in its worktree is a draft: Turn on adds it to the project's own checkout first.
              a.enabled && !asksYes(a) && !draft ? (
                action("Pause", PauseIcon, () => void setEnabled(a, false))
              ) : (
                <Button
                  key="Resume"
                  type="button"
                  size="sm"
                  variant="ghost"
                  title={draft ? "Turn on: add it to this project and start its schedule" : a.enabled ? "Turn on: what its file may do now is yours to allow" : "Resume: its schedule starts it again"}
                  onClick={(e) => (e.stopPropagation(), void (draft ? install(a, list.value ?? []) : setEnabled(a, true)))}
                  className="h-6 px-2 text-[12px] text-muted-foreground hover:text-foreground"
                >
                  {draft || a.enabled ? "Turn on" : "Resume"}
                </Button>
              ),
              action("Run now", PlayIcon, () => startRun(a, (x) => void runNow(x))),
              action("Edit", PencilEdit02Icon, () => navigate(settingsPath(a.id, "file"))),
            ]}
            tail={<span className="max-w-[220px] truncate text-[12px] text-[hsl(var(--subtle-foreground))] group-focus-within:hidden group-hover:hidden">{a.enabled || draft ? whenWords(a) : "Paused"}</span>}
          />
        );
      })}
    </Band>
  );
}

// ------------------------------------------------------------------ board

function WorkBoard({ groups, moves }: { groups: ReturnType<typeof workGroups>; moves: Moves }) {
  const label: Record<WorkGroup, string> = { needs: "Waiting on you", working: "Working", blocked: "Blocked", ready: "Ready to merge", review: "Ready for review", queued: "Queued", done: "Done" };
  return (
    <div className="flex min-w-min items-start gap-2.5 px-3 pb-5 pt-2">
      {/* Only the columns with work in them: in a panel this wide two fit, and an empty one would push the rest away. */}
      {WORK_GROUPS.map(({ id }) => {
        const work = groups.find((g) => g.group === id)?.work ?? [];
        if (work.length === 0) return null;
        return (
          <section key={id} className="w-[270px] shrink-0 rounded-xl bg-foreground/[0.035] p-1.5">
            <h2 className="flex h-9 items-center gap-2.5 px-2 text-[13.5px] font-medium text-foreground">
              <WorkMark group={id} className="w-4 shrink-0" />
              {label[id]}
              <span className="font-normal tabular-nums text-[hsl(var(--subtle-foreground))]">{work.length}</span>
            </h2>
            {work.map((w) => (
              <WorkCard key={w.item.id} work={w} moves={moves} />
            ))}
          </section>
        );
      })}
    </div>
  );
}

/**
 * One card on the board: its number, title and what proves it done in one muted line, what it needs in one short line,
 * then who runs it. The line folds open (its chevron, or the line itself) to the whole latest report, a row per field,
 * with its links as links. With the board's moves, its ⋯ (on hover or focus) and a right-click open the List row's menu.
 */
export function WorkCard({ work: w, moves, open: initial = false }: { work: Work; moves: Pick<Moves, "openChat"> & Partial<Pick<Moves, "act" | "mission">>; open?: boolean }) {
  const [open, setOpen] = useState(initial);
  const id = useId();
  const [menu, setMenu] = useState(false);
  // Its done-when line as a field (the menu's Set done when…); the menu leaves focus there as it closes.
  const [editing, setEditing] = useState(false);
  const [snoozing, setSnoozing] = useState<WorkspaceView | null>(null);
  const toField = useRef(false);
  const more = useRef<HTMLButtonElement>(null);
  const hold = useLongPress(() => setMenu(true));
  const { act, mission } = moves;
  const proof = w.item.done_when;
  const only = w.chats.length === 1 ? w.chats[0]! : null;
  const pr = workPullRequest(w.item, w.chats);
  // Queued work blocked on other work or a free slot says what it waits for when nothing else does.
  const note = workNote(w, pr) ?? (w.waiting ? { summary: w.waiting, more: false } : null);
  const head = (
    <>
      <span className={cn("flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[12px] text-[hsl(var(--subtle-foreground))]", act && "pr-6")}>
        {w.id ? <span className="shrink-0 tabular-nums">{w.id}</span> : null}
        {w.changeSet ? (
          <>
            <span>›</span>
            <span className="truncate">{w.changeSet.title}</span>
          </>
        ) : null}
      </span>
      {/* Clear of the ⋯, which sits on the number's line, or on the title's when it has none. */}
      <span className={cn("mt-1.5 line-clamp-2 block text-[13.5px] leading-[19px] text-foreground", act && !w.id && !w.changeSet && "pr-6")}>{w.title}</span>
    </>
  );
  const summary = note ? (
    <span className="line-clamp-2 min-w-0 flex-1 text-[12px] leading-4 text-muted-foreground">
      {note.label ? <span className={cn("font-medium", w.group === "needs" ? "text-warning" : "text-foreground")}>{note.label}{note.summary ? ": " : ""}</span> : null}
      {note.summary}
    </span>
  ) : null;
  return (
    <div
      data-work-card={w.item.id}
      onContextMenu={
        act
          ? (e) => {
              e.preventDefault();
              setMenu(true);
            }
          : undefined
      }
      {...(act ? hold : {})}
      className="group relative mb-1.5 rounded-[10px] border border-border bg-card px-3 py-2.5 transition-colors duration-75 focus-within:border-input hover:border-input"
    >
      {only ? (
        <button type="button" onClick={() => moves.openChat(only.id)} className="block w-full rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {head}
        </button>
      ) : (
        <div>{head}</div>
      )}
      {editing && mission ? (
        <DoneWhenField
          value={proof ?? ""}
          onDone={(text, byKey) => {
            setEditing(false);
            if (text !== null) mission(w, { done_when: text });
            // Ended by a key: back on its ⋯, where the person was.
            if (byKey) requestAnimationFrame(() => more.current?.focus());
          }}
          className="mt-1.5"
        />
      ) : proof ? (
        <DoneWhen text={proof} className="mt-1" />
      ) : null}
      {act && mission ? (
        <DropdownMenu open={menu} onOpenChange={setMenu} modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              ref={more}
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`${w.id ?? w.title} options`}
              className="absolute right-1.5 top-1.5 size-6 text-muted-foreground opacity-0 transition-opacity duration-75 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 touch:opacity-100"
            >
              <Icon icon={MoreHorizontalIcon} className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={2} className="w-[230px]" onCloseAutoFocus={(e) => keepRenameFocus(e, toField)}>
            <WorkMenuItems
              work={w}
              run={(action) => act(action, [w])}
              onDoneWhen={() => {
                toField.current = true;
                setEditing(true);
              }}
              mission={(patch) => mission(w, patch)}
              onSnooze={setSnoozing}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {snoozing ? <CustomSnoozeDialog workspace={snoozing} open onOpenChange={(o) => !o && setSnoozing(null)} /> : null}
      {note && note.more ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
          title={open ? "Show less" : "Show the whole report"}
          className="mt-2 flex w-full items-start gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {summary}
          <Icon icon={ArrowDown01Icon} className={cn("mt-px size-3.5 shrink-0 text-[hsl(var(--subtle-foreground))] transition-transform duration-150 ease-snap", !open && "-rotate-90")} />
        </button>
      ) : summary ? (
        <div className="mt-2 flex">{summary}</div>
      ) : null}
      {note && note.more && open ? (
        <div id={id} className="mt-2 space-y-1.5 border-l border-input pl-2.5 text-[12px] leading-4 text-foreground">
          {note.rows ? (
            note.rows.map((r, i) => (
              <div key={i}>
                <div className="text-[11px] text-[hsl(var(--subtle-foreground))]">{r.label}</div>
                <div className="break-words">
                  <Line text={r.value} />
                </div>
              </div>
            ))
          ) : (
            <div className="break-words">
              <Line text={w.item.detail ?? ""} />
            </div>
          )}
        </div>
      ) : null}
      <span className="mt-2 flex flex-wrap gap-1.5">
        {w.chats.length === 0 ? <Chip>No chat yet</Chip> : null}
        {w.chats.map((c) => (
          <Chip key={c.id}>
            <EngineMark engine={c.engine.id} className="size-3.5 shrink-0" />
            {c.engine.label} · {c.computer.label}
          </Chip>
        ))}
        {w.chats.length > 1 ? w.chats.map((c) => (c.pullRequest ? <PrChip key={`pr:${c.id}`} chat={c} /> : null)) : <PrChip pr={pr} />}
      </span>
    </div>
  );
}

/** A report's line with its links as links (they open outside the app). */
function Line({ text }: { text: string }) {
  return (
    <>
      {lineParts(text).map((p, i) =>
        p.href ? (
          <a key={i} href={p.href} target="_blank" rel="noreferrer" className="text-foreground underline decoration-muted-foreground underline-offset-2 hover:decoration-foreground">
            {p.text}
          </a>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

// ------------------------------------------------------------------ library

const ago = (at: string): string => {
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { day: "numeric", month: "short" });
};

/** The Chief's documents as a folder tree: a search, the latest few, then each project, each piece of work, its files. */
function Library({ groups, moves, projectName }: { groups: ReturnType<typeof workGroups>; moves: Moves; projectName: (id: string | null) => string | null }) {
  const [query, setQuery] = useState("");
  const [shut, setShut] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (k: string) => setShut((s) => (s.has(k) ? new Set([...s].filter((x) => x !== k)) : new Set([...s, k])));
  const q = query.trim().toLowerCase();
  const docs = workDocs(groups)
    .map((e) => ({ ...e, docs: e.docs.filter((d) => !q || d.title.toLowerCase().includes(q) || e.work.title.toLowerCase().includes(q)) }))
    .filter((e) => e.docs.length > 0);
  const recent = docs
    .flatMap((e) => e.docs)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 3);
  // By project, then by the work they came from.
  const byProject = new Map<string, typeof docs>();
  for (const entry of docs) {
    const project = projectName(entry.work.chats[0]?.projectId ?? entry.work.item.project_ids[0] ?? null) ?? "Other";
    byProject.set(project, [...(byProject.get(project) ?? []), entry]);
  }
  const file = (doc: WorkDoc, depth: number) => (
    <button
      key={`${depth}:${doc.key}`}
      type="button"
      onClick={() => moves.openDoc(doc)}
      style={{ paddingLeft: 8 + depth * 18 }}
      className="flex h-[30px] w-full items-center gap-2 whitespace-nowrap rounded-md pr-2 text-left text-[13.5px] text-foreground outline-none transition-colors duration-75 hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="w-3 shrink-0" />
      <Icon icon={doc.kind === "guide" ? GitPullRequestIcon : FileTextIcon} className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{doc.title}</span>
      <span className="ml-auto shrink-0 pl-2.5 text-[12px] text-[hsl(var(--subtle-foreground))]">{ago(doc.at)}</span>
    </button>
  );
  return (
    <div className="px-3.5 pb-10 pt-2.5">
      <label className="mb-1.5 mt-1 flex h-8 items-center gap-2 rounded-lg border border-input px-2.5 text-[13px] text-[hsl(var(--subtle-foreground))] focus-within:border-foreground/30">
        <Icon icon={Search01Icon} className="size-3.5 shrink-0" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search guides and contracts" className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-[hsl(var(--subtle-foreground))]" />
      </label>
      {docs.length === 0 ? (
        <p className="px-2 py-6 text-center text-[12.5px] text-[hsl(var(--subtle-foreground))]">{q ? "Nothing matches." : "Review guides and change set contracts land here as the work makes them."}</p>
      ) : (
        <>
          <h3 className="px-2 pb-1 pt-3.5 text-[12.5px] font-normal text-[hsl(var(--subtle-foreground))]">Recent</h3>
          {recent.map((d) => file(d, 0))}
          {[...byProject].map(([project, entries]) => {
            const pk = `p:${project}`;
            return (
              <div key={project} className="mt-2.5">
                <button type="button" onClick={() => toggle(pk)} className="flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left text-[13.5px] text-foreground outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring">
                  <Icon icon={ArrowDown01Icon} className={cn("size-2.5 w-3 shrink-0 text-[hsl(var(--subtle-foreground))] transition-transform duration-150 ease-snap", shut.has(pk) && "-rotate-90")} />
                  <Icon icon={Folder01Icon} className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate">{project}</span>
                </button>
                {shut.has(pk)
                  ? null
                  : entries.map(({ work, docs: files }) => {
                      const wk = `w:${work.item.id}`;
                      return (
                        <div key={work.item.id}>
                          <button
                            type="button"
                            onClick={() => toggle(wk)}
                            style={{ paddingLeft: 26 }}
                            className="flex h-[30px] w-full items-center gap-2 whitespace-nowrap rounded-md pr-2 text-left text-[13.5px] text-foreground/75 outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <Icon icon={ArrowDown01Icon} className={cn("size-2.5 w-3 shrink-0 text-[hsl(var(--subtle-foreground))] transition-transform duration-150 ease-snap", shut.has(wk) && "-rotate-90")} />
                            <WorkMark group={work.group} className="w-4 shrink-0" />
                            <span className="min-w-0 truncate">
                              {work.id ? <span className="mr-1.5 text-[hsl(var(--subtle-foreground))]">{work.id}</span> : null}
                              {work.title}
                            </span>
                            <span className="ml-auto shrink-0 pl-2.5 text-[12px] text-[hsl(var(--subtle-foreground))]">{files.length}</span>
                          </button>
                          {shut.has(wk) ? null : files.map((d) => file(d, 2))}
                        </div>
                      );
                    })}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ documents

function DocSurface({ tab }: SurfaceProps<"chief-doc">) {
  const chief = useChief(tab.params.chief_id);
  const projects = useRuntimeSelector((v) => v.projects);
  const set = chief.changeSets.find((c) => c.id === tab.params.change_set_id);
  if (!set) return <SurfaceEmpty title="Not on the board">This change set is no longer on the board.</SurfaceEmpty>;
  const name = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <article className="mx-auto max-w-[680px] px-9 pb-20 pt-5">
        <p className="mb-3.5 text-[12.5px] text-muted-foreground">Contract · merges {set.merge_order.map(name).join(", then ")}</p>
        <h1 className="mb-3.5 text-[28px] font-semibold leading-tight tracking-[-0.015em] text-foreground">{set.title}</h1>
        <MarkdownDocument source={set.contract} />
      </article>
    </div>
  );
}

defineSurface({
  kind: "chief-work",
  label: "Work",
  icon: ({ className }) => <Icon icon={CheckListIcon} className={className} />,
  identity: "one",
  title: () => "Work",
  component: WorkSurface,
  bar: WorkBar,
  pinned: true,
  launcher: false,
  defaultWidth: "clamp(420px, 42%, 680px)",
});

defineSurface({
  kind: "chief-doc",
  label: "Document",
  icon: ({ className }) => <Icon icon={FileTextIcon} className={className} />,
  identity: (p) => p.change_set_id,
  title: () => "Contract",
  component: DocSurface,
  launcher: false,
  portable: () => true,
  defaultWidth: "clamp(420px, 50%, 760px)",
});
