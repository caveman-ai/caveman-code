import { APP_HOST, APP_SCHEME } from "./assets.ts";

/**
 * caveman-code://w/<id> -> "/w/<id>"; caveman-code://app/#/runs -> "/runs".
 * The client uses hash routing, so a route is applied as location.hash.
 */
export function routeFromDeepLink(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:`) return null;
  if (url.host === APP_HOST) return url.hash.replace(/^#/, "") || "/";
  return `/${url.host}${url.pathname === "/" ? "" : url.pathname}`;
}
