import type { Environment, EnvironmentBuild } from "@caveman-app/session-protocol";
import { expect, it } from "vitest";
import { ciLine, cloudUnavailable, environmentLine, httpsUrl, failureCopy, foldLine, lineDiff, listOf, missingValues, runOnLabel, servicesOf, sizeOf, startWaitsForValues, stepProgress, summaryLine, withSize, type EnvironmentAnswer } from "./environment.ts";

const steps = (statuses: Array<EnvironmentBuild["steps"][number]["status"]>) =>
  ["clone", "services", "setup", "check", "snapshot", "restore_check"].map((name, i) => ({ name, status: statuses[i] ?? "pending" }));
const build = (over: Partial<EnvironmentBuild> = {}): EnvironmentBuild => ({
  id: "b1",
  status: "running",
  steps: steps(["done", "done", "running"]),
  log_tail: "",
  failure: null,
  gaps: [],
  started_at: "2026-10-18T10:00:00Z",
  finished_at: null,
  ...over,
});
const env = (over: Partial<Environment> = {}): Environment => ({
  repo: "acme/web",
  branch: "main",
  state: "not_set_up",
  source: "none",
  config: null,
  updated_by: null,
  updated_at: null,
  secret_names: [],
  sizes: ["2x8", "4x16", "8x32", "16x64"],
  max_size: "4x16",
  services: { postgres: ["15", "16", "17"] },
  snapshot: null,
  build: null,
  ...over,
});
const answer = (e: Environment | null, over: Partial<EnvironmentAnswer> = {}): EnvironmentAnswer => ({ environment: e, available: true, ...over });

it("the run-on pill has three states and no more, amber never red; a Cloud that cannot be picked says why", () => {
  expect(runOnLabel(null)).toEqual({ chip: "Cloud", tone: "idle" });
  // Not set up yet (Caveman sets it up with the first chat), set up, updating, or set up with a failed check or
  // update beside it: the chat starts either way, so the pill is the one word.
  expect(runOnLabel(answer(env()))).toEqual({ chip: "Cloud", tone: "idle" });
  const done = build({ status: "succeeded", steps: steps(["done", "done", "done", "done", "done", "done"]) });
  for (const ready of [env({ state: "ready", build: done }), env({ state: "ready", build: build() }), env({ state: "ready_with_gaps", build: { ...done, gaps: ["pnpm test failed"] } }), env({ state: "ready", build: build({ status: "failed" }) })]) {
    expect(runOnLabel(answer(ready))).toEqual({ chip: "Cloud", tone: "ok" });
  }
  expect(runOnLabel(answer(env({ state: "setting_up", build: build() })))).toEqual({ chip: "Cloud · setting up 2/5", tone: "busy" });
  expect(runOnLabel(answer(env({ state: "setting_up" })))).toEqual({ chip: "Cloud · setting up", tone: "busy" });
  expect(runOnLabel(answer(env({ state: "failed", build: build({ status: "failed" }) })))).toEqual({ chip: "Cloud · setup failed", tone: "warn", failed: true });
  // No pill says what a person need not know.
  for (const state of ["not_set_up", "setting_up", "failed", "ready_with_gaps", "ready"] as const) {
    expect(runOnLabel(answer(env({ state, build: build({ status: "failed", gaps: ["x"] }) }))).chip).not.toMatch(/ready|gaps|snapshot|bare|computer/i);
  }

  // Why Cloud cannot be picked: our words, never the runtime's (which name servers and what they prepare).
  expect(runOnLabel(answer(null, { available: false, reason: "Cloud computers are off for Acme." })).disabled).toBe("Cloud is off. Ask your admin.");
  expect(runOnLabel(answer(null, { available: false, reason: "This Caveman server doesn't set up repos for Cloud computers yet." })).disabled).toBe("Cloud is off. Ask your admin.");
  expect(runOnLabel(answer(null, { available: false })).disabled).toBe("Cloud is off. Ask your admin.");
  expect(runOnLabel(answer(null, { available: false, reason: "Sign in to Caveman to set up Cloud computers (Settings, Remote control)." })).disabled).toBe("Sign in to use Cloud (Settings > Account).");
  expect(cloudUnavailable("Open this repo's Cloud setup from Caveman Code on your Mac.")).toBe("Change Cloud setup on your Mac (Settings > Environments).");
  // A project with no repository on GitHub.
  expect(runOnLabel(answer(null)).disabled).toBe("Cloud needs this project on GitHub.");

  expect(stepProgress(build({ steps: steps(["done", "done", "done", "done", "done", "done"]) }), null)).toBe("5/5");
  // With a service, Services is a step the person sees.
  expect(stepProgress(build(), '[services]\npostgres = "16"\n')).toBe("3/6");
});

it("a repo's row in Settings, Environments: its state, and when one that is set up was", () => {
  const now = Date.parse("2026-10-18T12:00:00Z");
  const snapshot = { commit: "4f2c1a0deadbeef", built_at: "2026-10-18T10:00:00Z", checks: [] };
  const done = build({ status: "succeeded", steps: steps(["done", "done", "done", "done", "done", "done"]) });
  expect(environmentLine(null)).toEqual({ tone: "idle", text: "Checking Cloud…" });
  expect(environmentLine(answer(null, { available: false, reason: "Sign in to Caveman" }))).toEqual({ tone: "idle", text: "Sign in to use Cloud (Settings > Account)." });
  expect(environmentLine(answer(env()))).toEqual({ tone: "idle", text: "Not set up. Its first chat in Cloud sets it up." });
  expect(environmentLine(answer(env({ state: "setting_up", build: build() })))).toEqual({ tone: "busy", text: "Setting up 2/5" });
  expect(environmentLine(answer(env({ state: "failed", build: build({ status: "failed", failure: { kind: "command", step: "setup", message: "pnpm install exited 1" } }) })))).toEqual({
    tone: "warn",
    text: "Setup failed: pnpm install exited 1",
  });
  expect(environmentLine(answer(env({ state: "ready", snapshot, build: done })), now)).toEqual({ tone: "ok", text: "Set up · 4f2c1a0, 2 h ago" });
  // An update running: the earlier setup still serves.
  expect(environmentLine(answer(env({ state: "ready", snapshot, build: build() })), now)).toEqual({ tone: "ok", text: "Set up · 4f2c1a0, 2 h ago · updating now" });
  expect(environmentLine(answer(env({ state: "ready", snapshot, build: build({ status: "failed" }) })), now)).toEqual({ tone: "warn", text: "Set up · 4f2c1a0, 2 h ago · the last update failed" });
  expect(environmentLine(answer(env({ state: "ready_with_gaps", snapshot, build: { ...done, gaps: ["pnpm test failed"] } })), now)).toEqual({ tone: "warn", text: "Set up · 4f2c1a0, 2 h ago · a check failed" });
});

it("the fold line, and the failure table's copy and buttons", () => {
  const done = build({ status: "succeeded", finished_at: "2026-10-18T10:04:12Z", steps: steps(["done", "done", "done", "done", "done", "done"]) });
  const snapshot = { commit: "4f2c1a0deadbeef", built_at: "2026-10-18T10:04:12Z", checks: [{ command: "pnpm typecheck", ok: true, seconds: 12 }, { command: "pnpm test", ok: true, seconds: 41 }] };
  expect(foldLine(done, snapshot)).toBe("Set up in 4m 12s · 2 checks passed");
  expect(foldLine(done, { ...snapshot, checks: [snapshot.checks[0]!, { ...snapshot.checks[1]!, ok: false }] })).toBe("Set up in 4m 12s · 1 of 2 checks passed");

  const now = Date.parse("2026-10-18T12:00:00Z");
  const failed = (failure: EnvironmentBuild["failure"], log_tail = "") => build({ status: "failed", failure, log_tail, steps: steps(["done", "done", "failed", "skipped", "skipped", "skipped"]) });
  expect(failureCopy(failed({ kind: "command", step: "setup", message: "pnpm install exited 1" }), env({ snapshot }), now)).toEqual({
    text: "Setup failed at step 2: pnpm install exited 1. Chats keep using the setup from 2 h ago.",
    actions: ["fix", "log"],
  });
  expect(failureCopy(failed({ kind: "command", step: "setup", message: "pnpm install exited 1" }), env(), now).text).toContain("Chats start without setup until it works.");
  expect(failureCopy(failed({ kind: "registry_auth", step: "setup", message: "npm.pkg.github.com refused the install (401)" }), env(), now)).toEqual({
    text: "npm.pkg.github.com refused the install (401). Setup needs NPM_TOKEN as a build secret: shared for this repository, read only while it builds.",
    actions: ["add_build_secret"],
    value: "NPM_TOKEN",
  });
  expect(failureCopy(failed({ kind: "command", step: "setup", message: "pnpm install exited 1" }, "ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with \"frozen-lockfile\" because pnpm-lock.yaml is not up to date"), env(), now)).toEqual({
    text: "pnpm-lock.yaml doesn't match its manifest on the default branch. That's in the repository, not the setup.",
    actions: ["log"],
  });
  expect(failureCopy(failed({ kind: "timeout", step: "setup", message: "past 30 minutes" }), env(), now).text).toMatch(/^Setup ran past its time limit at setup\./);
  expect(failureCopy(failed({ kind: "too_big", step: "clone", message: "Asks for 8x32; this install allows up to 4x16" }), env(), now)).toEqual({
    text: "Asks for 8x32; this install allows up to 4x16.",
    actions: ["use_size"],
    size: "4x16",
  });
  // A setup Cloud never started is Cloud's side: no setup chat for it, only the log.
  expect(failureCopy(failed({ kind: "start", step: "clone", message: "no node had room for 16x64 within 10 minutes" }), env(), now)).toEqual({
    text: "Cloud couldn't start the setup: no node had room for 16x64 within 10 minutes. The setup itself didn't run, so Rebuild tries it again. Chats start without setup until it works.",
    actions: ["log"],
  });
});

it("reads and writes the parts of computer.toml the panel shows", () => {
  const text = '[setup]\nrun = [\n  "pnpm install --frozen-lockfile",\n]\ncheck = ["pnpm typecheck", "pnpm test"]\n\n[services]\npostgres = "16"\nredis = "7"\n';
  expect(listOf(text, "setup", "check")).toEqual(["pnpm typecheck", "pnpm test"]);
  expect(listOf(text, "setup", "run")).toEqual(["pnpm install --frozen-lockfile"]);
  expect(servicesOf(text)).toEqual([{ name: "postgres", version: "16" }, { name: "redis", version: "7" }]);
  expect(sizeOf(text)).toBeUndefined();
  const sized = withSize(text, "8x32");
  expect(sizeOf(sized)).toBe("8x32");
  expect(sizeOf(withSize(sized, "16x64"))).toBe("16x64");
  expect(withSize(sized, "16x64").match(/\[computer\]/g)).toHaveLength(1);
  expect(missingValues(env({ secret_names: ["A", "B", "C"] }), ["B"])).toEqual(["A", "C"]);
});

it("a Cloud start waits only for values this Mac's .env files can give", () => {
  const here = new Map([["STRIPE_KEY", ".env.local"]]);
  // Stored names not known yet: nothing to decide on.
  expect(startWaitsForValues(null, [], new Map())).toBe(true);
  // Still looking through the .env files: wait rather than start without values that may be there.
  expect(startWaitsForValues([], ["STRIPE_KEY"], null)).toBe(true);
  expect(startWaitsForValues([], ["STRIPE_KEY"], here)).toBe(true);
  // Missing, but this Mac has none of them: the start goes; the agent asks when it needs one.
  expect(startWaitsForValues([], ["SENTRY_DSN"], new Map())).toBe(false);
  // Nothing missing (all set, or added or skipped on this start).
  expect(startWaitsForValues(["STRIPE_KEY"], [], new Map())).toBe(false);
});

it("a row says first when the setup chat's fix waits for the person", () => {
  const failedEnv = env({ state: "failed", build: build({ status: "failed", failure: { kind: "command", step: "setup", message: "pnpm install exited 1" } }) });
  const chat = { workspace_id: "w1", session_id: "s1", state: "review" as const, builds: 2, started_at: "2026-10-23T10:00:00Z", proposal: { config: "x", build_id: "b2", summary: "Adds libvips." } };
  expect(environmentLine(answer(failedEnv, { setup_chat: chat }))).toEqual({ tone: "warn", text: "Fix ready for review" });
  // Agents' proposals are cards of their own: the line stays the setup's.
  expect(environmentLine(answer(failedEnv, { proposals: [{ id: "p1", workspace_id: "w2", summary: "Install libvips", why: "sharp failed", at: "2026-10-23T10:00:00Z" }] })).text).toBe("Setup failed: pnpm install exited 1");
  // A working chat waits for nobody: the build's own line.
  expect(environmentLine(answer(failedEnv, { setup_chat: { ...chat, state: "working" } })).text).toBe("Setup failed: pnpm install exited 1");
});

it("a build secret left on disk: the setup wasn't saved, and the setup chat can fix how setup writes it", () => {
  const now = Date.parse("2026-10-18T12:00:00Z");
  expect(failureCopy(build({ status: "failed", failure: { kind: "secret_on_disk", step: "snapshot", message: "NPM_TOKEN's value is in /home/caveman/.npmrc" } }), env(), now)).toEqual({
    text: "Setup left a build secret in a file, so it wasn't saved and no chat got it: NPM_TOKEN's value is in /home/caveman/.npmrc. Have setup read it from the environment (npm reads ${NPM_TOKEN} in .npmrc) or delete the file before it ends. Chats start without setup until it works.",
    actions: ["fix", "log"],
  });
});

it("CI on the built commit says whether it's the repo or the setup", () => {
  expect(ciLine({ commit: "abc1234def5678", state: "failing", failing: ["lint", "test"] })).toEqual({ tone: "warn", text: "CI on abc1234 is failing too: lint, test. That's the repository, not the Cloud setup." });
  expect(ciLine({ commit: "abc1234def5678", state: "passing", failing: [] })).toEqual({ tone: "ok", text: "Passes in CI on abc1234, so the Cloud setup is what differs." });
  expect(ciLine({ commit: "main", state: "pending", failing: [] })?.text).toBe("CI on main is still running.");
  expect(ciLine({ commit: "abc1234def5678", state: "failing", failing: ["a", "b", "c", "d", "e", "f"] })?.text).toBe("CI on abc1234 is failing too: a, b, c, d +2. That's the repository, not the Cloud setup.");
  expect(ciLine({ commit: "abc1234def5678", state: "unknown", failing: [] })).toBeNull();
  expect(ciLine(null)).toBeNull();
});

it("diffs a proposal against the setup in use, folded to its changes", () => {
  const before = '[setup]\nrun = ["pnpm install --frozen-lockfile"]\ncheck = ["pnpm test"]\n';
  const after = '[system]\npackages = ["libvips"]\n\n[setup]\nrun = ["pnpm install --frozen-lockfile"]\ncheck = ["pnpm test"]\n';
  expect(lineDiff(before, after)).toEqual([
    { kind: "add", text: "[system]" },
    { kind: "add", text: 'packages = ["libvips"]' },
    { kind: "add", text: "" },
    { kind: "same", text: "[setup]" },
    { kind: "same", text: 'run = ["pnpm install --frozen-lockfile"]' },
    { kind: "same", text: 'check = ["pnpm test"]' },
  ]);
  // Nothing saved yet: all of it is new.
  expect(lineDiff("", "a\nb\n")).toEqual([
    { kind: "add", text: "a" },
    { kind: "add", text: "b" },
  ]);
  // Far-apart changes fold the untouched middle.
  const long = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  const changed = long.map((l, i) => (i === 1 ? "first" : i === 18 ? "last" : l));
  const diff = lineDiff(long.join("\n"), changed.join("\n"), 1);
  expect(diff.filter((l) => l === null)).toHaveLength(1);
  expect(diff.filter((l) => l?.kind === "del").map((l) => l!.text)).toEqual(["line 1", "line 18"]);
  expect(lineDiff("same\n", "same\n")).toEqual([]);
});

it("an organization's environment reads its state and who set it up", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  const row = { repo: "acme/billing", branch: "main", source: "cloud" as const, updated_by: "Ada", updated_at: "2026-10-23T10:00:00Z", snapshot_built_at: "2026-10-23T11:00:00Z" };
  expect(summaryLine({ ...row, state: "ready" }, now)).toEqual({ tone: "ok", text: "Set up · 1 h ago · by Ada" });
  expect(summaryLine({ ...row, state: "ready_with_gaps" }, now).text).toBe("Set up · 1 h ago · by Ada · a check failed");
  expect(summaryLine({ ...row, state: "ready_with_gaps" }, now).tone).toBe("warn");
  expect(summaryLine({ ...row, state: "failed", snapshot_built_at: null }, now)).toEqual({ tone: "warn", text: "Setup failed · set up by Ada · 2 h ago" });
  expect(summaryLine({ ...row, state: "not_set_up", updated_by: null, updated_at: null, snapshot_built_at: null }, now)).toEqual({ tone: "idle", text: "Not set up" });
});

it("links from a server or an agent only when they are https", () => {
  expect(httpsUrl("https://github.com/acme/web/actions/runs/1")).toBe("https://github.com/acme/web/actions/runs/1");
  expect(httpsUrl("javascript:alert(1)")).toBeUndefined();
  expect(httpsUrl("http://github.com/acme/web")).toBeUndefined();
  expect(httpsUrl("file:///etc/passwd")).toBeUndefined();
  expect(httpsUrl("not a url")).toBeUndefined();
  expect(httpsUrl(undefined)).toBeUndefined();
});
