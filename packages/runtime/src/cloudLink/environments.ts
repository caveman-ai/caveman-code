// A repo's Cloud setup from This Mac (docs/ §3): Caveman Cloud's
// environments routes, called with the runtime's own token as the member who signed this runtime in, like
// cloud.computers. Cloud's answers are copied field by field, so a field Cloud adds never reaches a client.
import type { Environment, EnvironmentBuild, EnvironmentSummary, EnvironmentVersion } from "@caveman-app/session-protocol";

import { call, request } from "./computers.ts";
import type { Identity } from "./identity.ts";
import type { LinkState } from "./index.ts";

type Raw = Record<string, unknown>;
const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
const strOrNull = (v: unknown) => (typeof v === "string" ? v : null);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

const STEP_STATUS = ["pending", "running", "done", "failed", "skipped"] as const;
const BUILD_STATUS = ["queued", "running", "validating", "succeeded", "failed"] as const;
const FAILURE_KINDS = ["command", "timeout", "too_big", "registry_auth", "service", "check", "restore", "clone", "start", "secret_on_disk"] as const;
const STATES = ["not_set_up", "setting_up", "ready", "ready_with_gaps", "failed"] as const;
const oneOf = <T extends string>(values: ReadonlyArray<T>, v: unknown, fallback: T): T => (values.includes(v as T) ? (v as T) : fallback);

export function toBuild(raw: Raw): EnvironmentBuild {
  const failure = raw.failure as Raw | null | undefined;
  return {
    id: str(raw.id),
    status: oneOf(BUILD_STATUS, raw.status, "queued"),
    steps: (Array.isArray(raw.steps) ? (raw.steps as Raw[]) : []).map((s) => {
      const seconds = num(s.seconds);
      return { name: str(s.name), status: oneOf(STEP_STATUS, s.status, "pending"), ...(seconds === undefined ? {} : { seconds }) };
    }),
    log_tail: str(raw.log_tail),
    // A kind this app doesn't know yet reads as a failed command: its message still says what happened.
    failure: failure ? { kind: oneOf(FAILURE_KINDS, failure.kind, "command"), step: str(failure.step), message: str(failure.message) } : null,
    gaps: strs(raw.gaps),
    started_at: strOrNull(raw.started_at),
    finished_at: strOrNull(raw.finished_at),
  };
}

export function toEnvironment(raw: Raw): Environment {
  const snapshot = raw.snapshot as Raw | null | undefined;
  const services = (raw.services ?? {}) as Record<string, unknown>;
  const version = num(raw.config_version);
  return {
    repo: str(raw.repo),
    branch: str(raw.branch),
    state: oneOf(STATES, raw.state, "not_set_up"),
    source: oneOf(["repo", "cloud", "none"] as const, raw.source, "none"),
    config: strOrNull(raw.config),
    ...(version === undefined ? {} : { config_version: Math.floor(version) }),
    updated_by: strOrNull(raw.updated_by),
    updated_at: strOrNull(raw.updated_at),
    secret_names: strs(raw.secret_names),
    // Names only: Cloud never answers a build secret's value, and none would be copied here if it did.
    ...(Array.isArray(raw.build_secret_names) ? { build_secret_names: strs(raw.build_secret_names) } : {}),
    sizes: strs(raw.sizes),
    max_size: str(raw.max_size),
    services: Object.fromEntries(Object.entries(services).map(([name, versions]) => [name, strs(versions)])),
    snapshot: snapshot
      ? {
          commit: str(snapshot.commit),
          built_at: str(snapshot.built_at),
          checks: (Array.isArray(snapshot.checks) ? (snapshot.checks as Raw[]) : []).map((c) => ({ command: str(c.command), ok: c.ok === true, seconds: num(c.seconds) ?? 0 })),
        }
      : null,
    build: raw.build ? toBuild(raw.build as Raw) : null,
  };
}

const query = (repo: string, branch: string | undefined) => `repo=${encodeURIComponent(repo)}${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`;

export const getEnvironment = async (identity: Identity, state: LinkState, repo: string, branch?: string, fetchImpl?: typeof fetch) =>
  toEnvironment(await call<Raw>(identity, state, "GET", `environments?${query(repo, branch)}`, undefined, fetchImpl));

export async function saveEnvironment(
  identity: Identity,
  state: LinkState,
  /**
   * `by: "caveman"`: Caveman saved it (background prepare); the version reads updated_by Caveman. `base_version`: the
   * Cloud-copy version this text was based on; Cloud answers 409 cave_code_environment_changed when a newer one is saved.
   */
  input: { readonly repo: string; readonly branch?: string; readonly config: string; readonly secret_names?: ReadonlyArray<string>; readonly by?: "caveman"; readonly base_version?: number },
  fetchImpl?: typeof fetch,
) {
  const out = await call<{ environment: Raw; build_id: string }>(identity, state, "PUT", "environments", input, fetchImpl);
  return { environment: toEnvironment(out.environment), build_id: str(out.build_id) };
}

export async function startBuild(
  identity: Identity,
  state: LinkState,
  input: { readonly repo: string; readonly branch?: string; readonly config?: string; readonly save?: boolean; readonly by?: "caveman" },
  fetchImpl?: typeof fetch,
) {
  return { build_id: str((await call<{ build_id: string }>(identity, state, "POST", "environments/builds", input, fetchImpl)).build_id) };
}

/** A person is about to start a Cloud chat on the repo: Cloud keeps a computer standing on its ready snapshot. */
export const warmHint = async (identity: Identity, state: LinkState, input: { readonly repo: string; readonly branch?: string }, fetchImpl?: typeof fetch) =>
  (await call<{ warm?: unknown }>(identity, state, "POST", "environments/warm-hint", input, fetchImpl))?.warm === true;

export const getBuild = async (identity: Identity, state: LinkState, id: string, fetchImpl?: typeof fetch) =>
  toBuild(await call<Raw>(identity, state, "GET", `environments/builds/${encodeURIComponent(id)}`, undefined, fetchImpl));

export const getBuildLog = async (identity: Identity, state: LinkState, id: string, fetchImpl?: typeof fetch) =>
  (await request(identity, state, "GET", `environments/builds/${encodeURIComponent(id)}/log`, undefined, fetchImpl, { accept: "text/plain" })).text();

/** A shared build secret (setup and checks read it at build time): the value goes to Cloud once and never comes back. */
export const setBuildSecret = async (identity: Identity, state: LinkState, input: { readonly repo: string; readonly branch?: string; readonly name: string; readonly value: string }, fetchImpl?: typeof fetch) =>
  strs((await call<{ names?: unknown }>(identity, state, "PUT", "environments/secrets", input, fetchImpl))?.names);

export const deleteBuildSecret = async (identity: Identity, state: LinkState, input: { readonly repo: string; readonly name: string }, fetchImpl?: typeof fetch) =>
  strs((await call<{ names?: unknown }>(identity, state, "DELETE", "environments/secrets", input, fetchImpl))?.names);

export async function listVersions(identity: Identity, state: LinkState, repo: string, fetchImpl?: typeof fetch): Promise<EnvironmentVersion[]> {
  const out = await call<{ versions?: unknown }>(identity, state, "GET", `environments/versions?repo=${encodeURIComponent(repo)}`, undefined, fetchImpl);
  return (Array.isArray(out?.versions) ? (out.versions as Raw[]) : []).flatMap((v) => {
    const version = num(v.version);
    return version === undefined ? [] : [{ version: Math.floor(version), config: str(v.config), updated_by: strOrNull(v.updated_by), updated_at: str(v.updated_at) }];
  });
}

export async function restoreVersion(identity: Identity, state: LinkState, input: { readonly repo: string; readonly branch?: string; readonly version: number; readonly base_version?: number }, fetchImpl?: typeof fetch) {
  const out = await call<{ environment: Raw; build_id: string }>(identity, state, "POST", "environments/versions/restore", input, fetchImpl);
  return { environment: toEnvironment(out.environment), build_id: str(out.build_id) };
}

/** Every environment of the organization the person may read (Cloud's /all); `project_id` is the runtime's to add. */
export async function listAll(identity: Identity, state: LinkState, fetchImpl?: typeof fetch): Promise<EnvironmentSummary[]> {
  const out = await call<{ environments?: unknown }>(identity, state, "GET", "environments/all", undefined, fetchImpl);
  return (Array.isArray(out?.environments) ? (out.environments as Raw[]) : []).map((e) => ({
    repo: str(e.repo),
    branch: str(e.branch),
    state: oneOf(STATES, e.state, "not_set_up"),
    source: oneOf(["repo", "cloud", "none"] as const, e.source, "none"),
    updated_by: strOrNull(e.updated_by),
    updated_at: strOrNull(e.updated_at),
    snapshot_built_at: strOrNull(e.snapshot_built_at),
  }));
}

export const buildDone = (b: Pick<EnvironmentBuild, "status">) => b.status === "succeeded" || b.status === "failed";
