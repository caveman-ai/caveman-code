// The two services automations run on, and what passes between them. AutomationFiles owns the
// `.caveman/` files of a project (loading, the default branch's copy for triggers, writes, watching).
// AutomationRunner owns runs (admission, steps, checks, outputs, the budget, the journal). Triggers and
// the Session Protocol handlers hold both; the runner never reads files, so a run only ever sees the
// revision it was admitted with (SEMANTICS 8.4).
import type { AgentInfo, Diagnostic, LoadedAutomation, ParsedAgent, ProjectCheck } from "@caveman-app/automations";
import type {
  AutomationRunOutput as RunOutputSchema,
  AutomationRunReason as RunReasonSchema,
  AutomationRunRecord,
  AutomationRunSummary,
} from "@caveman-app/session-protocol/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { RunRow } from "./journal.ts";
import type { RunEvent, RunState, RunStatus } from "./machine.ts";
import type { OutputError } from "./outputs.ts";
import type { StepLauncher } from "./steps.ts";

type AutomationRunOutput = typeof RunOutputSchema.Type;
type AutomationRunReason = typeof RunReasonSchema.Type;

/** One automation as a run sees it: the file and every agent file it uses, fixed at admission. */
export interface Revision {
  /** sha256 over the automation file and the agent files it uses, so an edit to either is a new revision. */
  readonly digest: string;
  readonly automation: LoadedAutomation;
  /** The registry as the run sees it, with instructions (built-ins included). */
  readonly agents: ReadonlyArray<ParsedAgent>;
  /** Where the definition came from: the working tree (manual, Me files) or the default branch (triggers). */
  readonly from: "working_tree" | "default_branch";
  /** Each agent's `returns` JSON Schema, parsed, by agent name (read with the revision, so a run validates against what it was admitted with). */
  readonly returnsSchemas?: Readonly<Record<string, unknown>>;
}

/** What a trigger hands the runner. Payloads are normalized (never raw API JSON) and always data. */
export interface TriggerEvent {
  readonly kind: "manual" | "schedule" | "github" | "webhook" | "slack" | "linear" | "jira";
  /** `github:<owner>/<repo>#<n>`, `github:<owner>/<repo>#<n>/comment/<id>`, `schedule:<automation>`, `manual:<ulid>`. */
  readonly subject: string;
  /** The delivery id the run id derives from (SEMANTICS §0); absent for manual runs. */
  readonly delivery?: string;
  /** e.g. `issues.labeled`, for the data block's source label. */
  readonly event?: string;
  readonly payload?: unknown;
  /** The issue or pull request title (or commit subject) the subject names, for the run view. */
  readonly subjectTitle?: string;
  readonly subjectUrl?: string;
  /** Every author of the payload's text is trusted (SEMANTICS §13 rule 3). Manual and schedule runs carry no text. */
  readonly trusted: boolean;
  readonly receivedAt: string;
}

export interface AdmitRequest {
  readonly projectId: string;
  readonly revision: Revision;
  readonly trigger: TriggerEvent;
  readonly inputs?: Readonly<Record<string, string>>;
  /** false: outputs are a dry run until applied (manual runs). */
  readonly apply: boolean;
  /** An agent run (agent.run): the agent's name. Its id is `agent:<project>:<agent>` and its branch caveman/agent-<name>/<run>. */
  readonly agent?: string;
  /** A run Caveman Cloud fired: its id there, so the run record, events and outputs carry the same one. */
  readonly runId?: string;
  /** A Cloud run's automation id there (otherwise `file:<project>:<scope>:<name>`). */
  readonly automationId?: string;
}

/** What a host adds to the runner (runner.ts RunHost). */
/** A pull request a hosted run opens: the checked commit, pushed to its caveman/* branch first. */
export interface CloudPullRequest {
  readonly runId: string;
  /** The project's checkout, where the branch is. */
  readonly root: string;
  /** owner/name. */
  readonly repo: string;
  readonly head: string;
  readonly base: string;
  readonly sha: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  readonly idempotencyKey: string;
}

/** A comment a hosted run posts (or edits: the App's own comment holding `marker`) on an issue, pull request or commit. */
export interface CloudComment {
  readonly runId: string;
  readonly repo: string;
  readonly issue?: number;
  readonly commit?: string;
  readonly body: string;
  readonly marker: string;
  readonly idempotencyKey: string;
}

export interface CloudGitHub {
  readonly pullRequest: (input: CloudPullRequest) => Effect.Effect<{ readonly url?: string; readonly remoteId?: string }, OutputError>;
  readonly comment: (input: CloudComment) => Effect.Effect<{ readonly url?: string; readonly remoteId?: string }, OutputError>;
}

export interface RunHostHooks {
  readonly environment?: "this-mac" | "cloud";
  readonly post?: (input: {
    readonly runId: string;
    readonly kind: "slack.message" | "linear.comment" | "jira.comment";
    readonly target: string;
    readonly body: string;
    readonly idempotencyKey: string;
  }) => Effect.Effect<{ readonly url?: string; readonly remoteId?: string }, OutputError>;
  readonly observe?: (row: RunRow, event: RunEvent, state: RunState) => Effect.Effect<void>;
  /** Caveman Cloud's pull requests and comments for a hosted run (CORRECTNESS C1). */
  readonly cloudGitHub?: CloudGitHub;
}

/** What answering an approval gate did: the run as it is now, or why nothing happened. */
export type ApproveResult = { readonly run: AutomationRunRecord } | { readonly refused: "not_found" | "invalid_state"; readonly message: string };

export type AdmitResult =
  | { readonly runId: string; readonly replaced?: string }
  | { readonly refused: AutomationRunReason; readonly message: string };

export interface RunFilter {
  readonly projectId?: string;
  /** The automation's id (`file:<project>:<scope>:<name>`). */
  readonly automationId?: string;
  /** The automation's name, in either scope. */
  readonly automation?: string;
  /** Only this scope's file automations. */
  readonly scope?: "me" | "project";
  /** Only runs in this status (the Inbox's gates: `waiting`). */
  readonly status?: RunStatus;
  /** Only agent runs (agent.run's, `agent:<project>:<agent>`). */
  readonly agentRuns?: boolean;
  /** Only runs still going (queued, running or waiting), every one of them: `limit` does not apply. */
  readonly live?: boolean;
  readonly limit?: number;
}

/**
 * A routine's run for a Chief (outputs.chief): its step's report when the step succeeded, or why the run failed. Every
 * one updates the routine's row; one whose step decided news wakes the Chief. `chiefId`: the Chief the file names
 * (outputs.chief.to); absent, or gone, one that works in the project takes it.
 */
export interface RoutineReport {
  readonly projectId: string;
  readonly chiefId?: string;
  readonly automationId: string;
  readonly automation: string;
  readonly runId: string;
  readonly step: string;
  readonly status: "succeeded" | "failed";
  readonly decision?: string;
  readonly summary: string;
  readonly at: string;
}

/** Where routine reports go: the Chief service, once the Session Protocol is up. Fails when no Chief takes it. */
export type ChiefSink = (report: RoutineReport) => Effect.Effect<void, { readonly message: string }>;

export class AutomationRunner extends Context.Service<
  AutomationRunner,
  {
    readonly admit: (request: AdmitRequest) => Effect.Effect<AdmitResult>;
    readonly cancel: (runId: string, reason: "cancelled" | "superseded" | "policy_denied") => Effect.Effect<void>;
    /** Applies a dry-run run's outputs (a manual run's), once: all of them, or only the one with `key`. */
    readonly applyOutputs: (runId: string, key?: string) => Effect.Effect<ReadonlyArray<AutomationRunOutput>>;
    readonly runs: (filter: RunFilter) => Effect.Effect<ReadonlyArray<AutomationRunSummary>>;
    readonly get: (runId: string) => Effect.Effect<AutomationRunRecord | undefined>;
    /** The Session Protocol, once up, says how a step starts like a new chat in its project (engine, model, access). */
    readonly useLauncher: (launcher: StepLauncher) => Effect.Effect<void>;
    /** Answers a step's approval gate (§5): approve lets the run go on, reject fails the step. `by` names who answered. */
    readonly approve: (input: { readonly runId: string; readonly step: string; readonly decision: "approve" | "reject"; readonly by?: string; readonly message?: string }) => Effect.Effect<ApproveResult>;
    /** A host (the Cloud host on a Cloud computer) says where runs happen, posts Cloud's outputs, and watches each transition. */
    readonly useHost: (host: RunHostHooks) => Effect.Effect<void>;
    /**
     * The Session Protocol, once up, takes routine reports (outputs.chief) for the Chiefs; undefined: this runtime has no
     * Chief. Said once: until then a chief output waits.
     */
    readonly useChief: (sink: ChiefSink | undefined) => Effect.Effect<void>;
  }
>()("caveman/automations/AutomationRunner") {}

export interface ProjectFiles extends ProjectCheck {
  readonly projectId: string;
  /** The checkout the files were read from. */
  readonly root: string;
  /** The default branch's name, and whether each Project automation's current file is on it. */
  readonly defaultBranch: string | undefined;
}

export class AutomationFiles extends Context.Service<
  AutomationFiles,
  {
    /** The working tree's files, checked. */
    readonly load: (projectId: string) => Effect.Effect<ProjectFiles>;
    /** The revision a manual run uses (working tree) or a trigger uses (default branch; Me files: working tree). */
    readonly revision: (
      projectId: string,
      name: string,
      scope: "me" | "project",
      from: Revision["from"],
    ) => Effect.Effect<Revision | undefined>;
    /** The agent registry for a project (files, user, plugins, built-ins), with instructions. */
    readonly agents: (projectId: string) => Effect.Effect<ReadonlyArray<ParsedAgent>>;
    readonly read: (projectId: string, path: string) => Effect.Effect<string>;
    readonly write: (projectId: string, path: string, text: string) => Effect.Effect<ReadonlyArray<Diagnostic>>;
    /** A project's `.caveman/` changed on disk. */
    readonly changes: Stream.Stream<{ readonly projectId: string }>;
  }
>()("caveman/automations/AutomationFiles") {}

export type { AgentInfo };

/** Until the runner lands: admits nothing and lists no runs, so files and triggers work on their own. */
export const AutomationRunnerStub = Layer.succeed(AutomationRunner, {
  admit: () => Effect.succeed({ refused: "engine_unavailable", message: "This runtime cannot run automations yet." } as const),
  cancel: () => Effect.void,
  applyOutputs: () => Effect.succeed([]),
  runs: () => Effect.succeed([]),
  get: () => Effect.succeed(undefined),
  useLauncher: () => Effect.void,
  approve: (input) => Effect.succeed({ refused: "not_found", message: `No run ${input.runId} on this runtime.` } as const),
  useHost: () => Effect.void,
  useChief: () => Effect.void,
});
