// Where Review's Ask and Fix start their chat on the pull request's head: This Mac (its project's worktree), one of
// the person's Cloud computers that holds the repository (through Cloud's relay; the computer's runtime reads the
// pull request through Cloud and fetches its head), or a new Cloud computer for the repository (it opens on the
// Cloud page, which starts the chat once the computer runs).
import type { Params, PrSummary } from "@caveman-app/session-protocol";
import type { PendingStart } from "../../state/cloud.ts";
import type { ChatListSnapshot } from "../../state/sync/chat-list.ts";
import { liveRuntimes } from "../../state/sync/chats-view.ts";

export interface AskComputer {
  readonly runtimeId: string;
  readonly computerId: string;
  readonly name: string;
  /** Not online now: Ask wakes it, waits for its runtime, then starts the chat there. */
  readonly asleep: boolean;
}

export type AskWhere = { readonly kind: "here" } | ({ readonly kind: "computer" } & AskComputer) | { readonly kind: "new" };
export const ASK_HERE: AskWhere = { kind: "here" };

/**
 * Where an Ask on the Review page runs, as a person picks it: "This Mac" or "Cloud", bare. Cloud is the person's Cloud
 * computer that holds the repository, an awake one first (askComputers' order), else a new one; null when Cloud can
 * take none.
 */
export function askInCloud(computers: ReadonlyArray<AskComputer>, canMakeOne: boolean): AskWhere | null {
  const held = computers[0];
  if (held) return { kind: "computer", ...held };
  return canMakeOne ? { kind: "new" } : null;
}

/**
 * What an Ask or Fix in a chat's own pull request tab sends that chat, as the person's message: the pull request by
 * reference, the passage and where it came from, then their words. The chat already knows its work; no instructions.
 */
export function chatAskText(input: { readonly pr: Pick<PrSummary, "number" | "title" | "url">; readonly mode: "ask" | "fix"; readonly passage?: { readonly where: string; readonly quote: string } | undefined; readonly text: string }): string {
  const { pr, mode, passage, text } = input;
  const lines = [`${mode === "fix" ? "Fix in" : "About"} pull request #${pr.number} “${pr.title}” (${pr.url}):`];
  if (passage) {
    const quote = passage.quote.length > 1200 ? `${passage.quote.slice(0, 1200)}…` : passage.quote;
    lines.push("", `From ${passage.where}:`, ...quote.split("\n").map((l) => `> ${l}`));
  }
  const words = text.trim();
  lines.push("", words || (mode === "fix" ? "Fix this, then push it to the pull request." : "Explain this: what it does and why."));
  return lines.join("\n");
}

/** How long Ask waits for a computer it woke to come online before it says so. */
export const WAKE_WAIT_MS = 3 * 60_000;

/** `owner/name` from owner/name or a GitHub URL, lower case, for comparing. */
const repoKey = (repo: string) =>
  repo
    .trim()
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();

/**
 * The person's Cloud computers whose chats in Cloud's list are on `repo` (a computer holds one repository), awake ones
 * first, then by name, leaving out the runtimes this window already is and deleted computers. An asleep one is
 * offered too: Ask wakes it.
 */
export function askComputers(list: Pick<ChatListSnapshot, "chats" | "runtimes"> | null, repo: string, home: ReadonlyArray<string | null | undefined>): AskComputer[] {
  if (!list) return [];
  const want = repoKey(repo);
  const own = new Set(home.filter((id): id is string => typeof id === "string"));
  const holding = new Set([...list.chats.values()].filter((chat) => chat.repo !== undefined && repoKey(chat.repo) === want).map((chat) => chat.runtime_id));
  return [...list.runtimes.values()]
    .filter((r) => r.kind === "cloud" && r.computer_state !== "deleted" && !own.has(r.runtime_id) && holding.has(r.runtime_id))
    .map((r) => ({ runtimeId: r.runtime_id, computerId: r.computer_id, name: r.name || "A Cloud computer", asleep: !r.online }))
    .sort((a, b) => (a.asleep === b.asleep ? a.name.localeCompare(b.name) : a.asleep ? 1 : -1));
}

/**
 * The runtime of `computer` that is on line now, as Cloud's list says: the one it was picked as, or the one its
 * computer woke as (Cloud mints a new runtime id at every wake, so it is looked up by computer id). Undefined: none yet.
 */
export function onlineRuntime(runtimes: Pick<ChatListSnapshot, "runtimes">["runtimes"] | undefined, computer: Pick<AskComputer, "runtimeId"> & { readonly computerId?: string }): string | undefined {
  if (!runtimes) return undefined;
  if (runtimes.get(computer.runtimeId)?.online === true) return computer.runtimeId;
  return computer.computerId === undefined ? undefined : liveRuntimes(runtimes).get(computer.computerId)?.runtime_id;
}

/**
 * Resolves with the computer's runtime once Cloud's list says it is online (a computer Ask woke); rejects after
 * `timeoutMs` with the computer's name. Never polls: it hears the list's own updates.
 */
export function waitOnline(
  list: { readonly get: () => Pick<ChatListSnapshot, "runtimes"> | null; readonly subscribe: (listener: () => void) => () => void },
  computer: Pick<AskComputer, "runtimeId" | "name"> & { readonly computerId?: string },
  timeoutMs: number = WAKE_WAIT_MS,
): Promise<string> {
  const online = () => onlineRuntime(list.get()?.runtimes, computer);
  const now = online();
  if (now !== undefined) return Promise.resolve(now);
  return new Promise((resolve, reject) => {
    const done = (runtimeId: string | undefined, error?: Error) => {
      clearTimeout(timer);
      off();
      if (runtimeId === undefined) reject(error);
      else resolve(runtimeId);
    };
    const off = list.subscribe(() => {
      const up = online();
      if (up !== undefined) done(up);
    });
    // Cloud, never the computer's name (words.md): a person never meets one.
    const timer = setTimeout(() => done(undefined, new Error(`Cloud didn't wake within ${Math.round(timeoutMs / 60_000)} minutes.`)), timeoutMs);
  });
}

/** The engines a Cloud computer runs; another engine's chat goes to the Caveman engine there. */
export const CLOUD_ASK_ENGINES: ReadonlySet<string> = new Set(["caveman", "claude-agent", "codex"]);
export const cloudEngine = (engine: string) => (CLOUD_ASK_ENGINES.has(engine) ? engine : "caveman");

/** workspace.create for the chat on a Cloud computer: the repository by URL (its checkout is the computer's) and the pull request. */
export function prChatParams(input: { readonly pr: Pick<PrSummary, "repo" | "number">; readonly engine: string; readonly title: string; readonly task: string; readonly requestId: string }): Params<"workspace.create"> {
  return {
    request_id: input.requestId,
    repo: { url: `https://github.com/${input.pr.repo}` },
    engine: cloudEngine(input.engine) as NonNullable<Params<"workspace.create">["engine"]>,
    title: input.title,
    task: { text: input.task },
    pull_request: { number: input.pr.number },
  };
}

/** What the Cloud page starts on the new computer once it runs (state/cloud.ts pendingStartParams). */
export function prPendingStart(computerId: string, input: { readonly pr: Pick<PrSummary, "repo" | "number">; readonly engine: string; readonly title: string; readonly task: string }): Omit<PendingStart, "from_link"> {
  return { computer_id: computerId, repo: input.pr.repo, engine: cloudEngine(input.engine), task: input.task, title: input.title, pull_request: input.pr.number };
}

/**
 * The chat on one of the person's Cloud computers: an asleep one (as Cloud's list says now, not when it was picked) is
 * woken first and the chat made once its runtime is up; then `create` makes it there (through the relay).
 */
export async function startOnComputer<T>(input: {
  readonly computer: AskComputer;
  readonly list: Parameters<typeof waitOnline>[0] | null;
  readonly resume: ((computerId: string) => Promise<void>) | undefined;
  readonly create: (runtimeId: string) => Promise<T>;
  readonly waitMs?: number;
}): Promise<T> {
  const runtimes = input.list?.get()?.runtimes;
  const up = onlineRuntime(runtimes, input.computer);
  if (up !== undefined) return input.create(up);
  if (runtimes?.has(input.computer.runtimeId) || input.computer.asleep) {
    if (!input.resume || !input.list) throw new Error("Cloud can't be reached from this device.");
    await input.resume(input.computer.computerId);
    // The runtime it wakes as: a new id at every wake.
    return input.create(await waitOnline(input.list, input.computer, input.waitMs));
  }
  return input.create(input.computer.runtimeId);
}
