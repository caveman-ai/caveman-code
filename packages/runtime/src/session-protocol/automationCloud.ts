// automation.apply, automation.cloud_runs, agent.publish and agent.published: Caveman Cloud's automations and
// agents, reached as the person who signed this computer in. The runtime holds only its own runtime token, so it
// calls the runtime twins of the person routes (CONTRACT-CHANGES A2-2) and Cloud acts as that person. The files
// sent are checked here first; a file with errors never leaves this computer.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { parseAgentFile, renderDiagnostics, type ParsedAgent } from "@caveman-app/automations";
import type { CloudAgent, CloudAutomation, CloudAutomationRun } from "@caveman-app/session-protocol/protocol";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { ApplyError, applyPlanFrom, applyPlanOf, appliedFrom, authorityDiffFrom, renderApplied, repoSlug } from "../automations/apply.ts";
import { defaultBranchOf, fetchDefaultBranch, git, readBranch, readWorkingTree, type ProjectSources } from "../automations/files.ts";
import type { Handler } from "./handlers.ts";
import { ProtocolError } from "./handlers.ts";

type CloudMethod = "automation.apply" | "automation.cloud_runs" | "automation.cloud_list" | "automation.cloud_answer" | "agent.publish" | "agent.published";

export interface AutomationCloudDeps {
  /** One `/api/v1/code/runtime/<path>` call as the signed-in person; refusals arrive as protocol errors. */
  readonly cloud: <A>(method: "GET" | "POST", path: string, body?: unknown) => Effect.Effect<A, ProtocolError>;
  /** A project's checkout on this computer. */
  readonly projectRoot: (projectId: string) => Effect.Effect<string | undefined>;
  /** The agents every repository can name (the user's and the built-ins), for check. */
  readonly registry: Effect.Effect<ReadonlyArray<ParsedAgent>>;
  /** Caveman Cloud's origin, for a new webhook's URL in the apply's text. */
  readonly origin?: () => string | undefined;
  /** Files never read whatever their name, symlinks followed: the runtime's own state (auth/serverInternalPaths.ts). */
  readonly refused?: (file: string) => boolean;
}

const fail = (reason: string, message: string) => new ProtocolError({ reason, message });
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : 0);

/** Cloud's run rows, read tolerantly: unknown fields are ignored, missing ones default. */
export function cloudRunsFrom(raw: unknown): CloudAutomationRun[] {
  const list = (raw as { runs?: unknown } | undefined)?.runs;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): CloudAutomationRun[] => {
    if (item === null || typeof item !== "object") return [];
    const r = item as Record<string, unknown>;
    const id = str(r.id) ?? str(r.run_id);
    const automationId = str(r.automation_id);
    if (id === undefined || automationId === undefined) return [];
    const ask = (r.requires_action !== null && typeof r.requires_action === "object" ? r.requires_action : undefined) as Record<string, unknown> | undefined;
    const askKind = ask?.kind === "approval" || ask?.kind === "question" || ask?.kind === "tool" ? ask.kind : undefined;
    const askId = str(ask?.ask_id);
    const name = str(r.name) ?? str(r.automation);
    const repo = str(r.repo);
    const step = str(ask?.step);
    const by = ask?.by === "owner" || ask?.by === "members" ? ask.by : undefined;
    return [
      {
        id,
        automation_id: automationId,
        revision_id: str(r.revision_id) ?? null,
        trigger: str(r.trigger) ?? "manual",
        status: str(r.status) ?? "queued",
        outcome: str(r.outcome) ?? null,
        session_id: str(r.session_id) ?? null,
        cost_usd: num(r.cost_usd),
        started_at: str(r.started_at) ?? null,
        finished_at: str(r.finished_at) ?? str(r.ended_at) ?? null,
        ...(name === undefined ? {} : { name }),
        ...(repo === undefined ? {} : { repo }),
        ...(askKind === undefined || askId === undefined
          ? {}
          : { requires_action: { ask_id: askId, kind: askKind, ...(step === undefined ? {} : { step }), ...(by === undefined ? {} : { by }) } }),
      },
    ];
  });
}

const STATES = new Set(["active", "pending_approval", "superseded", "unchanged", "removed"]);

/** Cloud's automations, read tolerantly. */
export function cloudAutomationsFrom(raw: unknown): CloudAutomation[] {
  const list = Array.isArray(raw) ? raw : (raw as { automations?: unknown } | undefined)?.automations;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): CloudAutomation[] => {
    if (item === null || typeof item !== "object") return [];
    const a = item as Record<string, unknown>;
    const id = str(a.id);
    if (id === undefined) return [];
    const state = str(a.state) ?? str(a.revision_state);
    const appliedAt = str(a.applied_at) ?? str(a.updated_at);
    return [
      {
        id,
        name: str(a.name) ?? id,
        repo: str(a.repo) ?? "",
        path: str(a.path) ?? "",
        enabled: a.enabled !== false,
        state: state !== undefined && STATES.has(state) ? (state as CloudAutomation["state"]) : "active",
        revision_id: str(a.revision_id) ?? str(a.active_revision_id) ?? null,
        ...(appliedAt === undefined ? {} : { applied_at: appliedAt }),
        ...(a.authority_diff === undefined || a.authority_diff === null ? {} : { authority_diff: authorityDiffFrom(a.authority_diff) }),
      },
    ];
  });
}

/** One Cloud agent, read tolerantly (summary fields may sit at the top or under `summary`). */
export function cloudAgentFrom(raw: unknown): CloudAgent | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const a = raw as Record<string, unknown>;
  const id = str(a.id);
  const name = str(a.name);
  if (id === undefined || name === undefined) return undefined;
  const summary = (a.summary !== null && typeof a.summary === "object" ? a.summary : {}) as Record<string, unknown>;
  const description = str(a.description) ?? str(summary.description);
  const engine = str(a.engine) ?? str(summary.engine);
  const model = str(a.model) ?? str(summary.model);
  const sha = str(a.file_sha256) ?? str(a.latest_file_sha256);
  return {
    id,
    name,
    latest_version: Math.max(0, Math.trunc(num(a.latest_version ?? a.version))),
    ...(description === undefined ? {} : { description }),
    ...(engine === undefined ? {} : { engine }),
    ...(model === undefined ? {} : { model }),
    archived: a.archived === true || str(a.archived_at) !== undefined,
    ...(sha === undefined ? {} : { file_sha256: sha }),
  };
}

const agentsFrom = (raw: unknown): CloudAgent[] => {
  const list = Array.isArray(raw) ? raw : (raw as { agents?: unknown } | undefined)?.agents;
  return Array.isArray(list) ? list.flatMap((a) => cloudAgentFrom(a) ?? []) : [];
};

/** Only agent files go to Cloud: a markdown file in an agents folder (`.caveman/agents`, `.claude/agents`). */
const AGENT_FILE = /(^|\/)\.(caveman|claude)\/agents\/[^/]+\.md$/;

export const makeAutomationCloudHandlers = (deps: AutomationCloudDeps) => {
  const rootOf = (p: { readonly repo_root?: string | undefined; readonly project_id?: string | undefined }) =>
    Effect.gen(function* () {
      if (p.repo_root !== undefined) {
        if (!path.isAbsolute(p.repo_root) || !fs.existsSync(path.join(p.repo_root, ".git"))) {
          return yield* fail("invalid_params", `${p.repo_root} is not a git checkout on this computer.`);
        }
        return p.repo_root;
      }
      if (p.project_id === undefined) return yield* fail("invalid_params", "Name the repository: repo_root or project_id.");
      const root = yield* deps.projectRoot(p.project_id);
      if (root === undefined) return yield* fail("not_found", `No checkout of project ${p.project_id} on this computer.`);
      return root;
    });

  return {
    "automation.apply": (p) =>
      Effect.gen(function* () {
        const root = yield* rootOf(p);
        const registry = yield* deps.registry;
        const plan = yield* Effect.tryPromise({
          try: () => applyPlanOf(root, registry),
          catch: (error) => (error instanceof ApplyError ? fail(error.reason === "nothing" ? "not_found" : "invalid_params", error.message) : fail("internal", (error as Error).message)),
        });
        const answer = yield* deps.cloud<unknown>("POST", "automations/apply", plan.body);
        const automations = [...appliedFrom(answer)];
        return {
          repo: plan.body.repo,
          commit_sha: plan.body.commit_sha,
          automations,
          skipped: [...plan.skipped],
          text: renderApplied({ repo: plan.body.repo, automations, skipped: plan.skipped, origin: deps.origin?.() }),
        };
      }),

    "automation.cloud_runs": (p) =>
      Effect.gen(function* () {
        const query = new URLSearchParams();
        if (p.automation_id !== undefined) query.set("automation_id", p.automation_id);
        query.set("limit", String(p.limit ?? 50));
        const answer = yield* deps.cloud<unknown>("GET", `automations/runs?${query.toString()}`);
        return { runs: cloudRunsFrom(answer) };
      }),

    "automation.cloud_list": () => deps.cloud<unknown>("GET", "automations").pipe(Effect.map((answer) => ({ automations: cloudAutomationsFrom(answer) }))),

    "automation.cloud_answer": (p) =>
      Effect.gen(function* () {
        // The run's session: given, else found among the person's recent Cloud runs.
        const sessionId =
          p.session_id ??
          cloudRunsFrom(yield* deps.cloud<unknown>("GET", "automations/runs?limit=200")).find((r) => r.id === p.run_id)?.session_id ??
          undefined;
        if (sessionId === undefined) return yield* fail("not_found", `Cloud has no session for run ${p.run_id} that is waiting on you.`);
        yield* deps.cloud<unknown>("POST", `sessions/${encodeURIComponent(sessionId)}/user-events`, {
          request_id: p.request_id,
          type: "user.approval",
          ask_id: p.ask_id,
          decision: p.decision,
          ...(p.message === undefined ? {} : { message: p.message }),
        });
        return {};
      }),

    "agent.publish": (p) =>
      Effect.gen(function* () {
        const root = p.project_id === undefined ? undefined : yield* rootOf({ project_id: p.project_id });
        const file = path.isAbsolute(p.path) ? p.path : root === undefined ? undefined : path.join(root, p.path);
        if (file === undefined) return yield* fail("invalid_params", "A repo-relative path needs project_id; or give an absolute path.");
        const normalized = path.normalize(file).split(path.sep).join("/");
        if (!AGENT_FILE.test(normalized)) return yield* fail("invalid_params", "Only an agent file publishes: a .md file in .caveman/agents/ or .claude/agents/.");
        if (deps.refused?.(file)) return yield* fail("not_found", `No agent file at ${p.path}.`);
        const text = yield* Effect.tryPromise({ try: () => fs.promises.readFile(file, "utf8"), catch: () => fail("not_found", `No agent file at ${p.path}.`) });
        const rel = normalized.slice(normalized.search(/\.(caveman|claude)\/agents\//));
        const parsed = parseAgentFile({ path: rel, text }, "project");
        const errors = parsed.diagnostics.filter((d) => d.severity === "error");
        if (parsed.agent === undefined || errors.length > 0) {
          return yield* fail("invalid_params", `The agent file has errors; fix them, then publish.\n${renderDiagnostics(errors.length > 0 ? errors : parsed.diagnostics)}`);
        }
        const name = parsed.agent.name;
        const existing = agentsFrom(yield* deps.cloud<unknown>("GET", "agents")).find((a) => a.name === name);
        const answer =
          existing === undefined
            ? yield* deps.cloud<unknown>("POST", "agents", { name, file: text })
            : yield* deps.cloud<unknown>("POST", `agents/${encodeURIComponent(existing.id)}`, { file: text });
        const saved = cloudAgentFrom((answer as { agent?: unknown } | undefined)?.agent ?? answer);
        if (saved === undefined) return yield* fail("internal", "Caveman answered without the agent it saved.");
        const version = saved.latest_version;
        return { agent_id: saved.id, name, version, unchanged: existing !== undefined && existing.latest_version === version };
      }),

    "agent.published": () => deps.cloud<unknown>("GET", "agents").pipe(Effect.map((answer) => ({ agents: agentsFrom(answer) }))),
  } satisfies { readonly [M in CloudMethod]: Handler<M> };
};

const CLOUD_HOST = /^host:\s*["']?cloud["']?\s*(#.*)?$/m;
const hasCloudAutomation = (sources: ProjectSources | undefined) =>
  (sources?.files ?? []).some((f) => f.path.startsWith(".caveman/automations/") && CLOUD_HOST.test(f.text));
const FETCH_EVERY_MS = 2 * 60_000;
/** A send Cloud refused (or that failed) waits this long before the same files are tried again. */
const RETRY_AFTER_MS = 30 * 60_000;
/** What was last sent for a repository with nothing for Cloud any more: an empty set, which retires its automations. */
const EMPTY = "empty";

/**
 * Merging deploys: when a project's default branch carries `host: cloud` automations
 * that differ from what this computer last sent, they go to Caveman Cloud as the signed-in person, exactly as
 * automation.apply sends them, but read from the default branch at its head (definitions come from the default
 * branch, rule 1). Removing the last one from the branch retires it in Cloud. Cloud's GitHub App does the same on a
 * push where it is installed; the same files again come back unchanged, so the two never conflict, and a stale
 * origin (its fetch failed) is never sent. Cloud still holds a revision that widens authority for the owner. A
 * Deploy to Cloud of a branch's copy lasts until the default branch next changes what Cloud runs.
 */
export const deployOnMerge = (deps: AutomationCloudDeps & {
  readonly projects: Effect.Effect<ReadonlyArray<{ readonly projectId: string; readonly root: string }>>;
  readonly changes: Stream.Stream<{ readonly projectId: string }>;
  /** Where what was last sent is kept, so a restart neither resends nor misses a merge made while it was off. */
  readonly stateFile?: string;
}) =>
  Effect.gen(function* () {
    const deploy = makeDeployer(deps);
    const each = (rows: ReadonlyArray<{ readonly root: string }>) => Effect.forEach(rows, (r) => deploy(r.root), { concurrency: 2, discard: true });
    // The project a change names (a merge moves origin's head, a file saved), and a slow tick for fetches.
    yield* Effect.forkScoped(
      deps.changes.pipe(
        Stream.debounce("2 seconds"),
        Stream.runForEach(({ projectId }) => deps.projects.pipe(Effect.flatMap((rows) => each(rows.filter((r) => r.projectId === projectId))))),
      ),
    );
    yield* Effect.forkScoped(deps.projects.pipe(Effect.flatMap(each), Effect.repeat(Schedule.spaced("3 minutes"))));
  });

/** One checkout's deploy on merge, remembering what it last sent so the same files never go twice. */
export const makeDeployer = (deps: Pick<AutomationCloudDeps, "cloud" | "registry"> & { readonly stateFile?: string; readonly now?: () => number }) => {
  const now = deps.now ?? Date.now;
  /** Per checkout: sha256 of the files last sent (or EMPTY). Kept in `stateFile` when there is one. */
  const sent = new Map<string, string>(Object.entries(readState(deps.stateFile)));
  const failed = new Map<string, { key: string; at: number }>();
  const fetched = new Map<string, { at: number; ok: boolean }>();
  const busy = new Set<string>();
  const remember = (root: string, key: string) => {
    sent.set(root, key);
    writeState(deps.stateFile, Object.fromEntries(sent));
  };
  return (root: string) =>
    Effect.gen(function* () {
      if (busy.has(root)) return;
      busy.add(root);
      yield* Effect.gen(function* () {
        const branch = yield* Effect.promise(() => defaultBranchOf(root));
        if (branch === undefined) return;
        // Only a repository that has (or had, or is about to merge) a Cloud automation is fetched for this.
        const before = yield* Effect.promise(() => readBranch(root, branch.ref).catch(() => undefined));
        const hadSent = sent.has(root) && sent.get(root) !== EMPTY;
        if (!hadSent && !hasCloudAutomation(before) && !hasCloudAutomation(yield* Effect.promise(() => readWorkingTree(root).catch(() => undefined)))) return;
        if (branch.ref.startsWith("origin/")) {
          const last = fetched.get(root);
          if (last === undefined || !last.ok || now() - last.at > FETCH_EVERY_MS) {
            const ok = yield* Effect.promise(() => fetchDefaultBranch(root, branch.name));
            fetched.set(root, { at: now(), ok });
          }
          // Offline, or no access: origin's copy may be older than what Cloud runs, so nothing is sent.
          if (fetched.get(root)?.ok !== true) return;
        }
        const [sources, remote, head] = yield* Effect.promise(() =>
          Promise.all([readBranch(root, branch.ref).catch(() => undefined), git(root, ["remote", "get-url", "origin"]).catch(() => ""), git(root, ["rev-parse", branch.ref]).catch(() => "")]),
        );
        const repo = repoSlug(remote);
        if (sources === undefined || repo === undefined || head.trim() === "") return;
        const body = hasCloudAutomation(sources)
          ? applyPlanFrom({ sources, registry: yield* deps.registry, repo, commitSha: head.trim() }).body
          : hadSent
            ? { repo, commit_sha: head.trim(), files: {} }
            : undefined;
        if (body === undefined) return;
        const key = Object.keys(body.files).length === 0 ? EMPTY : createHash("sha256").update(JSON.stringify(Object.entries(body.files).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
        if (sent.get(root) === key) return;
        const lastFailure = failed.get(root);
        if (lastFailure?.key === key && now() - lastFailure.at < RETRY_AFTER_MS) return;
        const answer = yield* deps.cloud<unknown>("POST", "automations/apply", body).pipe(
          Effect.tapError(() => Effect.sync(() => failed.set(root, { key, at: now() }))),
        );
        failed.delete(root);
        remember(root, key);
        const applied = appliedFrom(answer).filter((a) => a.state !== "unchanged");
        if (applied.length > 0) yield* Effect.logInfo(`Deployed ${repo}@${branch.name} to Caveman Cloud: ${applied.map((a) => `${a.name} (${a.state})`).join(", ")}`);
      }).pipe(Effect.ensuring(Effect.sync(() => busy.delete(root))));
    }).pipe(
      // Errors in a file never leave this computer (applyPlanFrom throws); a refusal waits RETRY_AFTER_MS.
      Effect.catchCause((cause) => Effect.logDebug("Cloud automations not deployed on merge", cause)),
    );
};

function readState(file: string | undefined): Record<string, string> {
  if (file === undefined) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" ? Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
  } catch {
    return {};
  }
}

function writeState(file: string | undefined, state: Record<string, string>): void {
  if (file === undefined) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
    fs.renameSync(`${file}.tmp`, file);
  } catch {}
}
