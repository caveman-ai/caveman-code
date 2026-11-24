// Cloud's connector proxy, as a Cloud computer's runtime reaches it (docs/ CONTRACT
// §3.2, SPEC §5 item 3). Where a person's credentials stay outside the computer (credentialRule.ts) the runtime holds
// no connector's token and no GitHub login: its MCP hub and its own GitHub reads send to `{cloud}/relay/v1/mcp/...`
// with the runtime's own token, naming a connection by the id Cloud listed, and Cloud attaches the sign-in outside
// the computer. Nothing here names a host: the upstream is the address Cloud registered for the connection.
//
// The proxy answers in Cloud's error body. `cave_code_upstream` is the upstream's own status with Cloud's words (the
// upstream's never arrive); every other code is the proxy's own refusal, which says what a person can do about it.
// 409 `cave_code_connection_reconnect` is a sign-in that needs making again, whether Cloud's refresh of it was refused
// or the server itself no longer takes it (its 401 is never passed on as one: that is the runtime token's).
import type { AuthProvider, McpFetch } from "@earendil-works/pi-mcp";

import { tokenFor, withRuntimeToken } from "./computers.ts";
import { onYourMac, PLUGINS_WHERE } from "./credentialRule.ts";
import { CloudError, cloudFailure, type Identity } from "./identity.ts";
import type { LinkState } from "./index.ts";

/** Where the proxy is, under Cloud's origin. */
export const PROXY_PATH = "/relay/v1/mcp";
/** GitHub's own MCP server: the one address the proxy sends the person's Cloud GitHub login to as an MCP server. */
export const GITHUB_MCP_SERVER = "https://api.githubcopilot.com/mcp";
/** The repository a chat works in (`host/owner/name`): it chooses among the workspaces Cloud placed on this computer. */
export const REPOSITORY_HEADER = "x-caveman-repository";
/** Cloud's code for an upstream's own answer, passed on with its status and Cloud's words. */
export const UPSTREAM = "cave_code_upstream";

const DEFAULT_PORT: Record<string, string> = { "https:": "443", "http:": "80" };

/**
 * What `url` adds below `base`: "" when they are the same address, `/x/y` (and its query) when `url` is under it at a
 * `/`, undefined when it is elsewhere (another scheme, host or port, or a path that only shares a prefix). The proxy
 * appends exactly this below the address Cloud registered, so a server never reaches beside it.
 */
export function pathBelow(url: string, base: string): string | undefined {
  let target: URL;
  let root: URL;
  try {
    target = new URL(url.trim());
    root = new URL(base.trim());
  } catch {
    return undefined;
  }
  const port = (u: URL) => u.port || DEFAULT_PORT[u.protocol] || "";
  if (
    target.protocol !== root.protocol ||
    target.hostname.toLowerCase() !== root.hostname.toLowerCase() ||
    port(target) !== port(root)
  )
    return undefined;
  const under = root.pathname.replace(/\/+$/, "");
  const path = target.pathname.replace(/\/+$/, "");
  if (path !== under && !path.startsWith(`${under}/`)) return undefined;
  return `${path.slice(under.length)}${target.search}`;
}

/** The proxy's address for a connection Cloud listed, and what the server's own URL adds below its registered one. */
export const connectorUrl = (
  identity: Pick<Identity, "cloudUrl">,
  connectionId: string,
  below = "",
) => `${identity.cloudUrl}${PROXY_PATH}/${encodeURIComponent(connectionId)}${below}`;

/** What a GitHub MCP server's URL adds below GitHub's own (`/x/issues`), or undefined when it is not GitHub's MCP server. */
export const githubMcpBelow = (url: string): string | undefined =>
  pathBelow(url, GITHUB_MCP_SERVER);

/** The proxy's address for GitHub's MCP server (read-only there) and for one path of GitHub's API. */
export const githubMcpUrl = (identity: Pick<Identity, "cloudUrl">, below = "") =>
  `${identity.cloudUrl}${PROXY_PATH}/github/mcp${below}`;
export const githubApiUrl = (identity: Pick<Identity, "cloudUrl">, path: string) =>
  `${identity.cloudUrl}${PROXY_PATH}/github/api/${path.replace(/^\/+/, "")}`;

/**
 * The runtime's own token as the proxy's bearer: the link's, or a newer one after the proxy refused it (401
 * `cave_unauthorized`: rotated by a newer mint, expired across a sleep). It is the only credential the runtime sends,
 * and it stops at the proxy.
 */
export const runtimeBearer = (
  identity: Identity,
  link: LinkState,
  fetchImpl: typeof fetch = fetch,
): AuthProvider => {
  let refused: string | undefined;
  return {
    token: () => tokenFor(identity, link, fetchImpl, refused),
    onUnauthorized: async ({ token }) => {
      refused = token;
    },
  };
};

/** The proxy's own refusal of a request: Cloud's status and code, and a sentence a person can act on. */
export class ProxyRefusal extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly retryAfterMs: number | undefined;
  constructor(failure: CloudError) {
    super(refusalText(failure));
    this.status = failure.status;
    this.code = failure.code;
    this.retryAfterMs = failure.retryAfterMs;
  }
}

/** This Cloud does not run the proxy (an older one, or one whose relay leaves it off): the route's own 404. */
export const NO_PROXY_TEXT = `Connectors don't work in Cloud yet. Use this one in a chat ${onYourMac()}.`;
/** The proxy is switched off (Cloud's `code.connectorProxy: false`). */
export const PROXY_OFF_TEXT = `Your admin turned connectors off for Cloud. Use this one in a chat ${onYourMac()}.`;
/** Not a connection this computer may use: not the person's, or a shared account not offered to this project. */
export const NOT_OFFERED_TEXT = `Connect it ${onYourMac(PLUGINS_WHERE)}, or ask your admin to share it.`;
/** Its sign-in stopped working: only a new one, made from the person's own device, mends it. */
export const RECONNECT_ELSEWHERE_TEXT = `Its sign-in expired. Reconnect it ${onYourMac(PLUGINS_WHERE)}.`;
/** No answer of Cloud's own for a connector (something in front of the proxy, or Cloud failing). Its status stays on the refusal (ProxyRefusal.status), out of the sentence. */
export const UNREACHABLE_TEXT = "Can't reach this connector. Try again in a moment.";

/** The proxy's refusal in a sentence: its own words where they say what to do, ours where only the code does. */
export function refusalText(failure: CloudError): string {
  switch (failure.code) {
    case "cave_code_connection_reconnect":
      return RECONNECT_ELSEWHERE_TEXT;
    case "cave_code_connection_kind_off":
      return PROXY_OFF_TEXT;
    case "cave_not_found":
      return NOT_OFFERED_TEXT;
    case "cave_code_engine_rate":
      return `Too many connector requests. Try again in ${failure.retryAfterMs === undefined ? "a moment" : `${Math.ceil(failure.retryAfterMs / 1000)} s`}.`;
    case undefined:
      // No Cloud error body: the relay's own 404 for a route it does not serve, or something in front of it.
      return failure.status === 404 ? NO_PROXY_TEXT : UNREACHABLE_TEXT;
    default:
      // The computer's own state (asleep, shared, a disabled account), GitHub's allowed reads, a size or a timeout: Cloud says which.
      return failure.message;
  }
}

/**
 * `fetch` for an MCP transport that sends to the proxy. The upstream's own answers pass with their status (a 404 ends
 * an MCP session, a 405 means no stream) and Cloud's sentence as their text; a 401 is the runtime's token, which the
 * transport's auth provider renews once; any other refusal is the proxy's own and fails the request as a ProxyRefusal.
 */
export const proxyFetch =
  (fetchImpl: typeof fetch = fetch): McpFetch =>
  async (input, init) => {
    const response = await fetchImpl(input, init);
    if (response.ok || response.status === 401) return response;
    const failure = await cloudFailure(response);
    if (failure.code !== UPSTREAM) throw new ProxyRefusal(failure);
    return new Response(failure.message, {
      status: response.status,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  };

/** One answer of GitHub's API through the proxy: its status and text, or the proxy's and the upstream's refusal as a CloudError. */
export interface ProxiedRead {
  readonly status: number;
  readonly body: string;
}

/**
 * One GET of GitHub's API through the proxy (`path` below the API root, query included), with the runtime's token.
 * A refusal throws Cloud's status, code and sentence (CloudError): `cave_code_upstream` is GitHub's own status.
 */
export async function githubApiGet(
  identity: Identity,
  link: LinkState,
  path: string,
  options: {
    readonly fetch?: typeof fetch;
    readonly timeoutMs?: number;
    readonly accept?: string;
  } = {},
): Promise<ProxiedRead> {
  const fetchImpl = options.fetch ?? fetch;
  const response = await withRuntimeToken(identity, link, fetchImpl, (token) =>
    fetchImpl(githubApiUrl(identity, path), {
      headers: {
        accept: options.accept ?? "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "caveman-code",
        authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    }),
  );
  if (!response.ok) throw await cloudFailure(response);
  return { status: response.status, body: await response.text() };
}
