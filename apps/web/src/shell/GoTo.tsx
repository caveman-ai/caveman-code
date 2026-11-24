// Search (⌘K, or the sidebar's search field), built to feel like Arc's command bar: one field, the selected row's
// mark beside it, and the top row's name typed ahead and selected as you type (→ keeps it, Backspace drops it, Enter
// opens that row). Each selected row says at its right what Enter does ("Open", "Switch to pane").
// Its scale is compact search: the menu row
// of STYLE.md section 5 (32px, a 16px mark, 13px words), a 15px field, quiet 12px section names.
// Typing asks the runtime's chat.search, which finds the chat where something happened even when that chat was
// mostly about something else, by words and by meaning, and returns its best place; picking it opens the chat on
// that place with the find bar on the words that matched. Titles still match here at once, before the runtime
// answers and on a runtime without chat.search. Pages, actions ("dark", "bigger") and Settings sections match too.
// Before anything is typed it is a launcher: the Chiefs, what can be done to the chat in front (Rename, Pin, Done,
// Fork, Archive), what is open in a pane, the latest chats and the pages.
// Under the field a strip of filters narrows the list to one kind: All, Chats, Actions, Pages, Settings (a click, or
// ← → while the field is empty). A filter with nothing typed lists all of its kind: every chat, action or setting.
// The list reads in sections, each under a quiet name: "This chat", "Open", "Recent", "Go to" before anything is
// typed; "Top hit", "Chats", "Actions", "Settings" once something is. The arrows step through it as one list.
// A new chat is one key away: Tab (Arc's "Search Twitter  Tab"), or the field's New chat, opens New chat with what
// was typed already in its box. The same row closes every list, and leads it when nothing matched by its words.
// Ask (⌘↵, or the button in the field) hands what the search found to a fast, cheap model (chat.find), which says
// which chat is meant and why: its picks lead the list until the words change. One call per ask, never per letter.
// ⌘-click, or ⇧⌘↵, opens a chat or page in a new tab (desktop).
import * as Dialog from "@radix-ui/react-dialog";
import type { ChatFindPick, ChatFindResult, ChatSearchHit, ChatSearchPassage, ChatSearchResult } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { Keycap } from "@caveman-app/ui/components/menu";
import { arriveMotion, overlayMotion, paletteMotion } from "@caveman-app/ui/motion";
import type { PixelIconName } from "@caveman-app/ui/icons/names";
import { cn } from "@caveman-app/ui/lib/cn";
import {
  Icon,
  Archive02Icon,
  CheckmarkCircle02Icon,
  GitForkIcon,
  GitPullRequestIcon,
  Mail01Icon,
  MailOpen01Icon,
  PanelLeftIcon,
  PencilEdit02Icon,
  PinIcon,
  PinOffIcon,
  Undo02Icon,
} from "@caveman-app/ui/icons/huge";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { ChiefSprite } from "../components/ChiefSprite.tsx";
import { jumpTo } from "../components/find/jump.ts";
import { ago } from "../components/project-candidates.ts";
import { EngineMark } from "../components/transcript/marks.tsx";
import { revealSubagent } from "../components/transcript/reveal-subagent.ts";
import { previewThemeSelection } from "../state/theme-selection.ts";
import { matches } from "../lib/search.ts";
import { IS_MAC } from "../lib/platform.ts";
import { findSettings, SETTINGS_SECTIONS, type SettingsSection } from "../routes/settings/sections.ts";
import { prPath } from "../routes/review/model.ts";
import { announce, panes, useLayout, useOpenWorkspaces, windowTabs } from "../panes/store.ts";
import { findPane } from "../panes/tree.ts";
import { ACTION_ICONS } from "../panels/actions/icons.ts";
import { runInTerminal } from "../panels/terminal/run.ts";
import { actionIcon, actionKey, useActionsList } from "../state/actions.ts";
import { chiefPath, useChiefs } from "../state/chiefs.ts";
import { openInPanes, type WorkspaceView } from "../state/model.ts";
import { prefetchSession, requestId, useRuntimeClient, useRuntimeSelector } from "../state/runtime.tsx";
import { toggleSidebar, useSidebarLayout } from "../state/sidebar-layout.ts";
import { chord, useKeybindings } from "../state/keybindings.ts";
import { ariaChord, formatChord, IS_DESKTOP, isComposing } from "../panels/chrome.tsx";
import { completion, GOTO_FILTERS, goToActions, newChatLeads, sections, stepFilter, type GoToFilter, type GoToGroup } from "./goto-actions.ts";
import { useInbox } from "./InboxItems.tsx";
import { peek } from "../state/peek.ts";
import { showShortcuts } from "./ShortcutHelp.tsx";
import { useTabNav } from "./tab-nav.ts";
import { showWhatsNew } from "../whats-new/WhatsNew.tsx";
import { baseName } from "../lib/paths.ts";
import { reportProblem } from "../state/bug-report.ts";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

/** What a row is: it picks the words its selected row shows at the right ("Open", "Switch to pane"). */
type Kind = "new" | "chief" | "here" | "open" | "chat" | "page" | "action" | "setting";
const VERB: Record<Kind, string> = {
  new: "Start chat",
  chief: "Open",
  here: "",
  open: "Switch to pane",
  chat: "Open",
  page: "Go to",
  action: "",
  setting: "Open",
};

interface Row {
  readonly key: string;
  readonly kind: Kind;
  /** The section it sits under: "Top hit", "This chat", "Recent", "Go to". */
  readonly section: string;
  /** The filter that keeps it. None for New chat with what was typed, which every filter ends with. */
  readonly group?: GoToGroup;
  readonly icon: ReactNode;
  readonly label: string;
  readonly description: string;
  /** Grey at the row's right while it is not selected: how long ago, a state. */
  readonly meta?: string;
  readonly run: () => void;
  /** ⌘-click or ⇧⌘Enter (desktop): the same place in a tab of its own; answers the route to show. */
  readonly tab?: () => string | null;
  /** A chat's session: loaded while its row is the one Enter would open. */
  readonly sessionId?: string | null;
  /** A chat found by what was said in it: its best place, shown under the title. */
  readonly found?: { readonly passage: ChatSearchPassage; readonly places: number };
  /** Found by meaning alone, not by its words: a guess, which New chat outranks. */
  readonly byMeaning?: boolean;
  /** A chat the model picked (Ask): why, in a line. */
  readonly why?: string;
}

const PAGES: ReadonlyArray<{ to: string; icon: PixelIconName; label: string; description: string }> = [
  { to: "/chief", icon: "chief", label: "Chief", description: "Tell it anything; what needs you and what waits" },
  { to: "/review", icon: "review", label: "Review", description: "Pull requests waiting on you, and your own" },
  { to: "/plugins", icon: "spaces", label: "Plugins", description: "Plugins, MCP servers, skills and rules every engine loads" },
  { to: "/plugins/browse", icon: "customize", label: "Browse plugins", description: "Caveman's catalog, your team's and the marketplaces you added" },
  { to: "/automations", icon: "automations", label: "Automations", description: "Runs on a schedule or when something happens in your repos" },
  { to: "/settings/general", icon: "settings", label: "Settings", description: "Account, appearance, keyboard, models, projects" },
];
/** Who said it, as a found place's lead-in. */
const SAID: Record<ChatSearchPassage["kind"], string> = {
  title: "Title",
  user: "You",
  assistant: "Answer",
  agent: "Agent",
  plan: "Plan",
  ask: "Question",
  tool: "Ran",
  files: "Files",
};

/** How long after the last key the runtime is asked: one search per pause, not per letter. */
const DEBOUNCE_MS = 90;

/** chat.search for what is typed. The last answer stays up while the next is on its way, so the list never blanks. */
function useChatSearch(query: string, open: boolean): { readonly result: ChatSearchResult | null; readonly settled: boolean } {
  const { client } = useRuntimeClient();
  const [answer, setAnswer] = useState<{ readonly query: string; readonly result: ChatSearchResult | null } | null>(null);
  const text = query.trim();
  useEffect(() => {
    if (!open || !client || !text) {
      setAnswer(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      client
        .call("chat.search", { query: query.slice(0, 500), limit: 20 })
        .then((result) => live && setAnswer({ query, result }))
        // A runtime from before chat.search, or one that failed: titles still match below.
        .catch(() => live && setAnswer({ query, result: null }));
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, query, text, open]);
  return { result: text ? (answer?.result ?? null) : null, settled: !text || answer?.query === query };
}

/** Ask's chord: Enter opens, ⌘↵ asks. */
const ASK = "mod+enter";

type Asked =
  | { readonly query: string; readonly state: "asking" }
  | { readonly query: string; readonly state: "done"; readonly result: ChatFindResult; readonly ms: number }
  | { readonly query: string; readonly state: "failed"; readonly message: string };

/** chat.find, when the person asks: the latest ask wins, and closing the palette forgets it. */
function useChatFind(open: boolean): { readonly asked: Asked | null; readonly ask: (query: string) => void } {
  const { client } = useRuntimeClient();
  const [asked, setAsked] = useState<Asked | null>(null);
  const latest = useRef(0);
  useEffect(() => {
    if (open) return;
    latest.current++;
    setAsked(null);
  }, [open]);
  const ask = useCallback(
    (query: string) => {
      const text = query.trim();
      if (!client || !text) return;
      const n = ++latest.current;
      const started = performance.now();
      setAsked({ query, state: "asking" });
      client
        .call("chat.find", { query: text.slice(0, 500) })
        .then((result) => n === latest.current && setAsked({ query, state: "done", result, ms: performance.now() - started }))
        .catch((error: unknown) => n === latest.current && setAsked({ query, state: "failed", message: error instanceof Error ? error.message : "The model did not answer." }));
    },
    [client],
  );
  return { asked, ask };
}

const NO_PICKS: ReadonlyArray<ChatFindPick> = [];

/** "1.2s", or "640ms" under a second: how long the model took. */
const took = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

/** The words that matched in a place, the longest first: what the chat's find bar looks for. */
const matchedWords = (passage: ChatSearchPassage) =>
  passage.marks
    .map((m) => passage.text.slice(m.start, m.end))
    .sort((a, b) => b.length - a.length)[0] ?? "";

/**
 * Where to land: the best place if the chat can scroll to it (a message, through the find bar; a subagent's
 * row, opened in place), else the best message among its places; none for a title or the changed files alone.
 */
export function landing(hit: ChatSearchHit): ChatSearchPassage | undefined {
  const message = (p: ChatSearchPassage) => p.kind === "user" || p.kind === "assistant";
  const best = hit.passages[0];
  return best && (message(best) || best.kind === "agent") ? best : hit.passages.find(message);
}

function Snippet({ passage }: { passage: ChatSearchPassage }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [i, m] of passage.marks.entries()) {
    if (m.start > at) parts.push(passage.text.slice(at, m.start));
    parts.push(
      <mark key={i} className="rounded-[3px] bg-transparent font-semibold text-foreground">
        {passage.text.slice(m.start, m.end)}
      </mark>,
    );
    at = m.end;
  }
  parts.push(passage.text.slice(at));
  return (
    <span className="line-clamp-2 break-words text-[12px] leading-[17px] text-muted-foreground">
      <span className="text-foreground/75">{SAID[passage.kind]}</span>
      {passage.by === "meaning" ? (
        <span title="Found by meaning: not the same words" className="text-[hsl(var(--subtle-foreground))]">
          {" "}
          ≈
        </span>
      ) : null}
      <span aria-hidden> · </span>
      {parts}
    </span>
  );
}

/** Ask's line while the model reads, when it failed, or when no chat fits; its picks are rows. */
function AskStatus({ answer }: { answer: Asked }) {
  const line =
    answer.state === "asking" ? (
      <span className="lucy-shimmer">Reading your chats for what you mean…</span>
    ) : answer.state === "failed" ? (
      <span className="text-muted-foreground">Could not ask: {answer.message}</span>
    ) : answer.result.chats.length > 0 ? (
      <span className="flex min-w-0 flex-1 items-baseline gap-2 text-muted-foreground">
        <span className="min-w-0 truncate">Picked by {answer.result.model}</span>
        <span className="ml-auto shrink-0 tabular-nums text-[hsl(var(--subtle-foreground))]">
          {answer.result.read} chats read · {took(answer.ms)}
        </span>
      </span>
    ) : (
      <span className="text-muted-foreground">
        {answer.result.read === 0 ? "There are no chats to read yet." : `No chat fits, of ${answer.result.read} read. Try saying what was done in it, or when.`}
      </span>
    );
  return (
    <div role="status" aria-live="polite" className={cn("flex min-h-8 items-center gap-2.5 px-2 py-1 text-[12.5px]", answer.state !== "asking" && arriveMotion)}>
      <span className="grid size-4 shrink-0 place-items-center">
        <Glyph name="engine-caveman" className={cn(answer.state === "asking" && "px-blink-loop")} />
      </span>
      {line}
    </div>
  );
}

const NO_WORKSPACES: ReadonlyArray<WorkspaceView> = [];
/** How many of the latest chats the empty list shows. */
const RECENT = 6;
/** How many rows a list holds at most. */
const MOST = 60;

export function GoTo({
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where focus goes as it closes (Radix's own event): the opener says, since a shortcut is no trigger to go back to. */
  onCloseAutoFocus: (event: Event) => void;
}) {
  // Closed, ⌘K reads nothing that changes: a push re-renders no palette.
  const workspaces = useRuntimeSelector((v) => (open ? v.workspaces : NO_WORKSPACES));
  const projects = useRuntimeSelector((v) => v.projects);
  const engines = useRuntimeSelector((v) => v.engines);
  const settingsNow = useRuntimeSelector((v) => v.settings);
  const latestSettings = useRef(settingsNow);
  useLayoutEffect(() => { latestSettings.current = settingsNow; }, [settingsNow]);
  const saveSettings = useRuntimeSelector((v) => v.saveSettings);
  const refresh = useRuntimeSelector((v) => v.refresh);
  const { client } = useRuntimeClient();
  const chiefs = useChiefs();
  const inbox = useInbox();
  const sidebar = useSidebarLayout();
  const sidebarKeys = formatChord(useKeybindings()["app.toggleSidebar"] ?? chord("app.toggleSidebar"));
  const openIds = useOpenWorkspaces();
  const layout = useLayout();
  // The focused chat: its actions lead, its project is where New chat starts, and "test" finds its Run Test.
  const here = findPane(layout, layout.focused)?.workspaceId ?? null;
  const hereChat = here ? (workspaces.find((w) => w.id === here && w.state !== "archived") ?? null) : null;
  const hereActions = useActionsList(here ?? "", open && here !== null).list?.actions;
  const navigate = useNavigate();
  const go = useTabNav();
  // What was typed. The field shows it plus the top row's typed-ahead rest (`ahead`), selected, as Arc does.
  const [query, setQuery] = useState("");
  // Off once the words stop growing, so Backspace takes the typed-ahead part away instead of bringing it back.
  const [complete, setComplete] = useState(true);
  const [at, setAt] = useState(0);
  // The strip under the field: everything, or one kind of row.
  const [filter, setFilter] = useState<GoToFilter>("all");
  // Rename… turns the field into the chat's name; Enter saves it, Escape comes back to the list.
  const [renaming, setRenaming] = useState<{ readonly workspace: WorkspaceView; readonly title: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const { result: search, settled } = useChatSearch(query, open);
  const { asked, ask } = useChatFind(open);
  // An answer is for the words it was asked with: typing on puts the search back in front, and back again restores it.
  const answer = asked !== null && asked.query === query ? asked : null;
  const picks = answer?.state === "done" ? answer.result.chats : NO_PICKS;
  const typed = query.trim() !== "";

  const close = (then: () => void) => () => {
    onOpenChange(false);
    then();
  };
  // New chat with what was typed in its box, in the focused chat's project (else the one last used). Nothing is sent.
  const newProject = hereChat?.projectId ? projects.find((p) => p.id === hereChat.projectId) : undefined;
  const startNew = () => {
    onOpenChange(false);
    const text = query.trim();
    navigate(newProject ? `/new?project=${encodeURIComponent(newProject.id)}` : "/new", text ? { state: { prompt: { text } } } : undefined);
  };

  const rows = useMemo<Row[]>(() => {
    const act = (call: Promise<unknown> | undefined, done?: string) =>
      void call?.then(
        () => {
          if (done) announce(done);
          refresh();
        },
        (e: unknown) => announce(e instanceof Error ? e.message : String(e)),
      );
    const projectName = new Map(projects.map((p) => [p.id, p.name]));
    const show = (id: string) => {
      panes.show(id);
      navigate(`/w/${id}`);
    };

    const chiefRows: Row[] = (chiefs.status === "ready" ? chiefs.chiefs : []).map((c) => ({
      key: `chief:${c.id}`,
      kind: "chief",
      section: "Chiefs",
      group: "chats",
      icon: <ChiefSprite avatar={c.avatar} pose={chiefs.working.has(c.id) ? "working" : "wave"} className="size-4" />,
      label: c.name,
      description: c.home ? "Your Chief" : "Chief",
      ...(chiefs.working.has(c.id) ? { meta: "Thinking" } : {}),
      run: close(() => navigate(chiefPath(c))),
      tab: () => windowTabs.openPage(chiefPath(c)),
    }));
    const pages: Row[] = [
      { key: "chat", kind: "page", section: "Create", group: "actions", icon: <Glyph name="new" />, label: "New chat", description: "Start a chat in a project", run: close(() => navigate("/new")), tab: windowTabs.openNewChat },
      // The Chief page only where the Chiefs are not rows of their own.
      ...PAGES.filter((p) => p.to !== "/chief" || chiefRows.length === 0).map(
        (p): Row => ({ key: p.to, kind: "page", section: "Go to", group: "pages", icon: <Glyph name={p.icon} />, label: p.label, description: p.description, run: close(() => navigate(p.to)), tab: () => windowTabs.openPage(p.to) }),
      ),
      { key: "shortcuts", kind: "page", section: "Help", group: "pages", icon: <Glyph name="artifact-code" />, label: "Keyboard shortcuts", description: "Every shortcut (?)", run: close(showShortcuts) },
      { key: "whats-new", kind: "page", section: "Help", group: "pages", icon: <Glyph name="artifact-markdown" />, label: "What's new", description: "What changed in each release", run: close(showWhatsNew) },
    ];
    // A found chat, opening on its place.
    const hitRow = (hit: ChatSearchHit, prefix: "picked" | "found"): Row => {
      const w = hit.workspace;
      const target = landing(hit);
      const where = w.kind === "chief" ? "Chief" : (w.project_id && projectName.get(w.project_id)) || baseName("path" in w.repo ? w.repo.path : w.repo.url);
      return {
        key: `${prefix}:${w.id}`,
        kind: "chat",
        section: "Chats",
        group: "chats",
        icon: w.kind === "chief" ? <Glyph name="chief" /> : <EngineMark engine={w.engine} />,
        label: w.title,
        description: [where, w.status === "archived" ? "Archived" : ""].filter(Boolean).join(" · "),
        meta: [hit.passages.length + hit.more > 1 ? `${hit.passages.length + hit.more} places` : "", ago(w.updated_at)].filter(Boolean).join(" · "),
        run: close(() => {
          if (w.status === "archived") peek(w);
          if (w.kind === "chief") navigate(`/chief/${encodeURIComponent(w.id)}`);
          else show(w.id);
          if (target?.kind === "agent" && target.item_id) revealSubagent(target.item_id);
          else if (target?.item_id) jumpTo(w.session_id, { item: target.item_id, query: target.by === "meaning" ? "" : matchedWords(target) });
        }),
        ...(w.kind === "chief" || w.status === "archived" ? {} : { tab: () => windowTabs.openChat(w.id) }),
        sessionId: w.session_id,
        ...(hit.passages[0] ? { found: { passage: hit.passages[0], places: hit.passages.length + hit.more } } : {}),
        byMeaning: hit.passages.every((p) => p.by === "meaning"),
      };
    };
    // What the model picked leads; chats found by what was said in them follow, best first, none twice.
    const picked: Row[] = picks.map((pick) => ({ ...hitRow(pick, "picked"), section: "Picked", why: pick.why }));
    const pickedIds = new Set(picks.map((pick) => pick.workspace.id));
    const found: Row[] = (search?.chats ?? []).filter((hit) => !pickedIds.has(hit.workspace.id)).map((hit) => hitRow(hit, "found"));
    const shown = new Set([...pickedIds, ...(search?.chats ?? []).map((hit) => hit.workspace.id)]);
    const opened = openInPanes(workspaces, openIds);
    const openedIds = new Set(opened.map((w) => w.id));
    const chat = (section: string) => (w: WorkspaceView): Row => ({
      key: `chat:${w.id}`,
      kind: openedIds.has(w.id) ? "open" : "chat",
      section,
      group: "chats",
      icon: <EngineMark engine={w.engine.id} />,
      label: w.title,
      description: (w.projectId && projectName.get(w.projectId)) || w.repo,
      // Under "Open" the section says it; there the row says when it last moved.
      meta: w.id === here ? "In front" : openedIds.has(w.id) && section !== "Open" ? "Open" : ago(w.updatedAt),
      sessionId: w.sessionId,
      run: close(() => show(w.id)),
      tab: () => windowTabs.openChat(w.id),
    });
    const latest = [...workspaces].filter((w) => w.state !== "archived" && !w.automationStep).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    // What can be done to the chat in front, as its row menu offers it.
    const w = hereChat;
    const canFork = w !== null && engines.find((e) => e.id === w.engine.id)?.capabilities.fork === true && w.sessionId !== null && w.branch !== "";
    const hereRow = (key: string, icon: ReactNode, label: string, description: string, run: () => void): Row => ({ key: `here:${key}`, kind: "here", section: "This chat", group: "actions", icon, label, description, run });
    const hereRows: Row[] =
      w && client
        ? [
            hereRow("rename", <Icon icon={PencilEdit02Icon} />, "Rename chat…", w.title, () => {
              setRenaming({ workspace: w, title: w.title });
              setQuery("");
            }),
            ...(inbox
              ? [
                  w.inbox?.pinnedAt
                    ? hereRow("pin", <Icon icon={PinOffIcon} />, "Unpin chat", "Back among its project's chats", close(() => inbox(w.id, { do: "unpin" })))
                    : hereRow("pin", <Icon icon={PinIcon} />, "Pin chat", "Keep it at the top of the sidebar", close(() => inbox(w.id, { do: "pin" }))),
                  w.inbox?.doneAt
                    ? hereRow("done", <Icon icon={Undo02Icon} />, "Mark chat not done", "Back in the queue", close(() => inbox(w.id, { do: "reopen" })))
                    : hereRow("done", <Icon icon={CheckmarkCircle02Icon} />, "Mark chat done", "Off the queue until something new happens", close(() => inbox(w.id, { do: "done" }))),
                  w.unread
                    ? hereRow("unread", <Icon icon={MailOpen01Icon} />, "Mark chat read", "", close(() => inbox(w.id, { do: "seen", through: w.updatedAt })))
                    : hereRow("unread", <Icon icon={Mail01Icon} />, "Mark chat unread", "Come back to it later", close(() => inbox(w.id, { do: "unread" }))),
                ]
              : []),
            ...(w.pullRequest && w.projectId
              ? [hereRow("review", <Icon icon={GitPullRequestIcon} />, `Review #${w.pullRequest.number}`, "Its pull request", close(() => navigate(prPath({ project_id: w.projectId!, number: w.pullRequest!.number }))))]
              : []),
            ...(canFork
              ? [
                  hereRow("fork", <Icon icon={GitForkIcon} />, "Fork chat", "Carry on in a copy, on its own branch", close(() =>
                    act(
                      client.call("session.fork", { request_id: requestId(), session_id: w.sessionId! }).then((r) => {
                        panes.show(r.workspace.id);
                        navigate(`/w/${r.workspace.id}`);
                        announce(`Forked into ${r.workspace.title}.`);
                      }),
                    ),
                  )),
                ]
              : []),
            hereRow("archive", <Icon icon={Archive02Icon} />, "Archive chat", "Restore brings it back", close(() => act(client.call("workspace.archive", { request_id: requestId(), workspace_id: w.id }), `Archived ${w.title}.`))),
          ]
        : [];

    // Each Settings section ("theme", "api key") and each thing to do ("light", "bigger", "dracula", "sidebar"),
    // saved like any Settings change.
    const setting = (under: string) => (section: SettingsSection): Row => ({
      key: `settings:${section.id}`,
      kind: "setting",
      section: under,
      group: "settings",
      icon: <Glyph name={section.icon} />,
      label: section.label,
      description: section.description,
      run: close(() => navigate(`/settings/${section.id}`)),
    });
    const actions: Row[] = goToActions(query, settingsNow, sidebar.hidden, sidebarKeys, filter === "actions").map((a) => ({
      key: `action:${a.key}`,
      kind: "action",
      section: "Actions",
      group: "actions",
      icon: "sidebar" in a.act ? <Icon icon={PanelLeftIcon} /> : <Glyph name="settings" />,
      label: a.label,
      description: a.description,
      run: close(() => {
        if ("sidebar" in a.act) return toggleSidebar();
        if ("report" in a.act) return reportProblem({ surface: "other" });
        const patch = a.act.settings;
        const preview = patch.color_theme && settingsNow ? previewThemeSelection(settingsNow, patch) : null;
        const pending = saveSettings ? saveSettings(patch) : client?.call("settings.set", { request_id: requestId(), settings: patch }).then(refresh);
        const restore = () => { if (settingsNow) preview?.rollback(latestSettings.current ?? settingsNow); };
        if (!pending) restore();
        else void pending.then(() => preview?.commit(), restore);
      }),
    }));
    const runs: Row[] =
      here && client
        ? (hereActions ?? []).map((a): Row => ({
            key: `run:${actionKey(a)}`,
            kind: "action",
            section: "Actions",
            group: "actions",
            icon: <Icon icon={ACTION_ICONS[actionIcon(a)]} />,
            label: `Run ${a.name}`,
            description: a.command,
            run: close(() => void runInTerminal(client, here, a.command).catch(() => undefined)),
          }))
        : [];

    if (!typed) {
      const rest = latest.filter((x) => !openedIds.has(x.id));
      // The launcher: the Chiefs, what to do with the chat in front, what is open, the latest chats, the pages.
      if (filter === "all") return [...chiefRows, ...hereRows, ...opened.map(chat("Open")), ...rest.slice(0, RECENT).map(chat("Recent")), ...pages];
      // One kind, all of it: every chat, everything there is to do, each page, each Settings section under its group.
      const every = [
        ...chiefRows,
        ...opened.map(chat("Open")),
        ...rest.map(chat("Recent")),
        ...hereRows,
        ...pages,
        ...actions,
        ...runs,
        ...SETTINGS_SECTIONS.flatMap((g) => (g.sections as ReadonlyArray<SettingsSection>).map(setting(g.label))),
      ];
      return every.filter((r) => r.group === filter).slice(0, MOST);
    }
    const settings: Row[] = findSettings(query).map(setting("Settings"));
    const match = (rows: Row[]) => rows.filter((r) => matches(query, `${r.label} ${r.description}`));
    // A name that begins with what was typed leads (Arc's first row, typed ahead in the field); then what was said,
    // which is what a question is after. Doing beats going: "dark" puts Dark mode above the Appearance page. The
    // app's own actions before the chat's: a repo's action can't stand in for "Dark mode". Chats by title last.
    const titled = latest.filter((x) => !shown.has(x.id)).map(chat(found.length > 0 ? "More chats" : "Chats"));
    const all = [...found, ...match(chiefRows), ...match(hereRows), ...match(pages), ...actions, ...match(runs), ...settings, ...match(titled)].filter((r) => filter === "all" || r.group === filter);
    const lead = all.findIndex((r) => !r.byMeaning && completion(query, r.label) !== "");
    // That row leaves its section for one of its own, "Top hit", above the rest.
    const ranked = (lead >= 0 ? [{ ...all[lead]!, section: "Top hit" }, ...all.slice(0, lead), ...all.slice(lead + 1)] : all).slice(0, MOST);
    // New chat with what was typed is always a row (Arc's "Search for…"): first when nothing matched by its words.
    // Its section says what it is, so the row says only where.
    const fresh: Row = { key: "new-chat", kind: "new", section: "New chat", icon: <Glyph name="new" />, label: query.trim(), description: newProject ? `In ${newProject.name}` : "", run: startNew };
    // What the model picked (Ask) leads everything: the person asked for it.
    const asked = picked.filter((r) => filter === "all" || r.group === filter);
    if (asked.length > 0) return [...asked, ...ranked, fresh];
    return newChatLeads(query, settled, ranked) ? [fresh, ...ranked] : [...ranked, fresh];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- close and startNew read only what is listed
  }, [workspaces, openIds, projects, engines, search, picks, query, typed, filter, settled, chiefs, inbox, hereChat, newProject, navigate, onOpenChange, settingsNow, sidebar.hidden, sidebarKeys, saveSettings, client, refresh, here, hereActions]);

  useEffect(() => setAt(0), [search, picks, query, filter, open]);
  // The chat Enter would open loads now, so it opens whole.
  const atSession = open ? rows[at]?.sessionId : undefined;
  useEffect(() => prefetchSession(client, atSession), [client, atSession]);
  useEffect(() => {
    if (open) return;
    setQuery("");
    setFilter("all");
    setRenaming(null);
  }, [open]);
  // Block body: scrollIntoView returns a Promise in newer browsers, and an effect must not return one.
  useEffect(() => {
    list.current?.querySelector(`[data-row="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  // Typed ahead: the rest of the top row's name, while it is the selected one and the last key was not a deletion.
  const ahead = !renaming && complete && at === 0 && rows[0] && rows[0].kind !== "new" ? completion(query, rows[0].label) : "";
  useLayoutEffect(() => {
    const el = input.current;
    if (el && ahead && document.activeElement === el) el.setSelectionRange(query.length, query.length + ahead.length, "backward");
  }, [ahead, query]);

  const pick = (row: Row | undefined, newTab: boolean) => {
    if (!row) return;
    if (newTab && IS_DESKTOP && row.tab) {
      onOpenChange(false);
      go(row.tab());
      return;
    }
    row.run();
  };
  const saveName = () => {
    if (!renaming) return;
    const title = renaming.title.trim();
    const { workspace } = renaming;
    onOpenChange(false);
    if (!client || !title || title === workspace.title) return;
    void client.call("workspace.rename", { request_id: requestId(), workspace_id: workspace.id, title }).then(refresh, (e: unknown) => announce(e instanceof Error ? e.message : String(e)));
  };

  // A line under the list while it matters: an index still filling, meaning not ready yet.
  const status = [search?.indexing ? "Still reading older chats" : "", search?.meaning === "preparing" ? "Meaning search is getting ready" : ""].filter(Boolean).join(" · ");
  // The field's mark is the selected row's, once something is typed (Arc shows where Enter goes).
  const mark = renaming ? <Icon icon={PencilEdit02Icon} /> : typed && rows[at] ? rows[at].icon : <Glyph name="search" />;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
 {/* A light dim: the glass shows the page it floats over (compact search, ). */}
        <Dialog.Overlay className={`fixed inset-0 z-40 bg-black/20 ${overlayMotion}`} />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            input.current?.focus();
          }}
          onCloseAutoFocus={onCloseAutoFocus}
          // Escape while renaming comes back to the list; with words typed ahead it drops them; otherwise it closes.
          onEscapeKeyDown={(e) => {
            if (renaming) {
              e.preventDefault();
              setRenaming(null);
            } else if (ahead) {
              e.preventDefault();
              setComplete(false);
            }
          }}
          className={`fixed inset-x-0 top-[14vh] z-50 mx-auto flex max-h-[72vh] w-[min(640px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl glass outline-none ${paletteMotion}`}
        >
          <Dialog.Title className="sr-only">Search</Dialog.Title>
          <div className="relative flex h-12 shrink-0 items-center gap-2.5 pl-3.5 pr-2">
            <span className="grid size-4 shrink-0 place-items-center text-muted-foreground [&_svg:not([class*='size-']):not(.px-art)]:size-4">{mark}</span>
            <input
              ref={input}
              key={renaming ? "rename" : "search"}
              autoFocus
              value={renaming ? renaming.title : query + ahead}
              onChange={(e) => {
                if (renaming) return setRenaming({ ...renaming, title: e.target.value });
                // Typed ahead again only when the words grew: Backspace over the selected rest leaves them as they were.
                setComplete(e.target.value.length > query.length);
                setQuery(e.target.value);
              }}
              onFocus={(e) => renaming && e.currentTarget.select()}
              onKeyDown={(e) => {
                if (isComposing(e)) return;
                if (renaming) {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveName();
                  }
                  return;
                }
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const n = rows.length;
                  if (n > 0) setAt((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
                  // ⌘↵ asks a model which chat is meant (once per words); ⇧⌘↵ opens the row in a new tab.
                  if (mod && !e.shiftKey) {
                    if (typed && answer?.state !== "asking" && answer?.state !== "done") ask(query);
                  } else pick(rows[at], mod);
                } else if (e.key === "Tab") {
                  // Tab: a new chat with what was typed, wherever the list is (Arc's "Search Twitter  Tab").
                  e.preventDefault();
                  if (!e.shiftKey) startNew();
                } else if (query === "" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
                  // ← → in an empty field step through the filters, as in the model picker.
                  e.preventDefault();
                  setFilter(stepFilter(filter, e.key === "ArrowRight" ? 1 : -1));
                } else if (ahead && (e.key === "ArrowRight" || e.key === "End")) {
                  // → keeps the typed-ahead words as typed.
                  e.preventDefault();
                  setQuery(query + ahead);
                }
              }}
              placeholder={renaming ? "Chat name" : "Search or start a chat…"}
              aria-label={renaming ? "New name for the chat" : "Search chats, pages, actions and settings, or start a chat"}
              {...(renaming
                ? {}
                : { role: "combobox", "aria-expanded": true, "aria-controls": "goto-list", "aria-activedescendant": rows[at] ? `goto-${at}` : undefined, "aria-autocomplete": "both" as const })}
              spellCheck={false}
              autoComplete="off"
              className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-foreground caret-foreground outline-none selection:bg-foreground/15 placeholder:text-[hsl(var(--subtle-foreground))]"
            />
            {renaming ? (
              <span className="flex shrink-0 items-center gap-1.5 pr-1.5 text-[12.5px] text-muted-foreground">
                Save <Keycap>↵</Keycap>
              </span>
            ) : (
              <>
                {typed ? (
                  <Button
                    variant="ghost"
                    // The field keeps focus, so the arrows and Enter still drive the list.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => answer?.state !== "asking" && ask(query)}
                    disabled={!client}
                    aria-keyshortcuts={ariaChord(ASK)}
                    title="Ask a fast model which chat you mean"
                    size="sm"
                    className="shrink-0 gap-1.5 pl-2 pr-1 font-normal"
                  >
                    <Glyph name="engine-caveman" className={cn(answer?.state === "asking" && "px-blink-loop")} />
                    Ask
                    <Keycap>{formatChord(ASK)}</Keycap>
                  </Button>
                ) : null}
                <Button variant="ghost" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={startNew} title="Start a new chat with what you typed" className="shrink-0 gap-1.5 pl-2 pr-1 font-normal">
                  New chat
                  <Keycap>Tab</Keycap>
                </Button>
              </>
            )}
            {/* While a model reads: a short light runs along the field's edge. */}
            {answer?.state === "asking" ? (
              <span aria-hidden className="pointer-events-none absolute inset-x-0 -bottom-px h-px overflow-hidden">
                <span className="lucy-sweep block h-full w-2/5" />
              </span>
            ) : null}
          </div>
          {renaming ? null : (
            // The filters. Never focused (the field keeps the keys): a click, or ← → while the field is empty.
            <div role="tablist" aria-label="Show" className="flex shrink-0 items-center gap-0.5 px-1.5 pb-2">
              {GOTO_FILTERS.map((f) => (
                <Button
                  key={f.id}
                  role="tab"
                  aria-selected={f.id === filter}
                  aria-controls="goto-list"
                  tabIndex={-1}
                  variant={f.id === filter ? "secondary" : "ghost"}
                  size="sm"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setFilter(f.id)}
                  className={cn("px-2", f.id === filter ? "font-medium" : "border border-transparent font-normal")}
                >
                  {f.label}
                </Button>
              ))}
            </div>
          )}
          <div className="mx-2 h-px shrink-0 bg-border" />
          {renaming ? (
            <p className="px-3.5 py-3 text-[13px] text-muted-foreground">
              Renaming <span className="text-foreground">{renaming.workspace.title}</span>
              <span aria-hidden> · </span>Escape goes back
            </p>
          ) : (
            // The top scroll padding is a section name's height and the list's padding: arrowing up to a section's first row
            // brings its name along.
            <div ref={list} id="goto-list" role="listbox" aria-label="Results" className="min-h-0 overflow-y-auto scroll-pb-1.5 scroll-pt-9 p-1.5 [mask-image:linear-gradient(to_bottom,black_calc(100%-12px),transparent)]">
              {search?.corrected ? (
                <p className="px-2 pb-1 pt-1 text-[12px] text-muted-foreground">
                  Showing chats for <span className="text-foreground">{search.corrected}</span>
                </p>
              ) : null}
              {answer !== null ? <AskStatus answer={answer} /> : null}
              {sections(rows).map((s, n, every) => (
                <div key={`${n}:${s.name}`} role="group" aria-label={s.name}>
                  {/* A filter's lone section goes unnamed while nothing is typed: the filter says it. The name starts where the marks do (the rows' 8px padding). */}
                  {filter === "all" || typed || every.length > 1 ? (
                    <div aria-hidden className={cn("select-none px-2 pb-1 text-[12px] leading-4 text-muted-foreground", n === 0 ? "pt-1" : "pt-2.5")}>
                      {s.name}
                    </div>
                  ) : null}
                  {s.rows.map(({ row: r, index: i }) => {
                    const on = i === at;
                    const verb = VERB[r.kind];
                    return (
                      <div
                        key={r.key}
                        id={`goto-${i}`}
                        data-row={i}
                        role="option"
                        aria-selected={on}
                        data-active={on}
                        title={IS_DESKTOP && r.tab ? `${IS_MAC ? "⌘" : "Ctrl"}-click or ${IS_MAC ? "⇧⌘" : "Shift+Ctrl+"}Enter: in a new tab` : undefined}
                        onPointerMove={() => !on && setAt(i)}
                        onClick={(e) => pick(r, IS_MAC ? e.metaKey : e.ctrlKey)}
                        className={cn(
                          "px-play-hover flex min-h-8 cursor-default select-none flex-col justify-center rounded-[10px] px-2 text-[13px] text-foreground transition-colors duration-75",
                          on && "bg-foreground/[0.07]",
                          (r.found || r.why) && "py-1.5",
                          r.why && arriveMotion,
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-2.5">
                          <span
                            className={cn(
                              "grid size-4 shrink-0 place-items-center transition-colors duration-75 [&_svg:not([class*='size-']):not(.px-art)]:size-4",
                              on ? "text-foreground" : "text-muted-foreground",
                            )}
                          >
                            {r.icon}
                          </span>
                          {/* A long title truncates too, after its description. */}
                          <span className="min-w-0 truncate">{r.kind === "new" ? `“${r.label}”` : r.label}</span>
                          {r.description ? (
                            <span className="min-w-0 shrink-[4] truncate text-muted-foreground">
                              <span aria-hidden>— </span>
                              {r.description}
                            </span>
                          ) : null}
                          <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-3 text-[12px] tabular-nums text-muted-foreground">
                            {on ? (
                              <>
                                {verb ? <span className="text-foreground">{verb}</span> : null}
                                <Keycap className="text-foreground">↵</Keycap>
                              </>
                            ) : r.kind === "new" ? (
                              <Keycap>Tab</Keycap>
                            ) : r.meta ? (
                              <span>{r.meta}</span>
                            ) : null}
                          </span>
                        </span>
                        {r.why ? (
                          <span className="line-clamp-2 break-words pl-[26px] text-[12px] leading-[17px] text-foreground/80">{r.why}</span>
                        ) : r.found ? (
                          <span className="pl-[26px]">
                            <Snippet passage={r.found.passage} />
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ))}
              {status ? <p className="px-2 pb-1 pt-2 text-[12px] text-muted-foreground">{status}</p> : null}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
