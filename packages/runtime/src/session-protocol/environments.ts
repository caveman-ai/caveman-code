// environment.*: a project's Cloud setup (docs/). The draft is made here
// (environmentDraft.ts); saves, builds and their logs go to Caveman Cloud through this runtime's sign-in
// (cloudLink/environments.ts); a setup chat repairs a failed build with test builds through its
// environment_build tool (mcp/toolkits/setup), at most 20 minutes or 5 builds; a project with a chat here
// gets its setup drafted and saved in the background (Settings.cloud_prepare); environment.setup does the same
// at the person's word; and environment.warm, sent while a Cloud chat is written, asks Cloud to keep a computer
// standing on the repo's snapshot (Cloud the spec, 2026-10-23). While a build runs
// and a client asked in the last minute, the runtime polls Cloud every 3 s and sends environment.updated.
//
// docs/ a failed build with no ready snapshot starts the setup chat by itself
// (Settings.cloud_auto_fix, D1), once per build; the setup chat never saves, its passing test build waits as a
// proposal the person publishes (a save as them) or discards; any chat in a project with a GitHub remote can propose
// a setup change (propose_setup_change, D9) that Apply hands to the setup chat; versions and restore, shared build
// secrets (names only ever come back), the organization's whole list, GitHub-only repos set up without a clone, and
// CI on the built commit (D6, D3, D12, D11).
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import type { Environment, EnvironmentBuild, EnvironmentCi, EnvironmentSummary, Params, RepositoryLink, Result, SetupChat, SetupProposal } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  buildDone,
  deleteBuildSecret,
  getBuild,
  getBuildLog,
  getEnvironment,
  listAll,
  listVersions,
  restoreVersion,
  saveEnvironment,
  setBuildSecret,
  startBuild,
  warmHint,
} from "../cloudLink/environments.ts";
import { CloudError, type Identity } from "../cloudLink/identity.ts";
import type { LinkState } from "../cloudLink/index.ts";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { ComputerConfigError, parseComputerConfig } from "./computerConfig.ts";
import { ciStatus } from "./environmentCi.ts";
import { draftEnvironment, readMacSeed, type EnvironmentDraft } from "./environmentDraft.ts";
import { draftFromGitHub } from "./environmentRemote.ts";
import { ProtocolError } from "./handlers.ts";
import type { SessionStore } from "./store.ts";

/** A setup chat's limits (design E1): whichever comes first. */
export const SETUP_CHAT_MS = 20 * 60_000;
export const SETUP_CHAT_BUILDS = 5;
/**
 * How often a running build is read, a setup chat's time limit, how often a project's warm hint reaches Cloud, and
 * how often a build nobody watches is read (to start the setup chat when it fails), and how recently a failed build
 * must have ended for the setup chat to start by itself; tests shorten them.
 */
export const timing = { pollMs: 3_000, setupChatMs: SETUP_CHAT_MS, warmEveryMs: 20_000, followMs: 15_000, autoFixWithinMs: 60 * 60_000 };
const WATCH_MS = 60_000;
/** A build this runtime started is followed this long at most: Cloud ends any build within the hour. */
const FOLLOW_MS = 75 * 60_000;
const BUILDS_KEPT = 10;
const PROPOSALS_KEPT = 5;
/** Failures a setup chat can't fix: Cloud's side (start), a value only a person has (registry_auth), access (clone). */
const NOT_THE_SETUP: ReadonlySet<string> = new Set(["start", "registry_auth", "clone"]);


// ------------------------------------------------------------- the tool's bridge

/** What the agent reads when environment_build fails. */
export class SetupChatError extends Schema.TaggedError<SetupChatError>()("SetupChatError", { message: Schema.String }) {}

export interface SetupBuildResult {
  readonly status: EnvironmentBuild["status"];
  readonly steps: EnvironmentBuild["steps"];
  readonly failure: EnvironmentBuild["failure"];
  readonly gaps: ReadonlyArray<string>;
  readonly log_tail: string;
  /** It passed and waits for the person to publish it (propose true). */
  readonly proposed: boolean;
  readonly builds_left: number;
}
type BuildTool = (threadId: string, input: { readonly config: string; readonly propose: boolean; readonly summary?: string | undefined }) => Effect.Effect<SetupBuildResult, SetupChatError>;
type ProposeTool = (threadId: string, input: { readonly summary: string; readonly why: string }) => Effect.Effect<{ readonly id: string }, SetupChatError>;

/** The setup tools' way into the route that owns setup chats and proposals (as ChiefHost is the Chief's). */
export class SetupChats extends Context.Service<
  SetupChats,
  {
    readonly build: BuildTool;
    /** propose_setup_change: any chat's agent records a setup change for the person to apply. */
    readonly propose: ProposeTool;
    /** The route's implementation; the last bind wins. */
    readonly bind: (tools: { readonly build: BuildTool; readonly propose: ProposeTool }) => Effect.Effect<void>;
  }
>()("caveman/session-protocol/SetupChats") {}

export const layerSetupChats = Layer.sync(SetupChats, () => {
  let bound: { readonly build: BuildTool; readonly propose: ProposeTool } | undefined;
  const absent = Effect.fail(new SetupChatError({ message: "Setup chats aren't running on this runtime yet." }));
  return SetupChats.of({
    build: (threadId, input) => (bound ? bound.build(threadId, input) : absent),
    propose: (threadId, input) => (bound ? bound.propose(threadId, input) : absent),
    bind: (tools) => Effect.sync(() => void (bound = tools)),
  });
});

/**
 * The engine threads of setup chats: the Caveman adapter declares the setup tools to these only, so no other
 * chat carries their schemas. ponytail: process-wide (thread ids are unique UUIDs); the route refills it at start.
 */
export const setupThreads = new Set<string>();

// ------------------------------------------------------------- the handlers

type EnvironmentMethod =
  | "environment.get"
  | "environment.draft"
  | "environment.save"
  | "environment.setup"
  | "environment.warm"
  | "environment.build"
  | "environment.build.get"
  | "environment.build.log"
  | "environment.fix"
  | "environment.add_to_repo"
  | "environment.setup_repo"
  | "environment.list"
  | "environment.publish"
  | "environment.discard"
  | "environment.versions"
  | "environment.restore"
  | "environment.build_secret.set"
  | "environment.build_secret.delete"
  | "environment.ci"
  | "environment.proposal.apply"
  | "environment.proposal.dismiss"
  | "environment.proposals";

/**
 * The methods that act as the runtime's person (their Cloud sign-in, their push rule, their git): only its own
 * clients and its owner may call them, as with secret.*.
 */
export const AS_THE_PERSON = [
  "environment.save",
  "environment.setup",
  "environment.build",
  "environment.fix",
  "environment.publish",
  "environment.discard",
  "environment.restore",
  "environment.build_secret.set",
  "environment.build_secret.delete",
  "environment.setup_repo",
  "environment.proposal.apply",
  "environment.proposal.dismiss",
  "environment.add_to_repo",
] as const satisfies ReadonlyArray<EnvironmentMethod>;
type CallContext = { readonly connectionId?: string; readonly principal?: string | undefined };

export interface ProjectRef {
  readonly id: string;
  readonly path: string;
  readonly repository?: RepositoryLink | undefined;
}

interface SetupChatRecord extends SetupChat {
  readonly project_id: string;
  readonly thread_id: string;
  /** The Cloud-copy version its brief showed: a publish says so, and Cloud refuses it when a newer one was saved since. */
  readonly base_version?: number | undefined;
  /** Its setup was published (or, before review, saved): the chat is done. */
  readonly saved: boolean;
}

export interface EnvironmentDeps {
  readonly store: SessionStore["Service"];
  readonly project: (projectId: string) => Effect.Effect<ProjectRef | undefined>;
  /** A Cloud call as the person who signed this runtime in; undefined identity: not signed in, or a Cloud computer. */
  readonly identity: () => Identity | undefined;
  readonly cloudCall: <A>(run: (identity: Identity) => Promise<A>) => Effect.Effect<A, ProtocolError>;
  /** The live Cloud link's token, when Remote control holds one. */
  readonly link: LinkState;
  readonly onCloudComputer: boolean;
  /** The Caveman engine has a key, an endpoint or credits: a setup chat can run. */
  readonly canFix: Effect.Effect<boolean>;
  readonly cloudPrepare: Effect.Effect<boolean>;
  /** Settings.cloud_auto_fix is not false: a failed build with no snapshot starts the setup chat by itself. */
  readonly cloudAutoFix: Effect.Effect<boolean>;
  /** This runtime's projects (environment.list marks the organization's repos that are one here). */
  readonly projects: Effect.Effect<ReadonlyArray<ProjectRef>>;
  /** git for a GitHub-only repo's sparse checkout (environment.setup_repo), under `stateDir`. */
  readonly git: GitVcsDriver.GitVcsDriver["Service"];
  readonly stateDir: string;
  /** The person's github.com token for CI reads, when they signed in to GitHub here. */
  readonly githubToken: () => Effect.Effect<string | undefined>;
  /** Whether a caller may change a setup as this runtime's person (secretsAllowed: its own clients and its owner). */
  readonly allowed: (principal: string | undefined) => boolean;
  readonly cloudComputersAvailable: Effect.Effect<boolean>;
  /** Starts the setup chat: a Caveman-engine workspace of kind setup in the project, `text` its message and `brief` what the engine reads. */
  readonly startSetupChat: (input: { readonly project: ProjectRef; readonly title: string; readonly text: string; readonly brief: string }) => Effect.Effect<{ workspace_id: string; session_id: string; thread_id: string }, ProtocolError>;
  /** A person's words to a running setup chat. */
  readonly tell: (workspaceId: string, text: string) => Effect.Effect<void, ProtocolError>;
  /** Stops its running turn. */
  readonly stop: (workspaceId: string) => Effect.Effect<void>;
  readonly noteIn: (workspaceId: string, title: string, body?: string) => Effect.Effect<void>;
  /** Add to repo: a pull request with only `.caveman/computer.toml` (`update`: the branch has one, and this changes it). */
  readonly openPullRequest: (project: ProjectRef, config: string, options?: { readonly update?: boolean }) => Effect.Effect<{ url: string }, ProtocolError>;
}

const fail = (reason: string, message: string) => Effect.fail(new ProtocolError({ reason, message }));
const githubRepo = (project: ProjectRef) => (project.repository?.host === "github.com" ? project.repository.full_name : undefined);
/** GitHub's owner/name, neither part only dots: the one rule for setup_repo, branchHead and CI (environmentCi.ts). */
export const isGitHubRepo = (repo: string) => /^(?!\.+\/)[A-Za-z0-9_.-]+\/(?!\.+$)[A-Za-z0-9_.-]+$/.test(repo);
/** Where a GitHub-only repo's manifests are fetched from (environment.setup_repo); tests point it at a local remote. */
export const remotes = { cloneUrl: (repo: string) => `https://github.com/${repo}.git` };

/**
 * The commit a branch's head is on GitHub, with the person's token: what a failed build built, since Cloud's builds
 * don't say which commit they cloned. Undefined without a token, or when GitHub doesn't answer in 5 s.
 */
export function branchHead(input: { readonly repo: string; readonly branch: string; readonly token: string | undefined; readonly fetch?: typeof fetch }): Effect.Effect<string | undefined> {
  const { repo, branch, token } = input;
  if (!token || !isGitHubRepo(repo) || !/^[A-Za-z0-9._/+-]{1,255}$/.test(branch)) return Effect.succeed(undefined);
  const get = input.fetch ?? fetch;
  return Effect.promise(() =>
    get(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(branch)}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github.sha", "x-github-api-version": "2022-11-28", "user-agent": "caveman-code" },
      signal: AbortSignal.timeout(5_000),
    }).then(
      async (r) => {
        const sha = r.ok ? (await r.text()).trim() : "";
        return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
      },
      () => undefined,
    ),
  );
}
const STALE_SETUP = "This repo's Cloud setup isn't set up yet.";

/** Cloud's refusal of a build secret, with the value cut out should a message ever carry it. */
const scrubbed = (error: ProtocolError, value: string) =>
  value.length >= 4 && error.message.includes(value) ? new ProtocolError({ reason: error.reason, message: error.message.split(value).join("[value]") }) : error;

/** A step's name in the person's words. */
export const STEP_LABEL: Record<string, string> = { clone: "Clone", services: "Services", setup: "Setup", check: "Checks", snapshot: "Snapshot", restore_check: "Fresh-computer check" };

/** The first line of a setup chat's message, from the build that failed. */
const failureLine = (build: EnvironmentBuild | null | undefined) =>
  build?.failure ? `The last Cloud build failed at ${STEP_LABEL[build.failure.step] ?? build.failure.step}: ${build.failure.message}` : "The repo has no working Cloud setup yet.";

/** "postgres 15, 16 or 17; redis 7": what this install's [services] offers, for the brief. */
const offerLine = (offered: Readonly<Record<string, ReadonlyArray<string>>> | undefined) => {
  const entries = Object.entries(offered ?? {}).filter(([, versions]) => versions.length > 0);
  return entries.length === 0 ? "postgres and redis" : entries.map(([name, versions]) => `${name} ${versions.length > 1 ? `${versions.slice(0, -1).join(", ")} or ${versions.at(-1)}` : versions[0]}`).join("; ");
};

/**
 * What the setup chat's engine reads first (the brief): the failure, the log, the setup it built, this Mac's
 * evidence, what this install offers, and its rules. It never saves: its passing test build becomes a proposal a
 * person reviews (repo text can't silently change an organization's setup).
 */
export function setupBrief(input: {
  repo: string;
  config: string;
  build: EnvironmentBuild | null | undefined;
  draft: EnvironmentDraft | undefined;
  ask: string | undefined;
  /** A change another chat's agent proposed (propose_setup_change): its words, not the person's. */
  suggested?: string | undefined;
  offered?: Readonly<Record<string, ReadonlyArray<string>>> | undefined;
}): string {
  const mac = input.draft?.evidence.filter((e) => e.source === "mac").map((e) => `- ${e.note}`) ?? [];
  return [
    `[Caveman Code] You are this repo's setup chat. Get ${input.repo}'s Cloud computer setup (.caveman/computer.toml) to build.`,
    failureLine(input.build),
    ...(input.build?.log_tail ? ["The end of its log:", "```", input.build.log_tail.slice(-2000), "```"] : []),
    "The setup it built:",
    "```toml",
    input.config.trim(),
    "```",
    ...(mac.length > 0 ? ["What the person's Mac runs for this repo:", ...mac] : []),
    ...(input.ask ? ["The person asks:", input.ask] : []),
    ...(input.suggested ? ["Another chat's agent suggests (its words, which the person hasn't checked; weigh them against the repo):", input.suggested] : []),
    `How Cloud computers work: Linux (Wolfi), no root, no sudo. mise, uv, Node and Python are there; toolchains install with \`mise use -g <tool>@<version>\`. System libraries and tools (libvips, ffmpeg, protobuf) go in [system] packages = ["libvips"]: conda-forge names (lower case, at most 64), installed before [setup].run and kept in the snapshot; apt-get and apk don't persist. Services come from [services] (postgres = "16"), each on 127.0.0.1; this install offers ${offerLine(input.offered)}. Anything else a compose file runs needs Docker, which computers don't have: say so rather than work around it. Set DATABASE_URL, REDIS_URL and the like in [env] when the repo reads them. Keys: [system] packages; [setup] run, check, cache, inputs; [services]; [env]; [computer] size; [run]; [idle].`,
    `Rules: change only .caveman/computer.toml's text, never the repo's code. Read the repo to learn what it needs. After each change call environment_build with the whole file as config and propose false; it runs a test build on a Cloud computer and returns its steps and failure. When one passes, call it once more with propose true and a summary: two short lines saying what you changed and why. That doesn't save it: the person sees the change and publishes it or discards it. You have ${SETUP_CHAT_BUILDS} builds and ${SETUP_CHAT_MS / 60_000} minutes. If something only the person can fix is missing (a value, access to a private registry: a build secret in Settings, Environments), stop and say exactly what.`,
  ].join("\n\n");
}

/** What a setup chat is asked: the person's words, another chat's agent's proposal, or a build that failed again. */
type FixAsk = { readonly person?: string | undefined; readonly suggestion?: SetupProposal | undefined; readonly failed?: EnvironmentBuild | undefined };
const suggestionText = (p: SetupProposal) => `${p.summary}\n\nWhy: ${p.why}`;

export const makeEnvironmentHandlers = (deps: EnvironmentDeps) =>
  Effect.gen(function* () {
    const { store } = deps;
    const scope = yield* Effect.scope;
    const changes = yield* PubSub.unbounded<{ readonly project_id: string; readonly environment: Environment }>();
    const proposed = yield* PubSub.unbounded<{ readonly project_id: string; readonly proposal: SetupProposal }>();
    const chatChanged = yield* PubSub.unbounded<{ readonly project_id: string; readonly setup_chat: SetupChat }>();
    // Deciding whether to join a setup chat or start one happens under this, so a repo never gets two.
    const chatLock = yield* Semaphore.make(1);
    const watched = new Map<string, number>();
    /** Builds this runtime started, read until they end even when no client asks: a failure starts the setup chat. */
    const following = new Map<string, { until: number; next: number }>();
    /** Failed builds whose auto-fix was decided this run (the store keeps it across runs). */
    const decided = new Set<string>();
    const last = new Map<string, { json: string; environment: Environment }>();
    const prepared = new Set<string>();
    /** Each project's last warm hint: when it went to Cloud and what Cloud said. */
    const hints = new Map<string, { at: number; warm: boolean }>();
    const deadlines = new Map<string, ReturnType<typeof setTimeout>>();
    // A setup chat's build count is read and taken under this, so parallel environment_build calls stay within the cap.
    const buildLock = yield* Semaphore.make(1);

    const projectOrFail = (projectId: string) =>
      deps.project(projectId).pipe(Effect.flatMap((p) => (p === undefined ? fail("not_found", `no project ${projectId}`) : Effect.succeed(p))));
    const repoOrFail = (project: ProjectRef) => {
      const repo = githubRepo(project);
      return repo === undefined ? fail("invalid_state", "A Cloud computer clones from GitHub, and this project has no GitHub remote.") : Effect.succeed(repo);
    };

    // ---- builds this runtime saw, per project
    const buildsKey = (projectId: string) => `environment.builds:${projectId}`;
    const buildsOf = (projectId: string) =>
      store.kvGet(buildsKey(projectId)).pipe(Effect.map((raw): EnvironmentBuild[] => (raw === undefined ? [] : (JSON.parse(raw) as EnvironmentBuild[]))));
    // The list is read, changed and written back under this: a read that saw no `by` cannot write over the one
    // startedBuild just recorded, which would leave the failure nobody's and its setup chat never told.
    const buildsLock = yield* Semaphore.make(1);
    const remember = (projectId: string, build: EnvironmentBuild, by?: EnvironmentBuild["by"]) =>
      buildsLock.withPermits(1)(
        Effect.gen(function* () {
          const list = yield* buildsOf(projectId);
          const known = list.find((b) => b.id === build.id);
          const next = { ...build, ...((by ?? known?.by) ? { by: by ?? known!.by! } : {}) };
          yield* store.kvSet(buildsKey(projectId), JSON.stringify([next, ...list.filter((b) => b.id !== build.id)].slice(0, BUILDS_KEPT)));
        }),
      );

    // ---- setup chats, per project
    const chatKey = (projectId: string) => `environment.setup:${projectId}`;
    const chatOf = (projectId: string) =>
      store.kvGet(chatKey(projectId)).pipe(Effect.map((raw) => (raw === undefined ? undefined : (JSON.parse(raw) as SetupChatRecord))));
    // Every change reaches clients (environment.setup_chat): a review card never shows a proposal that was replaced.
    const putChat = (chat: SetupChatRecord) =>
      store.kvSet(chatKey(chat.project_id), JSON.stringify(chat)).pipe(Effect.andThen(PubSub.publish(chatChanged, { project_id: chat.project_id, setup_chat: publicChat(chat) })));
    const chatByThread = (threadId: string) =>
      Effect.gen(function* () {
        const record = yield* store.getByThread(threadId);
        return record?.workspace.kind === "setup" && record.workspace.project_id ? yield* chatOf(record.workspace.project_id) : undefined;
      });
    const publicChat = ({ workspace_id, session_id, state, builds, started_at, proposal }: SetupChatRecord): SetupChat => ({
      workspace_id,
      session_id,
      state,
      builds,
      started_at,
      ...(proposal && state === "review" ? { proposal } : {}),
    });

    // ---- setup changes agents proposed mid-chat, per project, newest first
    const proposalsKey = (projectId: string) => `environment.proposals:${projectId}`;
    const proposalsOf = (projectId: string) =>
      store.kvGet(proposalsKey(projectId)).pipe(Effect.map((raw): SetupProposal[] => (raw === undefined ? [] : (JSON.parse(raw) as SetupProposal[]))));
    const putProposals = (projectId: string, list: ReadonlyArray<SetupProposal>) => store.kvSet(proposalsKey(projectId), JSON.stringify(list.slice(0, PROPOSALS_KEPT)));
    /** The last failed build whose auto-fix was decided, per project. */
    const autoFixKey = (projectId: string) => `environment.autofix:${projectId}`;

    /** Cloud's "no such route" or "off" answers, as a reason; anything else stays an error. */
    const missing = (error: unknown) =>
      // Go's mux answers an unknown route with a bare 404; Cloud's own 404s carry a code.
      error instanceof CloudError && error.status === 404 && error.code === undefined
        ? { missing: "This Caveman server doesn't set up repos for Cloud computers yet." }
        : error instanceof CloudError && (error.code === "cave_code_cloud_computers_off" || error.code === "cave_code_environments_off")
          ? { missing: error.message }
          : Promise.reject(error);
    /** Why Cloud can't be asked from here, or undefined when it can. */
    const unreachable = () =>
      deps.onCloudComputer
        ? "Open this repo's Cloud setup from Caveman Code on your Mac."
        : deps.identity() === undefined
          ? "Sign in to Caveman to set up Cloud computers (Settings, Remote control)."
          : undefined;

    // GitHub-only drafts a crash left behind (environment.setup_repo removes its own when it can).
    yield* Effect.sync(() => {
      try {
        fs.rmSync(path.join(deps.stateDir, "environment-drafts"), { recursive: true, force: true });
      } catch {
        // Nothing to sweep, or not ours to remove: a draft makes its own directory again.
      }
    });

    // Setup chats from before a restart get their tools back.
    for (const record of yield* store.listWorkspaces()) if (record.workspace.kind === "setup" && record.workspace.status !== "archived") setupThreads.add(record.internal.threadId);

    /** The project's environment from Cloud, or why there is none; remembers its latest build and publishes a change. */
    const read = (project: ProjectRef) =>
      Effect.gen(function* () {
        const repo = githubRepo(project);
        if (repo === undefined) return { environment: null, available: true } as const;
        const away = unreachable();
        if (away !== undefined) return { environment: null, available: false, reason: away } as const;
        const got = yield* deps.cloudCall((id) =>
          getEnvironment(id, deps.link, repo).then(
            (environment) => ({ environment }),
            // An install that prepares no repos still runs Cloud computers: a chat there starts from the plain image.
            // Only Cloud computers being off makes Cloud unavailable here.
            (error: unknown) => (error instanceof CloudError && error.code === "cave_code_environments_off" ? { unprepared: true as const } : missing(error)),
          ),
        );
        if ("unprepared" in got) return { environment: null, available: true } as const;
        if ("missing" in got) return { environment: null, available: false, reason: got.missing } as const;
        const environment = got.environment;
        if (environment.build) yield* remember(project.id, environment.build);
        // A repo whose branch owns its file takes no save from Cloud: its fixes go in a pull request, by a person.
        if (environment.build?.status === "failed" && environment.snapshot === null && environment.source !== "repo") yield* autoFix(project, repo, environment);
        const json = JSON.stringify(environment);
        if (last.get(project.id)?.json !== json) {
          const before = last.get(project.id);
          last.set(project.id, { json, environment });
          if (before !== undefined) yield* PubSub.publish(changes, { project_id: project.id, environment });
        }
        return { environment, available: true } as const;
      });

    const busy = (e: Environment | undefined) => e !== undefined && (e.state === "setting_up" || (e.build !== null && !buildDone(e.build)));
    const watch = (projectId: string) => Effect.sync(() => void watched.set(projectId, Date.now() + WATCH_MS));
    // One poller for every watched project with a build running (every 3 s), and every build this runtime started
    // that nobody watches (every 15 s, until it ends).
    yield* Effect.gen(function* () {
      const now = Date.now();
      const due = new Set<string>();
      for (const [projectId, until] of watched) {
        if (until < now) watched.delete(projectId);
        else due.add(projectId);
      }
      for (const [projectId, follow] of following) {
        if (follow.until < now) following.delete(projectId);
        else if (now >= follow.next) {
          follow.next = now + timing.followMs;
          due.add(projectId);
        }
      }
      for (const projectId of due) {
        if (!busy(last.get(projectId)?.environment)) {
          following.delete(projectId);
          continue;
        }
        const project = yield* deps.project(projectId);
        if (project) yield* read(project).pipe(Effect.ignore);
      }
    }).pipe(Effect.andThen(Effect.suspend(() => Effect.sleep(`${timing.pollMs} millis`))), Effect.forever, Effect.forkIn(scope));

    const startedBuild = (project: ProjectRef, buildId: string, by: NonNullable<EnvironmentBuild["by"]>) =>
      Effect.gen(function* () {
        const build = yield* deps.cloudCall((id) => getBuild(id, deps.link, buildId)).pipe(Effect.orElseSucceed(() => undefined));
        if (build) yield* remember(project.id, build, by);
        following.set(project.id, { until: Date.now() + FOLLOW_MS, next: Date.now() + timing.followMs });
        yield* read(project).pipe(Effect.ignore);
      });

    const draftFor = (project: ProjectRef) =>
      Effect.promise(async () => {
        const seed = deps.onCloudComputer ? undefined : await readMacSeed(project.path).catch(() => undefined);
        const offered = last.get(project.id)?.environment.services;
        return draftEnvironment(project.path, { ...(seed ? { seed } : {}), ...(offered && Object.keys(offered).length > 0 ? { offered } : {}) });
      });

    /**
     * Starts the repo's setup chat (Fix it, an applied proposal, or a failed build by itself): a Caveman-engine chat
     * with the failure, the setup and this Mac's evidence in its brief.
     */
    const startChat = (project: ProjectRef, repo: string, ask: FixAsk): Effect.Effect<{ workspace_id: string; session_id: string }, ProtocolError> =>
      Effect.gen(function* () {
        const { environment } = yield* read(project);
        const draft = yield* draftFor(project);
        const config = environment?.config ?? draft.config;
        const text =
          ask.person ??
          (ask.suggestion ? `Another chat's agent suggests this change to ${repo}'s Cloud setup:\n\n${suggestionText(ask.suggestion)}` : `Fix ${repo}'s Cloud setup. ${failureLine(environment?.build)}`);
        const brief = setupBrief({ repo, config, build: environment?.build, draft, ask: ask.person, suggested: ask.suggestion ? suggestionText(ask.suggestion) : undefined, offered: environment?.services });
        const made = yield* deps.startSetupChat({ project, title: `Cloud setup for ${repo}`, text, brief });
        const chat: SetupChatRecord = {
          workspace_id: made.workspace_id,
          session_id: made.session_id,
          thread_id: made.thread_id,
          project_id: project.id,
          state: "working",
          builds: 0,
          started_at: new Date().toISOString(),
          saved: false,
          // base_version only to a Caveman Cloud that takes it: one from before it refuses unknown fields, and only it
          // leaves out build_secret_names (they arrived together, 2026-10-23).
          ...(environment?.source === "cloud" && environment.config_version !== undefined && environment.build_secret_names !== undefined
            ? { base_version: environment.config_version }
            : {}),
        };
        setupThreads.add(made.thread_id);
        yield* putChat(chat);
        armDeadline(chat);
        return { workspace_id: made.workspace_id, session_id: made.session_id };
      });

    // ---- the setup chat
    const finishChat = (chat: SetupChatRecord, state: SetupChat["state"]) =>
      Effect.gen(function* () {
        const timer = deadlines.get(chat.workspace_id);
        if (timer) clearTimeout(timer);
        deadlines.delete(chat.workspace_id);
        yield* putChat({ ...chat, state });
      });

    /** Takes one of the chat's builds (or gives one back), checking its limits, under buildLock. */
    const takeBuild = (threadId: string) =>
      buildLock.withPermits(1)(
        Effect.gen(function* () {
          const chat = yield* chatByThread(threadId);
          if (chat === undefined) return yield* new SetupChatError({ message: "environment_build works only in a repo's setup chat." });
          // A turn that ended without a passing proposal can go on when the person answers it, and one in review can
          // try again (a newer proposal replaces it); publishing, discarding, a cap or a newer setup chat for the repo
          // ends it (an older chat never spends the newer one's builds).
          if (chat.thread_id !== threadId || chat.state === "succeeded" || chat.state === "stopped") return yield* new SetupChatError({ message: "This setup chat has ended." });
          if (chat.builds >= SETUP_CHAT_BUILDS) return yield* new SetupChatError({ message: `${SETUP_CHAT_BUILDS} test builds is this setup chat's limit. Stop, and say what still fails.` });
          if (Date.now() >= Date.parse(chat.started_at) + timing.setupChatMs) return yield* new SetupChatError({ message: `${SETUP_CHAT_MS / 60_000} minutes is this setup chat's limit. Stop, and say what still fails.` });
          const taken = { ...chat, builds: chat.builds + 1 };
          yield* putChat(taken);
          return taken;
        }),
      );
    const giveBack = (threadId: string) =>
      buildLock.withPermits(1)(
        chatByThread(threadId).pipe(Effect.flatMap((chat) => (chat?.thread_id === threadId && chat.builds > 0 ? putChat({ ...chat, builds: chat.builds - 1 }) : Effect.void))),
      );

    const buildTool: BuildTool = (threadId, input) =>
      Effect.gen(function* () {
        try {
          parseComputerConfig(input.config);
        } catch (error) {
          // A file that doesn't parse costs no build.
          if (error instanceof ComputerConfigError) return yield* new SetupChatError({ message: error.message });
          throw error;
        }
        const summary = input.summary?.trim();
        if (input.propose && !summary) return yield* new SetupChatError({ message: "propose true needs a summary: two short lines saying what you changed and why." });
        const asked = yield* takeBuild(threadId);
        const deadline = Date.parse(asked.started_at) + timing.setupChatMs;
        const project = yield* deps.project(asked.project_id);
        const repo = project && githubRepo(project);
        if (!project || !repo) return yield* new SetupChatError({ message: "This setup chat's project is gone." });
        const cloud = <A>(run: (id: Identity) => Promise<A>) => deps.cloudCall(run).pipe(Effect.mapError((e) => new SetupChatError({ message: e.message })));
        // A build Cloud refuses (a config it can't take, too many queued) costs none of the five. It never asks Cloud to
        // save: a person publishes what passed.
        const { build_id } = yield* cloud((id) => startBuild(id, deps.link, { repo, config: input.config, by: "caveman" })).pipe(
          Effect.tapError(() => giveBack(threadId)),
        );
        yield* watch(project.id);
        let build = yield* cloud((id) => getBuild(id, deps.link, build_id));
        yield* remember(project.id, build, "setup_chat");
        while (!buildDone(build) && Date.now() < deadline) {
          yield* Effect.suspend(() => Effect.sleep(`${timing.pollMs} millis`));
          build = yield* cloud((id) => getBuild(id, deps.link, build_id));
          yield* remember(project.id, build, "setup_chat");
        }
        let passed = false;
        if (input.propose && build.status === "succeeded") {
          // It waits for the person under the chat's current record (another build may have counted meanwhile), and
          // only while the chat is open: a build passing after a publish, a discard or a stop revives nothing.
          const now = (yield* chatOf(asked.project_id)) ?? asked;
          if (now.thread_id === threadId && (now.state === "working" || now.state === "failed" || now.state === "review")) {
            yield* putChat({ ...now, state: "review", proposal: { config: input.config, build_id, summary: summary! } });
            passed = true;
          }
        }
        yield* read(project).pipe(Effect.ignore);
        return {
          status: build.status,
          steps: build.steps,
          failure: buildDone(build) ? build.failure : { kind: "timeout", step: "setup", message: "The setup chat's time ran out before the build finished." },
          gaps: build.gaps,
          log_tail: build.log_tail.slice(-1500),
          proposed: passed,
          builds_left: SETUP_CHAT_BUILDS - asked.builds,
        };
      });

    /** propose_setup_change: the calling chat's project gets a proposal the person applies or dismisses. */
    const proposeTool: ProposeTool = (threadId, input) =>
      Effect.gen(function* () {
        const record = yield* store.getByThread(threadId);
        if (record === undefined || !record.workspace.project_id) return yield* new SetupChatError({ message: "propose_setup_change works in a chat in a project." });
        if (record.workspace.kind === "setup") return yield* new SetupChatError({ message: "You are this repo's setup chat: change the setup with environment_build." });
        if (deps.onCloudComputer) return yield* new SetupChatError({ message: "Proposals reach the person from Caveman Code on their Mac, not from a Cloud computer. Say in your answer what the Cloud setup is missing." });
        const project = yield* deps.project(record.workspace.project_id);
        if (!project || !githubRepo(project)) return yield* new SetupChatError({ message: "This project has no GitHub remote, so it has no Cloud setup to change." });
        const summary = input.summary.trim();
        const why = input.why.trim();
        if (!summary || !why) return yield* new SetupChatError({ message: "Give a summary (what to change) and why (what failed without it)." });
        const proposal: SetupProposal = { id: randomUUID(), workspace_id: record.workspace.id, summary: summary.slice(0, 300), why: why.slice(0, 2000), at: new Date().toISOString() };
        // The same change proposed again replaces the older card rather than stacking.
        const kept = (yield* proposalsOf(project.id)).filter((p) => p.summary !== proposal.summary);
        yield* putProposals(project.id, [proposal, ...kept]);
        yield* PubSub.publish(proposed, { project_id: project.id, proposal });
        return { id: proposal.id };
      });
    yield* (yield* SetupChats).bind({ build: buildTool, propose: proposeTool });

    /** A setup chat out of time stops, and says so in its transcript. */
    const timeUp = (chat: SetupChatRecord) =>
      Effect.gen(function* () {
        yield* deps.stop(chat.workspace_id);
        yield* finishChat(chat, "stopped");
        yield* deps.noteIn(chat.workspace_id, `The setup chat stopped at its ${SETUP_CHAT_MS / 60_000}-minute limit`, "Chats still start on Cloud computers. Fix it starts a new one.");
      });
    const armDeadline = (chat: SetupChatRecord) => {
      const left = Date.parse(chat.started_at) + timing.setupChatMs - Date.now();
      const run = () =>
        Effect.runFork(
          Effect.gen(function* () {
            const current = yield* chatOf(chat.project_id);
            // One that had ended its turn is stopped when the person answers it (turnChanged).
            if (current?.workspace_id !== chat.workspace_id || current.state !== "working") return;
            yield* timeUp(current);
          }),
        );
      deadlines.set(chat.workspace_id, setTimeout(run, Math.max(0, left)));
    };
    for (const record of yield* store.listWorkspaces()) {
      if (record.workspace.kind !== "setup" || !record.workspace.project_id) continue;
      const chat = yield* chatOf(record.workspace.project_id);
      if (chat?.state === "working" && chat.workspace_id === record.workspace.id) armDeadline(chat);
    }

    const fixState = Effect.gen(function* () {
      if (deps.onCloudComputer) return { ok: false, reason: "Fix it runs from Caveman Code on your Mac." };
      return (yield* deps.canFix) ? { ok: true } : { ok: false, reason: "Fix it runs a Caveman engine chat: add a model key or turn on Caveman credits in Settings, Models & keys." };
    });

    /** A setup chat that goes on: working, in review, or ended a turn with builds and time left. */
    const isOpen = (chat: SetupChatRecord | undefined): chat is SetupChatRecord =>
      chat !== undefined &&
      (chat.state === "working" || chat.state === "review" || (chat.state === "failed" && chat.builds < SETUP_CHAT_BUILDS && Date.now() < Date.parse(chat.started_at) + timing.setupChatMs));

    /**
     * Fix it, an applied proposal, or a failed build: joins the repo's open setup chat (the ask goes to it, labelled
     * when it isn't the person's) or starts one. Under chatLock, so a repo never gets two.
     */
    const fix = (project: ProjectRef, repo: string, ask: FixAsk) =>
      chatLock.withPermits(1)(
        Effect.gen(function* () {
          const running = yield* chatOf(project.id);
          if (isOpen(running)) {
            const said =
              ask.person ??
              (ask.suggestion ? `Another chat's agent suggests (its words, not mine):\n\n${suggestionText(ask.suggestion)}` : ask.failed ? `A new Cloud build failed. ${failureLine(ask.failed)}` : undefined);
            if (said) yield* deps.tell(running.workspace_id, said);
            return { workspace_id: running.workspace_id, session_id: running.session_id };
          }
          const state = yield* fixState;
          if (!state.ok) return yield* fail("invalid_state", state.reason!);
          return yield* startChat(project, repo, ask);
        }),
      );

    /**
     * D1: a failed build while the repo has no ready snapshot sets the setup chat on it by itself, decided once per
     * failed build. Only a build this runtime started (the person's, or background prepare's: remembered with `by`)
     * that ended within the hour: never a teammate's, another runtime's setup chat's test build, or a failure
     * remembered from long ago. Not for a failure only a person or Cloud can fix, not while a setup chat works or waits
     * for review, and only with Settings.cloud_auto_fix on and a Caveman engine that can run. A setup chat that ended
     * a turn with builds and time left is told and goes on; none is started beside it.
     */
    const autoFix = (project: ProjectRef, repo: string, environment: Environment): Effect.Effect<void> =>
      Effect.gen(function* () {
        const build = environment.build!;
        if (deps.onCloudComputer || decided.has(build.id)) return;
        const by = (yield* buildsOf(project.id)).find((b) => b.id === build.id)?.by;
        if (by !== "person" && by !== "background") return;
        // A poll can see the failure before startedBuild records who initiated it. That is not
        // a decision yet: its later read must still notify the chat once ownership is known.
        // Recheck after the store read so concurrent readers cannot both decide the same build.
        if (decided.has(build.id)) return;
        decided.add(build.id);
        const ended = build.finished_at ? Date.parse(build.finished_at) : Number.NaN;
        if (!(Date.now() - ended < timing.autoFixWithinMs)) return;
        if ((yield* store.kvGet(autoFixKey(project.id))) === build.id) return;
        yield* store.kvSet(autoFixKey(project.id), build.id);
        if (build.failure && NOT_THE_SETUP.has(build.failure.kind)) return;
        const chat = yield* chatOf(project.id);
        if (chat && (chat.state === "working" || chat.state === "review")) return;
        if (!(yield* deps.cloudAutoFix) || !(yield* deps.canFix)) return;
        yield* fix(project, repo, { failed: build });
      }).pipe(
        Effect.catchCause((cause) => Effect.logInfo("Cloud setup chat didn't start by itself", cause)),
        Effect.forkIn(scope),
        Effect.asVoid,
      );

    /**
     * Sets up a repo nobody set up (`environment` as Cloud just answered): a branch with its own file gets a build, any
     * other the draft made here, saved. Set up or building already: left as it is. Background prepare saves as Caveman,
     * and says nothing when Cloud refuses the person's save (only admins and people who can push change a repo's
     * Cloud setup: the draft stays here, for Add to repo).
     */
    const setUp = (project: ProjectRef, repo: string, environment: Environment | null, by: "person" | "background") =>
      Effect.gen(function* () {
        if (!environment || environment.state !== "not_set_up" || environment.build !== null) return { environment };
        const latest = () => last.get(project.id)?.environment ?? environment;
        if (environment.source === "repo") {
          const out = yield* deps.cloudCall((id) => startBuild(id, deps.link, { repo }));
          yield* startedBuild(project, out.build_id, by);
          return { environment: latest() };
        }
        const draft = yield* draftFor(project);
        const saved = yield* deps.cloudCall((id) => {
          const save = saveEnvironment(id, deps.link, { repo, config: draft.config, secret_names: draft.secret_names, ...(by === "background" ? { by: "caveman" as const } : {}) });
          return by === "person"
            ? save
            : save.catch((error: unknown) => (error instanceof CloudError && error.code === "cave_code_environment_repo_access" ? undefined : Promise.reject(error)));
        });
        if (saved) yield* startedBuild(project, saved.build_id, by);
        return { environment: saved ? latest() : environment, evidence: draft.evidence };
      });

    /**
     * Background prepare: a project with a GitHub remote and a chat here, Cloud computers available and no ready
     * setup gets a draft saved (or, when its branch has the file, a build) quietly, once per runtime run.
     */
    const prepare = (projectId: string) =>
      Effect.gen(function* () {
        if (prepared.has(projectId) || deps.onCloudComputer || deps.identity() === undefined) return;
        prepared.add(projectId);
        if (!(yield* deps.cloudPrepare) || !(yield* deps.cloudComputersAvailable)) return;
        const project = yield* deps.project(projectId);
        const repo = project && githubRepo(project);
        if (!project || !repo) return;
        yield* setUp(project, repo, (yield* read(project)).environment, "background");
      }).pipe(
        Effect.catchCause((cause) => Effect.logInfo("Background Cloud setup skipped", cause)),
        Effect.forkIn(scope),
        Effect.asVoid,
      );

    /** The chat whose proposal the person reviewed: refused when none waits, or when it isn't the build they saw. */
    const reviewed = (projectId: string, buildId: string) =>
      Effect.gen(function* () {
        const chat = yield* chatOf(projectId);
        if (chat?.state !== "review" || !chat.proposal) return yield* fail("invalid_state", "No setup is waiting for review.");
        if (chat.proposal.build_id !== buildId) return yield* fail("invalid_state", "This fix changed since you looked; review it again.");
        return chat;
      });

    const handlers: { readonly [M in EnvironmentMethod]: (p: Params<M>) => Effect.Effect<Result<M>, ProtocolError> } = {
      "environment.get": (p) =>
        Effect.gen(function* () {
          const project = yield* projectOrFail(p.project_id);
          yield* watch(project.id);
          const got = yield* read(project);
          const chat = yield* chatOf(project.id);
          const proposals = githubRepo(project) === undefined ? [] : yield* proposalsOf(project.id);
          return {
            ...got,
            builds: yield* buildsOf(project.id),
            fix: yield* fixState,
            ...(chat ? { setup_chat: publicChat(chat) } : {}),
            ...(proposals.length > 0 ? { proposals } : {}),
          } as Result<"environment.get">;
        }),
      "environment.draft": (p) =>
        Effect.gen(function* () {
          const project = yield* projectOrFail(p.project_id);
          return yield* draftFor(project);
        }),
      "environment.save": (p) =>
        Effect.gen(function* () {
          const project = yield* projectOrFail(p.project_id);
          const repo = yield* repoOrFail(project);
          yield* Effect.try({ try: () => parseComputerConfig(p.config), catch: (e) => new ProtocolError({ reason: "invalid_params", message: (e as Error).message }) });
          const saved = yield* deps.cloudCall((id) => saveEnvironment(id, deps.link, { repo, config: p.config, ...(p.secret_names ? { secret_names: p.secret_names } : {}) }));
          yield* watch(project.id);
          yield* startedBuild(project, saved.build_id, "person");
          return saved;
        }),
      "environment.setup": (p) =>
        Effect.gen(function* () {
          const project = yield* projectOrFail(p.project_id);
          const repo = yield* repoOrFail(project);
          const got = yield* read(project);
          if (!got.available) return yield* fail("invalid_state", got.reason ?? "Cloud isn't available.");
          yield* watch(project.id);
          return yield* setUp(project, repo, got.environment, "person");
        }),
      "environment.warm": (p) =>
        Effect.gen(function* () {
          const project = yield* projectOrFail(p.project_id);
          const repo = githubRepo(project);
          if (repo === undefined || deps.onCloudComputer || deps.identity() === undefined) return { warm: false };
          const now = Date.now();
          const hinted = hints.get(project.id);
          if (hinted && now - hinted.at < timing.warmEveryMs) return { warm: hinted.warm };
          hints.set(project.id, { at: now, warm: hinted?.warm ?? false });
          yield* prepare(project.id);
          // Cloud's answer, or none: a Caveman Cloud from before warm hints, one without environments, a refusal.
          const warm = yield* deps.cloudCall((id) => warmHint(id, deps.link, { repo })).pipe(Effect.orElseSucceed(() => false));
          hints.set(project.id, { at: now, warm });
          return { warm };
        }),
      "environment.build": (p) =>
        Effect.gen(function* () {
          const project = yield* projectOrFail(p.project_id);
          const repo = yield* repoOrFail(project);
          if (p.config !== undefined) yield* Effect.try({ try: () => parseComputerConfig(p.config!), catch: (e) => new ProtocolError({ reason: "invalid_params", message: (e as Error).message }) });
          const out = yield* deps.cloudCall((id) => startBuild(id, deps.link, { repo, ...(p.config !== undefined ? { config: p.config } : {}), ...(p.save ? { save: true } : {}) }));
          yield* watch(project.id);
          yield* startedBuild(project, out.build_id, "person");
          return out;
        }),
      "environment.build.get": (p) => deps.cloudCall((id) => getBuild(id, deps.link, p.build_id)),
      "environment.build.log": (p) => deps.cloudCall((id) => getBuildLog(id, deps.link, p.build_id)).pipe(Effect.map((text) => ({ text }))),
      "environment.fix": (p) =>
        Effect.gen(function* () {
          const project = yield* projectOrFail(p.project_id);
          return yield* fix(project, yield* repoOrFail(project), { person: p.ask });
        }),
      "environment.publish": (p) =>
        Effect.gen(function* () {
          const project = yield* projectOrFail(p.project_id);
          const repo = yield* repoOrFail(project);
          const chat = yield* reviewed(project.id, p.build_id);
          const { environment } = yield* read(project);
          if (environment?.source === "repo") return yield* fail("invalid_state", `${repo}'s branch has its own .caveman/computer.toml: add the fix to it in a pull request (Add to repo).`);
          // Its turn stops first: nothing it builds after this replaces what is published.
          yield* deps.stop(chat.workspace_id);
          // A save as the person: Cloud applies their own push rule, and the version reads their name. Values its
          // computers read keep their names. Based on the version the chat started from: a save made since is Cloud's
          // to refuse (the proposal stays for another look).
          const saved = yield* deps.cloudCall((id) =>
            saveEnvironment(id, deps.link, {
              repo,
              config: chat.proposal!.config,
              ...(environment ? { secret_names: environment.secret_names } : {}),
              ...(chat.base_version !== undefined ? { base_version: chat.base_version } : {}),
            }),
          );
          const { proposal: _published, ...rest } = (yield* chatOf(project.id)) ?? chat;
          yield* finishChat({ ...rest, saved: true }, "succeeded");
          yield* deps.noteIn(chat.workspace_id, "Published as the repo's Cloud setup", "Chats on Cloud computers start from it once its build passes.");
          yield* watch(project.id);
          yield* startedBuild(project, saved.build_id, "person");
          return saved;
        }),
      "environment.discard": (p) =>
        Effect.gen(function* () {
          const project = yield* projectOrFail(p.project_id);
          const chat = yield* chatOf(project.id);
          if (chat?.state !== "review" || !chat.proposal) return {};
          // Its turn stops first, so a test build passing after this proposes nothing.
          yield* deps.stop(chat.workspace_id);
          const { proposal: _dropped, ...rest } = (yield* chatOf(project.id)) ?? chat;
          yield* finishChat(rest, "stopped");
          yield* deps.noteIn(chat.workspace_id, "Discarded: the Cloud setup stays as it was", "Fix it starts a new setup chat.");
          return {};
        }),
      "environment.proposal.apply": (p) =>
        Effect.gen(function* () {
          const project = yield* projectOrFail(p.project_id);
          const repo = yield* repoOrFail(project);
          const list = yield* proposalsOf(project.id);
          const proposal = list.find((x) => x.id === p.proposal_id);
          if (!proposal) return yield* fail("not_found", "That proposal is gone: it was applied or dismissed.");
          const chat = yield* fix(project, repo, { suggestion: proposal });
          yield* putProposals(project.id, (yield* proposalsOf(project.id)).filter((x) => x.id !== proposal.id));
          return chat;
        }),
      "environment.proposal.dismiss": (p) =>
        Effect.gen(function* () {
          const project = yield* projectOrFail(p.project_id);
          yield* putProposals(project.id, (yield* proposalsOf(project.id)).filter((x) => x.id !== p.proposal_id));
          return {};
        }),
      "environment.proposals": (p) =>
        Effect.gen(function* () {
          const project = yield* projectOrFail(p.project_id);
          return { proposals: githubRepo(project) === undefined ? [] : yield* proposalsOf(project.id) };
        }),
      "environment.versions": (p) =>
        Effect.gen(function* () {
          const project = yield* projectOrFail(p.project_id);
          const repo = yield* repoOrFail(project);
          return { versions: yield* deps.cloudCall((id) => listVersions(id, deps.link, repo)) };
        }),
      "environment.restore": (p) =>
        Effect.gen(function* () {
          const project = yield* projectOrFail(p.project_id);
          const repo = yield* repoOrFail(project);
          // Based on the version the person saw in use (or, unsaid, the one read last): Cloud refuses when one was saved since.
          const base = p.base_version ?? last.get(project.id)?.environment.config_version;
          const restored = yield* deps.cloudCall((id) => restoreVersion(id, deps.link, { repo, version: p.version, ...(base !== undefined ? { base_version: base } : {}) }));
          yield* watch(project.id);
          yield* startedBuild(project, restored.build_id, "person");
          return restored;
        }),
      "environment.build_secret.set": (p) =>
        Effect.gen(function* () {
          const project = yield* projectOrFail(p.project_id);
          const repo = yield* repoOrFail(project);
          const names = yield* deps.cloudCall((id) => setBuildSecret(id, deps.link, { repo, name: p.name, value: p.value })).pipe(Effect.mapError((e) => scrubbed(e, p.value)));
          yield* read(project).pipe(Effect.ignore);
          return { names };
        }),
      "environment.build_secret.delete": (p) =>
        Effect.gen(function* () {
          const project = yield* projectOrFail(p.project_id);
          const repo = yield* repoOrFail(project);
          const names = yield* deps.cloudCall((id) => deleteBuildSecret(id, deps.link, { repo, name: p.name }));
          yield* read(project).pipe(Effect.ignore);
          return { names };
        }),
      "environment.list": () =>
        Effect.gen(function* () {
          const away = unreachable();
          if (away !== undefined) return { environments: [], available: false, reason: away };
          const got = yield* deps.cloudCall((id) => listAll(id, deps.link).then((environments) => ({ environments }), missing));
          if ("missing" in got) return { environments: [], available: false, reason: got.missing };
          // A project here that is the repo (the first, when two checkouts are): its row opens it.
          const here = new Map<string, string>();
          for (const project of yield* deps.projects) {
            const repo = githubRepo(project)?.toLowerCase();
            if (repo !== undefined && !here.has(repo)) here.set(repo, project.id);
          }
          const rows: EnvironmentSummary[] = got.environments.map((e) => {
            const projectId = here.get(e.repo.toLowerCase());
            return projectId === undefined ? e : { ...e, project_id: projectId };
          });
          const listed = new Set(rows.map((e) => e.repo.toLowerCase()));
          for (const [repo, projectId] of here) {
            if (listed.has(repo)) continue;
            const project = yield* deps.project(projectId);
            rows.push({ repo: (project && githubRepo(project)) ?? repo, branch: "", state: "not_set_up", source: "none", updated_by: null, updated_at: null, snapshot_built_at: null, project_id: projectId });
          }
          return { environments: rows, available: true };
        }),
      "environment.setup_repo": (p) =>
        Effect.gen(function* () {
          const repo = p.repo.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
          if (!isGitHubRepo(repo)) return yield* fail("invalid_params", "repo must be a GitHub repository as owner/name.");
          const away = unreachable();
          if (away !== undefined) return yield* fail("invalid_state", away);
          const got = yield* deps.cloudCall((id) => getEnvironment(id, deps.link, repo).then((environment) => ({ environment }), missing));
          if ("missing" in got) return yield* fail("invalid_state", got.missing);
          const environment = got.environment;
          // Set up or building already: left as it is. A branch with its own file only needs its build.
          if (environment.state !== "not_set_up" || environment.build !== null) return { environment };
          if (environment.source === "repo") {
            yield* deps.cloudCall((id) => startBuild(id, deps.link, { repo }));
            return { environment: yield* deps.cloudCall((id) => getEnvironment(id, deps.link, repo)) };
          }
          // A temporary directory of its own under the state dir, gone when the draft is (or isn't) made.
          const root = path.join(deps.stateDir, "environment-drafts");
          const tempRoot = yield* Effect.sync(() => {
            fs.mkdirSync(root, { recursive: true, mode: 0o700 });
            return fs.mkdtempSync(path.join(root, "repo-"));
          });
          const draft = yield* draftFromGitHub({
            repo,
            cloneUrl: remotes.cloneUrl(repo),
            git: deps.git,
            tempRoot,
            ...(Object.keys(environment.services).length > 0 ? { offered: environment.services } : {}),
          }).pipe(Effect.ensuring(Effect.sync(() => fs.rmSync(tempRoot, { recursive: true, force: true }))));
          const saved = yield* deps.cloudCall((id) => saveEnvironment(id, deps.link, { repo, config: draft.config, secret_names: draft.secret_names }));
          return { environment: saved.environment, evidence: draft.evidence };
        }),
      "environment.ci": (p) =>
        Effect.gen(function* () {
          const project = yield* projectOrFail(p.project_id);
          const repo = githubRepo(project);
          if (repo === undefined) return { ci: null };
          const { environment } = yield* read(project);
          if (!environment) return { ci: null };
          // Cloud's builds don't say which commit they cloned: a failed build built the branch's head (as GitHub has it
          // now, which the answer names), so CI on the head answers for it; a gapped check is the snapshot's own commit.
          const commit =
            environment.build?.status === "failed" || environment.snapshot === null
              ? yield* branchHead({ repo, branch: environment.branch, token: yield* deps.githubToken() })
              : environment.snapshot.commit;
          if (!commit) return { ci: null };
          const ci: EnvironmentCi | null = yield* ciStatus({ repo, commit, token: deps.githubToken });
          return { ci };
        }),
      "environment.add_to_repo": (p) =>
        Effect.gen(function* () {
          const project = yield* projectOrFail(p.project_id);
          if (p.build_id !== undefined) {
            // The setup chat's fix for a repo whose branch owns its file: a pull request changing that file, opened by
            // the person, instead of a publish Cloud would refuse.
            const chat = yield* reviewed(project.id, p.build_id);
            yield* deps.stop(chat.workspace_id);
            const opened = yield* deps.openPullRequest(project, chat.proposal!.config, { update: true });
            const { proposal: _proposed, ...rest } = (yield* chatOf(project.id)) ?? chat;
            yield* finishChat({ ...rest, saved: true }, "succeeded");
            yield* deps.noteIn(chat.workspace_id, "Opened a pull request with the fix", opened.url);
            return opened;
          }
          const { environment } = yield* read(project);
          if (environment?.source === "repo") return yield* fail("invalid_state", "This repo already has .caveman/computer.toml.");
          // No Cloud copy (Cloud refused this person's save, or nobody saved one): the setup drafted here.
          const config = environment?.config ?? (environment ? (yield* draftFor(project)).config : undefined);
          if (!config) return yield* fail("invalid_state", STALE_SETUP);
          return yield* deps.openPullRequest(project, config);
        }),
    };

    /** A setup chat's turn ended (failed, until the person answers and it works again) or started again. */
    const turnChanged = (workspaceId: string, projectId: string, running: boolean) =>
      Effect.gen(function* () {
        const chat = yield* chatOf(projectId);
        if (chat?.workspace_id !== workspaceId || chat.saved || chat.state === "stopped" || chat.state === "review") return;
        // An answer after its time ran out (the timer found its turn already ended) gets no turn without a limit.
        if (running && chat.state === "failed" && Date.now() >= Date.parse(chat.started_at) + timing.setupChatMs) {
          yield* timeUp(chat).pipe(Effect.forkIn(scope));
          return;
        }
        // Review holds while the chat talks on (an answer, another try): its proposal waits until the person publishes
        // or discards it, or a newer passing build replaces it.
        if (!running && chat.state === "working") yield* putChat({ ...chat, state: "failed" });
        if (running && chat.state === "failed") yield* putChat({ ...chat, state: "working" });
      });

    // Calls acting as the person check who is calling first, as secret.* does.
    const forbidden = new ProtocolError({ reason: "forbidden", message: "Only this runtime's owner changes its repos' Cloud setup." });
    const asThePerson: ReadonlySet<string> = new Set(AS_THE_PERSON);
    const guarded = Object.fromEntries(
      Object.entries(handlers).map(([method, handler]) => [
        method,
        (params: never, ctx?: CallContext) => (asThePerson.has(method) && !deps.allowed(ctx?.principal) ? Effect.fail(forbidden) : (handler as (p: never) => Effect.Effect<unknown, ProtocolError>)(params)),
      ]),
    ) as unknown as { readonly [M in EnvironmentMethod]: (p: Params<M>, ctx?: CallContext) => Effect.Effect<Result<M>, ProtocolError> };

    return { handlers: guarded, changes, proposed, chatChanged, prepare, turnChanged };
  });

// ------------------------------------------------------------- the boot note

const SERVICE_PORTS: Readonly<Record<string, number>> = { postgres: 5432, redis: 6379, mysql: 3306 };

/** "2 h ago", "3 days ago": a snapshot's age for the engine. */
export function ago(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(min)) return "at an unknown time";
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/**
 * The one line a Cloud computer's first turn starts with: what it booted from (the
 * snapshot's age and commit), whether setup ran or was skipped, and which services answer.
 */
export function bootNote(input: {
  readonly marker: { readonly commit?: string; readonly built_at?: string } | undefined;
  /** "copying": setup is baked into the computer, and what it installed is being copied into this chat's own checkout. */
  readonly setup: "skipped" | "running" | "copying" | "none";
  readonly services: ReadonlyArray<{ readonly name: string; readonly version: string; readonly up: boolean }>;
  /** What this boot's on_wake and start could not do (bootSteps.ts), one sentence each. */
  readonly steps?: ReadonlyArray<string>;
  readonly now?: number;
}): string {
  const from =
    input.marker?.commit && input.marker.built_at
      ? `booted from the repo's snapshot built ${ago(input.marker.built_at, input.now)} at ${input.marker.commit.slice(0, 7)}`
      : "booted without a snapshot of the repo, so nothing it installs is there yet";
  const setup =
    input.setup === "skipped"
      ? "Setup skipped: nothing it installs changed since."
      : input.setup === "running"
        ? "Setup ([setup].run) is running now for what changed since; it reports when it ends."
        : input.setup === "copying"
          ? "Setup is not run again: what it installed is being copied into this chat's checkout now; a note says when it is there."
          : "The repo has no [setup].run.";
  const services = input.services.length === 0 ? "" : ` Services: ${input.services.map((s) => `${s.name} ${s.version} ${s.up ? `up on 127.0.0.1:${SERVICE_PORTS[s.name] ?? "?"}` : "not answering"}`).join(", ")}.`;
  const steps = input.steps?.length ? ` When it last woke: ${input.steps.join(" ")}` : "";
  return `[Caveman Code] This Cloud computer ${from}. ${setup}${services}${steps}`;
}

/** Whether something listens on 127.0.0.1:`port` (half a second at most). */
export const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    import("node:net").then(({ connect }) => {
      const socket = connect({ host: "127.0.0.1", port, timeout: 500 });
      const done = (up: boolean) => {
        socket.destroy();
        resolve(up);
      };
      socket.once("connect", () => done(true));
      socket.once("timeout", () => done(false));
      socket.once("error", () => done(false));
    });
  });

export const servicePort = (name: string) => SERVICE_PORTS[name];
