// Engine readiness the client decides on: which engine a first run defaults
// to, and whether the Caveman version can be offered.

import type { EngineDescriptor } from "@caveman-app/session-protocol";

/** Signed in or holding a key: a chat can start on it. */
export const engineReady = (e: EngineDescriptor | undefined): boolean => e !== undefined && (e.auth.state === "signed_in" || e.auth.state === "api_key");

/** An agent's status line: Ready, Checking… while its first probe runs, else `otherwise`. */
export function engineStatusLabel(e: EngineDescriptor, otherwise: string): string {
  return engineReady(e) ? "Ready" : e.auth.state === "checking" ? "Checking…" : otherwise;
}

/**
 * The engine a first run defaults to: Caveman when it holds a key, else
 * Claude Agent when the user's claude is signed in, else Codex, else any ready
 * engine (an ACP agent). Undefined while nothing is ready.
 */
export function firstReadyEngine(engines: ReadonlyArray<EngineDescriptor>): EngineDescriptor["id"] | undefined {
  const byId = (id: string) => engines.find((e) => e.id === id);
  return [byId("caveman"), byId("claude-agent"), byId("codex"), ...engines].find(engineReady)?.id;
}

/**
 * First run's default: an engine the person chose (Settings.default_engine_chosen) stays while it is ready; else
 * the first ready engine, Caveman first, as the runtime's own default is. A runtime from before the flag sends none:
 * there Claude Agent was the built-in default, so only another saved engine counts as chosen.
 */
export function onboardingDefault(
  engines: ReadonlyArray<EngineDescriptor>,
  saved: EngineDescriptor["id"] | undefined,
  chosen?: boolean,
): EngineDescriptor["id"] | undefined {
  const isChosen = chosen ?? (saved !== undefined && saved !== "claude-agent");
  return saved && isChosen && engineReady(engines.find((e) => e.id === saved)) ? saved : firstReadyEngine(engines);
}

/** Still probing: a first run waits for these before it picks a default. */
export function enginesChecking(engines: ReadonlyArray<EngineDescriptor>): boolean {
  return engines.some((e) => e.auth.state === "checking");
}

/**
 * The engine a new chat starts on: the one picked, else the default, else any ready one. Just after the runtime
 * starts it is still checking each sign-in (seconds, for a CLI): the picked or default engine stands in meanwhile, so
 * a message sent then starts its chat at once (the runtime takes it; a sign-in that turns out missing says so in the
 * chat) rather than "No engine is set up yet".
 */
export function chatEngine(engines: ReadonlyArray<EngineDescriptor>, picked: string | null | undefined, fallback: string | null | undefined): EngineDescriptor | undefined {
  const ready = engines.filter(engineReady);
  const wanted = picked ?? fallback;
  return (
    ready.find((e) => e.id === picked) ??
    ready.find((e) => e.id === fallback) ??
    ready[0] ??
    engines.find((e) => e.id === wanted && e.auth.state === "checking")
  );
}

/** Where every engine is set up (Settings > Models & keys). */
export const NO_ENGINE = "No agent is set up yet. Set one up in Settings > Models & keys.";

/** Nothing to run a chat on, once every engine has answered: New chat says so before anyone types. */
export function needsEngine(engines: ReadonlyArray<EngineDescriptor>): boolean {
  return engines.length > 0 && !enginesChecking(engines) && !engines.some(engineReady);
}

/**
 * The runtime these engines came from is a Cloud computer that keeps nothing of its person's (every engine there
 * says so, EngineDescriptor.auth.no_sign_in_here): it takes no sign-in, key, secret or connector, and a setting
 * changed there stays there. A client attached to it offers none of those, and says where they are managed.
 */
export const credentialsOutside = (engines: ReadonlyArray<Pick<EngineDescriptor, "auth">>): boolean => engines.some((e) => e.auth.no_sign_in_here === true);

/**
 * This Caveman Cloud takes a plan once for every computer (EngineDescriptor.auth.everywhere, on any engine): nothing
 * is signed in on a Cloud computer. False for a Cloud from before that, whose computers are signed in one by one.
 */
export const connectsOnce = (engines: ReadonlyArray<Pick<EngineDescriptor, "auth">>): boolean => engines.some((e) => e.auth.everywhere !== undefined);

// The providers message.caveman_version can rewrite with (provider-caveman's
// rewriter.ts CHEAP_MODEL_BY_PROVIDER); the Caveman engine's accounts are `caveman:<provider>`,
// and Caveman credits are `caveman:caveman`.
const REWRITE_ACCOUNTS = new Set(["caveman:openai", "caveman:google", "caveman:anthropic", "caveman:caveman"]);

/** The Caveman version needs a Caveman key or credits the rewriter can use; without one the button would only fail. */
export function cavemanVersionReady(engines: ReadonlyArray<EngineDescriptor>): boolean {
  return engines.find((e) => e.id === "caveman")?.auth.accounts.some((a) => REWRITE_ACCOUNTS.has(a.id)) ?? false;
}

/** Words as a reader counts them: whitespace-separated, markdown markers and inline images left out. */
export function wordCount(text: string): number {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "")
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/**
 * An engine's status line as shown where its setup already is (Models & keys, first run's engines):
 * the runtime's "Connect Cursor in Settings > Models & keys." pointed at the page it was on.
 * `setUpHere` false: this page has no way to set the engine up (its form is elsewhere), so the pointer stays and
 * the line still says where to go, never a dead end.
 */
export function setupHereMessage(message: string, setUpHere = true): string {
  return setUpHere ? message.replace(/ in Settings > Models & keys(?=[ .]|$)/, "") : message;
}

/** A harness (upstream other drivers: Cursor, ...): any engine that is not one of ours or an ACP agent. */
export const isHarness = (id: string): boolean => !["caveman", "claude-agent", "codex"].includes(id) && !id.startsWith("acp:");

/** What engine.scan found for one engine (Result<"engine.scan">). */
export type ScanFound = "ready" | "signed_out" | "not_found";

/**
 * The Claude Agent or Codex command is not on this computer. engine.scan says so (`found`); before it has run, the
 * runtime's own status line does ("... was not found on PATH", "Codex CLI (...) was not found").
 */
export function cliMissing(e: EngineDescriptor | undefined, found?: ScanFound): boolean {
  if (!e || (e.id !== "claude-agent" && e.id !== "codex") || engineReady(e)) return false;
  if (found !== undefined) return found === "not_found";
  return /was not found/.test(e.auth.message ?? "");
}
