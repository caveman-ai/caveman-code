import { isSvgAttachment } from "@caveman-app/shared/image";
import type { EngineDescriptor, SecretEntry, Settings, TurnInput } from "@caveman-app/session-protocol";
import { ACCESS, ACCESS_MODES, AccessSetting, pickAccess, type AccessMode } from "@caveman-app/ui/components/access-picker";
import { ChatSettings } from "@caveman-app/ui/components/chat-settings";
import { Keycap } from "@caveman-app/ui/components/menu";
import { pickEffort } from "@caveman-app/ui/components/effort";
import { nextSpeed, pickSpeed, STANDARD_SPEED } from "@caveman-app/ui/components/speed";
import { ModelPicker, parseModelKey, providerName, type ModelRef, type PickerEngine } from "@caveman-app/ui/components/model-picker";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, Add01Icon, Cancel01Icon, Pen01Icon, type IconSvgElement, Image01Icon, Attachment01Icon, Target02Icon, FireIcon, NoteAddIcon, PuzzleIcon, Folder01Icon, File01Icon, FileTextIcon } from "@caveman-app/ui/icons/huge";
import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { formatChord, isComposing, matchesChord } from "../panels/chrome.tsx";
import { useOpenSurface } from "../panels/navigation.tsx";
import { registerDropTarget, useDrag, type DragPayload } from "../panes/drag.ts";
import { planWindows } from "../routes/inbox-model.ts";
import { pinnedRoles } from "../routes/settings/agents-model.ts";
import { compact } from "./pane/cards/PaneCardsView.tsx";
import type { CaptureMode } from "../state/chief-model.ts";
import type { WorkspaceView } from "../state/model.ts";
import { turnMode, type SessionMode } from "../state/grill.ts";
import { chatEngine, engineReady } from "../state/engines.ts";
import { chord, runShortcut, SHORTCUTS } from "../state/keybindings.ts";
import { pickableLogins } from "../state/accounts.ts";
import { loginEngines, sectionOf } from "../state/runner.ts";
import { usePromptSuggestion } from "./promptSuggestion.ts";
import { CLOUD_HOSTED, requestId, sameItems, useRuntimeClient, useRuntimeSelector, type ContextUse } from "../state/runtime.tsx";
import { useEnginesThere } from "./cloud/EngineSignIn.tsx";
import { useUnlinkConfirm } from "./cloud/trust.tsx";
import { reloadEngineCommands, reloadSkills, useEngineCommands, useSkills } from "../state/composer-sources.ts";
import {
  CHIEF_COMMANDS,
  COMMANDS,
  commandById,
  engineCommandsFor,
  INIT_PROMPT,
  leadingCommand,
  leadingSlash,
  noteUse,
  rank,
  recentOrder,
  reviewPrompt,
  skillSource,
  skillsFor,
  slashTrigger,
  tildePath,
  type CommandId,
} from "./composer-complete.ts";
import { ComposerAddMenu, filterAddMenu, type AddItem, type AddRow, type AddSection } from "./ComposerAddMenu.tsx";
import { type PluginSummary } from "../routes/plugins/api.ts";
import { changeDraft, draftFromWire, EMPTY_DRAFT, matchChats, pieces, pillDeletion, refEdit, restoreRefs, serializeDraft, snapCaret, type Draft, type ThreadRef } from "./thread-refs.ts";
import { flushDrafts, keepDraft, keepFiles, keptDraft, keptFiles } from "../state/composer-drafts.ts";
import { fromBase64 } from "../state/media.ts";
import { historyKey, stepPrompt, type PromptEntry, type PromptPosition } from "./prompt-history.ts";
import { SavedSecrets } from "./secrets/ComposerSecrets.tsx";
import { SecretSheet } from "./secrets/SecretSheet.tsx";
import { useSecretCatch } from "./secrets/useSecretCatch.ts";
import { placeQuote, QUOTE_EVENT, quoteBlock, type QuoteDetail } from "./transcript/QuoteSelection.tsx";
import { landsNowhere, typesCharacter } from "./type-to-focus.ts";
import type { AnnotateMedia } from "./annotate/Annotator.tsx";
import { LazyAnnotator } from "./annotate/LazyAnnotator.tsx";
import type { Drawn, Mark } from "./annotate/model.ts";
import { COMPOSE_EVENT, takeFilesIn, type ComposeDetail } from "./compose-event.ts";
import { ownsFocus } from "../panes/focus.ts";
import { appendCodexArtifactTemplateUsePrompt } from "@caveman-app/shared/codexArtifactTemplates";
import { useArtifactTemplateComposerTarget } from "./artifact-template-composer.tsx";
import { VoiceProblem } from "../call/CallStage.tsx";
import { useCall } from "../call/store.ts";
import { MicButton } from "../dictation/MicButton.tsx";
import { ProgressRing } from "./ProgressRing.tsx";
import { SendKey, StopKey } from "./SendKey.tsx";
import { clearDictationError, spaceBefore, startDictation, stopDictation, stopDictationFor, useDictation } from "../dictation/store.ts";


export type SubmitKind = "steer" | "followup" | "queue";

/** Boxes that take focus when they mount: a chat New chat just started opens ready for the next message. */
const focusOnMount = new Set<string>();
export function focusWhenOpened(draftKey: string): void {
  focusOnMount.add(draftKey);
}
/**
 * What "+" typed to open the "@" menu, to take back when that menu closes untouched (Esc, or "+"
 * again): [start, end) of `text`, or null when the menu moved on (a query typed, the "@" gone).
 */
export function plusTyped(text: string, plus: { readonly at: number; readonly lead: string } | null, menu: { readonly kind: string; readonly start: number; readonly query: string } | null): readonly [number, number] | null {
  if (!plus || !menu || menu.kind !== "at" || menu.query !== "") return null;
  const end = plus.at + plus.lead.length;
  return menu.start === end - 1 && text.slice(plus.at, end) === plus.lead ? [plus.at, end] : null;
}

/** True once for a box focusWhenOpened named: the first of its mounts takes focus. */
export const takeFocusRequest = (draftKey: string | undefined): boolean => draftKey !== undefined && focusOnMount.delete(draftKey);

export type Attachment = NonNullable<TurnInput["attachments"]>[number];
/** Session Protocol TurnOptions: what this turn runs on. `account_id`: the login picked for this chat (one of two Claude accounts). */
export type TurnChoice = { engine?: EngineDescriptor["id"]; model?: string; effort?: string; speed?: string; access?: AccessMode; mode?: SessionMode; account_id?: string };
/** A pick in the picker: an undefined `account_id` drops a login picked before (another engine's). */
type Picked = Omit<TurnChoice, "account_id" | "effort" | "speed"> & { account_id?: string | undefined; effort?: string | undefined; speed?: string | undefined };

/** The "@" menu's Plugins rows: installed plugins that are on (their skills are in Skills). */
type Mentionable = ReadonlyArray<PluginSummary>;
/**
 * The open menu: "@" (files, folders, chats, skills, plugins), "/" (commands at the
 * start of the message, skills anywhere), or a command's arguments (/model's
 * models, /permissions' modes). [start, end) is the text a pick replaces.
 */
type MenuState =
  | { readonly kind: "at"; readonly start: number; readonly query: string }
  | { readonly kind: "slash"; readonly start: number; readonly query: string; readonly commands: boolean }
  | { readonly kind: "args"; readonly command: "model" | "permissions"; readonly start: number; readonly end: number; readonly query: string };
const menuEnd = (m: MenuState) => (m.kind === "args" ? m.end : m.start + 1 + m.query.length);
/** `drawn`: a marked-up image's way back (annotate/model.ts), so its chip opens on the marks, still marks, and can put the image back as it was. */
type Attached = { attachment: Attachment; url: string; size: number; drawn?: Drawn };

/** A picked or dropped file as the box holds it; also how another view hands a box a file (keepFiles). */
export async function attachedFile(file: File): Promise<Attached> {
  const image = sentAsImage(file);
  const url = await readDataUrl(file);
  return {
    url,
    size: file.size,
    attachment: {
      type: image ? "image" : "file",
      name: file.name || "Pasted image",
      mime_type: isSvgAttachment({ name: file.name, mimeType: file.type }) ? "image/svg+xml" : file.type || "application/octet-stream",
      data: url.slice(url.indexOf(",") + 1),
    },
  };
}

/**
 * Whether a file goes to the engine as a picture. An SVG is a file the agent reads by its path (no model takes one
 * as an image), so it attaches whatever the engine's image support (T3 #21355); the box still shows it.
 */
const sentAsImage = (file: Pick<File, "name" | "type">) => file.type.startsWith("image/") && !isSvgAttachment({ name: file.name, mimeType: file.type });

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** A box's draft from what composer-drafts.ts keeps for it. */
const asDraft = (kept: ReturnType<typeof keptDraft>): Draft => (kept ? { text: kept.text, refs: restoreRefs(kept.text, kept.refs), gone: [] } : EMPTY_DRAFT);
/**
 * The textarea's text metrics; the pill layer behind it repeats them exactly (no kerning or ligatures, which a textarea
 * may shape differently). 16px on a phone, as every text field there (styles.css), or iOS zooms in on it.
 */
/**
 * The compact box (a review reply's): whether its words sit above the controls, full width, instead of beside them. Past
 * one line they do (a new line, or wrapping: `height` is the field's content height, `line` its line height), and stay
 * there until the box empties.
 */
export function stackWords(was: boolean, text: string, height: number, line: number): boolean {
  if (text === "") return false;
  return was || text.includes("\n") || height > line * 1.5;
}

const FIELD = "px-1 text-[14px] leading-[22px] max-md:text-[16px] max-md:leading-6 [font-kerning:none] [font-variant-ligatures:none]";

/**
 * The "@" being typed at the caret (at the start or after a space): where it
 * starts and what follows, or null. An "@" inside a pill (its own, or one in
 * its title) opens nothing.
 */
export function atTrigger(text: string, caret: number, refs: ReadonlyArray<ThreadRef> = []): { start: number; query: string } | null {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  const start = m ? caret - m[1]!.length - 1 : -1;
  return m && !refs.some((r) => start >= r.start && start < r.end) ? { start, query: m[1]! } : null;
}

/** TurnOptions with only the keys that are set. */
/** One effort step from the keyboard; past either end it wraps to the other. */
export function stepEffort(levels: readonly string[], current: string, step: 1 | -1): string {
  const at = levels.indexOf(current);
  if (levels.length === 0) return current;
  return levels[(((at === -1 ? 0 : at) + step) % levels.length + levels.length) % levels.length]!;
}

/**
 * TurnOptions with what the person picked only (useTurnChoice): otherwise a chat keeps its own model, effort, speed and
 * access, and a new chat takes the runtime's defaults and the engine's active login.
 */
export function turnOptions(model: string | undefined, effort: string | undefined, access: AccessMode | undefined, account?: string, speed?: string): Omit<TurnChoice, "mode"> {
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(speed ? { speed } : {}), ...(access ? { access } : {}), ...(account ? { account_id: account } : {}) };
}

/**
 * The chat picker's engines: one with several logins lists each as a section of its own (`engine#account`, headed
 * by the login's name, as loginEngines does for pins), so a row picks the login too. The Caveman engine's models
 * carry the key they run on. Every section picks the next turn's harness, model and login in this chat.
 */
export function chatPickerEngines(engines: ReadonlyArray<EngineDescriptor>): PickerEngine[] {
  return withModelSources(engines)
    .sort((a, b) => Number(b.id === "caveman") - Number(a.id === "caveman"))
    .flatMap((e): PickerEngine[] => (e.id !== "caveman" && pickableLogins(e.auth.accounts).length > 1 ? loginEngines([e]) : [e]));
}

/**
 * The box's pick once the chat runs `model` at `effort`: a model and effort it already runs are dropped, so the box
 * follows the chat again; any other pick stays (the same object, so nothing re-renders).
 */
export function settledPick(picked: Picked, model: string, effort: string | null): Picked {
  if (picked.model === undefined && picked.effort === undefined) return picked;
  if (picked.model !== undefined && picked.model !== model) return picked;
  if (picked.effort !== undefined && picked.effort !== effort) return picked;
  const { model: _model, effort: _effort, ...rest } = picked;
  return rest;
}

/** Changing harness drops its old model-specific effort, speed and login, but never the person's permissions. */
export function mergeTurnPick(current: Picked, patch: Picked, engineId: string | undefined): Picked {
  return patch.engine !== undefined && patch.engine !== (current.engine ?? engineId)
    ? { ...current, effort: undefined, speed: undefined, account_id: undefined, ...patch }
    : { ...current, ...patch };
}

/** A bare /model or favorite names no login: keep this harness's pick; a harness change clears it in mergeTurnPick. */
export function turnModelPick(engine: EngineDescriptor["id"], model: string, account?: string): Picked {
  return { engine, model, ...(account === undefined ? {} : { account_id: account }) };
}

/** An explicit launch choice for New chat (for example, a link from another surface). */
export type NewChatPick = { engine: EngineDescriptor["id"]; model: string; account_id?: string };

/**
 * The section a chat on `engine` shows as picked: its login (`account`), else the engine's active one. Among this
 * computer's own logins only (pickableLogins): a chat that ran on a connection shows the first of them.
 */
export function chatPickerSection(engines: ReadonlyArray<EngineDescriptor>, engine: EngineDescriptor, account: string | undefined): string {
  const logins = pickableLogins(engine.auth.accounts);
  const id = logins.find((a) => a.id === account)?.id ?? logins.find((a) => a.active)?.id ?? logins[0]?.id;
  return id === undefined ? engine.id : sectionOf(engines, { engine: engine.id, instance_id: id });
}

type SendKeys = Pick<KeyboardEvent, "key" | "altKey" | "metaKey" | "ctrlKey" | "shiftKey">;

/**
 * The Chief's three send keys. Enter: the Chief decides; ⌥Enter: queue only;
 * ⌘Enter: start now. With ⌘Enter to send (Settings > Keyboard) each takes ⌘:
 * ⌘Enter decides, ⌥⌘Enter queues, ⇧⌘Enter starts. Null: not a send (a new line).
 */
export function chiefSendMode(e: SendKeys, sendShortcut: "enter" | "mod_enter" | undefined): CaptureMode | null {
  if (e.key !== "Enter") return null;
  const mod = e.metaKey || e.ctrlKey;
  if (sendShortcut === "mod_enter") {
    if (!mod) return null;
    return e.shiftKey ? (e.altKey ? null : "start") : e.altKey ? "queue" : "decide";
  }
  if (e.shiftKey) return null;
  return mod ? (e.altKey ? null : "start") : e.altKey ? "queue" : "decide";
}

/**
 * What the Chief's box says before you type: one plain line, no keys (few keybinds in
 * view). Queue and start-now keep their keys (chiefSendMode). The home Chief is "the Chief".
 */
export function chiefPlaceholder(captureOnly: boolean, name = "Chief", working = false): string {
  const who = name === "Chief" ? "the Chief" : name;
 // A messenger's box (compact Bots): you guide it while it works.
  return captureOnly ? `Note it for later; ${who} sorts it once it has a key` : working ? `Guide ${who} while it works` : `Message ${who}`;
}

/**
 * One box for every turn. While the engine works, Enter steers it now and
 * ⌥Enter queues a follow-up for after this turn; when idle, Enter sends.
 * The bottom bar (STYLE.md 11): "+" (also "@"), the chat's settings (where a
 * new chat runs, permissions: ⌘⇧A), then the model and effort on the right,
 * and the round send. In the open model picker
 * (⌘⇧M) ⌘1..⌘9 pick a favorite; everywhere else they go to the window's tabs.
 *
 * Another thread is referenced with "@" (the Chats rows) or by dropping its
 * sidebar row here. The textarea stays a textarea: a reference reads "@Title"
 * in it, and a layer behind it, laid out with the same metrics, paints the
 * pill while the textarea's own text goes transparent. Edits go through the
 * browser's editing (execCommand), so caret, IME, undo and paste stay native.
 *
 * "/" opens the commands and skills (composer-complete.ts). A command runs
 * here and is never sent; one typed whole ("/rename Auth fix", Enter) runs
 * too, and a "/word" no command owns goes to the engine as typed (Claude
 * Agent's own commands). A picked skill is a pill sent as `$name`.
 */
const NO_CHATS: ReadonlyArray<WorkspaceView> = [];

// Memo: the chat's pane re-renders on every streamed token (its view), and hands the box the same props each time;
// the box and its menus need not render with it (upstream #28564).
export const Composer = memo(function Composer({
  running,
  agentsWorking = false,
  workspaceId,
  repo,
  engineId,
  engineLabel,
  captureTo,
  canSteer: sessionCanSteer,
  onSubmit,
  onInterrupt,
  placeholder,
  projectId,
  context,
  tokens,
  onGoal,
  onRecordSkill,
  queue,
  strip,
  chatSettings,
  foot,
  glass = false,
  switchEngine,
  agentPicker,
  byTask,
  initialPick,
  onChoice,
  onTyping,
  mode,
  access: sessionAccess,
  turn: latestTurn,
  accountId,
  onCapture,
  onAttachChat,
  onClear,
  captureAccessory,
  captureCall,
  captureSettings,
  compact = false,
  initialDraft,
  onFork,
  lastAnswer,
  history,
  onUndo,
  onExport,
  draftKey,
}: {
  running: boolean;
  /** Agents this chat started are still at work: Stop shows (and stops them) even after the chat's own turn ended. */
  agentsWorking?: boolean;
  /** The workspace whose files and folders "@" finds (fs.search). */
  workspaceId?: string;
  /** The repository pasted secrets are stored for when there is no workspace yet (a new chat's project). */
  repo?: { readonly path: string } | { readonly url: string } | null;
  /** The session's current engine; the picker can choose another for the next turn. */
  engineId?: string;
  /** Finds the engine when engineId is not passed. */
  engineLabel: string;
  /** Who a captured note goes to (a Chief's name), for Send's label; "the Chief" when absent. */
  captureTo?: string;
  /** Kept for existing callers; the model picker shows the engine and model now. */
  engineIsCaveman?: boolean;
  modelLabel?: string | null;
  canSteer: boolean;
  onSubmit: (text: string, kind: SubmitKind, options: TurnChoice, attachments: Attachment[]) => Promise<void>;
  onInterrupt: () => Promise<void>;
  placeholder?: string;
  /** The project the Chats rows put first; defaults to the workspace's own. */
  projectId?: string | null;
  /** The session's latest context.updated: a status ring in the bar. */
  context?: ContextUse | null;
  /** Tokens the session used so far (its tooltip says them; never a price inside a session). */
  tokens?: number | undefined;
  /** The Goal row: what is typed next becomes the session goal (goal.set). Absent: the row is unavailable. */
  onGoal?: (objective: string) => Promise<void>;
  /** The Record a skill row. Absent: the row is unavailable. */
  onRecordSkill?: () => void;
  /** Queued follow-ups (AI Elements Queue), in the tray on the box's top edge above `strip`. */
  queue?: ReactNode;
  /** A strip on the box's top edge: the agents a chat waits on. */
  strip?: ReactNode;
  /** Rows of the chat's settings above Permissions (chat-settings.tsx SettingRows): where a new chat runs. */
  chatSettings?: ReactNode;
  /**
   * The foot, under the box (composer-foot.tsx): where the chat is, or where a new one starts. With it the context
   * ring sits at its end, as Codex's does; without it (the Chief's box) the ring stays among the box's controls.
   */
  foot?: ReactNode;
  /** The box is glass (STYLE.md 5): it floats over a wallpaper, as a new chat's does (wallpaper/Wallpaper.tsx). */
  glass?: boolean;
  /** A new chat: the picker offers these engines and updates its launch choice. An open chat switches in place. */
  switchEngine?: { engines: ReadonlyArray<EngineDescriptor>; onChange: (engineId: string) => void };
  /**
   * A new chat in Cloud from a browser window: what sits where the model picker does. The window has no computer of
   * its own to list models from, so its picker lists what Cloud does (routes/cloud-models.ts).
   */
  agentPicker?: ReactNode;
  /**
   * A new chat on this computer, with a task kind pinned (Settings > Subagents): the picker's first row starts the chat
   * on its first message's kind (Settings.new_chat_by_task); picking a model turns it off.
   */
  byTask?: { readonly on: boolean; readonly set: (on: boolean) => void } | undefined;
  /** An explicit model and login to start a new chat on. */
  initialPick?: NewChatPick | undefined;
  /** A new chat: the options a send would carry, now and as they change (New chat starts the engine on them). */
  onChoice?: (choice: TurnChoice) => void;
  /** A new chat: the box went from empty to typed in (New chat gets a Cloud computer ready then). */
  onTyping?: () => void;
  /** The session's mode: grill mode starts on when the session is in it. */
  mode?: SessionMode | undefined;
  /** The session's permissions (Session.access); absent for a new chat. */
  access?: AccessMode | undefined;
  /** The model, effort and speed its latest turn started on (turn.started): an open chat's box starts from them. Absent for a new chat. */
  turn?: { readonly model: string; readonly effort: string | null; readonly speed?: string | undefined } | null | undefined;
  /** The login its latest turn ran on (turn.started account_id); absent, the engine's active one. */
  accountId?: string | undefined;
  /**
   * The Chief's box: every send is a capture (chief.capture) in the mode its key names (chiefSendMode),
   * and the box has no model, access or modes of its own; it takes images (pasted, dropped or picked), never files.
   * Chat references still work (`+` opens them).
   */
  onCapture?: (text: string, mode: CaptureMode, attachments: Attachment[]) => Promise<void>;
  /** With onCapture: a chat dragged from the sidebar onto the box joins this Chief's board instead of being referenced. */
  onAttachChat?: { readonly label: string; readonly attach: (chat: DragPayload) => void };
  /** With onCapture: /clear, the box's one command (the Chief's page starts a fresh section). A string keeps it local but unavailable; absent: "/" is plain text. */
  onClear?: (() => void) | string;
  /** With onCapture: what sits where a chat's model picker does (the Chief's own picker). */
  captureAccessory?: ReactNode;
  /** With onCapture: beside Send, the Chief's Call button. */
  captureCall?: ReactNode;
  /** With onCapture: after `+`, where a chat's settings sit (the Chief's own). */
  captureSettings?: ReactNode;
  /** One line with its controls beside it, growing as you type (a review reply's box). */
  compact?: boolean;
  /** Typed in already (Try in chat): the text after a mention of the plugin. */
  initialDraft?: { readonly plugin?: { readonly id: string; readonly label: string } | undefined; readonly text: string } | undefined;
  /** /fork: carry on in a copy of this chat. Absent: no fork here. */
  onFork?: () => Promise<void>;
  /** /copy: the latest answer's text. */
  lastAnswer?: () => string | undefined;
  /** ↑ in an empty box: what was sent before in this chat (prompt-history.ts), oldest first. Absent: arrows only move the caret. */
  history?: () => ReadonlyArray<PromptEntry>;
  /** /undo: take back the last turn (a confirmation first), or why it can't now. */
  onUndo?: (() => void) | string;
  /** /export: save the chat as Markdown. */
  onExport?: () => void;
  /** Which box this is ("chat:<id>", "new-chat", "chief"): what is typed in it is kept for it (composer-drafts.ts). */
  draftKey?: string;
}) {
  const { client } = useRuntimeClient();
  // The chat's own computer's engines (a Cloud chat in a window on This Mac asks that computer): its models, not This Mac's.
  const engines = useEnginesThere();
  const settings = useRuntimeSelector((v) => v.settings);
  const projects = useRuntimeSelector((v) => v.projects);
  // Its own chat's view, not the list: a push about another chat re-renders no box.
  const ownChat = useRuntimeSelector((v) => (workspaceId === undefined ? undefined : v.workspaces.find((w) => w.id === workspaceId)));
  const navigate = useNavigate();
  const openSurface = useOpenSurface();
  // A pasted .env or key never becomes message text: it is stored for the repository, and the message names it.
  const secrets = useSecretCatch(repo ?? ownChat?.repoRef ?? null);
  const sessionEngine = engines.find((e) => e.id === engineId) ?? engines.find((e) => e.label === engineLabel || e.id === engineLabel);

  const [draft, setDraftState] = useState<Draft>(() => {
    // What was typed here before (another chat, Settings, a reload in between) comes back.
    if (!initialDraft) return asDraft(draftKey ? keptDraft(draftKey) : null);
    // Search's New chat brings only what was typed; Try in chat leads with a mention of its plugin.
    if (!initialDraft.plugin) return { text: initialDraft.text, refs: [], gone: [] };
    const e = refEdit("", 0, 0, { workspace_id: "", title: initialDraft.plugin.label, plugin: initialDraft.plugin.id });
    return { text: e.insert + initialDraft.text, refs: [e.ref], gone: [] };
  });
  const { text, refs } = draft;
  // The latest draft between renders: two edits can land before React re-renders.
  const draftNow = useRef(draft);
  const setDraft = (d: Draft) => {
    draftNow.current = d;
    setDraftState(d);
    if (draftKey) keepDraft(draftKey, d);
  };
  /** Where ↑/↓ stand in the history: the entry the box shows, while it still shows it. */
  const recall = useRef<PromptPosition | null>(null);
  useEffect(() => {
    if (takeFocusRequest(draftKey)) ref.current?.focus();
  }, [draftKey]);
  /** The reference the next change types: set around execCommand, taken in onChange. */
  const typing = useRef<ThreadRef | undefined>(undefined);
  /** The selection before this one, and whether a pointer made it: where a caret snaps out of a pill. */
  const sel = useRef({ start: 0, end: 0, pointer: false });
  const mirror = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<Attached[]>(() => (draftKey ? keptFiles<Attached>(draftKey) : []));
  useEffect(() => {
    if (draftKey) keepFiles(draftKey, files);
  }, [draftKey, files]);
  // Leaving the box writes what it holds at once. A box kept rendered while hidden (PaneFrame keeps the chats a pane
  // showed lately) takes the chat's draft as it is now when it shows again, if another box for the chat (its own tab,
  // another pane) typed in it or sent it meanwhile.
  const left = useRef<{ readonly text: string; readonly files: ReadonlyArray<Attached> } | null>(null);
  useLayoutEffect(() => {
    if (!draftKey) return;
    const was = left.current;
    if (was) {
      const kept = keptDraft(draftKey);
      if ((kept?.text ?? "") !== was.text) {
        draftNow.current = asDraft(kept);
        setDraftState(draftNow.current);
      }
      const keptNow = keptFiles<Attached>(draftKey);
      if (!sameItems(keptNow, was.files)) setFiles(keptNow);
    }
    return () => {
      flushDrafts(draftKey);
      left.current = { text: keptDraft(draftKey)?.text ?? "", files: keptFiles<Attached>(draftKey) };
    };
  }, [draftKey]);
  const [note, setNote] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Talking to type (dictation/store.ts): one box at a time holds the mic; this one is named by its draft key.
  const voiceId = useId();
  const dictationOwner = draftKey ?? voiceId;
  const dictation = useDictation(dictationOwner);
  const listening = dictation.phase !== "idle";
  const onCall = useCall().phase !== "idle";
  const filePicker = useRef<HTMLInputElement>(null);
  const imagePicker = useRef<HTMLInputElement>(null);

  const { engine, model, effort, speed, start, saveStart, access, pickedAccess, pickedAccount, choose, favorites, setFavorites, home, options: picks } = useTurnChoice(sessionEngine?.id, {
    access: sessionAccess,
    model: latestTurn?.model,
    effort: latestTurn?.effort,
    speed: latestTurn?.speed,
    // An open chat's own project: what it shows before its first turn is that project's default, as it started.
    projectId: projectId ?? ownChat?.projectId,
    ...(initialPick ? { picked: { engine: initialPick.engine, model: initialPick.model, account_id: initialPick.account_id } } : {}),
  });
  // A different harness/model/login cannot receive a steer into the running provider turn.
  const canSteer = sessionCanSteer && engine?.id === sessionEngine?.id
    && (!latestTurn || model?.id === latestTurn.model)
    && (pickedAccount === undefined || pickedAccount === accountId);
  const pickModel = (section: string, model: string) => {
    const [id, account] = section.split("#") as [string, string | undefined];
    const target = engines.find((e) => e.id === id);
    if (!target) return;
    choose(turnModelPick(target.id, model, account));
    if (id !== engine?.id) switchEngine?.onChange(id);
  };
  // Grill mode holds until turned off (the session keeps it too); Goal applies to what is typed next.
  const [grill, setGrill] = useState(mode === "grill");
  useEffect(() => setGrill(mode === "grill"), [mode]);
  const [goalMode, setGoalMode] = useState(false);
  const grills = engine?.capabilities.grill_mode === true;
  const choiceNow: TurnChoice = { ...picks, ...turnMode(grills, mode, grill) };
  const choiceKey = JSON.stringify(choiceNow);
  useEffect(() => onChoice?.(JSON.parse(choiceKey) as TurnChoice), [choiceKey, onChoice]);
  const hasText = text.trim() !== "";
  useEffect(() => {
    if (hasText) onTyping?.();
  }, [hasText, onTyping]);
  // In grill mode on an engine that can't grill (after a handoff): the chip still shows, so the user can leave.
  const showGrill = grill && (grills || mode === "grill");

  // The "+" / "@" menu, the "/" menu and a command's arguments: one listbox the textarea drives.
  const menuId = useId();
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Every chat, for "@": read only while that menu is open.
  const chats = useRuntimeSelector((v) => (menu?.kind === "at" ? v.workspaces : NO_CHATS));
  const [menuActive, setMenuActive] = useState(0);
  /** The menu Esc closed ("slash:0"): it stays shut until its trigger goes. */
  const dismissed = useRef<string | null>(null);
  // Held for every composer and read before the first "/", so the menu opens full on the first keystroke.
  const allSkills = useSkills(client);
  // The chat's engine's own commands, read for its checkout when the chat opens.
  const chatId = workspaceId !== undefined && !onCapture ? workspaceId : undefined;
  const ownCommands = useEngineCommands(client, chatId);
  // Signing out from /logout asks first, as Settings > Account does.
  const unlink = useUnlinkConfirm((wipe) =>
    client
      ? client.call("cloud.signout", { request_id: requestId(), delete_cloud_copies: wipe }).then(() => setFlash("Signed out of Caveman"), (e: unknown) => setNote(e instanceof Error ? e.message : String(e)))
      : Promise.resolve(),
  );
  /**
   * The open picker: the model's, or the chat's settings ("access": with Permissions open beside them, as /permissions
   * and its chord open it). Focus comes back to the box when it closes.
   */
  const [picker, setPicker] = useState<"model" | "settings" | "access" | null>(null);
  const closePicker = (open: boolean, which: "model") => {
    setPicker(open ? which : null);
    if (!open && picker === which) requestAnimationFrame(() => ref.current?.focus());
  };
  // Permissions opens a frame after the settings: opened together, the menu taking focus would close it again.
  const openAccess = () => {
    setPicker("settings");
    requestAnimationFrame(() => setPicker((p) => (p === "settings" ? "access" : p)));
  };
  /** A quiet confirmation in the bar ("Copied the last answer"). */
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(t);
  }, [flash]);
  const [plugins, setPlugins] = useState<Mentionable | null>(null);
  const loadPlugins = () => {
    if (plugins || !client) return;
    setPlugins([]);
    // This chat's project's path: its project installs and its repository's plugins are mentionable too.
    const cwd = projects.find((p) => p.id === here)?.path;
    client.call("plugin.list", cwd ? { cwd } : {}).then(
      (p) => setPlugins(p.plugins.filter((x) => x.installed && x.enabled)),
      () => setPlugins([]),
    );
  };
  const unavailable = "Not in this runtime";
  // The Chief's box offers images only: it passes them on to the chats it starts; files are a chat's.
  const addItems: AddItem[] = onCapture ? [{ id: "images", icon: Image01Icon, label: "Images", description: "Screenshots and pictures, or paste one" }] : [
    { id: "files", icon: Attachment01Icon, label: "Files", description: "Attach files from your computer" },
    ...(engine?.capabilities.images ? [{ id: "images", icon: Image01Icon, label: "Images", description: "Screenshots and pictures, or paste one" } as const] : []),
    { id: "goal", icon: Target02Icon, label: "Goal", description: "Set a goal to keep pursuing", ...(onGoal ? {} : { unavailable }) },
    {
      id: "grill",
      icon: FireIcon,
      label: showGrill ? "Leave grill mode" : "Grill mode",
      description: showGrill ? "Build again from the next turn" : "Answer its questions first, then build",
      ...(grills || showGrill ? {} : { unavailable: `${engine?.label ?? "This engine"} has no grill mode` }),
    },
    { id: "skill", icon: NoteAddIcon, label: "Record a skill", description: "Save this session as a skill", ...(onRecordSkill ? {} : { unavailable }) },
  ];
  const pluginSection: AddSection = {
    title: "Plugins",
    items: onCapture
      ? []
      : (plugins ?? []).map((p): AddItem => {
          const i = p.interface;
          return { id: `plugin:${p.id}`, icon: PuzzleIcon, label: i.display_name ?? p.name, plugin: p, ...(i.short_description ? { description: i.short_description } : {}) };
        }),
  };
  // Typed after "@": the workspace's files and folders, fuzzy-matched by the runtime, above the menu's own rows.
  const [found, setFound] = useState<readonly string[]>([]);
  const query = menu?.kind === "at" ? menu.query : "";
  useEffect(() => {
    if (!client || !workspaceId || !query) return setFound([]);
    // The runtime keeps the checkout's file list for a moment, so a search is cheap; the wait only spares a burst of
    // keys. An answer for a query typed past never replaces the newer one's.
    let current = true;
    const t = setTimeout(() => {
      client.call("fs.search", { workspace_id: workspaceId, query, limit: 6, include_directories: true }).then(
        (r) => current && setFound(r.paths),
        () => current && setFound([]),
      );
    }, 30);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [client, workspaceId, query]);
  const fileRows = found.map((path): AddRow => {
    const directory = path.endsWith("/");
    const name = directory ? path.slice(0, -1) : path;
    const cut = name.lastIndexOf("/");
    return {
      section: "In this workspace",
      item: { id: `file:${path}`, icon: directory ? Folder01Icon : File01Icon, label: `${name.slice(cut + 1)}${directory ? "/" : ""}`, mono: true, ...(cut > 0 ? { description: name.slice(0, cut) } : {}) },
    };
  });
  // Other threads to reference: this project's first (docs/agent-messaging.md, "Composer").
  const here = projectId ?? ownChat?.projectId ?? null;
  // A goal takes plain words (goal.set reads no thread links): no Chats rows in goal mode; a pill already there goes as "@Title".
  const chatRows = menu?.kind === "at" && !goalMode
    ? matchChats(chats, query, workspaceId, here).map(
        (w): AddRow => ({ section: "Chats", item: { id: `chat:${w.id}`, engine: w.engine.id, label: w.title, description: w.repo } }),
      )
    : [];
  // A bare "@" (or "+") leads with Add, then plugins; a typed name leads with what it names: files, plugins, chats.
  const addRows = filterAddMenu([{ title: "Add", items: addItems }], query);
  const pluginRows = filterAddMenu([pluginSection], query);

  // Skills this chat's engine runs, as "/name" rows: in "/" (after the commands, or first when they match better) and in "@".
  const skills = skillsFor(allSkills, engine?.id, here);
  const scored = (score: number, row: AddRow) => ({ score, row });
  const skillRows = (q: string) =>
    rank(skills, q, (k) => [k.token, k.name], (k) => `skill:${k.token}`, (k) => k.description).map((r) =>
      scored(r.score, {
        section: "Skills",
        item: {
          id: `skill:${r.item.token}`,
          icon: FileTextIcon,
          label: `/${r.item.token}`,
          hits: r.name === r.item.token ? r.hits.map((i) => i + 1) : [],
          ...(r.item.description ? { description: r.item.description } : {}),
          meta: skillSource(r.item),
          detail: tildePath(r.item.path),
        },
      }),
    );
  // In "@" once a name is typed (a bare "@" stays short); a goal takes plain words, so none in goal mode.
  const atSkillRows = menu?.kind === "at" && query && !goalMode ? skillRows(query).slice(0, 8).map((x) => x.row) : [];

  // What each command does here. No entry: not offered (a new chat has no /fork); a string: shown greyed, saying why.
  const inChat = workspaceId !== undefined && !onCapture;
  const engineName = engine?.label ?? "This engine";
  const go = (to: string) => () => navigate(to);
  const newChatPath = here ? `/new?project=${encodeURIComponent(here)}` : "/new";
  const surface = (kind: "diff" | "overview" | "agents" | "terminal" | "browser") => (inChat ? () => void openSurface(workspaceId!, kind, {}) : undefined);
  const failed = (e: unknown) => setNote(e instanceof Error ? e.message : String(e));
  // The Chief's box: its own few commands, or none; a chat's are a chat's.
  const commands = onCapture ? (onClear ? CHIEF_COMMANDS : []) : COMMANDS;
  const runs: Partial<Record<CommandId, ((args: string) => void) | string | undefined>> = onCapture
    ? { clear: typeof onClear === "function" ? () => onClear() : onClear }
    : {
        model: engine ? (a) => (a ? pickBest("model", a) : setPicker("model")) : undefined,
        permissions: engine && access ? (a) => (a ? pickBest("permissions", a) : openAccess()) : undefined,
        review: (a) => void submitText(reviewPrompt(a)),
        new: inChat ? () => navigate(newChatPath) : undefined,
        compact: inChat ? (engine?.capabilities.compact ? () => void submitText("/compact") : `${engineName} can't compact`) : undefined,
        init: () => void submitText(INIT_PROMPT),
        diff: surface("diff"),
        status: surface("overview"),
        goal: onGoal ? (a) => (a ? void onGoal(a).then(() => setFlash("Goal set"), failed) : setGoalMode(true)) : undefined,
        grill: grills || showGrill ? () => setGrill((g) => !g) : `${engineName} has no grill mode`,
        fork: onFork ? (engine?.capabilities.fork ? () => void onFork().catch(failed) : `${engineName} can't fork`) : undefined,
        undo: typeof onUndo === "function" ? () => onUndo() : onUndo,
        export: onExport ? () => onExport() : undefined,
        rename:
          inChat && client
            ? (a) => void client.call("workspace.rename", { request_id: requestId(), workspace_id: workspaceId!, title: a }).then(() => setFlash(`Renamed to ${a}`), failed)
            : undefined,
        resume: () => runShortcut("app.search"),
        mention: () => openPlus(),
        attach: () => filePicker.current?.click(),
        image: engine?.capabilities.images ? () => imagePicker.current?.click() : `${engineName} takes no images`,
        copy: lastAnswer ? () => copyLast() : undefined,
        agents: surface("agents"),
        terminal: surface("terminal"),
        browser: surface("browser"),
        skills: go("/customize/skills"),
        "record-skill": onRecordSkill ? () => onRecordSkill() : undefined,
        plugins: go("/customize/plugins"),
        mcp: go("/customize/mcp"),
        memory: go("/settings/memory"),
        automations: go("/automations"),
        archive: inChat && client ? () => void client.call("workspace.archive", { request_id: requestId(), workspace_id: workspaceId! }).then(() => setFlash("Archived"), failed) : undefined,
        models: go("/settings/models"),
        usage: go("/settings/usage"),
        theme: go("/settings/appearance"),
        keymap: go("/settings/keyboard"),
        settings: go("/settings/general"),
        // A browser on Caveman Cloud is not this computer: it signs nothing out.
        logout:
          client && !CLOUD_HOSTED
            ? () =>
                void client.call("cloud.status", {}).then(
                  (status) => (status.account ? unlink.open() : setFlash("This computer isn't signed in to Caveman")),
                  failed,
                )
            : undefined,
      };
  const commandRows = (q: string) =>
    rank(commands.filter((c) => runs[c.id] !== undefined), q, (c) => c.names, (c) => `cmd:${c.id}`, (c) => c.description).map((r) => {
      const how = runs[r.item.id];
      const others = r.item.names.filter((n) => n !== r.name);
      return scored(r.score, {
          section: "Commands",
          item: {
            id: `cmd:${r.item.id}`,
            icon: r.item.icon,
            label: `/${r.name}`,
            hits: r.hits.map((i) => i + 1),
            description: r.item.description,
            // An argument it cannot run without shows in the row; optional ones show in the box once it is picked.
            ...(r.item.args?.required ? { hint: r.item.args.hint } : {}),
            ...(typeof how === "string" ? { unavailable: how } : {}),
            ...(others.length ? { detail: `also ${others.map((n) => `/${n}`).join("  ")}` } : {}),
          },
        });
    });
  // The engine's own commands, under its name: sent as typed, so the engine runs them.
  const engineCommands = engineCommandsFor(ownCommands, new Set(skills.map((k) => k.token)));
  const engineRows = (q: string) =>
    rank(engineCommands, q, (c) => [c.name], (c) => `engine:${c.name}`, (c) => c.description).map((r) =>
      scored(r.score, {
        section: engineName,
        item: {
          id: `engine:${r.item.name}`,
          engine: engine?.id ?? "",
          label: `/${r.item.name}`,
          hits: r.hits.map((i) => i + 1),
          ...(r.item.description ? { description: r.item.description } : {}),
          ...(r.item.hint ? { hint: r.item.hint } : {}),
          meta: engineName,
          detail: `${engineName} runs it`,
        },
      }),
    );
  const slashRows = (m: Extract<MenuState, { kind: "slash" }>): AddRow[] => {
    // The Chief's box offers its commands alone: a note runs no skill and no engine's command.
    const groups = onCapture ? [commandRows(m.query)] : [m.commands ? commandRows(m.query) : [], m.commands ? engineRows(m.query) : [], skillRows(m.query)];
    if (m.query === "" && m.commands) {
      // A bare "/": what you picked lately on top, then ours in order, the engine's, then the skills.
      const all = groups.flat().filter((x) => !x.row.item.unavailable);
      const recent = recentOrder().flatMap((k) => all.filter((x) => x.row.item.id === k)).slice(0, 4);
      const lately = new Set(recent.map((x) => x.row.item.id));
      return [...recent.map((x) => ({ ...x.row, section: "Recent" })), ...groups.flat().filter((x) => !lately.has(x.row.item.id)).map((x) => x.row)];
    }
    // Typed: one list, best first across all of them (each row's tag says where it comes from), so the first row is the best one.
    return groups
      .flat()
      .map((x, at) => ({ ...x, at }))
      .sort((a, b) => b.score - a.score || a.at - b.at)
      .map((x) => ({ ...x.row, section: "" }));
  };
  // /model and /permissions take their pick as an argument: "/model op" lists the models that match.
  // Every ready harness can take the next turn without leaving the chat. Caveman stays visible before setup.
  const candidates = switchEngine?.engines ?? engines.filter((e) => e.id === engine?.id || (inChat && engineReady(e)));
  const offered = [...candidates, ...engines.filter((e) => e.id === "caveman" && !candidates.some((c) => c.id === e.id))]
    .map((e) => e.id === "caveman" && !engineReady(e) ? { ...e, models: [] } : e);
  const modelChoices = offered
    .flatMap((e) => e.models.map((m) => ({ engine: e, model: m })))
    // The chat's own engine first: "/model opus" sent whole stays in this chat when it can.
    .sort((a, b) => Number(a.engine.id !== engine?.id) - Number(b.engine.id !== engine?.id) || Number(a.model.legacy === true) - Number(b.model.legacy === true));
  const argRows = (m: Extract<MenuState, { kind: "args" }>): AddRow[] =>
    m.command === "model"
      ? rank(modelChoices, m.query, (c) => [c.model.label, c.model.id], (c) => `model:${c.engine.id}|${c.model.id}`, (c) => c.engine.label).map((r) => ({
          section: "Models",
          item: {
            id: `model:${r.item.engine.id}|${r.item.model.id}`,
            engine: r.item.engine.id,
            label: r.item.model.label,
            hits: r.name === r.item.model.label ? r.hits : [],
            description: r.item.engine.label,
            ...(r.item.engine.id === engine?.id && r.item.model.id === model?.id ? { meta: "Current" } : {}),
            detail: r.item.model.id,
          },
        }))
      : rank(engine?.access_modes?.length ? engine.access_modes : ACCESS_MODES, m.query, (a) => [ACCESS[a].label, a], (a) => `access:${a}`).map((r) => ({
          section: "Permissions",
          item: {
            id: `access:${r.item}`,
            icon: ACCESS[r.item].icon,
            label: ACCESS[r.item].label,
            hits: r.name === ACCESS[r.item].label ? r.hits : [],
            description: ACCESS[r.item].line,
            ...(r.item === access ? { meta: "Current" } : {}),
          },
        }));
  const menuRows: AddRow[] = !menu
    ? []
    : menu.kind === "slash"
      ? slashRows(menu)
      : menu.kind === "args"
        ? argRows(menu)
        : query
          ? [...fileRows, ...pluginRows, ...atSkillRows, ...chatRows, ...addRows]
          : [...addRows, ...pluginRows, ...chatRows];
  // A "/" later in the text (a path, "and/or") opens only when a skill answers it.
  // In the Chief's box a "/" no command answers is just text.
  const menuOpen = menu !== null && !(menu.kind === "slash" && (!menu.commands || onCapture) && menuRows.length === 0);
  // Rows the runtime cannot do show but are never the highlight; -1 when nothing can be picked.
  const pickable = (i: number) => menuRows[i] !== undefined && !menuRows[i]!.item.unavailable;
  const menuIndex = pickable(menuActive) ? menuActive : menuRows.findIndex((r) => !r.item.unavailable);
  const stepMenu = (dir: 1 | -1) => {
    for (let n = 1, len = menuRows.length; n <= len; n++) {
      const i = (menuIndex + dir * n + len * n) % len;
      if (pickable(i)) return setMenuActive(i);
    }
  };

  /** The menu the text calls for at the caret: "@", "/", or a command's argument. */
  const triggerAt = (value: string, caret: number, refs: ReadonlyArray<ThreadRef>): MenuState | null => {
    const at = atTrigger(value, caret, refs);
    if (at) return { kind: "at", ...at };
    const slash = slashTrigger(value, caret, refs);
    if (onCapture) return slash?.commands && commands.length > 0 ? { kind: "slash", ...slash } : null;
    if (slash) return { kind: "slash", ...slash };
    const lead = leadingCommand(value, refs);
    const id = lead?.command.id;
    if (lead && (id === "model" || id === "permissions") && typeof runs[id] === "function" && caret === value.length && value.length > lead.end) {
      return { kind: "args", command: id, start: lead.start, end: caret, query: lead.args };
    }
    return null;
  };
  const syncMenu = (value: string, caret: number, refs: ReadonlyArray<ThreadRef>) => {
    const next = triggerAt(value, caret, refs);
    if (!next || `${next.kind}:${next.start}` === dismissed.current) {
      if (!next) dismissed.current = null;
      setMenu(null);
      return;
    }
    if (next.query !== menu?.query || next.start !== menu?.start || next.kind !== menu?.kind) setMenuActive(0);
    // Opening: read the skills again behind the menu (at most every few seconds); the rows already show.
    if (!menu && client) {
      reloadSkills(client);
      if (chatId) reloadEngineCommands(client, chatId);
    }
    setMenu(next);
    if (next.kind === "at") loadPlugins();
  };
  const placeCaret = (pos: number) =>
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
    });

  /** Every change to the text: references follow it, the menu opens or closes. `restoring`: an undo or redo. */
  const onText = (value: string, caret: number, restoring = false) => {
    const added = typing.current;
    typing.current = undefined;
    const next = changeDraft(draftNow.current, value, caret, added, restoring);
    setDraft(next);
    sel.current = { start: caret, end: caret, pointer: false };
    syncMenu(value, caret, next.refs);
    // A line or word delete that cut into a pill: the rest of it goes too, before the next paint.
    if (next.cut) {
      const [start, end] = next.cut;
      queueMicrotask(() => edit(start, end, ""));
    }
  };

  /** Replace [start, end) through the browser's own editing, so ⌘Z undoes it; `added` is the reference it types. */
  const edit = (start: number, end: number, insert: string, added?: ThreadRef) => {
    const ta = ref.current;
    if (!ta || (start === end && !insert)) return;
    ta.focus();
    ta.setSelectionRange(start, end);
    typing.current = added;
    // execCommand fires onChange right here; where it cannot, the same change is applied by hand.
    const native = document.execCommand(insert ? "insertText" : "delete", false, insert);
    typing.current = undefined;
    if (native) return;
    typing.current = added;
    onText(ta.value.slice(0, start) + insert + ta.value.slice(end), start + insert.length);
    placeCaret(start + insert.length);
  };

  // A result card appends to the real draft through the same native edit path as typing/paste.
  // Read the DOM now: rapid repeat clicks must dedupe before React's next render too.
  useArtifactTemplateComposerTarget((template) => {
    const ta = ref.current;
    if (!ta) return;
    const current = ta.value;
    const next = appendCodexArtifactTemplateUsePrompt(current, template);
    if (next !== current) {
      recall.current = null;
      edit(current.length, current.length, next.slice(current.length));
    }
    placeCaret(next.length);
  });

  const insertRef = (start: number, end: number, chat: { workspace_id: string; title: string; plugin?: string; skill?: string }) => {
    const e = refEdit(ref.current?.value ?? text, start, end, chat);
    edit(start, end, e.insert, e.ref);
  };

  /** Selection moves: a caret or selection edge never rests inside a pill. */
  const onSelect = (ta: HTMLTextAreaElement) => {
    const prev = sel.current;
    const { refs } = draftNow.current;
    const start = snapCaret(refs, ta.selectionStart, prev.pointer ? null : prev.start);
    const end = snapCaret(refs, ta.selectionEnd, prev.pointer ? null : prev.end);
    if (start !== ta.selectionStart || end !== ta.selectionEnd) ta.setSelectionRange(start, end, ta.selectionDirection);
    sel.current = { start, end, pointer: prev.pointer };
    if (menu) syncMenu(ta.value, start, refs);
  };

  // Dictation's settled words, typed in at the end through the browser's editing (⌘Z takes back a phrase).
  const onDictated = useRef<(words: string) => void>(() => undefined);
  onDictated.current = (words) => {
    const ta = ref.current;
    if (!ta) return;
    const end = ta.value.length;
    edit(end, end, `${spaceBefore(ta.value)}${words}`);
  };
  const toggleDictation = useRef<() => void>(() => undefined);
  toggleDictation.current = () => {
    if (!client || onCall) return;
    if (listening) return void stopDictation();
    setNote(null);
    void startDictation(client, { owner: dictationOwner, ...(workspaceId && !onCapture ? { workspaceId } : {}), onFinal: (words) => onDictated.current(words) });
  };
  // The box going away stops listening for it.
  useEffect(() => () => void stopDictationFor(dictationOwner), [dictationOwner]);
  // Its shortcut starts or stops talking to type: in the box that has focus, else in this chat's box when its pane has it.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || !matchesChord(e, chord("app.dictate"))) return;
      const el = box.current;
      if (!el?.checkVisibility()) return;
      const active = document.activeElement;
      const here = active !== null && el.contains(active);
      if (!here && (onCapture || !workspaceId || active?.closest("[data-composer], [role=dialog]") || el.closest("[data-side-panel]") || !ownsFocus(el))) return;
      e.preventDefault();
      toggleDictation.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCapture, workspaceId]);

  // The pickers a chord opens: only those this composer shows (a model once the engine has one, permissions when offered).
  const openPickerRef = useRef<(which: "model" | "access") => boolean>(() => false);
  openPickerRef.current = (which) => {
    if (!engine || (which === "access" && !access)) return false;
    if (which === "access") openAccess();
    else setPicker(which);
    return true;
  };
  // Type-to-focus (T3): a letter typed or text pasted where nothing takes it goes to this chat's box, at the end.
  const typeIn = useRef<(text: string, pasted: boolean) => void>(() => undefined);
  typeIn.current = (typed, pasted) => {
    const ta = ref.current;
    if (!ta) return;
    const end = ta.value.length;
    // A paste is checked for keys as a paste into the box is.
    if (pasted && secrets.intercept(typed, "paste", (safe) => edit(end, end, safe))) return;
    edit(end, end, typed);
  };
  useEffect(() => {
    if (!workspaceId || onCapture) return;
    const mine = () => {
      const el = box.current;
      if (!el?.checkVisibility() || !ownsFocus(el)) return false;
      const active = document.activeElement;
      // Several composers can share one pane (the Chief and an embedded chat). The focused composer, or the chat
      // containing the focused transcript, owns its pickers; a panel's terminal and file viewer keep their keys.
      const composer = active?.closest("[data-composer]");
      if (composer) return composer === el;
      const chat = active?.closest("[data-chat-session]");
      if (chat) return chat === el.closest("[data-chat-session]");
      return !el.closest("[data-side-panel]") && !active?.closest("[data-side-panel]");
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      // ⌘⇧M / ⌘⇧A open this chat's model and permissions pickers from anywhere in it (Claude Desktop, T3).
      const pick = matchesChord(e, chord("app.pickModel")) ? "model" : matchesChord(e, chord("app.pickPermissions")) ? "access" : null;
      if (pick && !e.defaultPrevented && !e.repeat && mine() && !(e.target as Element | null)?.closest?.("[role=dialog]")) {
        if (!openPickerRef.current(pick)) return;
        e.preventDefault();
        return;
      }
      if (e.defaultPrevented || !typesCharacter(e) || !landsNowhere(e.target, document) || !mine()) return;
      // A key the app binds ("?" lists the shortcuts) keeps its job.
      if (SHORTCUTS.some((s) => matchesChord(e, chord(s.command)))) return;
      e.preventDefault();
      typeIn.current(e.key, false);
    };
    const onPasteAnywhere = (e: globalThis.ClipboardEvent) => {
      if (e.defaultPrevented || !e.clipboardData || e.clipboardData.files.length > 0 || !landsNowhere(e.target, document) || !mine()) return;
      const pasted = e.clipboardData.getData("text/plain");
      if (!pasted) return;
      e.preventDefault();
      typeIn.current(pasted, true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("paste", onPasteAnywhere);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("paste", onPasteAnywhere);
    };
  }, [workspaceId, onCapture]);

  // Words from elsewhere (compose-event.ts): Edit on a message of the person's, after the restore, or a Chief's
  // thing to try. They come back here, above anything typed.
  const onCompose = useRef<(wire: string) => void>(() => undefined);
  onCompose.current = (wire) => {
    const typed = serializeDraft(draftNow.current).trim();
    const next = draftFromWire(typed ? `${wire}\n\n${typed}` : wire);
    recall.current = null;
    setDraft(next);
    placeCaret(draftFromWire(wire).text.length);
  };
  const composeBox = workspaceId ?? draftKey;
  useEffect(() => {
    if (!composeBox) return;
    const on = (e: Event) => {
      const detail = (e as CustomEvent<ComposeDetail>).detail;
      if (detail?.box === composeBox) onCompose.current(detail.wire);
    };
    window.addEventListener(COMPOSE_EVENT, on);
    return () => window.removeEventListener(COMPOSE_EVENT, on);
  }, [composeBox]);

  // Quote on an answer's selected words (transcript/QuoteSelection.tsx): a quote at the caret, else at the end.
  const onQuote = useRef<(text: string) => void>(() => undefined);
  onQuote.current = (quoted) => {
    const ta = ref.current;
    if (!ta) return;
    const { at, insert } = placeQuote(ta.value, document.activeElement === ta ? ta.selectionEnd : null, quoteBlock(quoted));
    edit(at, at, insert);
    // Under the quote, ready to write.
    placeCaret(at + insert.length);
  };
  useEffect(() => {
    if (!workspaceId) return;
    const on = (e: Event) => {
      const detail = (e as CustomEvent<QuoteDetail>).detail;
      if (detail?.workspaceId === workspaceId) onQuote.current(detail.text);
    };
    window.addEventListener(QUOTE_EVENT, on);
    return () => window.removeEventListener(QUOTE_EVENT, on);
  }, [workspaceId]);

  // A sidebar thread dropped here (panes/drag.ts): a reference at the caret, or at the end when the box was not being typed in;
  // on the Chief's box, it joins that Chief's board.
  const dropId = useId();
  const attachLabel = onAttachChat?.label;
  const onDropChat = useRef<(p: DragPayload) => void>(() => undefined);
  onDropChat.current = (p) => {
    if (onAttachChat) return onAttachChat.attach(p);
    const ta = ref.current;
    if (!ta) return;
    const at = document.activeElement === ta ? ta.selectionEnd : ta.value.length;
    insertRef(at, at, { workspace_id: p.workspaceId, title: p.title });
  };
  // A goal takes plain words (goal.set reads no thread links), so no drops then.
  useEffect(
    () =>
      goalMode
        ? undefined
        : registerDropTarget(box.current!, { kind: "composer", id: dropId, workspaceId: workspaceId ?? null, onDrop: (p) => onDropChat.current(p), ...(attachLabel ? { label: attachLabel } : {}) }),
    [dropId, workspaceId, goalMode, attachLabel],
  );
  const drag = useDrag();
  const dropHere = drag.target?.kind === "composer" && drag.target.id === dropId ? drag.payload : null;

  // The pill layer follows the textarea's scroll and stays clear of its scrollbar.
  const syncMirror = () => {
    const ta = ref.current;
    const m = mirror.current;
    if (!ta || !m) return;
    m.style.right = `${ta.offsetWidth - ta.clientWidth}px`;
    (m.firstElementChild as HTMLElement).style.transform = `translateY(${-ta.scrollTop}px)`;
  };
  useLayoutEffect(syncMirror);
  // A pane resize can bring the scrollbar in or out without a render.
  useEffect(() => {
    const ro = new ResizeObserver(() => syncMirror());
    ro.observe(ref.current!);
    return () => ro.disconnect();
  }, []);
  // While an IME composes, the textarea shows its own text (and the composition underline); the pill layer keeps only the tints.
  const [composing, setComposing] = useState(false);
  // Compact: once the words run past one line they sit above the controls, full width, and stay there until the box
  // empties (going back on every reflow would flip the layout as the width changes under the caret).
  const [stacked, setStacked] = useState(false);
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!compact || !ta) return;
    setStacked((was) => stackWords(was, text, ta.scrollHeight, parseFloat(getComputedStyle(ta).lineHeight) || 22));
  }, [compact, text]);

  /** The "@" that "+" typed, taken back if its menu closes untouched. */
  const plus = useRef<{ at: number; lead: string } | null>(null);
  const takeBackPlus = (): boolean => {
    const range = plusTyped(draftNow.current.text, plus.current, menu);
    plus.current = null;
    if (!range) return false;
    setMenu(null);
    edit(range[0], range[1], "");
    return true;
  };
  const openPlus = () => {
    // "+" again on the menu it opened closes it, and the box reads as before.
    if (takeBackPlus()) return;
    const now = ref.current?.value ?? text;
    const caret = ref.current?.selectionStart ?? now.length;
    // "+" types the "@" for you, so both doors open the same menu.
    const lead = caret > 0 && !/\s/.test(now[caret - 1]!) ? " @" : "@";
    dismissed.current = null;
    plus.current = { at: caret, lead };
    edit(caret, caret, lead);
  };

  /** Runs a command with what follows its name. False when it cannot run here (the bar says why). */
  const runCommand = (id: CommandId, args: string): boolean => {
    const how = runs[id];
    const command = commandById(id);
    const refusal =
      how === undefined ? `/${command.names[0]} isn't available here` : typeof how === "string" ? how : command.args?.required && !args ? `/${command.names[0]} needs a ${command.args.hint}` : null;
    if (refusal !== null || typeof how !== "function") {
      setNote(refusal);
      return false;
    }
    noteUse(`cmd:${id}`);
    setNote(null);
    how(args);
    return true;
  };
  /** A prompt command (/review, /init, /compact) as a turn: queued behind a running one. */
  const submitText = async (prompt: string) => {
    setBusy(true);
    setNote(null);
    try {
      await onSubmit(prompt, running ? "queue" : "followup", choiceNow, []);
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
      ref.current?.focus();
    }
  };
  const copyLast = () => {
    const answer = lastAnswer?.();
    if (!answer) return setFlash("No answer to copy yet");
    navigator.clipboard.writeText(answer).then(() => setFlash("Copied the last answer"), () => setNote("The clipboard is not reachable here"));
  };
  /** A model or permission mode picked by id ("model:<engine>|<model>", "access:<mode>"). */
  const applyArg = (id: string) => {
    noteUse(id);
    if (id.startsWith("access:")) return choose({ access: id.slice(7) as AccessMode });
    const [to, picked] = id.slice(6).split("|") as [string, string];
    pickModel(to, picked);
  };
  /** "/model opus" sent whole: the best match, as the menu would have had it first. */
  const pickBest = (command: "model" | "permissions", args: string) => {
    const top = argRows({ kind: "args", command, start: 0, end: 0, query: args })[0];
    if (top) applyArg(top.item.id);
    else setNote(`No ${command === "model" ? "model" : "permission mode"} matches “${args}”`);
  };

  /** Enter picks the row; Tab (or → on its ghost) completes it: a command's name waits for what follows. */
  const pickMenu = (i: number, how: "enter" | "tab" = "enter") => {
    const row = menuRows[i];
    if (!menu || !row || row.item.unavailable) return;
    const end = menuEnd(menu);
    const id = row.item.id;
    setMenu(null);
    if (id.startsWith("cmd:")) {
      const command = commandById(id.slice(4) as CommandId);
      if (how === "tab" || command.args?.required) {
        dismissed.current = null;
        edit(menu.start, end, `${row.item.label} `);
        return;
      }
      // What was already typed after it is its argument (/review then "the auth flow").
      const now = ref.current?.value ?? text;
      const args = command.args ? now.slice(end).trim() : "";
      edit(menu.start, args ? now.length : end, "");
      runCommand(command.id, args);
      return;
    }
    if (id.startsWith("engine:")) {
      // The engine's own: sent as typed. One that takes arguments, or Tab, types it and waits for them.
      const name = id.slice(7);
      noteUse(id);
      const now = ref.current?.value ?? text;
      if (how === "tab" || row.item.hint || now.slice(end).trim() !== "") {
        dismissed.current = null;
        edit(menu.start, end, `/${name} `);
        return;
      }
      edit(menu.start, end, "");
      void submitText(`/${name}`);
      return;
    }
    if (id.startsWith("skill:")) {
      noteUse(id);
      insertRef(menu.start, end, { workspace_id: "", title: id.slice(6), skill: id.slice(6) });
      return;
    }
    if (id.startsWith("model:") || id.startsWith("access:")) {
      edit(menu.start, end, "");
      applyArg(id);
      return;
    }
    if (id.startsWith("chat:")) insertRef(menu.start, end, { workspace_id: id.slice(5), title: row.item.label });
    else if (id.startsWith("plugin:")) insertRef(menu.start, end, { workspace_id: "", title: row.item.label, plugin: id.slice(7) });
    else edit(menu.start, end, id.startsWith("file:") ? `@${/\s/.test(id.slice(5)) ? JSON.stringify(id.slice(5)) : id.slice(5)} ` : "");
    if (row.item.id === "files") filePicker.current?.click();
    if (row.item.id === "images") imagePicker.current?.click();
    if (row.item.id === "goal") setGoalMode(true);
    if (row.item.id === "grill") setGrill((g) => !g);
    if (row.item.id === "skill") onRecordSkill?.();
  };

  /** Attaches what the box takes of `list` (`drawn`: a marked-up picture's way back); why it left one out, or null. */
  const attach = async (list: FileList | ReadonlyArray<File>, drawn?: Drawn | null): Promise<string | null> => {
    const problems: string[] = [];
    const added: Attached[] = [];
    for (const file of Array.from(list)) {
      const image = sentAsImage(file);
      if (onCapture && !image) problems.push("The Chief takes images only; attach files in a chat");
      else if (image && !onCapture && !engine?.capabilities.images) problems.push(`${engine?.label ?? "This engine"} takes no images`);
      else if (file.size > MAX_ATTACHMENT_BYTES) problems.push(`${file.name} is over 10 MB`);
      // A dropped or picked .env (or any text holding a key) is caught like a paste: stored, never attached.
      else if (!image && (await secrets.interceptFile(file))) continue;
      else added.push({ ...(await attachedFile(file)), ...(drawn ? { drawn } : {}) });
    }
    if (added.length) setFiles((f) => [...f, ...added]);
    setNote(problems[0] ?? null);
    return problems[0] ?? null;
  };
  // A picture marked up in this chat's viewer (compose-event.ts) lands here like a dropped one.
  const takeFiles = useRef(attach);
  takeFiles.current = attach;
  useEffect(() => (composeBox ? takeFilesIn(composeBox, { take: (file, drawn) => takeFiles.current([file], drawn), focus: () => ref.current?.focus() }) : undefined), [composeBox]);
  /** The attached image being marked up (annotate/Annotator.tsx), the marks it opens with, and its place among the files. */
  const [marking, setMarking] = useState<{ readonly index: number; readonly media: AnnotateMedia; readonly marks: ReadonlyArray<Mark> } | null>(null);
  const markUp = (index: number, { attachment, drawn }: Attached) =>
    setMarking({
      index,
      // A copy opens on what it was drawn on, its marks still marks; any other image on its own bytes.
      media: drawn ? { kind: "image", blob: drawn.original, name: drawn.name } : { kind: "image", blob: new Blob([fromBase64(attachment.data)], { type: attachment.mime_type }), name: attachment.name },
      marks: drawn?.marks ?? [],
    });
  // Kept: the caret is back in the box, to say what to do about it. An effect: by then the surface has let go of the focus.
  const [kept, setKept] = useState(0);
  useEffect(() => {
    if (kept) ref.current?.focus();
  }, [kept]);
  /** The marked-up copy takes the image's place in the message, with its way back; one with no marks left is the image as it was. */
  const keepMarked = async (file: File, drawn: Drawn | null): Promise<string | null> => {
    if (!marking) return null;
    if (file.size > MAX_ATTACHMENT_BYTES) return `${file.name} is over 10 MB`;
    const next: Attached = { ...(await attachedFile(file)), ...(drawn ? { drawn } : {}) };
    setFiles((all) => all.map((f, i) => (i === marking.index ? next : f)));
    setMarking(null);
    setKept((n) => n + 1);
    return null;
  };

  const sendable = (d: Draft) => (d.text.trim().length > 0 || ((files.length > 0 || secrets.saved.length > 0) && !goalMode)) && !busy;
  // Words still being heard count: sending lets them settle and land first.
  const canSend = sendable(draft) || (dictation.heard !== "" && !busy);
  /** A caught send: the draft's keys become $NAME, or the draft empties when it was all .env. */
  const placeInDraft = (safe: string, saved: ReadonlyArray<SecretEntry>) => {
    const next = safe === "" ? "" : saved.reduce((acc, s) => acc.split(s.value).join(`$${s.name}`), draftNow.current.text);
    onText(next, next.length);
  };
  // One send at a time: while the mic's last words land (up to 2 s) the box still reads as idle and holds what it is
  // about to send, so a second Enter or click would send it again.
  const sending = useRef(false);
  const send = async (kind: SubmitKind, capture: CaptureMode = "decide") => {
    if (!canSend || sending.current) return;
    sending.current = true;
    try {
      await sendNow(kind, capture);
    } finally {
      sending.current = false;
    }
  };
  const sendNow = async (kind: SubmitKind, capture: CaptureMode) => {
    // Talking to type: the mic stops, the last words land, then it all goes.
    if (listening) await stopDictation();
    if (!sendable(draftNow.current)) return;
    // "/rename Auth fix" sent whole runs here; a "/word" no command owns goes to the engine as typed.
    const lead = goalMode ? null : leadingCommand(draftNow.current.text, draftNow.current.refs, commands);
    if (lead) {
      if (runCommand(lead.command.id, serializeDraft(draftNow.current).slice(lead.end).trim())) {
        setDraft(EMPTY_DRAFT);
        setMenu(null);
      }
      return;
    }
    if (secrets.intercept(draftNow.current.text, "send", placeInDraft)) return;
    setBusy(true);
    setNote(null);
    try {
      if (onCapture) await onCapture([serializeDraft(draftNow.current).trim(), secrets.notice].filter(Boolean).join("\n\n"), capture, files.map((f) => f.attachment));
      else if (goalMode && onGoal) {
        await onGoal(draftNow.current.text.trim());
        setGoalMode(false);
      } else {
        const sent = { draft: draftNow.current, files };
        const message = [serializeDraft(sent.draft).trim(), secrets.notice].filter(Boolean).join("\n\n");
        const choice = choiceNow;
        // The box empties as the message goes, as in any chat; a refused send puts it back unless typing began again.
        setDraft(EMPTY_DRAFT);
        setFiles([]);
        setMenu(null);
        try {
          await onSubmit(message, kind, choice, sent.files.map((f) => f.attachment));
        } catch (e) {
          if (draftNow.current.text === "") {
            setDraft(sent.draft);
            setFiles(sent.files);
          }
          throw e;
        }
      }
      // Captures and goals empty the box once taken; a message did already (and typing since stays).
      if (onCapture || (goalMode && onGoal)) {
        setDraft(EMPTY_DRAFT);
        setFiles([]);
        setMenu(null);
      }
      secrets.sent();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      ref.current?.focus();
    }
  };

  // The engine's guess at the next message (promptSuggestion.ts): offered only in an empty, idle box of a chat.
  const promptSuggestion = usePromptSuggestion(chatId);
  const suggestion =
    promptSuggestion.suggestion !== null && !running && !busy && text === "" && files.length === 0 && secrets.saved.length === 0 && !goalMode && !listening && !dropHere && !menuOpen
      ? promptSuggestion.suggestion
      : null;

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposing(e)) return;
    // Tab takes the suggestion into the box, to send or change; Escape puts it away (Tab moves focus again).
    if (suggestion !== null && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      if (e.key === "Tab") {
        e.preventDefault();
        const next = { text: suggestion, refs: [], gone: [] };
        setDraft(next);
        placeCaret(next.text.length);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        promptSuggestion.dismiss();
        return;
      }
    }
    // The secret sheet is open: Escape drops what it caught, wherever focus is.
    if (secrets.pending && e.key === "Escape") {
      e.preventDefault();
      secrets.cancel();
      return;
    }
    // Escape stops listening; what was said stays.
    if (listening && e.key === "Escape" && !menuOpen) {
      e.preventDefault();
      e.stopPropagation();
      void stopDictation();
      return;
    }
    if (menu && menuOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (menuIndex >= 0) stepMenu(e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && menuIndex >= 0) {
        e.preventDefault();
        pickMenu(menuIndex, e.key === "Tab" ? "tab" : "enter");
        return;
      }
      // → at the end takes the ghost, as a shell does.
      if (e.key === "ArrowRight" && ghost && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        pickMenu(menuIndex, "tab");
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        // Opened with "+": closing it takes back the "@" it typed. Typed by hand, the "@" stays and the menu stays shut.
        if (takeBackPlus()) return;
        dismissed.current = `${menu.kind}:${menu.start}`;
        setMenu(null);
        return;
      }
    }
    // ↑ in an empty box brings back what was sent before, ↓ walks forward again (prompt-history.ts).
    if (history && !files.length) {
      const ta = e.currentTarget;
      const direction = historyKey(e, text, ta.selectionStart, ta.selectionEnd);
      const step = direction ? stepPrompt(direction, history(), recall.current, text) : null;
      if (step) {
        e.preventDefault();
        recall.current = step.position;
        const next = step.entry ? draftFromWire(step.entry.wire) : EMPTY_DRAFT;
        setDraft(next);
        placeCaret(next.text.length);
        return;
      }
    }
    // A pill goes whole: Backspace at its end, Delete at its start; a word delete (⌥ or Ctrl) reaches it across spaces.
    // ⌘ keeps the native line delete; whatever it leaves of a pill is cut in onText.
    if ((e.key === "Backspace" || e.key === "Delete") && !e.metaKey) {
      const ta = e.currentTarget;
      const range = ta.selectionStart === ta.selectionEnd ? pillDeletion(refs, text, ta.selectionStart, e.key, e.altKey || e.ctrlKey) : undefined;
      if (range) {
        e.preventDefault();
        edit(range[0], range[1], "");
        return;
      }
    }
    if (onCapture) {
      const capture = chiefSendMode(e, settings?.send_shortcut);
      if (!capture) return;
      e.preventDefault();
      void send("followup", capture);
      return;
    }
    if (e.key !== "Enter" || e.shiftKey) return;
    // Settings > Keyboard: with ⌘Enter to send, a plain Enter is a new line.
    if (settings?.send_shortcut === "mod_enter" && !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    if (!running) void send("followup");
    else if (e.altKey || !canSteer) void send("queue");
    else void send("steer");
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/") || isSvgAttachment({ name: f.name, mimeType: f.type }));
    if (images.length) {
      e.preventDefault();
      void attach(images);
      return;
    }
    const ta = e.currentTarget;
    const [start, end] = [ta.selectionStart, ta.selectionEnd];
    if (secrets.intercept(e.clipboardData.getData("text/plain"), "paste", (safe) => edit(start, end, safe))) {
      e.preventDefault();
    }
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    void attach(e.dataTransfer.files);
  };
  const onPicked = (input: HTMLInputElement) => {
    if (!input.files?.length) return;
    void attach(input.files).finally(() => (input.value = ""));
  };

  // The rest of the active row's name, in grey after the caret: Tab or → takes it.
  const caretAtEnd = (ref.current?.selectionEnd ?? text.length) === text.length;
  const activeRow = menuOpen ? menuRows[menuIndex] : undefined;
  const typed = menu?.kind === "slash" && menu.query ? `/${menu.query}` : menu?.kind === "args" ? menu.query : "";
  const ghost =
    typed && activeRow && caretAtEnd && text.endsWith(typed) && activeRow.item.label.toLowerCase().startsWith(typed.toLowerCase()) ? activeRow.item.label.slice(typed.length) : "";
  // A command at the start of the message is painted as one, and says what it takes until something follows it.
  const lead = goalMode ? null : leadingCommand(text, refs, commands);
  // An engine command opening the message is painted the same way; it is sent as typed.
  const word = onCapture || goalMode || lead ? null : leadingSlash(text, refs);
  const own = word ? engineCommands.find((c) => c.name === word.name) : undefined;
  const leadSpan = lead && runs[lead.command.id] !== undefined ? { start: lead.start, end: lead.end, command: true as const } : own && word ? { start: word.start, end: word.end, command: true as const } : null;
  // Send's word, and whether it turns into Stop with the box empty: the chat's turn, or agents it started, still at work.
  const sendWord = leadSpan && lead ? `Run /${lead.command.names[0]}` : onCapture ? "Send" : goalMode ? "Set goal" : running ? (canSteer ? "Steer" : "Queue") : "Send";
  const stoppable = (running || agentsWorking) && !onCapture;
  const hintFor = lead ? lead.command.args?.hint : own?.hint;
  const argHint =
    leadSpan && hintFor && (lead ?? word)!.args === "" && caretAtEnd && (!menuOpen || (menu?.kind === "args" && menu.query === ""))
      ? `${/\s$/.test(text) ? "" : " "}${hintFor}`
      : "";
  // The words being heard, in grey after the text: never in the draft until they settle.
  const heard = dictation.heard ? `${spaceBefore(text)}${dictation.heard}` : "";
  // While they show, the placeholder is empty: they paint where it would be.
  const after = heard || ghost || argHint;
  // They can run past the box's own lines: it grows to hold them while they are there, up to its max height (max-h-60,
  // less in a short pane: panes.css), which an inline min-height would otherwise override.
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.minHeight = "";
    const painted = mirror.current?.firstElementChild;
    if ((heard || suggestion) && painted && painted.scrollHeight > ta.clientHeight) ta.style.minHeight = `${Math.min(painted.scrollHeight, parseFloat(getComputedStyle(ta).maxHeight) || 240)}px`;
  }, [heard, suggestion]);
  const painted = refs.length > 0 || leadSpan !== null || after !== "" || suggestion !== null;
  const spans: Array<ThreadRef | NonNullable<typeof leadSpan>> = leadSpan ? [leadSpan, ...refs] : [...refs];
  const activeId = activeRow?.item.id ?? "";
  const menuKeys: ReadonlyArray<readonly [string, string]> = activeId.startsWith("cmd:")
    ? [["↵", "run"], ["⇥", commandById(activeId.slice(4) as CommandId).args ? "add details" : "complete"], ["esc", ""]]
    : activeId.startsWith("engine:")
      ? [["↵", activeRow?.item.hint ? "add" : "send"], ["⇥", "complete"], ["esc", ""]]
      : [["↵", activeId.startsWith("skill:") ? "add" : "pick"], ["esc", ""]];

  const ring =
    context && context.window_tokens > 0 ? (
      <ContextRing
        used={context.used_tokens}
        window={context.window_tokens}
        {...(context.compact_at_tokens === undefined ? {} : { compactAt: context.compact_at_tokens })}
        usage={usageLine(tokens, engine?.usage_limits)}
        onOpen={workspaceId ? () => openSurface(workspaceId, "overview", {}) : undefined}
      />
    ) : null;
  // `+` and the settings: first on the bar, or before the line in a one-line box.
  const addAndSettings = (
    <>
          <button
            type="button"
            onPointerDown={(e) => e.preventDefault()}
            onClick={openPlus}
            aria-label={onCapture ? "Add images or chats" : "Add files, folders, images or plugins"}
            aria-haspopup="listbox"
            aria-expanded={menuOpen && menu?.kind === "at"}
            className={cn(
              // Open, the + is the menu's raised tile (as its selected row's is), turned to a ×.
              "grid size-7 shrink-0 place-items-center rounded-[8px] text-muted-foreground outline-none transition-[background-color,color,box-shadow,transform] duration-100 ease-snap hover:bg-accent hover:text-foreground active:scale-[0.94] focus-visible:ring-2 focus-visible:ring-ring motion-reduce:active:scale-100",
              menuOpen && menu?.kind === "at" && "bg-background text-foreground ring-1 ring-border hover:bg-background",
            )}
          >
            <Icon icon={Add01Icon} className={cn("size-4 transition-transform duration-150 ease-snap", menuOpen && menu?.kind === "at" && "rotate-45")} />
          </button>
          {onCapture ? (captureSettings ?? null) : chatSettings || (engine && access) ? (
            <ChatSettings open={picker === "settings" || picker === "access"} onOpenChange={(o) => setPicker(o ? "settings" : null)} onClosed={() => ref.current?.focus()}>
              {chatSettings}
              {engine && access ? (
                <AccessSetting
                  modes={engine.access_modes}
                  value={access}
                  onChange={(a) => choose({ access: a })}
                  open={picker === "access"}
                  // Leaving the row goes back to the menu's rows; the whole menu closing stays closed.
                  onOpenChange={(o) => setPicker((p) => (o ? "access" : p === "access" ? "settings" : p))}
                />
              ) : null}
            </ChatSettings>
          ) : null}
    </>
  );
  return (
    <div
      className="relative"
      onKeyDown={(e) => {
        // ⌘⇧. / ⌘⇧, step the effort from anywhere in the composer, the picker included; ⌘⇧F goes to the next speed.
        if (e.defaultPrevented || !engine) return;
        if (matchesChord(e.nativeEvent, chord("app.toggleSpeed"))) {
          if (!model?.speeds?.length) return;
          e.preventDefault();
          choose({ speed: nextSpeed(model.speeds, speed) });
          return;
        }
        const step = matchesChord(e.nativeEvent, chord("app.increaseEffort")) ? 1 : matchesChord(e.nativeEvent, chord("app.decreaseEffort")) ? -1 : 0;
        if (step === 0 || !model || !effort) return;
        e.preventDefault();
        choose({ effort: stepEffort(model.efforts, effort, step) });
      }}
    >
      {menu && menuOpen ? (
        <ComposerAddMenu
          id={menuId}
          rows={menuRows}
          active={menuIndex}
          query={menu.query}
          onHover={setMenuActive}
          onPick={(i) => pickMenu(i)}
          {...(menu.kind === "slash"
            ? {
                label: "Commands and skills",
                keys: menuKeys,
                column: true,
                empty: (
                  <>
                    No command or skill named “{menu.query}”. <span className="text-foreground">↵</span> sends it to {engineName} as typed.
                  </>
                ),
              }
            : menu.kind === "args"
              ? { label: menu.command === "model" ? "Models" : "Permissions", keys: menuKeys, column: true }
              : {
                  search: onCapture ? "Images or a chat" : "Files, plugins, chats and more",
                  ...(menu.query ? {} : { empty: onCapture ? "No chats to reference yet." : "Nothing to add here." }),
                })}
        />
      ) : null}
      {unlink.dialog}
      {secrets.pending ? (
        <SecretSheet
          key={secrets.pending.id}
          entries={secrets.pending.entries}
          existing={secrets.existing}
          repoLabel={secrets.repoLabel}
          mode={secrets.pending.mode}
          busy={secrets.busy}
          error={secrets.error}
          onSave={(entries) => void secrets.save(entries).then(() => ref.current?.focus())}
          onCancel={() => {
            secrets.cancel();
            ref.current?.focus();
          }}
          {...(secrets.pasteAsText ? { onPasteAsText: secrets.pasteAsText } : {})}
        />
      ) : null}
      {dictation.error ? (
        <VoiceProblem
          error={dictation.error}
          icon="mic"
          onKey={() => {
            clearDictationError();
            navigate("/settings/chief");
          }}
          onDismiss={clearDictationError}
        />
      ) : null}
      <ComposerTray queue={queue} strip={strip} />
      <div
        ref={box}
        data-composer
        onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
        onDrop={onDrop}
        className={cn(
          "relative rounded-2xl transition-[border-color,box-shadow] duration-75",
          glass ? "glass composer-glass" : "composer-card",
          // 1px border + 11px + the field's px-1 = 16: the words start on the conversation's column, which the box
          // overhangs by 16px (PaneFrame). The bar below them sits 8px in from the box's edge on every side (its row's
          // -mx-1), so Send keeps an even corner and the + lands on the words' column; 16px corners, Send's 10 plus 8.
          compact ? cn("flex flex-wrap items-end gap-x-1.5 px-1.5 py-1.5", stacked && "gap-y-1") : "px-[11px] pb-[7px] pt-2",
          // A thread held over the box: the one blue, "here" (STYLE.md 3).
          dropHere && "border-target focus-within:border-target ring-4 ring-target/15",
        )}
      >
        {files.length ? (
          <ul className={cn("flex flex-wrap gap-2 px-1 pb-2", compact && "basis-full pt-1", stacked && "order-first")} aria-label="Attachments">
            {files.map((f, i) => (
              <AttachmentChip
                key={`${f.attachment.name}-${i}`}
                file={f}
                onRemove={() => setFiles((all) => all.filter((_, j) => j !== i))}
                // An SVG stays the file the agent reads: marked up, it would be a picture of one.
                {...(f.attachment.type === "image" ? { onAnnotate: () => markUp(i, f) } : {})}
              />
            ))}
          </ul>
        ) : null}
        {secrets.saved.length ? <SavedSecrets mentions={secrets.saved} onRemove={secrets.unmention} /> : null}
        {compact ? <div className="flex shrink-0 items-center gap-0.5 self-end">{addAndSettings}</div> : null}
        {/* Compact keeps the field at least 12rem wide: past that its controls wrap to a row of their own (a phone). */}
        {/* Compact and one line: the words beside the controls. Past one line they take the whole width, above both groups of controls. */}
        <div className={compact ? cn("relative min-w-[min(100%,12rem)] flex-1 self-center", stacked && "order-first basis-full") : "relative"}>
          {painted ? (
            <div ref={mirror} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
              <div className={cn(FIELD, "whitespace-pre-wrap break-words", composing && "text-transparent [&_.thread-pill]:text-transparent [&_.composer-ghost]:hidden")}>
                {pieces(text, spans).map((p) =>
                  typeof p === "string" ? (
                    p
                  ) : "command" in p ? (
                    <span key="command" className="command-token">
                      {text.slice(p.start, p.end)}
                    </span>
                  ) : (
                    <span key={p.id} className={cn("thread-pill", p.skill !== undefined && "skill-pill")}>
                      <span className="thread-pill-at">{text[p.start]}</span>
                      {text.slice(p.start + 1, p.end)}
                    </span>
                  ),
                )}
                {after ? <span className="composer-ghost">{after}</span> : null}
                {suggestion !== null && !after ? (
                  <span className="composer-ghost">
                    {suggestion}
                    <Keycap className="ml-2 align-[1px]">⇥ Tab</Keycap>
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => {
              const kind = (e.nativeEvent as InputEvent).inputType;
              onText(e.target.value, e.target.selectionEnd, kind === "historyUndo" || kind === "historyRedo");
            }}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onSelect={(e) => onSelect(e.currentTarget)}
            onPointerDown={() => (sel.current.pointer = true)}
            onScroll={syncMirror}
            onBlur={() => setMenu(null)}
            onKeyDown={(e) => {
              sel.current.pointer = false;
              onKeyDown(e);
            }}
            onPaste={onPaste}
            rows={1}
            role="combobox"
            aria-label="Message"
            aria-autocomplete="list"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            aria-activedescendant={menuOpen && menuIndex >= 0 ? `${menuId}-${menuIndex}` : undefined}
            placeholder={
              suggestion !== null
                ? ""
                : dropHere
                ? attachLabel
                  ? `${attachLabel}: ${dropHere.title}`
                  : `Reference ${dropHere.title}`
                : goalMode
                  ? "Describe the goal to keep pursuing…"
                  : listening
                    ? (heard ? "" : "Listening… talk, and the words land here")
                    : (placeholder ?? (running ? (canSteer ? `Steer, or ${formatChord("alt+enter")} to queue a follow-up…` : "Queue a follow-up…") : grill && grills ? "What should it grill you on?" : onCapture ? "Ask for a change, or @ to add…" : "Ask for a change, / for commands, @ to add…"))
            }
            className={cn(
              "relative block max-h-60 w-full resize-none bg-transparent [field-sizing:content] placeholder:text-[hsl(var(--subtle-foreground))] focus:outline-none",
              // Three lines; fewer in a short pane (panes.css, .composer-field).
              compact ? "min-h-[22px]" : "composer-field min-h-[3lh]",
              FIELD,
              // The pill layer paints the words; the textarea keeps the caret and the selection.
              painted && !composing && "text-transparent caret-foreground selection:text-transparent",
            )}
          />
        </div>
        {/* Compact, the row sits beside one line of text and wraps under more; never wider than the box (its picker truncates). */}
        <div className={cn("composer-controls flex items-center gap-1 whitespace-nowrap", compact ? (stacked ? "min-w-0 max-w-full flex-1" : "min-w-0 max-w-full shrink-0") : "-mx-1 mt-1.5")}>
          {compact ? null : addAndSettings}
          {showGrill ? <ModeChip icon={FireIcon} label="Grill" title="Grill mode: it asks before it builds. Click to leave." onClear={() => setGrill(false)} /> : null}
          {goalMode ? <ModeChip icon={Target02Icon} label="Goal" title="What you send sets the session goal. Click to cancel." onClear={() => setGoalMode(false)} /> : null}
          {foot === undefined ? ring : null}
          {note ? (
            <span className="ml-1 min-w-0 truncate text-[12px] text-destructive">{note}</span>
          ) : flash ? (
            <span role="status" className="ml-1 min-w-0 truncate text-[12px] text-muted-foreground animate-in fade-in-0 duration-150 motion-reduce:animate-none">
              {flash}
            </span>
          ) : null}
          <span className="ml-auto" />
          {onCapture ? (captureAccessory ?? null) : agentPicker !== undefined ? agentPicker : <ModelPicker
            engines={chatPickerEngines(offered)}
            value={engine && model ? { engine: chatPickerSection(engines, engine, pickedAccount ?? (engine.id === sessionEngine?.id ? accountId : undefined)), model: model.id } : null}
            onChange={(r) => {
              if (byTask?.on) byTask.set(false);
              pickModel(r.engine, r.model);
            }}
            {...(byTask
              ? {
                  auto: { label: "By task", description: "Reads your message and starts on its kind's model", selected: byTask.on, onPick: () => byTask.set(true) },
                  ...(byTask.on ? { trigger: <span className="truncate">By task</span>, ariaLabel: "Model: By task" } : {}),
                }
              : {})}
            favorites={favorites}
            onFavoritesChange={setFavorites}
            {...home}
            effort={effort}
            onEffortChange={(level) => choose({ effort: level })}
            speed={speed}
            onSpeedChange={(next) => choose({ speed: next })}
            start={start}
            onSaveStart={saveStart}
            open={picker === "model"}
            onOpenChange={(o) => closePicker(o, "model")}
            onManageModels={() => navigate("/settings/models")}
            className="max-w-[280px]"
          />}
          <MicButton phase={dictation.phase} shortcut={chord("app.dictate")} blocked={onCall ? "On a call" : null} onToggle={() => toggleDictation.current()} />
          {onCapture ? (captureCall ?? null) : null}
          {stoppable && canSend ? <StopKey onStop={() => void onInterrupt()} /> : null}
          <SendKey
            mode={canSend ? "send" : stoppable ? "stop" : "idle"}
            label={sendWord}
            ariaLabel={onCapture && !(leadSpan && lead) ? `Send to ${captureTo ?? "the Chief"}` : sendWord}
            onSend={() => void send(running ? (canSteer ? "steer" : "queue") : "followup")}
            onStop={() => void onInterrupt()}
          />
        </div>
      </div>
      {foot !== undefined ? (
        // 10px + a chip's 6px: its first icon stands on the box's own column of words; 2px + 6px: its end, on Send's edge.
        <div data-wallpaper-reads className="composer-foot flex min-w-0 items-start gap-x-3 pl-[10px] pr-0.5 pt-1.5">
          {foot}
          {ring ? <span className="ml-auto flex shrink-0 items-center">{ring}</span> : null}
        </div>
      ) : null}
      {marking ? <LazyAnnotator media={marking.media} marks={marking.marks} saveLabel="Save" onSave={keepMarked} onClose={() => setMarking(null)} /> : null}
      <input ref={filePicker} type="file" multiple hidden onChange={(e) => onPicked(e.currentTarget)} />
      <input ref={imagePicker} type="file" accept="image/*" multiple hidden onChange={(e) => onPicked(e.currentTarget)} />
    </div>
  );
});

/**
 * The Caveman engine's models with the key they run on (its account's name, else the provider's): the picker's
 * heading over them. A provider's further keys are slots of their own (`openai~2`), so two GPT-6 Lunas sit under
 * "OpenAI personal" and "OpenAI work".
 */
export function withModelSources<E extends { readonly id: string; readonly models: ReadonlyArray<{ readonly id: string }>; readonly auth?: { readonly accounts: ReadonlyArray<{ readonly id: string; readonly label?: string }> } }>(
  engines: ReadonlyArray<E>,
): E[] {
  return engines.map((engine) => {
    if (engine.id !== "caveman" || engine.auth === undefined) return engine;
    const accounts = engine.auth.accounts;
    return {
      ...engine,
      models: engine.models.map((model) => {
        const slot = model.id.slice(0, model.id.indexOf("/"));
        const account = accounts.find((a) => a.id === `caveman:${slot}`);
        return model.id.includes("/") ? { ...model, source: { id: slot, label: account?.label ?? providerName(slot) } } : model;
      }),
    };
  });
}

/**
 * The model a turn runs on: the pick in this box, else the chat's own (an open chat's latest turn), else a new chat's
 * default: its project's, else Settings > General > New chats, else the runtime's default_model (Auto where offered).
 * A default the engine does not list now (Auto while it is not offered) gives way to default_model, as
 * workspace.create's does. `here` (Project.engine_default_models): Auto can't run in the project, so it replaces
 * default_model, and a configured Auto, there. Never the chat on screen's: a pick there is that chat's alone.
 */
export function turnModel<M extends { readonly id: string; readonly legacy?: boolean | undefined }>(
  engine: { readonly models: ReadonlyArray<M>; readonly default_model?: string | undefined } | undefined,
  ids: { readonly picked?: string | undefined; readonly chat?: string | undefined; readonly project?: string | undefined; readonly setting?: string | undefined; readonly here?: string | undefined },
): M | undefined {
  if (!engine) return undefined;
  const listed = (id: string | undefined) => (id === undefined ? undefined : engine.models.find((m) => m.id === id));
  // `here` is only ever named while default_model is Auto.
  const configured = listed(ids.project ?? ids.setting);
  const own = configured && !(ids.here !== undefined && configured.id === engine.default_model) ? configured : undefined;
  return listed(ids.picked) ?? listed(ids.chat) ?? own ?? listed(ids.here) ?? listed(engine.default_model) ?? engine.models.find((m) => !m.legacy) ?? engine.models[0];
}

type EngineModel = EngineDescriptor["models"][number];

/**
 * Where `model` on `engine` starts: the person's own (Settings.model_defaults: the picker's dotted level, Settings > General),
 * else an effort saved with Settings > General's model before there were starts, else the model's own default.
 */
export function modelStart(starts: Settings["model_defaults"], engine: string, model: EngineModel, saved: Settings["engines"][string] | undefined) {
  const own = starts?.[`${engine}/${model.id}`];
  return {
    effort: pickEffort(model.efforts, own?.effort ?? (saved?.model === model.id ? saved.effort : undefined), model.default_effort),
    speed: pickSpeed(model.speeds, own?.speed, model.default_speed),
  };
}

/** settings.set's model_defaults with `model` starting at `start` (replaced whole, so every other model's stays). */
export function withModelStart(starts: Settings["model_defaults"], engine: string, model: EngineModel, start: { readonly effort?: string | undefined; readonly speed?: string | undefined }) {
  const effort = start.effort && model.efforts.length > 1 ? { effort: start.effort } : {};
  const speed = start.speed && model.speeds?.length ? { speed: start.speed } : {};
  return { ...starts, [`${engine}/${model.id}`]: { ...effort, ...speed } };
}

/**
 * settings.set's engines for a new default model: `engines` is replaced whole, so every other engine's stays. An effort
 * saved with the old model goes: it was that model's.
 */
export const withDefaultModel = (settings: Settings, engine: string, model: string): Settings["engines"] => {
  const { effort: _effort, ...kept } = settings.engines[engine] ?? {};
  return { ...settings.engines, [engine]: { ...kept, model } };
};

/**
 * Model, effort, speed and permissions for an engine, as shown: the person's picks, else the chat's own, else the new
 * chat's defaults (turnModel; the model's start: Settings.model_defaults, an effort saved with Settings > General's
 * model, else the model's own). The picker's dotted level saves the chat's effort and speed as the model's start. Permissions (T3): the pick, else the
 * chat's own, else the new chat's project default, Settings.default_access, then full access. A pick is never saved
 * and is all `options` sends. Favorites live in Settings.favorite_models. The composer and the new-workspace dialog share it.
 */
export function useTurnChoice(
  engineId: string | undefined,
  /**
   * access, model and effort: the session's own (an open chat; model and effort its latest turn's); projectId: a new
   * chat's project, whose defaults come first.
   */
  scope: {
    readonly access?: AccessMode | undefined;
    readonly model?: string | undefined;
    readonly effort?: string | null | undefined;
    readonly speed?: string | undefined;
    readonly projectId?: string | null | undefined;
    readonly picked?: Picked;
  } = {},
) {
  const { client } = useRuntimeClient();
  // What the picker lists is what the chat's own computer runs (useEnginesThere): never This Mac's models for a Cloud chat.
  const engines = useEnginesThere();
  const settings = useRuntimeSelector((v) => v.settings);
  const projects = useRuntimeSelector((v) => v.projects);
  const refresh = useRuntimeSelector((v) => v.refresh);
  const [picked, setPicked] = useState<Picked>(scope.picked ?? {});
  const engine = engines.find((e) => e.id === (picked.engine ?? engineId));
  const sameEngine = engine?.id === engineId;
  const [favOverride, setFavOverride] = useState<string[] | null>(null);
  const favorites = favOverride ?? settings?.favorite_models ?? [];
  const defaults = engine ? settings?.engines[engine.id] : undefined;
  const project = projects.find((p) => p.id === scope.projectId);
  const model = turnModel(engine, {
    picked: picked.model,
    chat: sameEngine ? scope.model : undefined,
    project: engine && project?.default_models?.[engine.id],
    setting: defaults?.model,
    here: engine && project?.engine_default_models?.[engine.id],
  });
  const [startsOverride, setStartsOverride] = useState<Settings["model_defaults"] | null>(null);
  const starts = startsOverride ?? settings?.model_defaults ?? {};
  const start = engine && model ? modelStart(starts, engine.id, model, defaults) : undefined;
  // The pick, else the chat's own (an effort or speed the next model offers), else the model's start. An open chat whose
  // turn named no speed runs at standard (fast mode off), whatever its model's start says now.
  const chatSpeed = sameEngine && scope.model !== undefined ? (scope.speed ?? STANDARD_SPEED) : undefined;
  const effort = model ? pickEffort(model.efforts, picked.effort ?? (sameEngine ? scope.effort : undefined) ?? start?.effort, model.default_effort) : undefined;
  const speed = model ? pickSpeed(model.speeds, picked.speed ?? chatSpeed ?? start?.speed, model.default_speed) : undefined;
  // T3: a chat keeps its own permissions; a new chat starts from its project's default, else Settings > General,
  // else a per-engine pick saved before that setting existed, never from the chat on screen.
  const legacyAccess = (defaults as { access?: AccessMode } | undefined)?.access;
  const newChatAccess = project?.default_access ?? settings?.default_access ?? legacyAccess;
  const access = engine ? pickAccess(engine.access_modes, picked.access ?? scope.access ?? newChatAccess) : undefined;

  /** A pick applies to this chat (or the new chat) only: defaults are Settings > General's and a project's (T3). */
  const choose = (patch: Picked) => setPicked((p) => mergeTurnPick(p, patch, engineId));
  const reset = useCallback(() => setPicked({}), []);
  // A model the chat now runs (sent from here, or from another device) is no pick any more: the box follows the chat
 // from then on, so a later switch made elsewhere shows here too (upstream #20886).
  const chatModel = sameEngine ? scope.model : undefined;
  const chatEffort = sameEngine ? scope.effort : undefined;
  useEffect(() => {
    if (chatModel !== undefined) setPicked((p) => settledPick(p, chatModel, chatEffort ?? null));
  }, [chatModel, chatEffort]);
  const setFavorites = (next: string[]) => {
    setFavOverride(next);
    if (!client) return;
    void client
      .call("settings.set", { request_id: requestId(), settings: { favorite_models: next } })
      .then(refresh)
      .catch(() => undefined)
      .finally(() => setFavOverride(null));
  };

  /** The picker's dotted level: this model starts at the chat's effort and speed from now on. */
  const saveStart = () => {
    if (!client || !engine || !model) return;
    const next = withModelStart(starts, engine.id, model, { effort, speed });
    setStartsOverride(next);
    void client
      .call("settings.set", { request_id: requestId(), settings: { model_defaults: next } })
      .then(refresh)
      .catch(() => undefined)
      .finally(() => setStartsOverride(null));
  };

  // The picker's Home: the person's order, led by the default new chats start on (Settings > General's engine and its
  // model, as NewChat starts them). Moving another row to the top makes it that default.
  const [homeOverride, setHomeOverride] = useState<string[] | null>(null);
  const newChatEngine = chatEngine(engines, null, settings?.default_engine);
  const newChatModel = turnModel(newChatEngine, { setting: newChatEngine && settings?.engines[newChatEngine.id]?.model });
  const homeTop = homeOverride?.[0] === undefined ? null : parseModelKey(homeOverride[0]);
  const defaultModel: ModelRef | null = homeTop ?? (newChatEngine && newChatModel ? { engine: chatPickerSection(engines, newChatEngine, undefined), model: newChatModel.id } : null);
  const setHomeOrder = (next: string[]) => {
    const top = next[0] === undefined ? null : parseModelKey(next[0]);
    // A login's row (`engine#account`) makes its engine the default; new chats take the engine's active login.
    const id = top?.engine.split("#")[0];
    if (!client || !settings || !top || !id) return;
    setHomeOverride(next);
    const moved = id !== newChatEngine?.id || top.model !== newChatModel?.id;
    void client
      .call("settings.set", {
        request_id: requestId(),
        settings: { home_models: next, ...(moved ? { default_engine: id as EngineDescriptor["id"], engines: withDefaultModel(settings, id, top.model) } : {}) },
      })
      .then(refresh)
      .catch(() => undefined)
      .finally(() => setHomeOverride(null));
  };
  return {
    engine,
    model,
    effort,
    speed,
    /** Where the model starts, and saving the chat's effort and speed as that start (the picker's dotted level). */
    start,
    saveStart,
    access,
    pickedAccess: picked.access,
    pickedAccount: picked.account_id,
    choose,
    reset,
    favorites,
    setFavorites,
    /** The picker's Home props: its order, its default and moving its rows. */
    // Its rows say which roles delegated agents start on them for (Settings > Agents), beside Default.
    home: { homeOrder: homeOverride ?? settings?.home_models ?? [], defaultModel, roles: pinnedRoles(engines, settings?.subagent_role_pins, undefined, settings?.subagent_task_pins), onHomeOrderChange: setHomeOrder },
    // Model, effort and speed only when picked here, the effort and speed together (a selection is built whole):
    // otherwise a chat keeps its own and a new chat takes the runtime's default, which may differ from the one shown
    // (Auto gone since engine.list).
    options: {
      ...turnOptions(picked.model && model?.id, picked.model || picked.effort || picked.speed ? effort : undefined, picked.access, picked.account_id, picked.model || picked.effort || picked.speed ? speed : undefined),
      ...(picked.engine ? { engine: picked.engine } : {}),
    },
  };
}

/** One tray on the box's top edge: what's queued, then the strip right above the box. Nothing when both are empty.
 * Edged with the box's own hairline (styles.css `.composer-card`). */
export function ComposerTray({ queue, strip }: { queue?: ReactNode; strip?: ReactNode }) {
  if (!queue && !strip) return null;
  return (
    <div className="mx-3 flex flex-col divide-y divide-[hsl(var(--foreground)/0.1)] rounded-t-[10px] border border-b-0 border-[hsl(var(--foreground)/0.1)] bg-[hsl(var(--foreground)/0.025)] text-[13px]">
      {queue}
      {strip ? <div className="flex h-9 items-center gap-0.5 px-1.5">{strip}</div> : null}
    </div>
  );
}

/** An attached file. An image is a button: it opens to be marked up before it is sent (`onAnnotate`). */
function AttachmentChip({ file, onRemove, onAnnotate }: { file: Attached; onRemove: () => void; onAnnotate?: () => void }) {
  const { attachment } = file;
  return (
    <li className="group relative">
      {onAnnotate ? (
        <button
          type="button"
          onClick={onAnnotate}
          aria-label={`Annotate ${attachment.name}`}
          title="Annotate"
          className="group/chip relative block size-12 overflow-hidden rounded-lg border border-border bg-[hsl(var(--foreground)/0.04)] outline-none transition-colors duration-75 hover:border-input focus-visible:ring-2 focus-visible:ring-ring"
        >
          <img src={file.url} alt="" draggable={false} className="size-full object-contain" />
          <span aria-hidden className="absolute inset-0 grid place-items-center bg-black/55 text-white opacity-0 transition-opacity duration-75 group-hover/chip:opacity-100 group-focus-visible/chip:opacity-100">
            <Icon icon={Pen01Icon} className="size-4" />
          </span>
        </button>
      ) : attachment.type === "image" || attachment.mime_type === "image/svg+xml" ? (
        // An SVG in <img> runs no script and loads nothing.
        <img src={file.url} alt={attachment.name} className="size-12 rounded-lg border border-border bg-[hsl(var(--foreground)/0.04)] object-contain" />
      ) : (
        <span className="flex h-12 max-w-[220px] items-center gap-2 rounded-lg border border-border bg-secondary px-2.5">
          <Icon icon={File01Icon} className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block truncate text-[13px] leading-4 text-foreground">{attachment.name}</span>
            <span className="block text-[12px] leading-4 tabular-nums text-muted-foreground">{formatBytes(file.size)}</span>
          </span>
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${attachment.name}`}
        className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full border border-border bg-popover text-muted-foreground opacity-0 outline-none transition-opacity duration-75 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 touch:opacity-100"
      >
        <Icon icon={Cancel01Icon} className="size-3" strokeWidth={2} />
      </button>
    </li>
  );
}

function formatBytes(n: number): string {
 // The unit is picked after rounding: 1023.6 KB reads "1.0 MB", never "1024 KB" (upstream #26067).
  return n < 1024 ? `${n} B` : Math.round(n / 1024) < 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** A mode the composer is in (Grill, Goal): the action's glyph and word; clicking it leaves the mode. */
function ModeChip({ icon, label, title, onClear }: { icon: IconSvgElement; label: string; title: string; onClear: () => void }) {
  return (
    <button
      type="button"
      onClick={onClear}
      title={title}
      aria-label={`${label} on. Turn off`}
      className="group/chip inline-flex h-7 items-center gap-1.5 rounded-md bg-accent pl-1.5 pr-2 text-[13px] text-foreground outline-none transition-colors duration-75 hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon icon={icon} className="size-4" />
      <span data-compact-hide="">{label}</span>
      <Icon icon={Cancel01Icon} className="size-3 text-muted-foreground group-hover/chip:text-foreground" strokeWidth={2} />
    </button>
  );
}

/** The bar's status glyph for the context window: a 16px ring filled to the share used (warning from 85%). */
/**
 * The session's usage in its own tooltip: tokens, and on a plan its windows. Never dollars, so not
 * Claude's monthly spend budget either: that window stays in Settings.
 */
const usageLine = (tokens: number | undefined, windows: EngineDescriptor["usage_limits"]): string | undefined => {
  const used = planWindows(windows?.filter((w) => w.id !== "monthly_spend"));
  const parts = [tokens ? `${compact(tokens)} tokens this session` : "", used.length > 0 ? `plan used: ${used.join(" · ")}` : ""].filter(Boolean);
  return parts.length > 0 ? parts.join("; ") : undefined;
};

function ContextRing({ used, window, compactAt, usage, onOpen }: { used: number; window: number; compactAt?: number; usage: string | undefined; onOpen: (() => void) | undefined }) {
  const pct = Math.min(100, Math.round((used / window) * 100));
  const compacts = compactAt === undefined ? "" : `. Compacts automatically at about ${compactAt.toLocaleString("en-US")} tokens`;
  const label = `Context: ${pct}% of the window used${compacts}${usage ? `. ${usage[0]!.toUpperCase()}${usage.slice(1)}` : ""}`;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      title={label}
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ProgressRing percent={pct} arcClassName={pct >= 85 ? "text-warning" : undefined} />
      {/* The number says what the ring is: a ring alone with a short arc reads as loading (Claude's "Context 7%"). */}
      <span aria-hidden className={cn("text-[11px] tabular-nums", pct >= 85 && "text-warning")}>{pct}%</span>
    </button>
  );
}
