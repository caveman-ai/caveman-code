// The shell's own state, beside the app's store: which sheets are up over the stack, what a new chat starts on and where,
// the moment card's resting place on the screen that floats it, the shell's notices, and which screen is on top. None
// of it is kept on disk; it is what the chrome is doing right now. It is the same small store as the app's
// (store/core.ts), so a screen reads one slice with `useUi(pick)` and the actions below are plain functions any
// screen, sheet or row can call without a context.
import { setSolidGlass } from "../components/Glass";
import { setSlow } from "./sheetMotion";
import { setFontScale } from "../theme";
import { chatOf } from "../store/select";
import { NEW_CHAT, sessionOf } from "../store/sessions";
import { settingsNow } from "./settings/store";
import { createStore, useSelector } from "../store/core";
import { dispatch, store } from "../store/store";
import { deviceById, deviceByLabel, deviceLabel, type SentImage, THIS_MAC } from "../board/model";
import * as script from "../board/script";
import type { Start } from "../board/script";
import { type Notice, UNDO_MS } from "../components/Toast";
import { isLive } from "../live/seams";
import { type Focused, showChat } from "../nav/ref";
import { openGuide } from "../review/lookup";
import type { AddFrom } from "./pickers/AddProject";
import type { SectionId } from "./settings/sections";
import type { Pick } from "./Sheets";

/**
 * The sheets the shell holds over the stack. Profile (the avatar), Connect (Home's second circle: plugins, apps and MCP
 * servers, Grok's and native way), Details (a chat's title capsule: where it runs, its model, its family) and New
 * Chief are drawn in Overlays.tsx like the rest, all on one frame (Sheet.tsx SheetFrame). Share is Share to Caveman
 * (ShareSheet.tsx): what another app shared, and where it goes.
 */
export type SheetName = "model" | "where" | "settings" | "addProject" | "search" | "profile" | "connect" | "details" | "newChief" | "share";

export interface Where {
  repo: string;
  /** What the pickers call the place, its name: "Julius's MacBook Pro", "Studio", "Cloud". */
  computer: string;
}

export interface UiState {
  /**
   * The sheets up, the first opened first. A sheet opened while another is up is pushed over it on the same frame
 * (Profile's Settings, Where's Add a project), and Back comes back to it (native way, ).
   */
  stack: readonly SheetName[];
  /** The sheet on top, or null: the stack's last, kept for what only asks whether a sheet is up. */
  sheet: SheetName | null;
  /** Settings opens on its list, or on this section. */
  settingsAt?: SectionId;
  /** The model picker sets this chat's next turn, or a Chief's ("chief:<id>"); null sets what a new chat starts on. */
  modelFor: string | null;
  addFrom: AddFrom;
  /** What the Where sheet's search held when it opened Add a project, for that sheet's field. */
  addQuery: string;
  /** A new chat's model, once picked; null is Settings' default (Sheets.tsx useDefaultPick). */
  pick: Pick | null;
  /** Where a new chat runs: the last workspace you started one in, until you pick another. */
  where: Where;
  /** The moment card opened into its sheet. */
  reviewing: boolean;
  notice: Notice | null;
  /**
   * Where the focused screen lets the moment card float: how high it rests, the chat it must not float over (its own),
   * and whether the box is busy (writing or talking), when it makes way. Null where it doesn't float (Home, lists, a
   * Chief's screen, where what's ready shows in place).
   */
  floating: { owner: string; rest: number; except: string | null; busy: boolean } | null;
  /** The screen on top. */
  focused: Focused | null;
  /** The chat the Details sheet is about. */
  detailsFor: string | null;
  /**
   * How many large sheets are up, whoever draws them (Search here, a Chief's): they cover the
   * bar, so the toast takes their head row and the board's news waits.
   */
  covers: number;
  /** Connect opens on its plugins (Profile's and the box's Plugins, /plugins), or on everything. */
  connectAt?: "plugins";
  /** The Where sheet leads with the projects, or with the computers (opened from the computer's chip). */
  whereFocus?: "repo" | "computer";
  /** Bumped to hand the focused screen's box the keyboard (focusBox). */
  boxFocus: number;
  /** A box asked for by its draft's scope, to take the keyboard once its screen is on top (focusBoxOf). */
  boxFor: string | null;
}

/** The workspace of the chat started last, on the computer it ran on: where the next one starts by default. */
function lastWhere(): Where {
  const chats = store.get().board.chats.filter((c) => !c.parent);
  const last = chats.reduce<(typeof chats)[number] | undefined>((a, b) => (!a || b.startedAt > a.startedAt ? b : a), undefined);
  // On a real computer's board no project is made up: with no chat yet, the box asks for one.
  return { repo: last?.repo ?? (isLive() ? "" : "caveman-code"), computer: deviceLabel(deviceById(last?.device ?? THIS_MAC)) };
}

const fresh = () =>
  createStore<UiState, (s: UiState) => UiState>(
    { stack: [], sheet: null, modelFor: null, addFrom: "folder", addQuery: "", pick: null, where: lastWhere(), reviewing: false, notice: null, floating: null, focused: null, detailsFor: null, covers: 0, boxFocus: 0, boxFor: null },
    (s, change) => change(s),
  );
type UiStore = ReturnType<typeof fresh>;
// In development a hot reload of this file, or of one it imports (Toast.tsx), would make a fresh store and put every
// sheet away in the middle of whatever you were doing; it picks up the one it had instead, if that one is still shaped
// like today's.
const kept = __DEV__ ? (globalThis as { __cc?: { ui?: UiStore } }).__cc?.ui : undefined;
export const ui: UiStore = kept && Array.isArray(kept.get().stack) ? kept : fresh();

const set = (patch: Partial<UiState>) => ui.dispatch((s) => ({ ...s, ...patch }));

/** A slice of the shell's state; re-renders only when it changes (pass `shallow` for a fresh object). */
export const useUi = <T>(pick: (s: UiState) => T, equal?: (a: T, b: T) => boolean) => useSelector(ui, pick, equal);

// ---------------------------------------------------------------- sheets

/** The stack as it is after `next`, with the sheet on top beside it. */
const stacked = (next: readonly SheetName[]): { stack: readonly SheetName[]; sheet: SheetName | null } => ({ stack: next, sheet: next[next.length - 1] ?? null });

/**
 * Opens a sheet: over the one up, if one is, or on its own. A sheet already in the stack is gone back to rather than
 * opened twice.
 */
function show(name: SheetName, patch: Partial<UiState> = {}) {
  ui.dispatch((s) => {
    const at = s.stack.indexOf(name);
    return { ...s, ...patch, ...stacked(at >= 0 ? s.stack.slice(0, at + 1) : [...s.stack, name]) };
  });
}

/** Puts every sheet away. */
export const closeSheet = () => set(stacked([]));
/** Back one: the sheet on top goes and the one it was opened from is there again. */
export const popSheet = () => ui.dispatch((s) => ({ ...s, ...stacked(s.stack.slice(0, -1)) }));
/**
 * A sheet is done (a pick made, a project added): back to the sheet it was opened from, or, if it was the first, away
 * altogether.
 */
export const dismissSheet = (name: SheetName) =>
  ui.dispatch((s) => {
    const at = s.stack.indexOf(name);
    return at < 0 ? s : { ...s, ...stacked(s.stack.slice(0, at)) };
  });
/** Whether a sheet is in the stack, up or under another. */
export const inStack = (s: UiState, name: SheetName) => s.stack.includes(name);
/** Settings, on its list or on a section (a Chief's settings, Models). */
export const openSettings = (section?: SectionId) => show("settings", { settingsAt: section });
/**
 * The model picker, for a chat's next turn, for what a Chief starts its chats on ("chief:<id>", Sheets.tsx ModelSheet)
 * or (no id) for what a new chat starts on.
 */
export const openModel = (chat?: string) => show("model", { modelFor: chat ?? null });
/**
 * Where a new chat runs: from the workspace's chip the projects lead, from the computer's chip the computers do. It is
 * a press handler too (`onPress={openWhere}`), so only the word "computer" leads with the computers.
 */
export const openWhere = (focus?: unknown) => show("where", { whereFocus: focus === "computer" ? "computer" : "repo" });
export const openAddProject = (from: AddFrom = "folder", query = "") => show("addProject", { addFrom: from, addQuery: query });
export const openSearch = () => show("search");
/** You: the account, the plan, Automations, Settings (the avatar at Home's top left). */
export const openProfile = () => show("profile");
/** Plugins, apps and MCP servers to connect, with what is connected (Home's second circle, and `+`'s Plugins). */
// It is a press handler too (`onPress={openConnect}`), so only the word "plugins" picks the plugins view.
export const openConnect = (at?: unknown) => show("connect", { connectAt: at === "plugins" ? "plugins" : undefined });
/** A chat's details: its workspace and computer, its model, its parent and subagents (the title capsule). */
export const openDetails = (chat: string) => show("details", { detailsFor: chat });
/** Name a new Chief and pick its character and projects. */
export const openNewChief = () => show("newChief");

/**
 * Back to the box on the focused screen, the keyboard up: a pick made in a sheet opened from its card (a project or a
 * computer in Where) is the answer, so the sheet goes and you carry on writing.
 */
export const focusBox = () => ui.dispatch((s) => ({ ...s, boxFocus: s.boxFocus + 1 }));

/**
 * Share to Caveman: what came, a sheet of its own over whatever was up (its X is a Cancel, never a Back into another
 * sheet).
 */
export const openShare = () => set(stacked(["share"]));

/**
 * The box with this draft scope takes the keyboard, the caret at the end of its words, once its screen is on top,
 * whether it is drawn already or comes with the screen (Share to Caveman lands you in a box this way). A box that
 * never shows (its chat shows an ask instead) lets the ask go after a few seconds rather than take the keyboard later.
 */
export function focusBoxOf(scope: string) {
  set({ boxFor: scope });
  setTimeout(() => ui.dispatch((s) => (s.boxFor === scope ? { ...s, boxFor: null } : s)), 4000);
}
/** The box asked for has the keyboard (Composer.tsx). */
export const tookBoxFocus = () => ui.dispatch((s) => (s.boxFor ? { ...s, boxFor: null } : s));
/**
 * Whether the box with this scope is asked for (focusBoxOf): a screen that docks an ask in its box's place (a Chief's,
 * a chat's) puts the dock away for it, so the box holding what was shared shows and takes the keyboard.
 */
export const useBoxAsked = (scope: string) => useUi((s) => s.boxFor === scope);

/** A large sheet came up (true) or went (false): Sheet.tsx tells the shell, so the toast keeps clear of it. */
export const coverBar = (on: boolean) => ui.dispatch((s) => ({ ...s, covers: Math.max(0, s.covers + (on ? 1 : -1)) }));

// ---------------------------------------------------------------- a new chat

export const setPick = (pick: Pick | null) => set({ pick });
export const setWhere = (where: Where) => set({ where });

/**
 * Starts a chat on `pick` (the new chat's model, as the screen resolved it), where new chats run unless `repo` says
 * otherwise (a workspace's own box), and returns its id; the caller opens it. Starting one in a workspace makes that the
 * last workspace. `images`: the pictures that went with the first words.
 */
export function startChat(text: string, pick: Omit<Start, "repo" | "device">, repo?: string, images?: readonly SentImage[]): string {
  const where = ui.get().where;
  const next = repo ? { ...where, repo } : where;
  if (repo && repo !== where.repo) set({ where: next });
  // It starts on the Permissions its box picked (the workspace's or the new chat's), else Settings' for new chats.
  const access = pick.access ?? sessionOf(repo ? `workspace:${repo}` : NEW_CHAT)?.access ?? settingsNow().default_access;
  return script.start(text, { ...pick, access, repo: next.repo, device: deviceByLabel(next.computer)?.id }, images);
}

// ---------------------------------------------------------------- the moment card

/**
 * Opens a ready chat's review: its pull request's guide, pushed over any screen (review/GuideScreen.tsx). Every way in
 * (the Changes pill, a Chief's Ready card, Review's rows) comes through here, so they all land on the same screen.
 */
export function review(id: string) {
  openGuide(id);
}
export const setReviewing = (reviewing: boolean) => set({ reviewing });

/** The focused screen says where the card may rest; `null` takes it away. Only the owner's own call clears it. */
export function setFloating(owner: string, at: { rest: number; except: string | null; busy: boolean } | null) {
  ui.dispatch((s) => {
    if (!at) return s.floating?.owner === owner ? { ...s, floating: null } : s;
    const was = s.floating;
    if (was && was.owner === owner && was.rest === at.rest && was.except === at.except && was.busy === at.busy) return s;
    return { ...s, floating: { owner, ...at } };
  });
}

export const setFocused = (focused: Focused | null) => set({ focused });

// ---------------------------------------------------------------- archive, with Undo

export const notice = (next: Notice | null) => set({ notice: next });

// The toast holds the way back for a few seconds, then the board lets the chat go. A second archive lets the first go
// at once.
let pending: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;

function letGo() {
  const was = pending;
  if (!was) return;
  pending = null;
  clearTimeout(was.timer);
  script.archive(was.id);
  dispatch({ type: "inbox/restore", id: was.id });
}

/**
 * Archives a chat behind Undo. If it was the chat on screen, that screen sees it go and steps back (ThreadScreen);
 * Undo brings you back to it.
 */
export function archive(id: string) {
  const s = store.get();
  const gone = chatOf(s, id);
  if (!gone) return;
  const focused = ui.get().focused;
  const wasOpen = focused?.name === "Thread" && focused.id === id;
  letGo();
  dispatch({ type: "inbox/archive", id });
  pending = { id, timer: setTimeout(letGo, UNDO_MS) };
  notice({
    id: `archive-${id}-${Date.now()}`,
    text: `Archived “${s.inbox.titles[id] ?? gone.title}”`,
    tone: "info",
    icon: "archive",
    action: {
      label: "Undo",
      onPress: () => {
        if (pending?.id === id) {
          clearTimeout(pending.timer);
          pending = null;
        }
        dispatch({ type: "inbox/restore", id });
        // Back where it was: Archive took it off the panel (a root chat left a new chat in its place).
        if (wasOpen) showChat(id);
      },
    },
  });
}

// In development the shell's state sits beside the store's on `globalThis.__cc` (board/useBoard.ts): `__cc.ui.get()`.
// The accessibility stand-ins ride along: `__cc.ui.fontScale(2)` forces the text size (theme.ts) and
// `__cc.ui.solidGlass(true)` draws every glass opaque, as Reduce Transparency and Increase Contrast do (Glass.tsx).
// `__cc.ui.slow(8)` runs every sheet transition eight times slower, so a frame mid-push can be screenshotted
// (sheetMotion.ts); `__cc.ui.slow(1)` is real time again.
if (__DEV__) {
  const g = globalThis as { __cc?: Record<string, unknown> };
  g.__cc = { ...g.__cc, ui: Object.assign(ui, { fontScale: setFontScale, solidGlass: setSolidGlass, slow: setSlow }) };
}
