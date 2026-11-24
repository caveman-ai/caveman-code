// What a moved chat needs where it lands, beyond its copy (moves.ts) and its engine's own session (nativeSessions.ts):
// the turn a move cut short, told to the engine instead of re-run blind; for a Claude Agent or Codex chat whose own
// session missed turns that ran on another computer, those turns told to it with its next message (K15); and, for one
// whose own session could not come along or would not resume, its conversation handed to the engine as context (upstream
// context handoff of an imported thread: ContextHandoffService.prepareLegacyImport, the `create_with_handoff`
// transition).
import * as path from "node:path";

import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
  type ThreadId,
} from "@caveman-app/protocol";
import type { SessionEvent } from "@caveman-app/session-protocol";
import * as DateTime from "effect/DateTime";

import { conversationSummary } from "../orchestration-v2/ContextHandoffService.ts";
import { secretShapedPath } from "../session-protocol/lifecycle.ts";
import { intentsParagraph, MAY_HAVE_RUN, type ToolIntent } from "./toolIntents.ts";

/** The engines whose chats move with their CLI's own session file, and that file's kind. */
export const NATIVE_KIND = { "claude-agent": "claude", codex: "codex" } as const;
export type NativeEngine = keyof typeof NATIVE_KIND;
export const isNativeEngine = (engine: string): engine is NativeEngine => engine === "claude-agent" || engine === "codex";
/** upstream driver for each (the provider thread an adopted chat resumes on). */
export const NATIVE_DRIVER: Record<NativeEngine, string> = { "claude-agent": "claudeAgent", codex: "codex" };
export const ENGINE_LABEL: Record<string, string> = { caveman: "Caveman", "claude-agent": "Claude Agent", codex: "Codex" };

/**
 * Why This Mac cannot take a Claude Agent or Codex chat moved onto it, from the provider snapshot of the engine's
 * account a chat runs on here (the active one, else the engine's own instance): the CLI is not installed, or not
 * signed in, in the provider's own words with the fix ("Claude Agent is not authenticated. Run `claude auth login` and
 * try again."). Undefined when it can, or when nothing says it can't (no snapshot, a probe still running, a login it
 * could not read): the chat then comes, and its turn says what failed.
 */
export function engineLoginRefusal(
  engine: NativeEngine,
  snapshots: ReadonlyArray<{ readonly instanceId: string } & Pick<ServerProvider, "installed" | "auth" | "message" | "probePending">>,
  instance: { readonly active: string; readonly own: string },
): string | undefined {
  const snapshot = snapshots.find((p) => p.instanceId === instance.active) ?? snapshots.find((p) => p.instanceId === instance.own);
  if (snapshot === undefined || snapshot.probePending === true) return undefined;
  if (snapshot.installed && snapshot.auth.status !== "unauthenticated") return undefined;
  return snapshot.message ?? `${ENGINE_LABEL[engine]} is not signed in.`;
}

/** A turn a move cut short: it started, and the copy has no end for it. */
export interface OpenTurn {
  /** The cursor of its turn.started. */
  readonly started: number;
  /** The cursor of the last event the copy has of it. */
  readonly end: number;
  /** What the person asked in it (its user message), when the copy has it. */
  readonly asked?: string;
  /** Who wrote that message when it was not the person (another chat's agent): the thread's title. */
  readonly from?: string;
  /** The tools it ran, in order, with how each ended and the cursor it ended at (absent: still running when it moved). */
  readonly tools: ReadonlyArray<{ readonly title: string; readonly status?: "completed" | "failed" | "declined"; readonly done?: number; readonly item?: string }>;
}

/** The last turn in `events` that started and has no turn.done, if any; `ended`: the last turn, ended or not. */
export function openTurn(events: ReadonlyArray<SessionEvent>, ended = false): OpenTurn | undefined {
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const type = events[i]!.type;
    if (type === "turn.done" && !ended) return undefined;
    if (type === "turn.started") {
      start = i;
      break;
    }
  }
  if (start < 0) return undefined;
  const turn = events.slice(start);
  const tools = new Map<string, { title: string; status?: "completed" | "failed" | "declined"; done?: number; item?: string }>();
  let asked: string | undefined;
  let from: string | undefined;
  for (const event of turn) {
    if (event.type === "message.done" && event.payload.role === "user" && asked === undefined) {
      asked = event.payload.text;
      from = event.payload.from?.title;
    }
    if (event.type === "tool.started") tools.set(event.item_id ?? `${event.cursor}`, { title: event.payload.title || event.payload.name, ...(event.item_id !== undefined ? { item: event.item_id } : {}) });
    if (event.type === "tool.done") {
      const tool = tools.get(event.item_id ?? "");
      if (tool) {
        tool.status = event.payload.status;
        tool.done = event.cursor;
      }
    }
  }
  return { started: events[start]!.cursor, end: events.at(-1)!.cursor, ...(asked !== undefined ? { asked } : {}), ...(from !== undefined ? { from } : {}), tools: [...tools.values()] };
}

/** At most this many tools are listed by name; the rest are counted. */
const LISTED_TOOLS = 20;

/**
 * The turn an adopt carries on, told what already ran (restartNote): the copy's open turn, or, for a copy that says its
 * move stopped the turn (`interrupted`), its last one. Never a turn the person moved by hand (decision 29, "Stop this
 * turn and move": the copy's last park, its own computer's, says cause "user"): that turn ends where it stopped, even
 * when the copy holds no end for it (its computer's journal had not caught up with the stop when the copy left).
 */
export function turnToCarry(events: ReadonlyArray<SessionEvent>, interrupted: boolean): OpenTurn | undefined {
  const park = events.findLast((e) => e.type === "session.parked" || e.type === "session.resumed");
  const payload = park?.type === "session.parked" ? (park.payload as { reason?: string; cause?: string }) : undefined;
  if (payload?.reason === "move" && payload.cause === "user") return undefined;
  return openTurn(events) ?? (interrupted ? openTurn(events, true) : undefined);
}

/**
 * What the engine is told where a moved chat lands, for the turn the move cut short: that it moved, what already ran
 * (so nothing runs twice by accident) and to carry on. `filesAt`: the cursor the work in progress that came along was
 * taken at (mergeBundles `wip_at`). Before the turn began, nothing the turn changed is here, so it runs again from the
 * person's message; within it (a running turn's copy, decision 25), the tools that ended by then have their effects
 * here and the rest are named as not having reached this checkout; at its end, or not known, all of it is here.
 * `cause` "offline": the runtime stopped it here, losing Caveman (decision 26), and the files are as the tools left them;
 * "stopped": it stopped it here at a tool boundary before its Cloud computer went to sleep, the same; "rebuilt": the chat
 * did not move, its Cloud computer came back without it and took it from its copy, files and all.
 * `intents`: the steps the copy says were about to run and holds no result for (toolIntents.ts, R11): a tool of the
 * turn among them is said to have maybe finished, and one the copy holds no event of is named after the rest, so no
 * command or outside tool runs a second time without the engine being told it may already have run.
 */
export function restartNote(
  turn: OpenTurn,
  options: { readonly filesAt?: number | undefined; readonly cause?: "moved" | "offline" | "stopped" | "rebuilt"; readonly intents?: ReadonlyArray<ToolIntent> } = {},
): string {
  const intended = new Set((options.intents ?? []).flatMap((intent) => intent.items));
  const list = (tools: OpenTurn["tools"]) =>
    [
      ...tools
        .slice(0, LISTED_TOOLS)
        .map((t) => `- ${t.title.replace(/\s+/g, " ").slice(0, 160)} (${t.status ?? (t.item !== undefined && intended.has(t.item) ? MAY_HAVE_RUN : "stopped before it finished")})`),
      ...(tools.length > LISTED_TOOLS ? [`- and ${tools.length - LISTED_TOOLS} more`] : []),
    ].join("\n");
  // Steps the copy holds an intent for and no event of: they began after its last event.
  const shown = new Set(turn.tools.flatMap((t) => (t.item !== undefined ? [t.item] : [])));
  const unseen = intentsParagraph((options.intents ?? []).filter((intent) => !intent.items.some((id) => shown.has(id))));
  // Said as whose it was: a message another chat's agent wrote is never put to the engine as the person's own.
  const asked =
    turn.asked === undefined ? undefined : turn.from !== undefined ? `The message that started it, from ${turn.from.replace(/\s+/g, " ").slice(0, 160)} (not the person):\n${turn.asked}` : `The person asked:\n${turn.asked}`;
  if (options.cause === "offline" || options.cause === "stopped")
    return [
      options.cause === "stopped"
        ? "[Caveman Code] Your last turn stopped when this computer went to sleep, and continues now."
        : "[Caveman Code] Your last turn stopped when this computer lost its connection to Caveman, and continues now.",
      turn.tools.length > 0 ? `These tools already ran before it stopped; their effects on files are here:\n${list(turn.tools)}` : unseen !== undefined ? "No tool had finished." : "No tool had run yet.",
      ...(unseen !== undefined ? [unseen] : []),
      ...(asked !== undefined ? [asked] : []),
      "Carry on from where it stopped. Don't run a command again unless you need its result again.",
    ].join("\n\n");
  const filesAt = options.filesAt;
  // A computer rebuilt from the chat's copy is the same computer: what ran, ran before it lost its disk.
  const rebuilt = options.cause === "rebuilt";
  const headline = rebuilt
    ? "[Caveman Code] This computer was rebuilt from this chat's last copy in the middle of your last turn, and the chat continues here."
    : "[Caveman Code] This chat moved to another computer in the middle of your last turn, and continues here.";
  if (filesAt !== undefined && filesAt < turn.started)
    return [
      headline,
      "The files here are as they were when that turn began: nothing it changed came along.",
      turn.tools.length > 0
        ? `These tools ran ${rebuilt ? "before the rebuild" : "on the other computer"}, and their effects on files are not in this checkout:\n${list(turn.tools)}`
        : unseen !== undefined
          ? "No tool had finished when this chat was last copied."
          : "No tool had run yet.",
      ...(unseen !== undefined ? [unseen] : []),
      asked !== undefined ? `Do that turn again from the start. ${asked}` : "Do that turn again from the start.",
    ].join("\n\n");
  // Taken within the turn: a tool that ended after that, or never ended, went on changing files that never came along.
  const within = filesAt !== undefined && filesAt < turn.end;
  const here = within ? turn.tools.filter((t) => t.done !== undefined && t.done <= filesAt) : turn.tools;
  const after = within ? turn.tools.filter((t) => !(t.done !== undefined && t.done <= filesAt)) : [];
  return [
    headline,
    here.length > 0
      ? `These tools already ran before the ${rebuilt ? "rebuild" : "move"}; their effects on files are in this checkout:\n${list(here)}`
      : after.length > 0
        ? "No tool had finished when its files were last copied."
        : unseen !== undefined
          ? "No tool had finished when this chat was last copied."
          : "No tool had run yet.",
    ...(after.length > 0 ? [`These tools ran after its files were last copied, so their file changes didn't reach this checkout; redo what you still need:\n${list(after)}`] : []),
    ...(unseen !== undefined ? [unseen] : []),
    // A turn the queue started can be cut before the engine kept the person's message: it is said again here.
    ...(asked !== undefined ? [asked] : []),
    "Carry on from where it stopped. Don't run a command again unless you need its result again.",
  ].join("\n\n");
}

/**
 * What the engine is told where a chat lands whose copy holds the person's message of a running turn, no event of that
 * turn, and intents with no result (toolIntents.ts): the turn runs again from the message, and each of those steps may
 * already have run. Without intents the message alone runs again, as it always did.
 */
export function rerunNote(pending: string, intents: ReadonlyArray<ToolIntent>, rebuilt = false): string {
  const unseen = intentsParagraph(intents);
  if (unseen === undefined) return pending;
  return [
    rebuilt
      ? "[Caveman Code] This computer was rebuilt from this chat's last copy in the middle of your last turn, and the chat continues here."
      : "[Caveman Code] This chat moved to another computer in the middle of your last turn, and continues here.",
    unseen,
    `The person asked:\n${pending}`,
    "Do that turn again from the start, checking those steps first.",
  ].join("\n\n");
}

/**
 * The conversation as the transcript has it (each user and assistant message), for a context handoff. `from`: another
 * chat's agent, or an outside one, wrote that user-role message (mail it ran, from this Mac or another): never the
 * person's words, wherever the conversation is handed (F-7, THREAT-MODEL T18).
 */
export function transcriptMessages(
  events: ReadonlyArray<SessionEvent>,
): ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string; readonly at: string; readonly from?: string }> {
  return events.flatMap((event) =>
    event.type === "message.done" && event.payload.text.trim() !== ""
      ? [{ role: event.payload.role, text: event.payload.text, at: event.at, ...(event.payload.role === "user" && event.payload.from !== undefined ? { from: event.payload.from.title } : {}) }]
      : [],
  );
}

/**
 * What a chat whose own engine session did not resume runs again on the new session it hands its conversation to: the
 * failed turn's first message when the person wrote it; never one another agent wrote (mail the chat was running), which
 * would run there as the person's own turn (F-7, THREAT-MODEL T18): that one is named instead, for the chat to say so.
 */
export function rerunAfterHandover(turn: ReadonlyArray<SessionEvent>): { readonly text: string } | { readonly from: string } | undefined {
  const asked = turn.find((e) => e.type === "message.done" && e.payload.role === "user");
  if (asked?.type !== "message.done") return undefined;
  return asked.payload.from !== undefined ? { from: asked.payload.from.title } : { text: asked.payload.text };
}

/** How a handoff names a message another agent wrote: whose it was, and that it was not the person (F-7). */
export const agentMessageLabel = (from: string) => `Message from ${from.replace(/\s+/g, " ").slice(0, 160)}, another agent (not the person)`;

/**
 * The turns a chat's own engine session never saw, as the runtime tells it with its next message (K15): the session
 * carried on where this computer left it while the chat ran on a Cloud computer, so what the transcript holds after
 * that is put before the person's words. Written here from the transcript, never from another computer's session
 * file. undefined when none of those turns said anything.
 */
export function elsewhereContext(events: ReadonlyArray<SessionEvent>): string | undefined {
  const messages = transcriptMessages(events);
  if (messages.length === 0) return undefined;
  return conversationSummary(
    "[Caveman Code] While this chat ran on a Cloud computer, the conversation went on there without this session. Here is what was said there, as context: don't repeat it, and don't do again what it says was done, unless the person asks.",
    messages.map((m) => ({ label: m.from !== undefined ? agentMessageLabel(m.from) : m.role === "user" ? "User" : "Assistant", body: m.text })),
  );
}

/** The person's message with what its engine session missed in front, as T3 puts a context handoff before one. */
export const withElsewhereContext = (context: string, text: string) => `${context}\n\nUser message:\n${text}`;

const PREFIX = "caveman-move-handoff:v1";

/**
 * T3 events for a thread that starts from `messages` handed over as context: an imported thread (historyOrigin
 * v1_import) holding them as completed turn items and no engine session, so its first run creates one with the whole
 * conversation as a context handoff (Orchestrator: legacyImportRecoveryHandoff).
 */
export function handoffThreadEvents(input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly messages: ReturnType<typeof transcriptMessages>;
  readonly now: string;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const created = DateTime.makeUnsafe(input.messages[0]?.at ?? input.now);
  const updated = DateTime.makeUnsafe(input.now);
  const thread: OrchestrationV2AppThread = {
    createdBy: "system",
    creationSource: "server",
    id: input.threadId,
    projectId: input.projectId,
    title: input.title,
    providerInstanceId: input.modelSelection.instanceId,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: input.branch,
    worktreePath: input.worktreePath,
    linkedPullRequest: null,
    branchPullRequest: null,
    activeProviderThreadId: null,
    historyOrigin: "v1_import",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
    forkedFrom: null,
    createdAt: created,
    updatedAt: updated,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const events: Array<OrchestrationV2DomainEvent> = [
    { id: EventId.make(`${PREFIX}:thread:${input.threadId}`), type: "thread.created", threadId: input.threadId, providerInstanceId: input.modelSelection.instanceId, occurredAt: created, payload: thread },
  ];
  input.messages.forEach((m, index) => {
    const suffix = String(index).padStart(6, "0");
    const at = DateTime.makeUnsafe(m.at);
    const messageId = MessageId.make(`${input.threadId}:moved:${suffix}`);
    // Another agent's message stays its: authored by an agent, and said as whose it was (F-7).
    const text = m.from !== undefined ? `[${agentMessageLabel(m.from)}]\n${m.text}` : m.text;
    const createdBy = m.role === "user" && m.from === undefined ? "user" : "agent";
    const message: OrchestrationV2ConversationMessage = {
      createdBy,
      creationSource: "server",
      id: messageId,
      threadId: input.threadId,
      runId: null,
      nodeId: null,
      role: m.role,
      text,
      attachments: [],
      streaming: false,
      createdAt: at,
      updatedAt: at,
    };
    const common = {
      id: TurnItemId.make(`${PREFIX}:turn-item:${input.threadId}:${suffix}`),
      threadId: input.threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: index + 1,
      status: "completed" as const,
      title: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
    };
    const item: OrchestrationV2TurnItem =
      m.role === "user"
        ? { ...common, createdBy, creationSource: "server", type: "user_message", messageId, inputIntent: "turn_start", text, attachments: [] }
        : { ...common, type: "assistant_message", messageId, text: m.text, streaming: false };
    events.push(
      { id: EventId.make(`${PREFIX}:message:${input.threadId}:${suffix}`), type: "message.updated", threadId: input.threadId, occurredAt: at, payload: message },
      { id: EventId.make(`${PREFIX}:turn-item:${input.threadId}:${suffix}`), type: "turn-item.updated", threadId: input.threadId, occurredAt: at, payload: item },
    );
  });
  return events;
}

/**
 * Folders whose files make an agent, an editor or a tool on This Mac run code or change what it may do (S-R1), at any
 * depth: Caveman's own (.caveman: a computer's [setup] and [archive] runs, actions, automations, agents), the
 * repository's skills and plugin marketplaces Codex, the Caveman engine and the plugin registry read (.agents,
 * .claude-plugin, .cursor-plugin), git hook managers' (.husky) and a dev container's.
 */
const CONFIG_DIRS = new Set([".claude", ".codex", ".cursor", ".vscode", ".idea", ".caveman", ".agents", ".claude-plugin", ".cursor-plugin", ".husky", ".devcontainer"]);
/**
 * Files that do the same: MCP servers, direnv, a dev container, and git hook managers that run on the next commit
 * (pre-commit; lefthook in each format it reads, dotted or not, `-local` too, and under .config/).
 */
const CONFIG_FILES = /^(\.mcp\.json|\.envrc|\.devcontainer\.json|\.pre-commit-config\.ya?ml|\.?lefthook(-local)?\.(ya?ml|toml|jsonc?))$/;
/** `.git*` entries that are inert: GitHub's CI config (it runs on GitHub, not here) and ignore lists. */
const INERT_GIT = new Set([".github", ".gitignore", ".gitkeep"]);

/**
 * Whether a path in a chat's work in progress is one that makes an agent or a tool on This Mac run code, or tells it
 * what to do, without asking (Caveman Cloud review S-R1): `.claude/**`, `.codex/**`, `.cursor/**`, `.vscode/**`,
 * `.idea/**`, `.caveman/**`, `.agents/**`, `.claude-plugin/**`, `.cursor-plugin/**`, `.husky/**`, `.devcontainer/**`,
 * `.mcp.json`, `.envrc`, `.devcontainer.json`, `.pre-commit-config.yaml`, `lefthook.yml` (and its other formats),
 * `.git*` config and hooks, and `CLAUDE*.md` / `AGENTS*.md` instructions.
 */
export function agentConfigPath(file: string): boolean {
  const parts = file.split("/").filter((p) => p !== "");
  const base = parts.at(-1) ?? "";
  if (parts.some((p) => CONFIG_DIRS.has(p))) return true;
  if (CONFIG_FILES.test(base)) return true;
  if (parts.some((p) => p.startsWith(".git") && !INERT_GIT.has(p))) return true;
  return /^(CLAUDE|AGENTS)[^/]*\.md$/i.test(base);
}

/** Git modes that are not a plain file: a symlink (120000) or a submodule link (160000). */
const LINK_MODES = new Set(["120000", "160000"]);

/**
 * The paths `git diff --raw -z <from> <to>` lists that a return to This Mac holds back until the person accepts them:
 * agent and tool config (agentConfigPath), any symlink or submodule link on either side, everything in `hooksDir`,
 * the folder inside the tree This Mac's core.hooksPath names (a team's `tools/hooks`), whose files git runs as hooks,
 * and secret-shaped files (lifecycle.ts SECRET_SHAPED): a Cloud computer's edit to a tracked `.env.example` comes back
 * with the chat (A-5), but a `.env` read by a tool here can run code or point it elsewhere, so the person looks first.
 */
export function heldBackPaths(rawZ: string, hooksDir?: string): ReadonlyArray<string> {
  const fields = rawZ.split("\0");
  const held = new Set<string>();
  const inHooks = (file: string) => hooksDir !== undefined && file.startsWith(`${hooksDir}/`);
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i]!;
    const file = fields[i + 1]!;
    if (!meta.startsWith(":")) continue;
    const [srcMode = "", dstMode = ""] = meta.slice(1).split(" ");
    if (agentConfigPath(file) || secretShapedPath(file) || inHooks(file) || LINK_MODES.has(srcMode) || LINK_MODES.has(dstMode)) held.add(file);
  }
  return [...held].sort();
}

/** How the chat's note names what a return held back: agent and tool config, secret-shaped files, or both. */
export function heldWords(paths: ReadonlyArray<string>): { readonly title: string; readonly why: string } {
  const secrets = paths.some(secretShapedPath);
  const config = paths.some((file) => !secretShapedPath(file));
  if (secrets && !config) return { title: "Cloud changed files that look like secrets: review before they apply here", why: "look like secrets, which tools here read as settings" };
  if (secrets) return { title: "Cloud changed agent settings and files that look like secrets: review before they apply here", why: "make an agent or a tool run code, or look like secrets" };
  return { title: "Cloud changed agent settings: review before they apply here", why: "make an agent or a tool run code" };
}

/**
 * The folder a core.hooksPath value names inside a worktree, as a path relative to its root (git runs relative hooks
 * from there); undefined for none, an absolute or home path, or one outside or at the root of the tree.
 */
export function hooksDirInTree(hooksPath: string): string | undefined {
  const dir = hooksPath.trim().replace(/\\/g, "/");
  if (dir === "" || dir.startsWith("/") || dir.startsWith("~") || /^[A-Za-z]:\//.test(dir)) return undefined;
  const rel = path.posix.normalize(dir).replace(/\/+$/, "");
  return rel === "." || rel === ".." || rel.startsWith("../") ? undefined : rel;
}
