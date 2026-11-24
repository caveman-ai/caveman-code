// Which engines this runtime runs on a login of its person's own (CONTRACT 2026-10-21 §3, the heartbeat's
// `engines_signed_in`): Cloud moves a Claude Agent or Codex chat to a computer only when that engine can run there.
// An engine counts when the person keeps its key in Cloud's vault for their computers, when it is signed in on this
// computer (the CLI's own auth status, never its credential file), or when a sign-in the person made on another of
// their computers follows them here (engineLogins.ts). Computed by the session protocol (handlers.ts), read by the
// link at each heartbeat.
import { hasFollowedLogin } from "./engineLogins.ts";

export type LoginEngine = "claude" | "codex";

let signedIn: ReadonlyArray<LoginEngine> | undefined;
let changed: () => void = () => {};
/** What the next heartbeat says; undefined until first known (the field is left out, never sent empty by guess). */
export const enginesSignedIn = (): ReadonlyArray<LoginEngine> | undefined => signedIn;
/** Sets it; a change heartbeats at once (onEnginesChanged), so a sign-in made here counts for a move right away. */
export const setEnginesSignedIn = (engines: ReadonlyArray<LoginEngine> | undefined): void => {
  const next = engines === undefined ? undefined : [...new Set(engines)].sort();
  if (next?.join() === signedIn?.join() && (next === undefined) === (signedIn === undefined)) return;
  signedIn = next;
  changed();
};
/** The link's heartbeat, woken on a change. */
export const onEnginesChanged = (listener: () => void): void => void (changed = listener);

let followed: (engine: "claude-agent" | "codex") => boolean | Promise<boolean> = hasFollowedLogin;
/** A sign-in made on another of the person's computers that follows them here (engineLogins.ts). */
export const followedLogin = (engine: "claude-agent" | "codex") => followed(engine);
/** Tests stand in for the followed sign-ins; undefined puts engineLogins.ts back. */
export const setFollowedLogin = (check: ((engine: "claude-agent" | "codex") => boolean | Promise<boolean>) | undefined): void => void (followed = check ?? hasFollowedLogin);

/** What a provider snapshot says about an engine's CLI here (ProviderRegistry): never its credentials. */
export interface ProviderLogin {
  readonly engine: string;
  readonly installed: boolean;
  readonly authenticated: boolean;
}

const ENGINES = [["claude-agent", "claude"], ["codex", "codex"]] as const;

/**
 * The engines that count: signed in here by the CLI's own word, a vault key this runtime holds for it, or a sign-in
 * that follows the person (asked only when neither holds).
 */
export async function loginsFrom(providers: ReadonlyArray<ProviderLogin>, holdsKey: (engine: "claude-agent" | "codex") => boolean): Promise<Array<LoginEngine>> {
  const out: Array<LoginEngine> = [];
  for (const [engine, name] of ENGINES) {
    const here = providers.some((p) => p.engine === engine && p.installed && p.authenticated) || holdsKey(engine);
    if (here || (await Promise.resolve().then(() => followed(engine)).catch(() => false)) === true) out.push(name);
  }
  return out;
}
