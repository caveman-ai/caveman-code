// What delegate_task allows and which model a child starts on, decided by the
// runtime (Settings > Subagents), never by the prompt. The refusals are short:
// the model reads them as the tool's answer and should know what to do next.
// The token ceiling is enforced silently: no counts or costs reach the session.
import {
  isProviderNativeSubagentThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
  type SubagentSettings,
  type ThreadId,
} from "@caveman-app/protocol";
import * as Effect from "effect/Effect";

import type { AgentType } from "../agents/agentTypes.ts";
import { familyOf, isModelClass, modelForClass } from "../automations/classes.ts";
import { isRouterModel } from "../router/routerModel.ts";

export const ACTIVE_TASK_STATUSES: ReadonlySet<string> = new Set(["pending", "running", "waiting"]);

/** What an agent another agent started is told when it tries to start a chat of its own (a fresh root, outside the limits). */
export const DELEGATED_AGENT_STARTS_NO_THREADS =
  "An agent started by another agent cannot start new chats or scheduled tasks. Use delegate_task, which counts against this chat's limits.";

/** What an automation step (or check) is told when it tries to start work outside its run: that work would escape the run's wallet. */
export const AUTOMATION_STEP_STARTS_NO_THREADS =
  "An automation step cannot start chats, fork them, or start scheduled tasks or automation runs. Do the work in this step, or use delegate_task.";

/** What an automation step is told when it tries to change projects or environment settings, or run a scheduled task. */
export const AUTOMATION_STEP_CHANGES_NO_ENVIRONMENT =
  "An automation step cannot change projects or environment settings, or run scheduled tasks. Do the work in this step.";

/** What a thread in an automation run is told when it messages a thread outside its own step: a turn there would escape the run's wallet. */
export const AUTOMATION_STEP_MESSAGES_ONLY_ITS_OWN =
  "An automation step can message only its own thread and the agents delegated under it. Do the work in this step, or use delegate_task.";

/**
 * A thread an automation run started for a step or check (automations/steps.ts names them `automation:<run>.<step>.<n>`),
 * or one delegated under it.
 */
export const inAutomationRun = (thread: { readonly id: string; readonly lineage: { readonly rootThreadId: string } }): boolean =>
  thread.id.startsWith("automation:") || thread.lineage.rootThreadId.startsWith("automation:");

/** What run containment reads of a thread. */
export type RunThread = Pick<OrchestrationV2ThreadShell, "id" | "creationSource" | "lineage">;

/**
 * Whether a message `from` sends may reach `to`, where an idle thread starts a turn. A thread in an automation run
 * reaches only what its step's run pays for and stops with the step (automations/steps.ts `family`): the step's own
 * thread (`from` itself, else the root of its tree), and the agents delegate_task started under it, delegate by
 * delegate. A fork shares the step's root but is neither, and neither is anything under a fork. `to` is null for a
 * thread not on this computer, or none; `shell` reads each thread up its chain.
 */
export const messageStaysInRun = <E, R>(
  from: Pick<RunThread, "id" | "lineage">,
  to: RunThread | null,
  shell: (threadId: ThreadId) => Effect.Effect<RunThread | null, E, R>,
): Effect.Effect<boolean, E, R> =>
  Effect.gen(function* () {
    if (!inAutomationRun(from)) return true;
    const step = from.id.startsWith("automation:") ? from.id : from.lineage.rootThreadId;
    const seen = new Set<string>();
    let thread = to;
    while (thread !== null) {
      if (thread.id === step) return true;
      const parent = thread.lineage.parentThreadId;
      if (thread.lineage.relationshipToParent !== "subagent" || isProviderNativeSubagentThread(thread) || parent === null || seen.has(parent)) {
        return false;
      }
      seen.add(parent);
      thread = yield* shell(parent);
    }
    return false;
  });

/** Uncached input plus output of an agent's turns: what the tree ceiling counts. */
export function freshTokens(turns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "turnTokenUsage">>): number {
  let total = 0;
  for (const { turnTokenUsage: usage } of turns) {
    if (!usage) continue;
    total += Math.max(0, (usage.inputTokens ?? 0) - (usage.cachedInputTokens ?? 0)) + (usage.outputTokens ?? 0);
  }
  return total;
}

/**
 * Why a new delegation is refused, or undefined to allow it. One number says how many agents work at once under a
 * chat: Settings > Agents' (`limits.maxConcurrent`).
 */
export function delegationRefusal(
  limits: Pick<SubagentSettings, "maxDepth" | "maxConcurrent" | "treeTokenCeiling">,
  tree: { readonly callerDepth: number; readonly running: number; readonly tokens: number },
): string | undefined {
  if (tree.callerDepth + 1 > limits.maxDepth) {
    return `Not delegated: agents nest at most ${limits.maxDepth} levels deep and this one is at the limit. Do this part yourself.`;
  }
  if (tree.running >= limits.maxConcurrent) {
    return `Not delegated: ${limits.maxConcurrent} delegated agents are already working in this task. Wait for one to finish (its result wakes you), then delegate again.`;
  }
  if (limits.treeTokenCeiling > 0 && tree.tokens >= limits.treeTokenCeiling) {
    return "Not delegated: the agents in this task have used their budget. Finish the work yourself, or tell the user what is left.";
  }
  return undefined;
}

/**
 * The model a class or alias resolves beside. Auto (the Caveman router, or the Caveman engine's `auto`) has
 * no family of its own, so it anchors on the engine's own models: the first it lists of a family the class
 * table knows. Any other model is its own anchor. Chat delegation and automation steps share this rule.
 */
export function anchorModel(provider: Pick<ServerProvider, "models"> | undefined, model: string): string {
  if (!isRouterModel(model) && model !== "auto") return model;
  return provider?.models.find((m) => familyOf(m.slug) !== undefined)?.slug ?? model;
}

/**
 * Resolve only the agent type's configured model: a slug, Claude's haiku/sonnet/opus aliases, or a class
 * (fast, base, frontier; automations/classes.ts). Undefined inherits the parent's; a family alias or class
 * never substitutes a different family.
 */
export function defaultChildModel(input: {
  readonly provider: Pick<ServerProvider, "models"> | undefined;
  readonly parentModel: string;
  readonly agentType: Pick<AgentType, "model"> | undefined;
}): string | undefined {
  const { provider, agentType } = input;
  if (provider === undefined) return undefined;
  const parentModel = anchorModel(provider, input.parentModel);
  const wanted = agentType?.model;
  if (wanted !== undefined && wanted !== "inherit") {
    if (provider.models.some((m) => m.slug === wanted)) return wanted;
    if (isModelClass(wanted)) return modelForClass({ provider, model: parentModel, modelClass: wanted });
    if (wanted === "haiku" || wanted === "sonnet" || wanted === "opus") {
      // Provider/model ids stay with the parent's provider and its stored key.
      const slash = parentModel.indexOf("/");
      const prefix = slash > 0 ? parentModel.slice(0, slash + 1) : undefined;
      const family = new RegExp(`\\b${wanted}\\b`, "i");
      return provider.models.find((m) => (prefix === undefined || m.slug.startsWith(prefix)) && family.test(m.slug.slice(m.slug.lastIndexOf("/") + 1)))?.slug;
    }
  }
  return undefined;
}

/**
 * The model a child starts on (a delegated agent, an automation step or check) from the model its agent
 * file or step asks for, beside `parentModel` (the lead's model, or the engine's default for a step). On
 * the parent's engine that is defaultChildModel; another engine's child takes only an exact model id.
 * `model` undefined: keep the engine's choice (the lead's selection, or the new-chat default).
 */
export function resolveChildSelection(input: {
  readonly provider: Pick<ServerProvider, "models"> | undefined;
  readonly parentModel: string;
  readonly sameEngine: boolean;
  readonly wanted: string | undefined;
}): string | undefined {
  const { provider, parentModel, sameEngine, wanted } = input;
  if (sameEngine) return defaultChildModel({ provider, parentModel, agentType: wanted === undefined ? undefined : { model: wanted } });
  return wanted !== undefined && provider?.models.some((model) => model.slug === wanted) ? wanted : undefined;
}
