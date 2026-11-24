// chat.find: a fast, cheap model picks the chat a person means from what chat.search found (⌘K's Ask).
//
// chat.search does the reading: its best chats by words and meaning, each with its best places, and the most recent
// chats besides, by title, so "the one from yesterday about the sidebar" has something to land on. The model reads a
// line or three per chat, numbered, and answers with numbers and a reason: a few thousand tokens in, a few dozen out,
// about a second and a half of model time on Claude Haiku, plus the CLI's start. It runs on the review guides' writers (rankReviewGuideWriters): a subscription
// before a key, the cheapest model first, never a frontier one; one that fails falls to the next.
import type {
  ChatFindInput,
  ChatFindResult as Picked,
} from "@caveman-app/engine-core/server/textGeneration";
import {
  type ModelSelection,
  type ServerProvider,
  type ServerSettings,
  TextGenerationError,
} from "@caveman-app/protocol";
import type {
  ChatFindResult,
  ChatSearchHit,
  ChatSearchPassage,
  Workspace,
} from "@caveman-app/session-protocol";
import {
  rankReviewGuideWriters,
  resolveSourceControlWriterModelSelection,
} from "@caveman-app/shared/serverSettings";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

/**
 * Chats chat.search found that the model reads (below these its answer is noise), and the most recent chats
 * besides, by title alone. More candidates make a small model deliberate longer, which is most of the wait.
 */
const FOUND = 20;
const RECENT = 24;
/** Found places per chat, its best first. */
const PLACES = 2;
/** Writers tried before the person is told it failed: one that fails mostly fails at once (signed out, no quota). */
const TRIES = 3;

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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A day as the person says it, in this computer's time: "Tue 2026-11-03". */
export const day = (at: Date) =>
  `${WEEKDAYS[at.getDay()]} ${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;

/** What the model reads: chat.search's best chats, then the most recent of the person's other chats, none twice. */
export function chatFindCandidates(
  found: ReadonlyArray<ChatSearchHit>,
  workspaces: ReadonlyArray<Workspace>,
): ReadonlyArray<ChatSearchHit> {
  const best = found.slice(0, FOUND);
  const seen = new Set(best.map((hit) => hit.workspace.id));
  const recent = workspaces
    // Setup chats and automation steps are not chats the person keeps; the sidebar leaves them out too.
    .filter(
      (w) =>
        !seen.has(w.id) &&
        w.status !== "archived" &&
        w.kind !== "setup" &&
        w.automation === undefined,
    )
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, RECENT)
    .map((workspace): ChatSearchHit => ({ workspace, passages: [], more: 0 }));
  return [...best, ...recent];
}

/** One chat as the model reads it: its title; where, on what and when; the places its words matched. */
export function describeChat(
  hit: ChatSearchHit,
  projectName: (id: string) => string | undefined,
): ChatFindInput["chats"][number] {
  const w = hit.workspace;
  const repo = "path" in w.repo ? w.repo.path : w.repo.url;
  const where =
    w.kind === "chief"
      ? "Chief"
      : (w.project_id && projectName(w.project_id)) ||
        repo
          .replace(/[\\/]+$/, "")
          .split(/[\\/]/)
          .pop() ||
        repo;
  return {
    title: w.title,
    about: [
      where,
      w.engine,
      `last active ${day(new Date(w.updated_at))}`,
      w.status === "archived" ? "archived" : "",
    ]
      .filter(Boolean)
      .join(", "),
    places: hit.passages
      .filter((p) => p.kind !== "title")
      .slice(0, PLACES)
      .map((p) => `${SAID[p.kind]}: ${p.text}`),
  };
}

/** Who answers, best first: the guide models here (cheap, a plan before a key), else the writer for commits and titles. */
export function chatFindWriters(
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ModelSelection> {
  const cheap = rankReviewGuideWriters(settings, providers, null);
  return (
    cheap.length > 0 ? cheap : [resolveSourceControlWriterModelSelection(settings, providers, null)]
  ).slice(0, TRIES);
}

export interface ChatFindDeps {
  readonly search: (
    query: string,
    limit: number,
  ) => Effect.Effect<{ readonly chats: ReadonlyArray<ChatSearchHit> }>;
  readonly workspaces: Effect.Effect<ReadonlyArray<Workspace>>;
  readonly projects: Effect.Effect<ReadonlyArray<{ readonly id: string; readonly name: string }>>;
  readonly settings: Effect.Effect<ServerSettings>;
  readonly providers: Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly generate: (input: ChatFindInput) => Effect.Effect<Picked, TextGenerationError>;
  /** Where a run starts: a directory of the runtime's own, never a checkout. */
  readonly cwd: string;
}

/** The chats the person means, picked by the first writer that answers; fails with the last writer's reason. */
export const findChats = (deps: ChatFindDeps, query: string, now = new Date()) =>
  Effect.gen(function* () {
    const [found, workspaces, projects, settings, providers] = yield* Effect.all(
      [deps.search(query, FOUND), deps.workspaces, deps.projects, deps.settings, deps.providers],
      { concurrency: "unbounded" },
    );
    const chats = chatFindCandidates(found.chats, workspaces);
    const writers = chatFindWriters(settings, providers);
    if (chats.length === 0) return { chats: [], model: "", read: 0 } satisfies ChatFindResult;
    const names = new Map(projects.map((p) => [p.id, p.name]));
    const input = {
      cwd: deps.cwd,
      query,
      today: day(now),
      chats: chats.map((hit) => describeChat(hit, (id) => names.get(id))),
    };
    let failure: TextGenerationError | undefined;
    for (const modelSelection of writers) {
      const result = yield* Effect.result(deps.generate({ ...input, modelSelection }));
      if (Result.isFailure(result)) {
        failure = result.failure;
        yield* Effect.logWarning("chat.find: a writer failed; trying the next", {
          model: modelSelection.model,
          detail: failure.detail,
        });
        continue;
      }
      const provider = providers.find((p) => p.instanceId === modelSelection.instanceId);
      return {
        chats: result.success.picks.map(({ index, why }) => ({ ...chats[index]!, why })),
        model:
          provider?.models.find((m) => m.slug === modelSelection.model)?.name ??
          modelSelection.model,
        read: chats.length,
      } satisfies ChatFindResult;
    }
    return yield* (
      failure ??
        new TextGenerationError({
          operation: "findChats",
          detail: "No engine here can answer: sign in to one in Settings.",
        })
    );
  });
