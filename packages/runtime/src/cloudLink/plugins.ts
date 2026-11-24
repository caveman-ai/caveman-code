// Plugins in Caveman Cloud (marketplace design 2026-10-17 §7): what applies to
// a repository (the runtime route, with the runtime's own token) and the
// person's project and install writes (person routes, with the person's own
// Caveman sign-in, so Cloud checks their role: a team install needs org:update).
// Tenant scope is always the token's; nothing in a body names an org.
import type { CloudPlugins, InstallPolicy } from "../plugins/marketplaces.ts";
import { type AccountStore, accountCall } from "./account.ts";
import { call } from "./computers.ts";
import { CloudError, cloudFailure, type Identity } from "./identity.ts";
import type { LinkState } from "./index.ts";

/**
 * Team and project installs and org marketplaces for `repository`
 * (`host/owner/name`; absent: team only). Undefined when this Cloud has no
 * plugins yet (404): nothing applies.
 */
export async function runtimePlugins(identity: Identity, state: LinkState, repository: string | undefined, fetchImpl?: typeof fetch): Promise<CloudPlugins | undefined> {
  try {
    const out = await call<CloudPlugins>(identity, state, "GET", `plugins${repository === undefined ? "" : `?repository=${encodeURIComponent(repository)}`}`, undefined, fetchImpl);
    return { marketplaces: out?.marketplaces ?? [], installs: out?.installs ?? [], ...(out?.project ? { project: out.project } : {}) };
  } catch (cause) {
    if (cause instanceof CloudError && cause.status === 404) return undefined;
    throw cause;
  }
}

export interface CloudProject {
  readonly id: string;
  readonly name: string;
  readonly repos: ReadonlyArray<string>;
}

async function person<T>(store: AccountStore, route: string, init: { method?: string; body?: unknown } = {}, fetchImpl?: typeof fetch): Promise<T> {
  const response = await accountCall(store, route, init, fetchImpl);
  if (!response.ok) throw await cloudFailure(response);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export async function listProjects(store: AccountStore, fetchImpl?: typeof fetch): Promise<ReadonlyArray<CloudProject>> {
  const out = await person<{ projects?: CloudProject[] }>(store, "/api/v1/code/projects", {}, fetchImpl);
  return out.projects ?? [];
}

/** The active project holding `repository`, or a new one named `name` holding it; Cloud makes racing first installs share one. */
export const projectForRepository = (store: AccountStore, repository: string, name: string, fetchImpl?: typeof fetch) =>
  person<CloudProject>(store, "/api/v1/code/projects/for-repository", { method: "POST", body: { repository, name } }, fetchImpl);

export const createProject = (store: AccountStore, name: string, fetchImpl?: typeof fetch) =>
  person<CloudProject>(store, "/api/v1/code/projects", { method: "POST", body: { name } }, fetchImpl);

export const addProjectRepo = (store: AccountStore, projectId: string, repository: string, fetchImpl?: typeof fetch) =>
  person<CloudProject>(store, `/api/v1/code/projects/${encodeURIComponent(projectId)}/repos`, { method: "POST", body: { repository } }, fetchImpl);

export const removeProjectRepo = (store: AccountStore, projectId: string, repository: string, fetchImpl?: typeof fetch) =>
  person<CloudProject>(store, `/api/v1/code/projects/${encodeURIComponent(projectId)}/repos?repository=${encodeURIComponent(repository)}`, { method: "DELETE" }, fetchImpl);

/** Adds a git marketplace to the org (org admins; Cloud answers 403 otherwise). */
export const addOrgMarketplace = (store: AccountStore, input: { readonly name: string; readonly repo: string; readonly ref?: string; readonly commit: string }, fetchImpl?: typeof fetch) =>
  person<unknown>(store, "/api/v1/code/marketplaces", { method: "POST", body: input }, fetchImpl);

export interface InstallInput {
  readonly scope: "team" | "project";
  readonly project_id?: string;
  readonly plugin_id: string;
  readonly source?: { readonly url: string; readonly path?: string };
  readonly commit?: string;
  readonly version?: string;
  readonly policy: InstallPolicy;
  readonly connection: "personal" | "shared";
}

export const installPlugin = (store: AccountStore, input: InstallInput, fetchImpl?: typeof fetch) =>
  person<unknown>(store, "/api/v1/code/plugins/installs", { method: "POST", body: input }, fetchImpl);

export const uninstallPlugin = (store: AccountStore, input: { readonly scope: "team" | "project"; readonly project_id?: string; readonly plugin_id: string }, fetchImpl?: typeof fetch) =>
  person<unknown>(
    store,
    `/api/v1/code/plugins/installs?${new URLSearchParams({ scope: input.scope, plugin_id: input.plugin_id, ...(input.project_id === undefined ? {} : { project_id: input.project_id }) })}`,
    { method: "DELETE" },
    fetchImpl,
  );
