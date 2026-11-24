/**
 * A Chief's engine profile (Caveman Code's coordinators; runtime chief/). A
 * runtime has one or more Chiefs, each its own thread. A Chief runs on the
 * Caveman engine, on Claude Agent or on Codex,
 * with only its own tools: in-process functions the runtime hands the engine
 * here (declared directly to the Caveman engine, an in-process MCP server under
 * Claude Code, dynamic tools under Codex), and no file, shell or browser tools.
 *
 * Each of those adapters reads it with `Effect.serviceOption` when a session opens: a
 * thread with a profile is the Chief's, and gets exactly this prompt and these
 * tools. A host without the service has no Chief.
 *
 * @module engine-core/server/ChiefSessions
 */
import type { ProviderDriverKind, ProviderSessionId, ThreadId } from "@caveman-app/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProviderAdapterOpenSessionError } from "./ProviderAdapter.ts";

import type { InstructionSection } from "./SessionPlugins.ts";

/** What the engine knows of one call of a Chief tool. */
export interface ChiefToolCall {
  /** The provider's id for this call. */
  readonly callId: string;
  /** The app run (Session Protocol turn) the call belongs to. */
  readonly runId: string;
  /** Stable across a resumed run's replay of the same call: an idempotency key. Absent off a durable run. */
  readonly idempotencyKey?: string;
}

export interface ChiefTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema (draft-07) of its input object. */
  readonly input: Readonly<Record<string, unknown>>;
  /**
   * Runs the call for the thread that made it: its answer for the model (text,
   * or a value sent as JSON). A rejected promise is the tool's failure, its
   * message what the model reads.
   */
  readonly run: (threadId: ThreadId, input: unknown, call: ChiefToolCall) => Promise<unknown>;
}

export interface ChiefProfile {
  /** The Chief's own system text: a constant, first in the prefix. */
  readonly instructions: string;
  /** After it, in this order: that Chief's soul, its projects, then the memory brief. */
  readonly sections: ReadonlyArray<InstructionSection>;
  /** Every tool it has, declared in this order. */
  readonly tools: ReadonlyArray<ChiefTool>;
}

/**
 * A Chief's system text, cache-stable by construction: its own constant text, then its
 * sections (its soul, its projects, the memory brief) as `# title` blocks, in order. The
 * same on every engine it runs on (the Caveman engine, Claude Agent, Codex).
 */
export const chiefInstructions = (profile: Pick<ChiefProfile, "instructions" | "sections">) =>
  [profile.instructions.trim(), ...profile.sections.flatMap((s) => (s.text.trim() === "" ? [] : [`# ${s.title}\n\n${s.text.trim()}`]))].join("\n\n");

export class ChiefSessions extends Context.Service<
  ChiefSessions,
  {
    /**
     * The profile of whichever Chief owns `threadId`, else undefined. It fails when the host can't tell
     * yet, or the thread is a removed Chief's: the session must not open then, never open as a coding session.
     */
    readonly profile: (threadId: ThreadId) => Effect.Effect<ChiefProfile | undefined, Error>;
  }
>()("@caveman-app/engine-core/server/ChiefSessions") {}

/** Why an engine with no Chief mode refuses a Chief's thread. */
export const CHIEF_ENGINE_REFUSAL = "A Chief runs only on the Caveman engine, Claude Agent or Codex: this engine has its own shell and file tools.";

/**
 * For an adapter with no Chief mode, before a session opens: a Chief's thread fails here, so it never opens as a
 * coding session with that engine's own tools. Fails closed, as the Chief's own adapters do: a thread the host can't
 * place yet fails too.
 */
export const refuseChiefThread = (
  sessions: Option.Option<ChiefSessions["Service"]>,
  input: { readonly driver: ProviderDriverKind; readonly threadId: ThreadId; readonly providerSessionId: ProviderSessionId },
): Effect.Effect<void, ProviderAdapterOpenSessionError> =>
  Option.isNone(sessions)
    ? Effect.void
    : sessions.value.profile(input.threadId).pipe(
        Effect.flatMap((profile) => (profile === undefined ? Effect.void : Effect.fail(new Error(CHIEF_ENGINE_REFUSAL)))),
        Effect.mapError((cause) => new ProviderAdapterOpenSessionError({ driver: input.driver, providerSessionId: input.providerSessionId, cause })),
      );
