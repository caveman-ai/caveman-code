// A service account's credentials on the Cloud computer running its session (Caveman Cloud C2-5). Cloud's resolve
// answers them beside the repository secrets: `static_bearer {match_url, token}` and `mcp_oauth {match_url}` for the
// agent's MCP servers, and environment variables bound to `hosts`. Each reaches only its own target:
// - a bearer token goes on a server's requests only when the server's URL is under match_url (same scheme, host and
//   port, and the path at or below match_url's);
// - an mcp_oauth server's token is leased from Cloud for match_url (connectors.ts), Cloud answering with the
//   account's connection only;
// - a host-bound variable is never handed to the agent: its processes get a stand-in, and the runtime swaps the value
//   in at the egress it controls (the engines' egress scrub, the MCP hub) only on requests to one of its hosts. A
//   stand-in sent anywhere else is worth nothing.
// Every real value joins the scrubber (computerSecrets.ts), so none reaches a model, an event or a log. Memory only,
// like leased tokens: nothing is written to the volume.
//
// Where the account's credentials stay outside the computer (credentialRule.ts) Cloud's resolve answers none of them,
// only their names: `connectors: [{ id, type, match_url }]` (cloud-computers CONTRACT §3.2). A server under one's
// match_url is then reached through Cloud's connector proxy by that id (connectorProxy.ts), which attaches the token
// outside the computer. The proxy carries MCP servers only: a host-bound variable has no such route.
import { randomBytes } from "node:crypto";

import type { SecretEntry } from "@caveman-app/session-protocol";

export type AccountCredential =
  | { readonly type: "static_bearer"; readonly match_url: string; readonly token: string }
  | { readonly type: "mcp_oauth"; readonly match_url: string };

/** A credential of the account by name only: `id` is what Cloud's connector proxy calls it, and no value comes with it. */
export interface AccountConnector {
  readonly id: string;
  readonly type: "static_bearer" | "mcp_oauth";
  readonly match_url: string;
}

/** A resolved secret; `hosts` set: an environment variable that may reach only those hosts. */
export interface ResolvedSecret {
  readonly name: string;
  readonly value: string;
  readonly hosts?: ReadonlyArray<string> | null;
}

const DEFAULT_PORT: Record<string, string> = { "https:": "443", "http:": "80", "wss:": "443", "ws:": "80" };

const parse = (raw: string) => {
  try {
    const url = new URL(raw.trim());
    return { protocol: url.protocol, host: url.hostname.toLowerCase(), port: url.port || DEFAULT_PORT[url.protocol] || "", path: url.pathname };
  } catch {
    return undefined;
  }
};

/**
 * Whether `url` is under `matchUrl`: the same scheme, host and port, and a path equal to match_url's or below it at a
 * `/`. A plain string prefix would hand `https://mcp.example.com` a token meant for it on
 * `https://mcp.example.com.attacker.net`; this never does.
 */
export function urlMatches(url: string, matchUrl: string): boolean {
  const target = parse(url);
  const match = parse(matchUrl);
  if (target === undefined || match === undefined) return false;
  if (target.protocol !== match.protocol || target.host !== match.host || target.port !== match.port) return false;
  const base = match.path.replace(/\/+$/, "");
  return base === "" || target.path === base || target.path.startsWith(`${base}/`);
}

/** Whether `host` is one of `hosts`: an exact name, or `*.example.com` for its subdomains (not example.com itself). */
export function hostAllowed(host: string, hosts: ReadonlyArray<string>): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return hosts.some((entry) => {
    const allowed = entry.trim().toLowerCase().replace(/\.$/, "");
    if (allowed.startsWith("*.")) return name.endsWith(allowed.slice(1)) && name.length > allowed.length - 1;
    return name === allowed;
  });
}

let credentials: ReadonlyArray<AccountCredential> = [];
/** The account's connectors by name (under the rule): reached through Cloud's proxy, never held. */
let connectors: ReadonlyArray<AccountConnector> = [];
/** stand-in -> the variable it stands for. */
const bound = new Map<string, { readonly name: string; readonly value: string; readonly hosts: ReadonlyArray<string> }>();
/** name\0value -> its stand-in, stable for the run so processes started earlier keep working. */
const standIns = new Map<string, string>();

/** Bumped whenever the credentials change or go: a connection opened with older ones is closed before its next use. */
let generation = 0;

export const accountVault = {
  /** Which credentials connections opened now carry (see `generation`). */
  generation: () => generation,
  /**
   * Takes a resolve's answer: keeps the credentials, and answers the secrets as processes get them, a host-bound
   * variable as its stand-in.
   */
  take(secrets: ReadonlyArray<ResolvedSecret>, given: ReadonlyArray<AccountCredential> | undefined, named?: ReadonlyArray<AccountConnector>): ReadonlyArray<SecretEntry> {
    const next = (given ?? []).filter(
      (c) => (c.type === "static_bearer" && typeof c.token === "string" && c.token !== "" && parse(c.match_url) !== undefined) || (c.type === "mcp_oauth" && parse(c.match_url) !== undefined),
    );
    // Names only: an id the proxy can be asked by, and an address a server's URL can be under. Nothing else is kept of one.
    const names = (named ?? [])
      .filter((c) => (c.type === "static_bearer" || c.type === "mcp_oauth") && typeof c.id === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(c.id) && typeof c.match_url === "string" && parse(c.match_url) !== undefined)
      .map((c): AccountConnector => ({ id: c.id, type: c.type, match_url: c.match_url }));
    if (JSON.stringify(next) !== JSON.stringify(credentials) || JSON.stringify(names) !== JSON.stringify(connectors)) generation++;
    credentials = next;
    connectors = names;
    return secrets.map((secret) => {
      if (secret.hosts === undefined || secret.hosts === null) return { name: secret.name, value: secret.value };
      const key = `${secret.name}\0${secret.value}`;
      let standIn = standIns.get(key);
      if (standIn === undefined) {
        standIn = `caveman-secret-${randomBytes(24).toString("hex")}`;
        standIns.set(key, standIn);
      }
      bound.set(standIn, { name: secret.name, value: secret.value, hosts: [...secret.hosts] });
      return { name: secret.name, value: standIn };
    });
  },
  /** Cloud refused (a disabled account, a computer shared with other work) or forgot them: none is used any more. */
  clear(): void {
    if (credentials.length > 0 || connectors.length > 0 || bound.size > 0) generation++;
    credentials = [];
    connectors = [];
    bound.clear();
  },
  /**
   * The account's connector that covers a server at `url`, when Cloud named one (under the rule): the id to ask the
   * connector proxy by, and the match_url the server's URL is under. The longest match_url wins, as the most specific.
   */
  proxiedFor(url: string): AccountConnector | undefined {
    return connectors.filter((c) => urlMatches(url, c.match_url)).sort((a, b) => b.match_url.length - a.match_url.length)[0];
  },
  /** The bearer token for a server at `url`, when a static_bearer credential's match_url covers it. */
  bearerFor(url: string): string | undefined {
    const hit = credentials.find((c) => c.type === "static_bearer" && urlMatches(url, c.match_url));
    return hit?.type === "static_bearer" ? hit.token : undefined;
  },
  /** The match_url to lease a token for, when an mcp_oauth credential covers a server at `url`. */
  oauthFor(url: string): string | undefined {
    return credentials.find((c) => c.type === "mcp_oauth" && urlMatches(url, c.match_url))?.match_url;
  },
  /** Headers with every stand-in whose hosts include `target`'s host replaced by its value; others left as they are. */
  swap<H extends Record<string, unknown>>(headers: H, target: URL): H {
    if (bound.size === 0) return headers;
    const out: Record<string, unknown> = { ...headers };
    for (const [name, value] of Object.entries(out)) {
      const swapOne = (text: string) => {
        let next = text;
        for (const [standIn, secret] of bound) if (next.includes(standIn) && hostAllowed(target.hostname, secret.hosts)) next = next.split(standIn).join(secret.value);
        return next;
      };
      if (typeof value === "string") out[name] = swapOne(value);
      else if (Array.isArray(value)) out[name] = value.map((v) => (typeof v === "string" ? swapOne(v) : v));
    }
    return out as H;
  },
  /** Every real value (tokens and bound variables): what the scrubber must know. */
  values(): ReadonlyArray<SecretEntry> {
    return [
      ...credentials.flatMap((c) => (c.type === "static_bearer" ? [{ name: "SERVICE_ACCOUNT_TOKEN", value: c.token }] : [])),
      ...[...bound.values()].map((secret) => ({ name: secret.name, value: secret.value })),
    ];
  },
};
