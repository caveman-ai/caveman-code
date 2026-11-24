import type { EngineDescriptor } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";
import { cavemanVersionReady, connectsOnce, credentialsOutside, enginesChecking, firstReadyEngine, onboardingDefault, wordCount } from "./engines.ts";

const engine = (id: string, state: EngineDescriptor["auth"]["state"], accounts: Array<{ id: string }> = []) =>
  ({ id, label: id, auth: { state, accounts: accounts.map((a) => ({ ...a, label: a.id, kind: "api_key", active: true })) } }) as unknown as EngineDescriptor;

test("a first run defaults to Caveman with a key, then Claude Agent, then Codex", () => {
  const caveman = engine("caveman", "api_key", [{ id: "caveman:openai" }]);
  const claude = engine("claude-agent", "signed_in");
  const codex = engine("codex", "api_key");
  expect(firstReadyEngine([codex, claude, caveman])).toBe("caveman");
  expect(firstReadyEngine([codex, claude, engine("caveman", "signed_out")])).toBe("claude-agent");
  expect(firstReadyEngine([codex, engine("claude-agent", "unavailable"), engine("caveman", "signed_out")])).toBe("codex");
  expect(firstReadyEngine([engine("acp:gemini", "signed_in"), engine("claude-agent", "signed_out")])).toBe("acp:gemini");
  expect(firstReadyEngine([engine("claude-agent", "signed_out"), engine("codex", "checking")])).toBeUndefined();
});

test("a returning user's ready choice stays; an unready one or the built-in Claude Agent yields to the first ready", () => {
  const caveman = engine("caveman", "api_key", [{ id: "caveman:openai" }]);
  const claude = engine("claude-agent", "signed_in");
  const codex = engine("codex", "api_key");
  expect(onboardingDefault([caveman, claude, codex], "codex")).toBe("codex");
  expect(onboardingDefault([caveman, claude, engine("codex", "signed_out")], "codex")).toBe("caveman");
  expect(onboardingDefault([caveman, claude, codex], "claude-agent")).toBe("caveman");
  expect(onboardingDefault([engine("caveman", "signed_out"), claude, codex], "claude-agent")).toBe("claude-agent");
  expect(onboardingDefault([engine("caveman", "signed_out"), engine("claude-agent", "unavailable"), codex], "claude-agent")).toBe("codex");
  expect(onboardingDefault([caveman], undefined)).toBe("caveman");
});

test("a chosen Claude Agent stays even with Caveman ready; one nobody chose follows the runtime's default", () => {
  const caveman = engine("caveman", "api_key", [{ id: "caveman:openai" }]);
  const claude = engine("claude-agent", "signed_in");
  expect(onboardingDefault([caveman, claude], "claude-agent", true)).toBe("claude-agent");
  expect(onboardingDefault([caveman, claude], "claude-agent", false)).toBe("caveman");
  // The runtime already resolved its own default to Caveman: the same engine, so first run writes nothing.
  expect(onboardingDefault([caveman, claude], "caveman", false)).toBe("caveman");
  // A chosen engine that is not ready yields, as before.
  expect(onboardingDefault([caveman, engine("claude-agent", "signed_out")], "claude-agent", true)).toBe("caveman");
});

test("a first run waits while any engine is still being checked", () => {
  expect(enginesChecking([engine("claude-agent", "checking"), engine("codex", "api_key")])).toBe(true);
  expect(enginesChecking([engine("claude-agent", "signed_in")])).toBe(false);
});

test("the Caveman version is offered only with a key the rewriter can use", () => {
  expect(cavemanVersionReady([engine("caveman", "api_key", [{ id: "caveman:anthropic" }])])).toBe(true);
  expect(cavemanVersionReady([engine("caveman", "signed_out")])).toBe(false);
  // Caveman credits (the signed-in account's credits key) can pay for it too.
  expect(cavemanVersionReady([engine("caveman", "api_key", [{ id: "caveman:caveman" }])])).toBe(true);
  // A Claude plan alone (the main persona) has no Caveman key.
  expect(cavemanVersionReady([engine("claude-agent", "signed_in")])).toBe(false);
  // A provider the rewriter has no cheap model for does not count.
  expect(cavemanVersionReady([engine("caveman", "api_key", [{ id: "caveman:openrouter" }])])).toBe(false);
});

test("a client knows a Cloud computer that keeps nothing of its person's, and a Cloud that takes a plan once", () => {
  const mac = [engine("caveman", "api_key"), engine("claude-agent", "signed_in")];
  const withAuth = (auth: Partial<EngineDescriptor["auth"]>) => mac.map((e) => ({ ...e, auth: { ...e.auth, ...auth } }));
  // A Mac, or a Cloud computer from before the rule: sign-ins, keys, secrets and connectors are taken there.
  expect(credentialsOutside(mac)).toBe(false);
  expect(credentialsOutside(withAuth({ no_sign_in_here: true }))).toBe(true);
  expect(credentialsOutside([])).toBe(false);
  // Any engine that says where its plan stands: this Cloud connects once, and no Cloud computer is signed in.
  expect(connectsOnce(mac)).toBe(false);
  for (const everywhere of ["available", "off", "manage"] as const) expect(connectsOnce([mac[0]!, { ...mac[1]!, auth: { ...mac[1]!.auth, everywhere } }])).toBe(true);
});

test("word counts skip markdown markers and inline images", () => {
  expect(wordCount("Found bug. `Next()` round retry to whole minute.")).toBe(8);
  expect(wordCount("1. Full jitter.\n2. Breaker per endpoint.\n\n- [x] done ![shot](data:image/png;base64,AAAA)")).toBe(6);
  expect(wordCount("")).toBe(0);
});
