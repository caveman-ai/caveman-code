/**
 * One-click sign-ins for the Caveman engine, pi-ai's flows: a browser flow with
 * its loopback callback on this computer (compact, external tools), or a device
 * code the person enters on the provider's page (GitHub Copilot, SuperGrok).
 * external tools hands back an ordinary API key, stored like a pasted one; a plan's
 * sign-in hands back tokens that pi-ai refreshes (credentials.ts). Only the
 * providers.ts registry's sign-ins are offered.
 *
 * @module provider-caveman/server/signIn
 */
import type { AuthPrompt } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import type { CavemanCredential } from "./credentials.ts";
import { providerInfo, signInOf } from "./providers.ts";

/** How long the person has to approve in the browser (pi-ai's own login timeout is the same). */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/** The name a sign-in introduces this app with (OpenAI shows it on its consent page). */
const AGENT_NAME = "Caveman Code";

export interface ProviderSignIn {
  /** Open this in the person's browser. */
  readonly url: string;
  /** A device flow's code, to enter on that page. */
  readonly code?: string;
  /** The credential once approved; rejects on timeout, refusal or cancel. */
  readonly credential: Promise<CavemanCredential>;
  readonly cancel: () => void;
}

/** `deviceId`: this installation's stable UUID, which OpenAI asks for to tell one agent host from another. */
export async function startProviderSignIn(provider: string, deviceId: string): Promise<ProviderSignIn> {
  const signIn = signInOf(provider);
  const label = providerInfo(provider)?.label ?? provider;
  if (signIn === undefined) throw new Error(`${label} has no sign-in here; paste an API key.`);
  const oauth = builtinModels().getProvider(provider)?.auth.oauth;
  if (oauth === undefined) throw new Error(`${label} sign-in is not available in this build.`);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`${label} sign-in timed out.`)), SIGN_IN_TIMEOUT_MS);
  let gotUrl: (page: { url: string; code?: string }) => void = () => {};
  const url = new Promise<{ url: string; code?: string }>((resolve) => (gotUrl = resolve));
  const credential = oauth
    .login(
      {
        signal: abort.signal,
        notify: (event) => {
          if (event.type === "auth_url") gotUrl({ url: event.url });
          if (event.type === "device_code") gotUrl({ url: event.verificationUri, code: event.userCode });
        },
        // A text prompt asks for an optional setting (Copilot's GitHub Enterprise domain): blank, github.com.
        // No pasted redirect: the loopback callback on this computer answers, or the sign-in times out.
        prompt: (prompt: AuthPrompt) =>
          prompt.type === "text"
            ? Promise.resolve("")
            : new Promise<string>((_, reject) => abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true })),
      },
      { getDeviceId: () => deviceId, agentName: AGENT_NAME },
    )
    .then((got): CavemanCredential => {
      if (got.type !== "oauth" || !got.access) throw new Error(`${label} returned no credential.`);
      // A plan's sign-in keeps its tokens; any other hands back an API key as its access token.
      if (signIn.plan === undefined) return { key: got.access };
      const { type: _type, ...tokens } = got;
      return { oauth: tokens };
    })
    .finally(() => clearTimeout(timer));
  // A flow that fails before it has a URL fails the start.
  const first = await Promise.race([url, credential.then(() => undefined)]);
  if (first === undefined) throw new Error(`${label} sign-in did not start.`);
  credential.catch(() => {});
  return { ...first, credential, cancel: () => abort.abort(new Error("Sign-in cancelled.")) };
}
