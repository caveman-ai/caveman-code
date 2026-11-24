import type { Result, Settings } from "@caveman-app/session-protocol";

export type LidSummary = Result<"cloud.lid.summary">;
type LidChat = LidSummary["chats"][number];

/** What fixes a chat the lid keeps here, where one click does: the button its line carries. */
export type LidFix =
  /** Its agent's plan is not connected for Cloud: the same sign-in as Settings > Models & keys. */
  | { readonly kind: "connect"; readonly engine: "claude-agent" | "codex" }
  /** This Mac is not signed in to Caveman: Settings > Account. */
  | { readonly kind: "sign_in" }
  /** The plan is used up: Settings > Plan. */
  | { readonly kind: "plan" }
  /** Claude Agent and Codex chats were once set to stay here (Settings.move_other_engines false): turned back on. */
  | { readonly kind: "agents_on" };

/** One chat that does not carry on in Cloud when this Mac sleeps: what happens to it, why in a few words, and its fix. */
export interface LidLine {
  readonly session_id: string;
  readonly title: string;
  readonly tone: "pauses" | "stays";
  /** "Pauses" (it stops until this Mac wakes) or "Stays here" (it never runs in Cloud). */
  readonly what: "Pauses" | "Stays here";
  /** Why, in six words or fewer. */
  readonly why: string;
  readonly fix?: LidFix;
  /** The runtime's own sentence, for a hover: the short reason never loses what it knew. */
  readonly detail: string;
}

/** What the page knows of a chat beyond the runtime's summary: its agent, and the repositories and folders it works in. */
export interface LidChatFacts {
  readonly title: string;
  readonly engine: { readonly id: string; readonly label: string };
  /** A chat in several repositories or folders names each (WorkspaceView.sources). */
  readonly sources?: ReadonlyArray<unknown> | undefined;
  /** Its project is a plain folder on this Mac. */
  readonly folder?: boolean | undefined;
}

/** "Claude" for Claude Agent, "compact" for Codex: the plan an agent runs on, as its line and button name it. */
const PLAN_OF: Record<string, string> = { "claude-agent": "Claude", codex: "ChatGPT" };

/**
 * The runtime's reason for one chat (cloudLink/preflight.ts lidPlan, the lid's own words) as six words or fewer and
 * the one button that fixes it. Matched on the reason's own phrases; one the page does not know keeps a plain line
 * and its sentence on hover.
 */
function shortReason(reason: string, facts: LidChatFacts | undefined): { readonly why: string; readonly fix?: LidFix } {
  const engine = facts?.engine;
  const plan = engine ? PLAN_OF[engine.id] : undefined;
  if (/needs a login on Cloud/.test(reason)) return plan && (engine!.id === "claude-agent" || engine!.id === "codex") ? { why: `${plan} isn't connected`, fix: { kind: "connect", engine: engine!.id } } : { why: "its plan isn't connected" };
  if (/chats stay on this Mac when the lid closes/.test(reason)) return { why: `${engine?.label ?? "These"} chats turned off`, fix: { kind: "agents_on" } };
  if (/Sign in to Caveman first/.test(reason)) return { why: "not signed in to Caveman", fix: { kind: "sign_in" } };
  if (/neither can pay now/.test(reason)) return { why: "plan used up", fix: { kind: "plan" } };
  if (/don't move to Cloud computers yet/.test(reason)) return { why: "Caveman agent isn't in Cloud yet" };
  if (/runs no Cloud computers/.test(reason)) return { why: "Cloud turned off by your admin" };
  if (/isn't on GitHub/.test(reason)) return { why: facts?.folder ? "folder project" : "repository isn't on GitHub" };
  if (/Chief, setup chats/.test(reason)) return { why: "Chiefs and agents stay here" };
  if (/engine's chats stay on the computer/.test(reason)) return { why: `${engine?.label ?? "this agent"} runs only here` };
  if (/hasn't copied itself/.test(reason)) return { why: "saves after its next turn" };
  if (/isn't reaching Caveman/.test(reason)) return { why: "can't reach Caveman" };
  if (/didn't go into its copy/.test(reason)) return { why: "saving its changes again" };
  if (/uncommitted changes are|as many large files/.test(reason)) return { why: "uncommitted files too large" };
  return { why: "can't run in Cloud yet" };
}

const sentence = (text: string) => {
  const trimmed = text.trim().replace(/\.$/, "");
  return trimmed === "" ? "" : `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}.`;
};

/**
 * Settings > Computers, under "When this Mac sleeps": only the chats that will not carry on in Cloud, each with why
 * in a few words and its button where one click fixes it. Empty when every chat carries on. A chat in several
 * repositories, and one in a plain folder, stay here whatever the summary says: the lid keeps both (the runtime's
 * move check), so they are said first.
 */
export function lidLines(summary: LidSummary, factsOf: (sessionId: string) => LidChatFacts | undefined): ReadonlyArray<LidLine> {
  return summary.chats.flatMap((chat: LidChat): Array<LidLine> => {
    const facts = factsOf(chat.session_id);
    const title = facts?.title ?? "A chat";
    const detail = [chat.reason, chat.fix].filter((part): part is string => !!part).map(sentence).join(" ");
    const stays = (why: string): LidLine => ({ session_id: chat.session_id, title, tone: "stays", what: "Stays here", why, detail });
    const several = facts?.sources?.length ?? 0;
    if (several > 1) return [stays(`works in ${several} repositories`)];
    if (facts?.folder) return [stays("folder project")];
    if (chat.outcome === "continues" || chat.outcome === "continues_with_gaps") return [];
    const short = shortReason(chat.reason ?? "", facts);
    return [{ session_id: chat.session_id, title, tone: chat.outcome, what: chat.outcome === "pauses" ? "Pauses" : "Stays here", why: short.why, ...(short.fix ? { fix: short.fix } : {}), detail }];
  });
}

/**
 * Settings > Computers' "When this Mac sleeps", as the runtime decides it (C1): chats keep going in Cloud only while
 * they are saved to Caveman (sync_chats, or move_to_cloud until sync was answered; the spec/0135) and the lid's own
 * setting is not off. `unset` while neither is answered: nothing is saved and sleeping pauses chats, exactly as off.
 */
export function lidMoves(settings: Pick<Settings, "sync_chats" | "move_to_cloud"> | null | undefined): "on" | "off" | "unset" {
  const copies = settings?.sync_chats ?? settings?.move_to_cloud;
  if (copies === undefined) return "unset";
  return copies === true && settings?.move_to_cloud !== false ? "on" : "off";
}

/** What the dropdown writes: "Keep chats going in Cloud" needs them saved too, so it turns chat sync on; "Pause them" is the lid's alone. */
export const lidMovesWrite = (on: boolean): Partial<Settings> => (on ? { move_to_cloud: true, sync_chats: true } : { move_to_cloud: false });

/**
 * When the lid summary is read again (m-18): the lid's settings, and each chat's state and last change, so a chat that
 * starts or stops working, or moves, is said as it now is. A summary keyed on the list's length went stale.
 */
export function lidSummaryKey(
  settings: Pick<Settings, "sync_chats" | "move_to_cloud" | "move_other_engines"> | null | undefined,
  workspaces: ReadonlyArray<{ readonly sessionId: string | null; readonly state: string; readonly updatedAt: string; readonly computer: { readonly kind: string } }>,
): string {
  const chats = workspaces.map((w) => `${w.sessionId}:${w.state}:${w.computer.kind}:${w.updatedAt}`).sort();
  return [settings?.sync_chats, settings?.move_to_cloud, settings?.move_other_engines, ...chats].join("|");
}
/** The summary is read again at least this often while it shows: Cloud's side of it (its computers, the person's logins) changes on its own. */
export const LID_SUMMARY_REFRESH_MS = 30_000;
