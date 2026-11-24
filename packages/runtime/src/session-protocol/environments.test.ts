// environment.* against the stand-in Caveman Cloud (cloudLink/testCloud.ts environmentRoutes): a Cloud
// without the routes answers available false; the draft, a save and its build, environment.updated while
// it runs, a failed build; Fix it refused without a Caveman engine key; the setup chat (kind setup, out of
// workspace.list) and its environment_build loop through SetupChats, as the MCP tool calls it: a failing
// try, a passing one, the proposal, publish as the person, and the 5-build cap; and background prepare after a
// chat starts here. docs/ the setup chat starting by itself on a failed build
// (once, and not when Settings turns it off), discard and a refused publish, propose_setup_change's proposals,
// versions and restore, build secrets (no value in any answer, request log or file under the state dir), the
// organization's list, setup_repo and CI; another organization's repo reaches nothing.
import * as fs from "node:fs";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import * as Layer from "effect/Layer";

import { connect, type Environment, type SessionEvent } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

import { enroll } from "../cloudLink/identity.ts";
import { linkDirOf } from "../cloudLink/index.ts";
import { startTestCloud, type TestCloud } from "../cloudLink/testCloud.ts";
import { AS_THE_PERSON, branchHead, layerSetupChats, makeEnvironmentHandlers, remotes, SetupChats, setupBrief, setupThreads, timing, type EnvironmentDeps } from "./environments.ts";
import type { SessionStore } from "./store.ts";
import { git, makeConfig, makeRepo, startRuntime, tempRoot, until } from "./testHarness.ts";

// CI on a commit is lane A2's GitHub read (environmentCi.ts); here it records what it was asked.
const ciAsked = vi.hoisted(() => [] as Array<{ repo: string; commit: string; token: string | undefined }>);
vi.mock("./environmentCi.ts", async () => {
  const Effect = await import("effect/Effect");
  return {
    ciStatus: (input: { repo: string; commit: string; token: () => import("effect/Effect").Effect<string | undefined> }) =>
      input.token().pipe(
        Effect.map((token) => {
          ciAsked.push({ repo: input.repo, commit: input.commit, token });
          return { commit: input.commit, state: "failing" as const, failing: ["lint", "test"] };
        }),
      ),
  };
});
/** environmentRemote.ts until lane A2 lands its sparse checkout. */
const REMOTE_STUB = fs.readFileSync(new URL("./environmentRemote.ts", import.meta.url), "utf8").includes("isn't in this runtime yet");

let cloud: TestCloud;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
let root: string;
let stateDir: string;

beforeAll(async () => {
  timing.pollMs = 20;
  timing.followMs = 20;
  cloud = await startTestCloud();
  const config = await makeConfig();
  stateDir = config.stateDir;
  await enroll({ dir: linkDirOf(config.stateDir), cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "test" });
  // A Caveman engine key store (TestProviderHost) so Fix it can be allowed; the engine itself is the stand-in CLI.
  runtime = await startRuntime(config, "fake-claude", undefined, { alsoAs: ["caveman"], provide: TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)) });
  client = connect(runtime.url, runtime.token);
  root = tempRoot("sp-env-");
}, 60_000);
afterAll(async () => {
  client?.close();
  await runtime?.close();
  await cloud?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const reason = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { error?: { data?: { reason?: string }; message?: string } }) => `${error.error?.data?.reason}: ${error.error?.message}`,
  );

async function project(name: string, files: Record<string, string>) {
  const repo = makeRepo(tempRoot(`sp-env-${name}-`), files);
  git(repo, "remote", "add", "origin", `https://github.com/acme/${name}.git`);
  return client.call("project.create", { request_id: `p-${name}`, path: repo });
}

const PNPM_APP = {
  "package.json": JSON.stringify({ packageManager: "pnpm@9.12.0", scripts: { typecheck: "tsc", test: "vitest" } }),
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  ".nvmrc": "22.11.0\n",
};

test("a Caveman Cloud without environments answers available false; a project with no GitHub remote has none", async () => {
  cloud.state.environments.routes = false;
  const web = await project("old", PNPM_APP);
  const got = await client.call("environment.get", { project_id: web.id });
  expect(got).toMatchObject({ environment: null, available: false, reason: expect.stringContaining("doesn't set up repos") });
  cloud.state.environments.routes = true;
  // An org with Cloud computers off says so, in Cloud's words.
  cloud.state.environments.off = true;
  expect(await client.call("environment.get", { project_id: web.id })).toMatchObject({ environment: null, available: false, reason: "Cloud computers are off for Acme." });
  cloud.state.environments.off = false;
  // An install without a snapshot class prepares no repos, but its Cloud computers still run: Cloud stays available
  // (a chat starts from the plain image), never "Cloud is off".
  cloud.state.environments.noSnapshots = true;
  const unprepared = await client.call("environment.get", { project_id: web.id });
  expect(unprepared).toMatchObject({ environment: null, available: true });
  expect(unprepared).not.toHaveProperty("reason");
  cloud.state.environments.noSnapshots = false;

  const local = await client.call("project.create", { request_id: "p-local", path: makeRepo(tempRoot("sp-env-local-"), { "README.md": "x" }) });
  expect(await client.call("environment.get", { project_id: local.id })).toMatchObject({ environment: null, available: true });
});

test("draft, save and its build: environment.updated while it runs, the build remembered, then a failed build", async () => {
  const web = await project("web", PNPM_APP);
  const first = await client.call("environment.get", { project_id: web.id });
  expect(first).toMatchObject({ available: true, environment: { repo: "acme/web", state: "not_set_up", source: "none", build: null }, fix: { ok: false } });
  // Cloud's own extra fields never reach a client.
  expect(first.environment).not.toHaveProperty("added_by_cloud_later");

  const draft = await client.call("environment.draft", { project_id: web.id });
  expect(draft.config).toContain('"mise use -g node@22.11.0"');
  expect(draft.config).toContain('"pnpm install --frozen-lockfile"');
  expect(draft.evidence.map((e) => e.source)).toContain("repo");

  const updates: Array<Environment> = [];
  client.on("environment.updated", (u) => {
    if (u.project_id === web.id) updates.push(u.environment);
  });
  const saved = await client.call("environment.save", { request_id: "save-1", project_id: web.id, config: draft.config, secret_names: draft.secret_names });
  expect(saved.environment).toMatchObject({ source: "cloud", config: draft.config });
  await until(() => updates.some((e) => e.state === "ready"));
  expect(updates.some((e) => e.state === "setting_up")).toBe(true);
  const ready = await client.call("environment.get", { project_id: web.id });
  expect(ready.environment).toMatchObject({ state: "ready", snapshot: { checks: [{ command: "pnpm typecheck", ok: true }, { command: "pnpm test", ok: true }] } });
  expect(ready.builds?.[0]).toMatchObject({ id: saved.build_id, status: "succeeded", by: "person" });
  expect((await client.call("environment.build.log", { build_id: saved.build_id })).text).toContain("(full log)");

  // The next build fails at setup: it says where and why, and the old snapshot stays.
  cloud.state.environments.outcome = () => ({ fail: { kind: "command", step: "setup", message: "pnpm install exited 1" } });
  const { build_id } = await client.call("environment.build", { request_id: "rebuild", project_id: web.id });
  let build = await client.call("environment.build.get", { build_id });
  while (build.status !== "failed") build = await client.call("environment.build.get", { build_id });
  expect(build.failure).toEqual({ kind: "command", step: "setup", message: "pnpm install exited 1" });
  expect(build.steps.find((s) => s.name === "setup")?.status).toBe("failed");
  expect((await client.call("environment.get", { project_id: web.id })).environment?.state).toBe("ready");
  // A computer that never started says so as its own kind.
  cloud.state.environments.outcome = () => ({ fail: { kind: "start", step: "clone", message: "no node had room within 10 minutes" } });
  const unstarted = await client.call("environment.build", { request_id: "rebuild-start", project_id: web.id });
  build = await client.call("environment.build.get", { build_id: unstarted.build_id });
  while (build.status !== "failed") build = await client.call("environment.build.get", { build_id: unstarted.build_id });
  expect(build.failure).toEqual({ kind: "start", step: "clone", message: "no node had room within 10 minutes" });
  cloud.state.environments.outcome = () => ({});

  // A bad file never leaves the runtime.
  expect(await reason(client.call("environment.save", { request_id: "bad", project_id: web.id, config: "[setup]\nrnu = []\n" }))).toContain("invalid_params");
});

test("Fix it: refused without a Caveman engine key; the setup chat builds, proposes, the person publishes, and it stops at 5 builds", async () => {
  // Fix it by hand here: the failed build doesn't start a chat by itself (the next test covers that).
  await client.call("settings.set", { request_id: "auto-fix-off", settings: { cloud_auto_fix: false } });
  const api = await project("api", { ...PNPM_APP, "docker-compose.yml": "services:\n  db:\n    image: postgres:16\n" });
  // Its first build fails at setup.
  cloud.state.environments.outcome = (config) => (config.includes("vips") ? {} : { fail: { kind: "command", step: "setup", message: "sharp needs libvips" } });
  const draft = await client.call("environment.draft", { project_id: api.id });
  const saved = await client.call("environment.save", { request_id: "api-save", project_id: api.id, config: draft.config });
  let build = await client.call("environment.build.get", { build_id: saved.build_id });
  while (build.status !== "failed") build = await client.call("environment.build.get", { build_id: saved.build_id });

  const refused = await client.call("environment.get", { project_id: api.id });
  expect(refused.fix).toEqual({ ok: false, reason: expect.stringContaining("Models & keys") });
  expect(await reason(client.call("environment.fix", { request_id: "fix-0", project_id: api.id }))).toContain("invalid_state");

  await client.call("engine.account.add", { request_id: "key", engine: "caveman", provider: "anthropic", key: ("sk-" + "ant-api03-test-key-0000000000000000000000") });
  expect((await client.call("environment.get", { project_id: api.id })).fix).toEqual({ ok: true });
  // The stand-in CLI serves "caveman" as a Claude model.
  await client.call("settings.set", { request_id: "caveman-model", settings: { engines: { caveman: { model: "claude-sonnet-4-6" } } } });
  const chat = await client.call("environment.fix", { request_id: "fix-1", project_id: api.id });
  // A second Fix it joins it.
  expect(await client.call("environment.fix", { request_id: "fix-2", project_id: api.id })).toEqual(chat);
  const listed = await client.call("workspace.list", {});
  expect(listed.workspaces.some((w) => w.id === chat.workspace_id)).toBe(false);
  const workspace = await client.call("workspace.get", { workspace_id: chat.workspace_id });
  expect(workspace).toMatchObject({ kind: "setup", engine: "caveman", project_id: api.id });
  const threadId = `caveman:${chat.workspace_id}`;
  expect(setupThreads.has(threadId)).toBe(true);
  expect((await client.call("environment.get", { project_id: api.id })).setup_chat).toMatchObject({ workspace_id: chat.workspace_id, state: "working", builds: 0 });

  const chats = Context.get(runtime.context as unknown as Context.Context<SetupChats>, SetupChats);
  const run = (config: string, propose: boolean, summary?: string) => Effect.runPromise(chats.build(threadId, { config, propose, ...(summary ? { summary } : {}) }));
  const refusal = (thread: string, config: string) => Effect.runPromise(chats.build(thread, { config, propose: false }).pipe(Effect.flip));
  // Another thread has no setup tool; a file that doesn't parse costs no build.
  expect(await refusal("caveman:other", draft.config)).toMatchObject({ message: expect.stringContaining("only in a repo's setup chat") });
  expect(await refusal(threadId, "[setup]\nrnu = []\n")).toMatchObject({ message: expect.stringContaining('unknown key "setup.rnu"') });

  const sent = cloud.state.environments.requests.length;
  const tried = await run(draft.config, false);
  expect(tried).toMatchObject({ status: "failed", failure: { step: "setup", message: "sharp needs libvips" }, proposed: false, builds_left: 4 });
  const fixed = draft.config.replace("[setup]\n", '[setup]\n# needs libvips\n').replace('run = [', 'run = [\n  "mise use -g vips@latest",');
  const passed = await run(fixed, false);
  expect(passed).toMatchObject({ status: "succeeded", proposed: false, builds_left: 3 });
  // A proposal needs the two lines the person reads; asking without them costs no build.
  expect(await Effect.runPromise(chats.build(threadId, { config: fixed, propose: true }).pipe(Effect.flip))).toMatchObject({ message: expect.stringContaining("needs a summary") });
  // A config Cloud refuses (a service this install doesn't offer) costs no build either.
  expect(await refusal(threadId, fixed.includes("[services]\n") ? fixed.replace("[services]\n", '[services]\nmysql = "8"\n') : `${fixed}\n[services]\nmysql = "8"\n`)).toMatchObject({ message: expect.stringContaining("doesn't offer mysql") });
  const pushed: Array<{ project_id: string; setup_chat: { state: string; proposal?: { build_id: string } } }> = [];
  client.on("environment.setup_chat", (n) => {
    if (n.project_id === api.id) pushed.push(n);
  });
  const summary = "Installs libvips with mise before pnpm install.\nsharp needs it to build.";
  const kept = await run(fixed, true, summary);
  expect(kept).toMatchObject({ status: "succeeded", proposed: true, builds_left: 2 });
  // Every build the setup chat starts says Caveman started it, and none asks Cloud to save.
  const posts = cloud.state.environments.requests.slice(sent).filter((r) => r.method === "POST" && r.path.endsWith("/environments/builds"));
  expect(posts.length).toBeGreaterThanOrEqual(3);
  expect(posts.every((r) => r.body.by === "caveman" && r.body.save === undefined)).toBe(true);

  // Nothing saved yet: the passing setup waits for the person.
  const review = await client.call("environment.get", { project_id: api.id });
  expect(review.environment).toMatchObject({ source: "cloud", config: draft.config });
  expect(review.setup_chat).toMatchObject({ state: "review", builds: 3, proposal: { config: fixed, summary, build_id: expect.any(String) } });
  // Clients hear the proposal as it lands, not at their next read.
  const proposalBuild = review.setup_chat!.proposal!.build_id;
  await until(() => pushed.some((n) => n.setup_chat.state === "review" && n.setup_chat.proposal?.build_id === proposalBuild));
  // Its turn ending leaves it in review.
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect((await client.call("environment.get", { project_id: api.id })).setup_chat?.state).toBe("review");

  // Only what the person looked at is published: another build's id is refused.
  expect(await reason(client.call("environment.publish", { request_id: "publish-api-stale", project_id: api.id, build_id: "b-something-else" }))).toBe("invalid_state: This fix changed since you looked; review it again.");
  // Publish: a save as the person (their push rule, their name on the version), then its build.
  const published = await client.call("environment.publish", { request_id: "publish-api", project_id: api.id, build_id: proposalBuild });
  expect(published.environment).toMatchObject({ source: "cloud", config: fixed, updated_by: "Julius" });
  await until(async () => (await client.call("environment.get", { project_id: api.id })).environment?.state === "ready");
  const after = await client.call("environment.get", { project_id: api.id });
  expect(after.environment).toMatchObject({ source: "cloud", config: fixed, updated_by: "Julius", state: "ready" });
  expect(after.setup_chat).toMatchObject({ state: "succeeded", builds: 3 });
  expect(after.setup_chat).not.toHaveProperty("proposal");
  expect(after.builds?.filter((b) => b.by === "setup_chat")).toHaveLength(3);
  expect(after.builds?.[0]).toMatchObject({ id: published.build_id, by: "person" });
  // Nothing waits now: a second publish is refused.
  expect(await reason(client.call("environment.publish", { request_id: "publish-api-2", project_id: api.id, build_id: proposalBuild }))).toBe("invalid_state: No setup is waiting for review.");
  expect(pushed.at(-1)?.setup_chat).toMatchObject({ state: "succeeded" });
  // It has ended: no more builds.
  expect(await refusal(threadId, fixed)).toMatchObject({ message: "This setup chat has ended." });

  // A new setup chat stops at 5 builds.
  cloud.state.environments.outcome = () => ({ fail: { kind: "check", step: "check", message: "pnpm test failed" } });
  const second = await client.call("environment.fix", { request_id: "fix-3", project_id: api.id, ask: "Add redis" });
  expect(second.workspace_id).not.toBe(chat.workspace_id);
  const capped = `caveman:${second.workspace_id}`;
  for (let i = 0; i < 5; i++) await Effect.runPromise(chats.build(capped, { config: fixed, propose: false }));
  expect(await refusal(capped, fixed)).toMatchObject({ message: expect.stringContaining("5 test builds") });

  // Once its turn ends, a capped chat isn't joined: Fix it starts a new one.
  await until(async () => (await client.call("environment.get", { project_id: api.id })).setup_chat?.state === "failed");
  // Builds asked for at once still stop at 5: each takes its place before Cloud is asked.
  const third = await client.call("environment.fix", { request_id: "fix-4", project_id: api.id });
  expect(third.workspace_id).not.toBe(second.workspace_id);
  // The older chat has ended; it never spends the newer one's builds.
  expect(await refusal(capped, fixed)).toMatchObject({ message: "This setup chat has ended." });
  const parallel = `caveman:${third.workspace_id}`;
  const posted = () => cloud.state.environments.requests.filter((r) => r.method === "POST" && r.path.endsWith("/environments/builds")).length;
  const before = posted();
  const results = await Effect.runPromise(Effect.all(Array.from({ length: 8 }, () => Effect.result(chats.build(parallel, { config: fixed, propose: false }))), { concurrency: "unbounded" }));
  expect(results.filter((r) => r._tag === "Success")).toHaveLength(5);
  expect(results.flatMap((r) => (r._tag === "Failure" ? [r.failure.message] : []))).toEqual(Array(3).fill(expect.stringContaining("5 test builds")));
  expect(posted() - before).toBe(5);
  expect((await client.call("environment.get", { project_id: api.id })).setup_chat).toMatchObject({ workspace_id: third.workspace_id, builds: 5 });
  cloud.state.environments.outcome = () => ({});
  await client.call("settings.set", { request_id: "auto-fix-on", settings: { cloud_auto_fix: true } });
}, 120_000);

test("a setup chat whose turn had ended when its time ran out is stopped when the person answers it", async () => {
  const docs = await project("docs", PNPM_APP);
  const chat = await client.call("environment.fix", { request_id: "fix-docs", project_id: docs.id });
  await until(async () => (await client.call("environment.get", { project_id: docs.id })).setup_chat?.state === "failed");
  const limit = timing.setupChatMs;
  // Its 20 minutes are over (the timer found its turn ended and left it).
  timing.setupChatMs = 1;
  try {
    await client.call("turn.submit", { request_id: "docs-answer", session_id: chat.session_id, kind: "followup", input: { text: "Try again" } });
    await until(async () => (await client.call("environment.get", { project_id: docs.id })).setup_chat?.state === "stopped");
  } finally {
    timing.setupChatMs = limit;
  }
}, 60_000);

test("a member Cloud can't see push access for: a save is refused in Cloud's words, background prepare saves nothing and says nothing", async () => {
  cloud.state.environments.computers = true;
  cloud.state.environments.repoAccess = false;
  try {
    const blog = await project("blog", PNPM_APP);
    const draft = await client.call("environment.draft", { project_id: blog.id });
    expect(await reason(client.call("environment.save", { request_id: "blog-save", project_id: blog.id, config: draft.config }))).toBe(
      "forbidden: Only Acme's admins and people who can push to acme/blog change its Cloud setup. Add .caveman/computer.toml to the repo in a pull request instead.",
    );
    const refusedPuts = () => cloud.state.environments.requests.filter((r) => r.method === "PUT" && r.body.repo === "acme/blog").length;
    const before = refusedPuts();
    await client.call("workspace.create", { request_id: "chat-blog", repo: { path: blog.path }, engine: "claude-agent", options: { model: "claude-sonnet-4-6" } });
    await until(() => refusedPuts() > before);
    expect(cloud.state.environments.envs.has("acme/blog")).toBe(false);
    expect((await client.call("environment.get", { project_id: blog.id })).environment).toMatchObject({ state: "not_set_up", build: null });
  } finally {
    cloud.state.environments.repoAccess = true;
    cloud.state.environments.computers = false;
  }
}, 60_000);

test("set up now: the draft saved and built as the person, a repo file built, one already building left alone, a refusal in Cloud's words", async () => {
  const guide = await project("guide", PNPM_APP);
  const set = await client.call("environment.setup", { request_id: "setup-guide", project_id: guide.id });
  expect(set.environment).toMatchObject({ repo: "acme/guide", state: "setting_up", source: "cloud" });
  expect(set.evidence?.length).toBeGreaterThan(0);
  expect(cloud.state.environments.envs.get("acme/guide")).toMatchObject({ config: expect.stringContaining("pnpm install --frozen-lockfile"), updated_by: "Julius" });
  expect((await client.call("environment.get", { project_id: guide.id })).builds?.[0]?.by).toBe("person");
  const puts = () => cloud.state.environments.requests.filter((r) => r.method === "PUT").length;
  const before = puts();
  expect((await client.call("environment.setup", { request_id: "setup-guide-2", project_id: guide.id })).evidence).toBeUndefined();
  expect(puts()).toBe(before);

  cloud.state.environments.repoFiles.set("acme/tools", '[setup]\nrun = ["make"]\n');
  const tools = await project("tools", { Makefile: "all:\n\ttrue\n" });
  const built = await client.call("environment.setup", { request_id: "setup-tools", project_id: tools.id });
  expect(built.environment).toMatchObject({ source: "repo", state: "setting_up" });
  expect(cloud.state.environments.requests.some((r) => r.method === "POST" && r.path.endsWith("/builds") && r.body.repo === "acme/tools")).toBe(true);
  expect(cloud.state.environments.envs.has("acme/tools")).toBe(false);

  cloud.state.environments.repoAccess = false;
  try {
    const wiki = await project("wiki", PNPM_APP);
    expect(await reason(client.call("environment.setup", { request_id: "setup-wiki", project_id: wiki.id }))).toMatch(/^forbidden: Only Acme's admins/);
  } finally {
    cloud.state.environments.repoAccess = true;
  }
  const local = await client.call("project.create", { request_id: "p-local-setup", path: makeRepo(tempRoot("sp-env-local-setup-"), { "README.md": "x" }) });
  expect(await reason(client.call("environment.setup", { request_id: "setup-local", project_id: local.id }))).toMatch(/^invalid_state: .*no GitHub remote/);
}, 60_000);

test("warm hints: typing a Cloud chat prepares the repo, then keeps its snapshot warm, at most once per 20 s; never an error", async () => {
  cloud.state.environments.computers = true;
  const hints = (repo: string) => cloud.state.environments.requests.filter((r) => r.path.endsWith("/warm-hint") && r.body.repo === repo).length;
  try {
    const gateway = await project("gateway", PNPM_APP);
    // Nobody set it up: background prepare saves the draft, and nothing is ready to keep warm yet.
    expect(await client.call("environment.warm", { request_id: `warm-1`, project_id: gateway.id })).toEqual({ warm: false });
    await until(() => cloud.state.environments.envs.has("acme/gateway"));
    expect(cloud.state.environments.envs.get("acme/gateway")?.updated_by).toBe("Caveman");
    expect(hints("acme/gateway")).toBe(1);
    // Within 20 s a second hint goes nowhere.
    expect(await client.call("environment.warm", { request_id: `warm-2`, project_id: gateway.id })).toEqual({ warm: false });
    expect(hints("acme/gateway")).toBe(1);
    // Built and ready: warm.
    await until(async () => (await client.call("environment.get", { project_id: gateway.id })).environment?.state === "ready");
    timing.warmEveryMs = 0;
    expect(await client.call("environment.warm", { request_id: `warm-3`, project_id: gateway.id })).toEqual({ warm: true });
    expect(hints("acme/gateway")).toBe(2);
    // A Caveman Cloud from before warm hints: not warm, no error.
    cloud.state.environments.routes = false;
    expect(await client.call("environment.warm", { request_id: `warm-4`, project_id: gateway.id })).toEqual({ warm: false });
    cloud.state.environments.routes = true;
    // No GitHub remote: nothing to warm, and Cloud is not asked.
    const local = await client.call("project.create", { request_id: "p-local-warm", path: makeRepo(tempRoot("sp-env-local-warm-"), { "README.md": "x" }) });
    const before = cloud.state.environments.requests.length;
    expect(await client.call("environment.warm", { request_id: `warm-5`, project_id: local.id })).toEqual({ warm: false });
    expect(cloud.state.environments.requests.length).toBe(before);
  } finally {
    timing.warmEveryMs = 20_000;
    cloud.state.environments.routes = true;
    cloud.state.environments.computers = false;
  }
}, 60_000);

test("background prepare: a chat here drafts and saves its repo's Cloud setup once, quietly", async () => {
  cloud.state.environments.computers = true;
  const shop = await project("shop", PNPM_APP);
  const w = await client.call("workspace.create", { request_id: "chat-shop", repo: { path: shop.path }, engine: "claude-agent", options: { model: "claude-sonnet-4-6" } });
  await until(() => cloud.state.environments.envs.has("acme/shop"));
  expect(cloud.state.environments.envs.get("acme/shop")).toMatchObject({ config: expect.stringContaining("pnpm install --frozen-lockfile"), updated_by: "Caveman" });
  const got = await client.call("environment.get", { project_id: shop.id });
  expect(got.builds?.[0]?.by).toBe("background");
  // Once per project: a second chat saves nothing new.
  const before = cloud.state.environments.requests.filter((r) => r.method === "PUT").length;
  await client.call("workspace.create", { request_id: "chat-shop-2", repo: { path: shop.path }, engine: "claude-agent", options: { model: "claude-sonnet-4-6" } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(cloud.state.environments.requests.filter((r) => r.method === "PUT").length).toBe(before);
  // Settings turns it off.
  const settings = await client.call("settings.set", { request_id: "off", settings: { cloud_prepare: false } });
  expect(settings.cloud_prepare).toBe(false);
  expect(w.kind).toBeUndefined();
}, 60_000);

test("the setup brief proposes for review, and names [system] packages and the services this install offers", () => {
  const brief = setupBrief({ repo: "acme/x", config: "[setup]\nrun = []\n", build: null, draft: undefined, ask: undefined, offered: { postgres: ["15", "16", "17"], redis: ["7"], mysql: ["8.4"] } });
  expect(brief).toContain("this install offers postgres 15, 16 or 17; redis 7; mysql 8.4");
  expect(brief).toContain('[system] packages = ["libvips"]: conda-forge names (lower case, at most 64), installed before [setup].run');
  expect(brief).toContain("needs Docker, which computers don't have");
  expect(brief).toContain("propose true and a summary");
  expect(brief).toContain("That doesn't save it");
  expect(brief).not.toMatch(/save true/);
  // Another chat's agent's proposal reads as its words, never as the person's ask.
  const suggested = setupBrief({ repo: "acme/x", config: "", build: null, draft: undefined, ask: undefined, suggested: "Install libvips\n\nWhy: sharp failed" });
  expect(suggested).toContain("Another chat's agent suggests");
  expect(suggested).toContain("Install libvips");
  expect(suggested).not.toContain("The person asks");
});

test("a failed build with no ready snapshot starts the setup chat by itself, once; not for a value only a person has, nor with Settings off", async () => {
  const chats = Context.get(runtime.context as unknown as Context.Context<SetupChats>, SetupChats);
  await client.call("settings.set", { request_id: "auto-prepare-on", settings: { cloud_prepare: true } });
  cloud.state.environments.computers = true;
  cloud.state.environments.outcome = (config) => (config.includes("vips") ? {} : { fail: { kind: "command", step: "setup", message: "sharp needs libvips" } });
  try {
    const before = setupThreads.size;
    const cli = await project("cli", PNPM_APP);
    // A chat here saves the draft in the background. Nobody watches its build; the runtime follows it, and its
    // failure starts the setup chat.
    await client.call("workspace.create", { request_id: "chat-cli", repo: { path: cli.path }, engine: "claude-agent", options: { model: "claude-sonnet-4-6" } });
    await until(() => setupThreads.size > before);
    const started = (await client.call("environment.get", { project_id: cli.id })).setup_chat!;
    expect(started).toMatchObject({ state: expect.stringMatching(/^(working|failed)$/), builds: 0 });
    expect(await client.call("workspace.get", { workspace_id: started.workspace_id })).toMatchObject({ kind: "setup", engine: "caveman", project_id: cli.id });
    // Once per failed build: reading it again starts nothing.
    const threads = setupThreads.size;
    await client.call("environment.get", { project_id: cli.id });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(setupThreads.size).toBe(threads);
    expect((await client.call("environment.get", { project_id: cli.id })).setup_chat?.workspace_id).toBe(started.workspace_id);
    // Its own failing test build starts no other chat.
    const thread = `caveman:${started.workspace_id}`;
    const draft = cloud.state.environments.envs.get("acme/cli")!.config;
    await Effect.runPromise(chats.build(thread, { config: draft, propose: false }));
    await client.call("environment.get", { project_id: cli.id });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(setupThreads.size).toBe(threads);

    // It proposes; a publish Cloud refuses keeps the proposal, in Cloud's words; discard drops it.
    const fixed = draft.replace("[setup]\n", "[setup]\n# vips\n");
    expect(await Effect.runPromise(chats.build(thread, { config: fixed, propose: true, summary: "Adds libvips.\nsharp needs it." }))).toMatchObject({ proposed: true });
    const cliBuild = (await client.call("environment.get", { project_id: cli.id })).setup_chat!.proposal!.build_id;
    cloud.state.environments.repoAccess = false;
    try {
      expect(await reason(client.call("environment.publish", { request_id: "publish-cli", project_id: cli.id, build_id: cliBuild }))).toMatch(/^forbidden: Only Acme's admins and people who can push to acme\/cli/);
    } finally {
      cloud.state.environments.repoAccess = true;
    }
    expect((await client.call("environment.get", { project_id: cli.id })).setup_chat).toMatchObject({ state: "review", proposal: { config: fixed } });
    // A test build still running when the person discards passes later and revives nothing.
    const poll = timing.pollMs;
    timing.pollMs = 100;
    const late = Effect.runPromise(chats.build(thread, { config: `${fixed}# again\n`, propose: true, summary: "Again.\nStill vips." }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await client.call("environment.discard", { request_id: "discard-cli", project_id: cli.id });
    try {
      expect(await late).toMatchObject({ status: "succeeded", proposed: false });
    } finally {
      timing.pollMs = poll;
    }
    const discarded = await client.call("environment.get", { project_id: cli.id });
    expect(discarded.setup_chat).toMatchObject({ state: "stopped" });
    expect(discarded.setup_chat).not.toHaveProperty("proposal");
    expect(cloud.state.environments.envs.get("acme/cli")?.config).toBe(draft);
    expect(await Effect.runPromise(chats.build(thread, { config: fixed, propose: false }).pipe(Effect.flip))).toMatchObject({ message: "This setup chat has ended." });

    // Settings off: a failed build starts nothing.
    await client.call("settings.set", { request_id: "auto-fix-off-2", settings: { cloud_auto_fix: false } });
    const lib = await project("lib", PNPM_APP);
    await client.call("environment.save", { request_id: "lib-save", project_id: lib.id, config: (await client.call("environment.draft", { project_id: lib.id })).config });
    await until(async () => (await client.call("environment.get", { project_id: lib.id })).environment?.state === "failed");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await client.call("environment.get", { project_id: lib.id })).setup_chat).toBeUndefined();
    await client.call("settings.set", { request_id: "auto-fix-on-2", settings: { cloud_auto_fix: true } });

    // A teammate's build (one this runtime didn't start) that just failed starts nothing here.
    const justNow = new Date().toISOString();
    cloud.state.environments.builds.set("b-teammate", { id: "b-teammate", repo: "acme/shared", config: "[setup]\nrun = []\n", save: false, by: "Ada", step: 3, status: "failed", failure: { kind: "command", step: "setup", message: "exit 1" }, gaps: [], started_at: justNow, finished_at: justNow });
    cloud.state.environments.latest.set("acme/shared", "b-teammate");
    const shared = await project("shared", PNPM_APP);
    expect((await client.call("environment.get", { project_id: shared.id })).environment?.state).toBe("failed");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await client.call("environment.get", { project_id: shared.id })).setup_chat).toBeUndefined();
    // One of this runtime's own builds that ended longer ago than the window (remembered from before a restart) neither.
    const window = timing.autoFixWithinMs;
    timing.autoFixWithinMs = 0;
    try {
      const late = await project("late", PNPM_APP);
      await client.call("environment.save", { request_id: "late-save", project_id: late.id, config: (await client.call("environment.draft", { project_id: late.id })).config });
      await until(async () => (await client.call("environment.get", { project_id: late.id })).environment?.state === "failed");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect((await client.call("environment.get", { project_id: late.id })).setup_chat).toBeUndefined();
    } finally {
      timing.autoFixWithinMs = window;
    }

    // A private registry's token is the person's to add (a build secret): no setup chat, even with Settings on.
    cloud.state.environments.outcome = () => ({ fail: { kind: "registry_auth", step: "setup", message: "npm.pkg.github.com answered 401" } });
    const reg = await project("reg", PNPM_APP);
    await client.call("environment.save", { request_id: "reg-save", project_id: reg.id, config: (await client.call("environment.draft", { project_id: reg.id })).config });
    await until(async () => (await client.call("environment.get", { project_id: reg.id })).environment?.state === "failed");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await client.call("environment.get", { project_id: reg.id })).setup_chat).toBeUndefined();
  } finally {
    cloud.state.environments.outcome = () => ({});
    cloud.state.environments.computers = false;
    await client.call("settings.set", { request_id: "auto-prepare-off", settings: { cloud_prepare: false, cloud_auto_fix: true } });
  }
}, 90_000);

test("propose_setup_change: a chat in a GitHub project proposes; clients hear it and see it; Apply hands it to the setup chat, Dismiss drops it", async () => {
  const chats = Context.get(runtime.context as unknown as Context.Context<SetupChats>, SetupChats);
  const img = await project("img", PNPM_APP);
  const w = await client.call("workspace.create", { request_id: "chat-img", repo: { path: img.path }, engine: "caveman", options: { model: "claude-sonnet-4-6" } });
  const thread = `caveman:${w.id}`;
  const heard: Array<{ project_id: string; proposal: { id: string; summary: string } }> = [];
  client.on("environment.proposed", (n) => heard.push(n));
  const propose = (from: string, summary: string, why: string) => Effect.runPromise(chats.propose(from, { summary, why }));
  const refused = (from: string) => Effect.runPromise(chats.propose(from, { summary: "Add redis", why: "tests need it" }).pipe(Effect.flip));

  const first = await propose(thread, "Install libvips", "pnpm test: sharp: libvips not found");
  await until(() => heard.length === 1);
  expect(heard[0]).toMatchObject({ project_id: img.id, proposal: { id: first.id, workspace_id: w.id, summary: "Install libvips", why: "pnpm test: sharp: libvips not found" } });
  // The same change again replaces its card; another stacks on top.
  const again = await propose(thread, "Install libvips", "vitest: sharp: libvips not found");
  const redis = await propose(thread, "Add redis 7", "tests connect to 127.0.0.1:6379");
  const got = await client.call("environment.get", { project_id: img.id });
  expect(got.proposals?.map((p) => [p.id, p.summary])).toEqual([
    [redis.id, "Add redis 7"],
    [again.id, "Install libvips"],
  ]);

  // Not a chat in a project, or a project with no GitHub remote: refused.
  expect(await refused("caveman:no-such-thread")).toMatchObject({ message: expect.stringContaining("works in a chat in a project") });
  const local = await client.call("project.create", { request_id: "p-local-propose", path: makeRepo(tempRoot("sp-env-local-propose-"), { "README.md": "x" }) });
  const localChat = await client.call("workspace.create", { request_id: "chat-local-propose", repo: { path: local.path }, engine: "caveman", options: { model: "claude-sonnet-4-6" } });
  expect(await refused(`caveman:${localChat.id}`)).toMatchObject({ message: expect.stringContaining("no GitHub remote") });

  // Apply: the setup chat starts with it as its ask, and its card goes.
  const applied = await client.call("environment.proposal.apply", { request_id: "apply-redis", project_id: img.id, proposal_id: redis.id });
  expect(setupThreads.has(`caveman:${applied.workspace_id}`)).toBe(true);
  const after = await client.call("environment.get", { project_id: img.id });
  expect(after.setup_chat?.workspace_id).toBe(applied.workspace_id);
  expect(after.proposals?.map((p) => p.id)).toEqual([again.id]);
  // The setup chat itself proposes nothing: it builds.
  expect(await refused(`caveman:${applied.workspace_id}`)).toMatchObject({ message: expect.stringContaining("environment_build") });
  // Applying again: gone.
  expect(await reason(client.call("environment.proposal.apply", { request_id: "apply-redis-2", project_id: img.id, proposal_id: redis.id }))).toMatch(/^not_found: /);

  // Dismiss drops it.
  await client.call("environment.proposal.dismiss", { request_id: "dismiss-vips", project_id: img.id, proposal_id: again.id });
  expect((await client.call("environment.get", { project_id: img.id })).proposals).toBeUndefined();
}, 60_000);

/** A project whose origin is `owner/name` on GitHub. */
async function projectAt(fullName: string, files: Record<string, string>) {
  const repo = makeRepo(tempRoot(`sp-env-${fullName.replace("/", "-")}-`), files);
  git(repo, "remote", "add", "origin", `https://github.com/${fullName}.git`);
  return client.call("project.create", { request_id: `p-${fullName}`, path: repo });
}

test("versions and restore: newest first; a restore is a new version and a build; a repo's own file and another organization's repo refused in Cloud's words", async () => {
  const infra = await project("infra", PNPM_APP);
  const v1 = '[setup]\nrun = ["make deps"]\n';
  const v2 = '[setup]\nrun = ["make deps", "make db"]\n';
  await client.call("environment.save", { request_id: "infra-v1", project_id: infra.id, config: v1 });
  await client.call("environment.save", { request_id: "infra-v2", project_id: infra.id, config: v2 });
  const { versions } = await client.call("environment.versions", { project_id: infra.id });
  expect(versions.map((v) => [v.version, v.config, v.updated_by])).toEqual([
    [2, v2, "Julius"],
    [1, v1, "Julius"],
  ]);
  const restored = await client.call("environment.restore", { request_id: "infra-restore-1", project_id: infra.id, version: 1 });
  expect(restored.environment).toMatchObject({ config: v1, config_version: 3, updated_by: "Julius" });
  expect((await client.call("environment.get", { project_id: infra.id })).builds?.[0]).toMatchObject({ id: restored.build_id, by: "person" });
  expect((await client.call("environment.versions", { project_id: infra.id })).versions[0]).toMatchObject({ version: 3, config: v1 });
  expect(await reason(client.call("environment.restore", { request_id: "infra-restore-9", project_id: infra.id, version: 9 }))).toBe("invalid_params: acme/infra has no version 9.");

  // A branch that owns its file: edit it there.
  cloud.state.environments.repoFiles.set("acme/owned", '[setup]\nrun = ["make"]\n');
  const owned = await project("owned", { Makefile: "all:\n\ttrue\n" });
  expect(await reason(client.call("environment.restore", { request_id: "owned-restore", project_id: owned.id, version: 1 }))).toBe("invalid_state: acme/owned has .caveman/computer.toml on main; edit it there.");

  // Another organization's repo: Acme reads none of its versions and changes nothing.
  cloud.state.environments.foreign.add("globex/payroll");
  cloud.state.environments.versions.set("globex/payroll", [{ version: 1, config: '[env]\nGLOBEX = "1"\n', updated_by: "Globex admin", updated_at: "2026-10-01T00:00:00.000Z" }]);
  const payroll = await projectAt("globex/payroll", PNPM_APP);
  expect((await client.call("environment.versions", { project_id: payroll.id })).versions).toEqual([]);
  const forbidden = "forbidden: Only Acme's admins and people who can push to globex/payroll change its Cloud setup. Add .caveman/computer.toml to the repo in a pull request instead.";
  expect(await reason(client.call("environment.restore", { request_id: "payroll-restore", project_id: payroll.id, version: 1 }))).toBe(forbidden);
  expect(await reason(client.call("environment.build_secret.set", { request_id: "payroll-secret", project_id: payroll.id, name: "NPM_TOKEN", value: "globex-guess-value" }))).toBe(forbidden);
  expect(cloud.state.environments.buildSecrets.has("globex/payroll")).toBe(false);
}, 60_000);

/** Every file under `dir`, recursively. */
const filesUnder = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const at = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(at) : entry.isFile() ? [at] : [];
  });

test("build secrets: names only ever come back; the value is in no answer, request log or file under the runtime's state dir", async () => {
  const VALUE = ("np" + "m_9f3Kq2LxVb7TzR4wPmN8sYcD1eHjU6oA");
  const pkg = await project("pkg", PNPM_APP);
  const answers: unknown[] = [];
  const set = (request_id: string, name: string, value: string) => client.call("environment.build_secret.set", { request_id, project_id: pkg.id, name, value });
  answers.push(await set("pkg-npm", "NPM_TOKEN", VALUE));
  expect(answers[0]).toEqual({ names: ["NPM_TOKEN"] });
  answers.push(await set("pkg-gh", "GH_PACKAGES_TOKEN", "ghp_another_value_000000000000"));
  // A retry answers its receipt; the receipt keeps no value.
  answers.push(await set("pkg-npm", "NPM_TOKEN", VALUE));
  expect(answers[2]).toEqual({ names: ["NPM_TOKEN"] });
  const got = await client.call("environment.get", { project_id: pkg.id });
  answers.push(got);
  expect(got.environment?.build_secret_names).toEqual(["GH_PACKAGES_TOKEN", "NPM_TOKEN"]);
  answers.push(await client.call("environment.list", {}));
  expect(await client.call("environment.build_secret.delete", { request_id: "pkg-gh-off", project_id: pkg.id, name: "GH_PACKAGES_TOKEN" })).toEqual({ names: ["NPM_TOKEN"] });
  // A name that isn't a NAME never leaves the runtime.
  expect(await reason(set("pkg-bad", "1BAD", VALUE))).toMatch(/^invalid_params/);
  // A member Cloud can't see push access for: refused in Cloud's words, which carry no value.
  cloud.state.environments.repoAccess = false;
  try {
    const refusal = await reason(set("pkg-refused", "NPM_TOKEN", VALUE));
    expect(refusal).toMatch(/^forbidden: Only Acme's admins/);
    answers.push(refusal);
  } finally {
    cloud.state.environments.repoAccess = true;
  }
  // Cloud keeps it sealed; nothing else holds it.
  expect(cloud.state.environments.buildSecrets.get("acme/pkg")?.get("NPM_TOKEN")).toBe(VALUE);
  const encodings = [VALUE, Buffer.from(VALUE).toString("base64"), encodeURIComponent(VALUE)];
  for (const form of encodings) {
    expect(JSON.stringify(answers)).not.toContain(form);
    expect(JSON.stringify(cloud.state.environments.requests)).not.toContain(form);
    expect(filesUnder(stateDir).filter((file) => fs.readFileSync(file).includes(form))).toEqual([]);
  }
}, 60_000);

test("environment.list: the organization's environments, teammates' too, with the projects here merged; none of another organization's", async () => {
  cloud.state.environments.teammates.set("acme/billing", { state: "ready", updated_by: "Ada", updated_at: "2026-10-22T09:00:00.000Z" });
  const fresh = await project("fresh", PNPM_APP);
  const { environments, available } = await client.call("environment.list", {});
  expect(available).toBe(true);
  // A teammate's, from another Mac: no project here.
  expect(environments.find((e) => e.repo === "acme/billing")).toEqual({
    repo: "acme/billing",
    branch: "main",
    state: "ready",
    source: "cloud",
    updated_by: "Ada",
    updated_at: "2026-10-22T09:00:00.000Z",
    snapshot_built_at: "2026-10-22T09:00:00.000Z",
  });
  // One set up here opens its project; one nobody set up is listed from the project.
  expect(environments.find((e) => e.repo === "acme/web")).toMatchObject({ state: "ready", source: "cloud", project_id: expect.any(String) });
  expect(environments.find((e) => e.repo === "acme/fresh")).toEqual({ repo: "acme/fresh", branch: "", state: "not_set_up", source: "none", updated_by: null, updated_at: null, snapshot_built_at: null, project_id: fresh.id });
  expect(environments.filter((e) => e.repo === "acme/web")).toHaveLength(1);
  // Another organization's repo is only the checkout here: nothing of Globex's setup comes with it.
  expect(environments.filter((e) => e.repo.startsWith("globex/"))).toEqual([
    { repo: "globex/payroll", branch: "", state: "not_set_up", source: "none", updated_by: null, updated_at: null, snapshot_built_at: null, project_id: expect.any(String) },
  ]);
  // A Caveman Cloud from before the list: unavailable, with why.
  cloud.state.environments.routes = false;
  try {
    expect(await client.call("environment.list", {})).toMatchObject({ environments: [], available: false, reason: expect.stringContaining("doesn't set up repos") });
  } finally {
    cloud.state.environments.routes = true;
  }
});

test("environment.ci: CI on the branch head for a failed build, on the snapshot's commit for a gapped check; none without a GitHub remote", async () => {
  const web = (await client.call("environment.list", {})).environments.find((e) => e.repo === "acme/web")!;
  ciAsked.length = 0;
  // web's latest build failed: its head is what it built, and with no GitHub sign-in here nobody can say which commit.
  expect(await client.call("environment.ci", { project_id: web.project_id! })).toEqual({ ci: null });
  expect(ciAsked).toEqual([]);
  cloud.state.environments.outcome = () => ({ gaps: ["pnpm test failed"] });
  try {
    const gaps = await project("gaps", PNPM_APP);
    const saved = await client.call("environment.save", { request_id: "gaps-save", project_id: gaps.id, config: (await client.call("environment.draft", { project_id: gaps.id })).config });
    await until(async () => (await client.call("environment.get", { project_id: gaps.id })).environment?.state === "ready_with_gaps");
    expect(saved.build_id).toBeTruthy();
    await client.call("environment.ci", { project_id: gaps.id });
    expect(ciAsked.at(-1)).toEqual({ repo: "acme/gaps", commit: "4f2c1a0d9e8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c", token: undefined });
  } finally {
    cloud.state.environments.outcome = () => ({});
  }
  const local = await client.call("project.create", { request_id: "p-local-ci", path: makeRepo(tempRoot("sp-env-local-ci-"), { "README.md": "x" }) });
  const asked = ciAsked.length;
  expect(await client.call("environment.ci", { project_id: local.id })).toEqual({ ci: null });
  expect(ciAsked.length).toBe(asked);
}, 60_000);

test("a branch's head comes from GitHub with the person's token, and only a full sha counts", async () => {
  const sha = "4f2c1a0d9e8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c";
  const asked: Array<{ url: string; auth: string | null; accept: string | null }> = [];
  const github = (answer: () => Response) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      asked.push({ url: String(url), auth: headers.get("authorization"), accept: headers.get("accept") });
      return answer();
    }) as typeof fetch;
  expect(await Effect.runPromise(branchHead({ repo: "acme/web", branch: "main", token: "gho_t", fetch: github(() => new Response(`${sha}\n`)) }))).toBe(sha);
  expect(asked).toEqual([{ url: "https://api.github.com/repos/acme/web/commits/main", auth: "Bearer gho_t", accept: "application/vnd.github.sha" }]);
  expect(await Effect.runPromise(branchHead({ repo: "acme/web", branch: "main", token: "gho_t", fetch: github(() => new Response("not found", { status: 404 })) }))).toBeUndefined();
  expect(await Effect.runPromise(branchHead({ repo: "acme/web", branch: "main", token: "gho_t", fetch: github(() => new Response("<html>")) }))).toBeUndefined();
  // No token: GitHub isn't asked.
  const before = asked.length;
  expect(await Effect.runPromise(branchHead({ repo: "acme/web", branch: "main", token: undefined, fetch: github(() => new Response(sha)) }))).toBeUndefined();
  expect(asked.length).toBe(before);
});

test("environment.setup_repo: owner/name only; one set up already is left alone; a repo's own file gets its build", async () => {
  expect(await reason(client.call("environment.setup_repo", { request_id: "sr-bad", repo: "not a repo" }))).toBe("invalid_params: repo must be a GitHub repository as owner/name.");
  const puts = () => cloud.state.environments.requests.filter((r) => r.method === "PUT").length;
  const before = puts();
  expect((await client.call("environment.setup_repo", { request_id: "sr-web", repo: "acme/web" })).environment).toMatchObject({ repo: "acme/web", source: "cloud" });
  expect(puts()).toBe(before);
  cloud.state.environments.repoFiles.set("acme/svc", '[setup]\nrun = ["make"]\n');
  const svc = await client.call("environment.setup_repo", { request_id: "sr-svc", repo: "https://github.com/acme/svc.git" });
  expect(svc.environment).toMatchObject({ repo: "acme/svc", source: "repo", state: "setting_up" });
  expect(cloud.state.environments.requests.some((r) => r.method === "POST" && r.path.endsWith("/builds") && r.body.repo === "acme/svc")).toBe(true);
  expect(puts()).toBe(before);
});

test.skipIf(REMOTE_STUB)("environment.setup_repo drafts a GitHub-only repo from its manifests with no Mac seed, saves it, and leaves no temp dir", async () => {
  const remote = makeRepo(tempRoot("sp-env-remote-"), PNPM_APP);
  const original = remotes.cloneUrl;
  remotes.cloneUrl = () => `file://${remote}`;
  try {
    const out = await client.call("environment.setup_repo", { request_id: "sr-remote", repo: "acme/remote-only" });
    expect(out.environment).toMatchObject({ repo: "acme/remote-only", source: "cloud" });
    expect(cloud.state.environments.envs.get("acme/remote-only")?.config).toContain("pnpm install --frozen-lockfile");
    expect(out.evidence?.some((e) => e.source === "mac")).toBe(false);
    expect(fs.readdirSync(path.join(stateDir, "environment-drafts"))).toEqual([]);
  } finally {
    remotes.cloneUrl = original;
  }
}, 60_000);

test("a setup chat reads working from its start until its first turn ends, not while its worktree is made", async () => {
  cloud.state.environments.outcome = () => ({ fail: { kind: "command", step: "setup", message: "make deps exited 2" } });
  const states: Array<string> = [];
  let turnEnded = false;
  let offChat: (() => void) | undefined;
  try {
    const deps = await project("deps", PNPM_APP);
    let attached: Promise<unknown> | undefined;
    offChat = client.on("environment.setup_chat", (u) => {
      if (u.project_id !== deps.id) return;
      states.push(u.setup_chat.state);
      attached ??= client.attach(u.setup_chat.session_id, 0, (e) => void (e.type === "turn.done" && (turnEnded = true)));
    });
    const draft = (await client.call("environment.draft", { project_id: deps.id })).config;
    await client.call("environment.save", { request_id: "deps-save", project_id: deps.id, config: draft });
    // Its first turn ends with builds and time left: it waits, open. Until then it works: a failed build meanwhile is
    // not told to it (autoFix), and its panel never says it stopped without a fix.
    await until(() => turnEnded && states.at(-1) === "failed");
    expect(states).toEqual(["working", "failed"]);
  } finally {
    offChat?.();
    cloud.state.environments.outcome = () => ({});
  }
}, 60_000);

test("a failed build while the repo's setup chat has builds and time left goes to that chat; none starts beside it", async () => {
  cloud.state.environments.outcome = () => ({ fail: { kind: "command", step: "setup", message: "make deps exited 2" } });
  try {
    const ops = await project("ops", PNPM_APP);
    const before = setupThreads.size;
    const draft = (await client.call("environment.draft", { project_id: ops.id })).config;
    await client.call("environment.save", { request_id: "ops-save", project_id: ops.id, config: draft });
    await until(() => setupThreads.size > before);
    const first = (await client.call("environment.get", { project_id: ops.id })).setup_chat!;
    // Its turn ends with builds and time left: it waits, open.
    await until(async () => (await client.call("environment.get", { project_id: ops.id })).setup_chat?.state === "failed");
    const events: Array<SessionEvent> = [];
    await client.attach(first.session_id, 0, (e) => events.push(e));
    // The person saves again, and that build fails too: the same chat hears of it.
    const fetch = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    const blocked = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).startsWith(`${cloud.url}/api/v1/code/runtime/environments/builds/`) && (!init?.method || init.method === "GET")) {
        held = true;
        await gate;
      }
      return response;
    });
    const saving = client.call("environment.save", { request_id: "ops-save-2", project_id: ops.id, config: `${draft}\n# again\n` });
    try {
      await until(() => held);
      // Cloud finishes while the save's build-detail response is still in flight. A concurrent read
      // sees the failure before startedBuild has recorded that this runtime initiated the build.
      await until(async () => (await client.call("environment.get", { project_id: ops.id })).environment?.build?.status === "failed");
      expect(events.some((e) => e.type === "message.done" && JSON.stringify(e.payload).includes("A new Cloud build failed"))).toBe(false);
    } finally {
      release();
      blocked.mockRestore();
      await saving;
    }
    const delivered = () => events.filter((e) => e.type === "message.done" && e.payload.role === "user" && e.payload.text.includes("A new Cloud build failed"));
    await until(() => delivered().length > 0, 30_000);
    await Promise.all(Array.from({ length: 4 }, () => client.call("environment.get", { project_id: ops.id })));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(delivered()).toHaveLength(1);
    expect(setupThreads.size).toBe(before + 1);
    expect((await client.call("environment.get", { project_id: ops.id })).setup_chat?.workspace_id).toBe(first.workspace_id);
  } finally {
    cloud.state.environments.outcome = () => ({});
  }
}, 60_000);

test("a repo whose branch owns its file: no setup chat by itself, and its fix goes in a pull request, not a publish", async () => {
  const chats = Context.get(runtime.context as unknown as Context.Context<SetupChats>, SetupChats);
  const file = '[setup]\nrun = ["make"]\n';
  cloud.state.environments.repoFiles.set("acme/owner", file);
  cloud.state.environments.outcome = (config) => (config.includes("# fixed") ? {} : { fail: { kind: "command", step: "setup", message: "make: no rule" } });
  try {
    const owner = await project("owner", { Makefile: "all:\n\ttrue\n" });
    const before = setupThreads.size;
    await client.call("environment.setup", { request_id: "owner-setup", project_id: owner.id });
    await until(async () => (await client.call("environment.get", { project_id: owner.id })).environment?.state === "failed");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(setupThreads.size).toBe(before);
    expect((await client.call("environment.get", { project_id: owner.id })).setup_chat).toBeUndefined();
    // Fix it by hand: its passing fix can't be published.
    const chat = await client.call("environment.fix", { request_id: "owner-fix", project_id: owner.id });
    await Effect.runPromise(chats.build(`caveman:${chat.workspace_id}`, { config: `${file}# fixed\n`, propose: true, summary: "Fixes the make rule.\nIt was missing." }));
    const proposal = (await client.call("environment.get", { project_id: owner.id })).setup_chat!.proposal!;
    expect(await reason(client.call("environment.publish", { request_id: "owner-publish", project_id: owner.id, build_id: proposal.build_id }))).toBe(
      "invalid_state: acme/owner's branch has its own .caveman/computer.toml: add the fix to it in a pull request (Add to repo).",
    );
    // Add to repo takes the reviewed fix only.
    expect(await reason(client.call("environment.add_to_repo", { request_id: "owner-pr-stale", project_id: owner.id, build_id: "b-not-it" }))).toBe("invalid_state: This fix changed since you looked; review it again.");
    expect((await client.call("environment.get", { project_id: owner.id })).setup_chat).toMatchObject({ state: "review" });
  } finally {
    cloud.state.environments.outcome = () => ({});
  }
}, 60_000);

test("a publish or restore based on a Cloud copy someone changed since is refused in Cloud's words, and the proposal stays", async () => {
  const chats = Context.get(runtime.context as unknown as Context.Context<SetupChats>, SetupChats);
  const repoName = "acme/race";
  const race = await project("race", PNPM_APP);
  const v1 = '[setup]\nrun = ["make deps"]\n';
  await client.call("environment.save", { request_id: "race-v1", project_id: race.id, config: v1 });
  const chat = await client.call("environment.fix", { request_id: "race-fix", project_id: race.id, ask: "Add a check" });
  await Effect.runPromise(chats.build(`caveman:${chat.workspace_id}`, { config: `${v1}check = ["make test"]\n`, propose: true, summary: "Adds make test.\nAs asked." }));
  // A teammate saves meanwhile.
  const saved = cloud.state.environments.envs.get(repoName)!;
  cloud.state.environments.envs.set(repoName, { ...saved, version: saved.version + 1, config: '[setup]\nrun = ["make all"]\n', updated_by: "Ada" });
  const proposal = (await client.call("environment.get", { project_id: race.id })).setup_chat!.proposal!;
  expect(await reason(client.call("environment.publish", { request_id: "race-publish", project_id: race.id, build_id: proposal.build_id }))).toBe(
    `invalid_state: ${repoName}'s Cloud setup changed since (now version ${saved.version + 1}, by Ada). Review it again.`,
  );
  expect((await client.call("environment.get", { project_id: race.id })).setup_chat).toMatchObject({ state: "review", proposal: { build_id: proposal.build_id } });
  expect(cloud.state.environments.envs.get(repoName)?.updated_by).toBe("Ada");
  // A restore chosen while looking at an older version, likewise.
  expect(await reason(client.call("environment.restore", { request_id: "race-restore", project_id: race.id, version: 1, base_version: saved.version }))).toMatch(/^invalid_state: acme\/race's Cloud setup changed since/);
}, 60_000);

test("calls that act as the person refuse any other caller, as secret.* do; reads don't", async () => {
  const kv = new Map<string, string>();
  const store = {
    kvGet: (key: string) => Effect.succeed(kv.get(key)),
    kvSet: (key: string, value: string) => Effect.sync(() => void kv.set(key, value)),
    listWorkspaces: () => Effect.succeed([]),
    getByThread: () => Effect.succeed(undefined),
  } as unknown as SessionStore["Service"];
  const deps: EnvironmentDeps = {
    store,
    project: () => Effect.succeed(undefined),
    identity: () => undefined,
    cloudCall: () => Effect.die("no Cloud here"),
    link: {} as never,
    onCloudComputer: false,
    canFix: Effect.succeed(false),
    cloudPrepare: Effect.succeed(false),
    cloudAutoFix: Effect.succeed(false),
    cloudComputersAvailable: Effect.succeed(false),
    projects: Effect.succeed([]),
    git: {} as never,
    stateDir: tempRoot("sp-env-guard-"),
    githubToken: () => Effect.succeed(undefined),
    allowed: (principal) => principal === undefined || principal === "local" || principal === "cloud:owner",
    startSetupChat: () => Effect.die("no chats here"),
    tell: () => Effect.void,
    stop: () => Effect.void,
    noteIn: () => Effect.void,
    openPullRequest: () => Effect.die("no pull requests here"),
  };
  const params = { request_id: "r", project_id: "p", build_id: "b", version: 1, name: "NPM_TOKEN", value: "v", proposal_id: "x", repo: "acme/x", config: "[setup]\nrun = []\n" } as never;
  const reasons = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { handlers } = yield* makeEnvironmentHandlers(deps);
        const call = (method: string, principal: string) =>
          (handlers as unknown as Record<string, (p: never, ctx: { connectionId: string; principal: string }) => Effect.Effect<unknown, { reason: string }>>)[method]!(params, { connectionId: "c", principal })
            .pipe(Effect.match({ onFailure: (e) => e.reason, onSuccess: () => "ok" }));
        const out: Record<string, { stranger: string; owner: string }> = {};
        for (const method of [...AS_THE_PERSON, "environment.get", "environment.proposals", "environment.versions"]) out[method] = { stranger: yield* call(method, "cloud:someone-else"), owner: yield* call(method, "cloud:owner") };
        return out;
      }),
    ).pipe(Effect.provide(layerSetupChats)),
  );
  for (const method of AS_THE_PERSON) {
    expect(reasons[method]!.stranger, method).toBe("forbidden");
    expect(reasons[method]!.owner, method).not.toBe("forbidden");
  }
  for (const method of ["environment.get", "environment.proposals", "environment.versions"]) expect(reasons[method]!.stranger, method).not.toBe("forbidden");
});
