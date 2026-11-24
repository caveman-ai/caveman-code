// Which Caveman Cloud this computer uses, and what that means for the hosts
// the app talks to. Caveman's hosted Cloud is the
// default and keeps Caveman's own gateway. Any other Cloud (a company's own
// install, a local stack) gets only the hosts it names itself: its device
// grant's gateway for credits and Auto. Nothing falls back to a Caveman host,
// and a Caveman host another Cloud names is not taken.
import { CREDITS_GATEWAY_URL } from "@caveman-app/provider-caveman/server";

import { cloudOrigin } from "./identity.ts";

/** Caveman's hosted Cloud: the default, and the only Cloud whose credits and Auto go to Caveman's own gateway. */
export const HOSTED_CLOUD = "https://app.caveman.so";

/** caveman.so or a host under it. */
export const onCavemanHost = (raw: string): boolean => {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === "caveman.so" || host.endsWith(".caveman.so");
  } catch {
    return false;
  }
};

/**
 * A host `cloudUrl` named for one of its services (its gateway), as an
 * origin: http(s), no path, query or credential, and never a Caveman host
 * unless `cloudUrl` is the hosted Cloud. Undefined when it is not one.
 */
export function serviceOrigin(cloudUrl: string, raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return undefined;
    if (cloudUrl !== HOSTED_CLOUD && onCavemanHost(url.origin)) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * The gateway a sign-in's Auto asks and its credits keys run on: Caveman's
 * (or the dev override) for the hosted Cloud, as before; for any other Cloud
 * only the one its device grant named (cloudSignin.ts keeps it), else none.
 */
export const cloudGateway = (session: { readonly cloud_url: string; readonly gateway_url?: string | undefined }): string | undefined =>
  session.cloud_url === HOSTED_CLOUD ? CREDITS_GATEWAY_URL : session.gateway_url;

/**
 * The gateway a credits key minted under `session` is kept with: none for the
 * hosted Cloud (provider-caveman's gatewayOf runs such a key on Caveman's, as
 * every build stored it), else the one that Cloud named. A held key whose
 * gateway differs belongs to another Cloud.
 */
export const creditsGatewayFor = (session: { readonly cloud_url: string; readonly gateway_url?: string | undefined }): string | undefined =>
  session.cloud_url === HOSTED_CLOUD ? undefined : session.gateway_url;

/** Whether a held credits key (`held.gateway` as stored) is the one `session`'s Cloud would mint. */
export const creditsFit = (held: { readonly gateway?: string | undefined }, session: { readonly cloud_url: string; readonly gateway_url?: string | undefined }): boolean =>
  held.gateway === creditsGatewayFor(session);
