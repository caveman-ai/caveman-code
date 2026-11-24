// Connectors held by Caveman Cloud (Cloud's /code/runtime/connections): Cloud runs the OAuth sign-in
// (discovery, client registration, PKCE, its own callback), keeps and refreshes the tokens, and leases a
// short-lived access token to this runtime, which only the hub attaches (plugins/connectors.ts). The
// runtime never sends Cloud a token and never refreshes one itself.
import { call } from "./computers.ts";
import type { Identity } from "./identity.ts";
import type { LinkState } from "./index.ts";

/**
 * A connection by resource (an MCP server's URL) or GitHub. `plugin_id` names
 * the plugin it serves: a lease then gets the person's own connection, else
 * the org's shared account when an install of that plugin shares one (Cloud
 * finds the project from `repository` itself; nothing here names a project).
 * `owner: "org"` on a start connects that shared account (org admins).
 */
export type ConnectionTarget = ({ readonly resource: string } | { readonly provider: "github" }) & {
  readonly plugin_id?: string;
  /** A lease's repository (`host/owner/name`): where the session works, so Cloud finds the project's shared install. */
  readonly repository?: string;
  readonly owner?: "org";
};

export interface CloudConnection {
  readonly connection_id: string;
  readonly resource?: string;
  readonly provider?: string;
  readonly issuer?: string;
  readonly status: "connected" | "pending" | "needs_reconnect" | "error";
  readonly problem?: string;
  readonly updated_at: string;
  /** person: the caller's own; org: a shared account an admin connected for `plugin_id`. Absent: person (Cloud before shared accounts). */
  readonly owner?: "person" | "org";
  readonly plugin_id?: string | null;
  /** An org row: who connected it, as Cloud names them, when it says. */
  readonly signed_in_by_name?: string | null;
  /**
   * An org row, to a Cloud computer's runtime: whether Cloud offers this shared account to the workspace asked about
   * (an install of its plugin shares it with the team or with that workspace's project). Cloud lists a project's own
   * account before the team's. Only an offered row is used through the connector proxy (connectorProxy.ts).
   */
  readonly offered?: boolean;
}

export interface Lease {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_at: string;
}

/**
 * The key Cloud stores a connection under (connections.go canonicalResource): lowercase scheme and
 * host, no default port. Compared without a trailing slash, as Cloud's sameResource does, so a
 * server URL typed `https://MCP.Example.com:443/mcp/` finds Cloud's `https://mcp.example.com/mcp`.
 */
export function canonicalResource(raw: string): string {
  try {
    const url = new URL(raw.trim());
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return raw.trim();
  }
}

/** What a person calls one of Cloud's connections: GitHub, or the server's URL (Cloud's provider is "mcp" on every other row). */
export const connectionLabel = (c: Pick<CloudConnection, "connection_id" | "resource" | "provider">) =>
  c.provider === "github" ? "GitHub" : c.resource || c.connection_id;

/** Hosts a GitHub login may be sent to: GitHub's own API and MCP servers, never another server that asks for `auth: "github"`. */
export function githubHost(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (host === "github.com" || host.endsWith(".github.com") || host === "api.githubcopilot.com");
  } catch {
    return false;
  }
}

/** Cloud's 409 when a connection's refresh was refused: the person signs in again. */
export const RECONNECT = "cave_code_connection_reconnect";

export const startConnection = (identity: Identity, state: LinkState, target: ConnectionTarget, fetchImpl?: typeof fetch) =>
  call<{ connection_id: string; authorize_url: string }>(identity, state, "POST", "connections/start", target, fetchImpl);

/**
 * Cloud's list: names and states, never a token. `repository` (`host/owner/name`, on a Cloud computer) names the
 * repository a chat works in, so `offered` is about that chat's workspace, as the proxy's `x-caveman-repository` is.
 */
export async function listConnections(identity: Identity, state: LinkState, fetchImpl?: typeof fetch, repository?: string): Promise<ReadonlyArray<CloudConnection>> {
  const path = repository === undefined ? "connections" : `connections?repository=${encodeURIComponent(repository)}`;
  const out = await call<ReadonlyArray<CloudConnection> | { connections?: ReadonlyArray<CloudConnection> }>(identity, state, "GET", path, undefined, fetchImpl);
  return Array.isArray(out) ? out : ((out as { connections?: ReadonlyArray<CloudConnection> }).connections ?? []);
}

/** `owner: "org"` removes a shared account (an org admin's); without it only the person's own connection goes. */
export const deleteConnection = (identity: Identity, state: LinkState, id: string, fetchImpl?: typeof fetch, owner?: "org") =>
  call<unknown>(identity, state, "DELETE", `connections/${encodeURIComponent(id)}${owner === undefined ? "" : `?owner=${owner}`}`, undefined, fetchImpl).then(() => undefined);

/** `stale`: the server refused the last lease, so Cloud refreshes now rather than hand the same token back. */
export const leaseConnection = (identity: Identity, state: LinkState, target: ConnectionTarget, stale = false, fetchImpl?: typeof fetch) =>
  call<Lease>(identity, state, "POST", "connections/lease", stale ? { ...target, stale: true } : target, fetchImpl);

/**
 * Access tokens leased this run: memory only (never the secrets store, a log or the state volume), and
 * joined to the egress scrub until exit like provider keys, so one a server echoes never reaches a
 * model, a transcript or an event. ponytail: process-wide, like providerKeyValues.
 */
export const leasedTokens = new Set<string>();
