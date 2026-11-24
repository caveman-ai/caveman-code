// cloud.client_token: the desktop renderer opens a Cloud computer's chats in the app (through the relay) and reads the
// person's chat list from Cloud, with a short-lived bearer Cloud mints for it from the runtime's own Caveman sign-in:
// good for the chat routes, wake hints, latency reports and relay attach only, for an hour (security review L4; C1
// `POST /api/v1/code/desktop-token`). The sign-in's own access and refresh tokens never leave the runtime, and the token
// handed out joins the egress scrub's redaction list (appProxyTokens).
import { accountCall, type AccountSession, type AccountStore } from "./account.ts";
import { CloudError, cloudFailure } from "./identity.ts";

/** Cloud's mint for the desktop's narrowed bearer (Caveman Cloud C1, CONTRACT-CHANGES C1 2026-10-22 00:40). */
export const DESKTOP_TOKEN_ROUTE = "/api/v1/code/desktop-token";
/** The longest a minted token is handed out for, whatever Cloud says (Cloud mints for an hour). */
export const DESKTOP_TOKEN_MAX_MS = 60 * 60_000;

/** The relay's client endpoint for a Cloud at `cloudUrl`; the client appends `/<runtime id>`. */
export function relayUrlOf(cloudUrl: string): string {
  const url = new URL(cloudUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/relay/v1/runtimes";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** cloud.client_token's answer: the bearer Cloud minted for the desktop, never the sign-in's own. Any refusal fails. */
export async function desktopTokenOf(store: AccountStore, session: AccountSession, now: number, fetchImpl: typeof fetch = fetch) {
  const response = await accountCall(store, DESKTOP_TOKEN_ROUTE, { method: "POST", body: {} }, fetchImpl);
  if (!response.ok) throw await cloudFailure(response);
  const minted = (await response.json()) as { token?: unknown; expires_at?: unknown };
  if (typeof minted.token !== "string" || minted.token === "" || typeof minted.expires_at !== "string" || Number.isNaN(Date.parse(minted.expires_at))) {
    throw new CloudError(502, "Caveman minted no desktop token.");
  }
  return {
    token: minted.token,
    expires_at: new Date(Math.min(Date.parse(minted.expires_at), now + DESKTOP_TOKEN_MAX_MS)).toISOString(),
    api_url: new URL(session.cloud_url).origin,
    relay_url: relayUrlOf(session.cloud_url),
  };
}
