// Builders on Cloud computers (session-protocol/builders.ts) end to end against the stand-in Cloud and the tools
// container's exec channel, with the stand-in Claude CLI (no model): a lead on a Cloud computer starts builders as
// worktrees of its checkout up to the computer's limit, and past it through Cloud's mail/spawn; the builder's
// computer turns the spawn into a workspace and a first turn, and its result comes back by mail and wakes the lead;
// a lead on This Mac asks for Cloud. A chat moved onto a Cloud computer is placed as any chat there, and the one it
// left lets its checkout go.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { ThreadId } from "@caveman-app/protocol";
import { connect, type SessionEvent, type Workspace } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, expect, test } from "vitest";

import { isLiveCallerShell } from "../mcp/OrchestratorMcpService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { BRANCH_TRAILER, Builders, NO_SUCH_COMPUTER } from "../session-protocol/builders.ts";
import { createReady, makeConfig, makeRepo, MODEL, orchestratorOf, startRuntime, tempRoot, until } from "../session-protocol/testHarness.ts";
import { builderKit, gitIn, refusalOf, userTexts } from "./builders.kit.ts";
import { startTestCloud } from "./testCloud.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const { startTools, githubWith, checkoutOf, computerRuntime, delegate } = builderKit(cleanups);

// Skipped on Windows: a Cloud computer is Linux, and its tools channel is a Unix socket.
test.skipIf(process.platform === "win32")("a lead on a Cloud computer starts builders as worktrees up to its size, then through Cloud; the spawn becomes a workspace on its computer and its result wakes the lead", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  await startTools();
  // A 4x8 computer holds three chats (capacity.ts): two worktrees beside its first chat.
  process.env.CAVEMAN_COMPUTER_CPUS = "4";
  process.env.CAVEMAN_COMPUTER_MEMORY_GIB = "8";
  cleanups.push(() => (delete process.env.CAVEMAN_COMPUTER_CPUS, delete process.env.CAVEMAN_COMPUTER_MEMORY_GIB));
  const source = makeRepo(tempRoot("builders-source-"), {
    ".caveman/computer.toml": '[run]\ncommand = "echo run"\nports = ["web"]\n',
    "README.md": "widgets\n",
  });
  cloud.state.gitBackend = githubWith(source);

  const leadCheckout = checkoutOf(cloud.state.gitBackend, "builders-lead-");
  const builderCheckout = checkoutOf(cloud.state.gitBackend, "builders-spawned-");
  const leadComputer = await computerRuntime(cloud, leadCheckout, "lead");
  const builderComputer = await computerRuntime(cloud, builderCheckout, "builder");
  // The spawn past the lead computer's limit lands on the builder's computer (Cloud makes it; the test enrolled it).
  cloud.state.tree.nextComputers.push(builderComputer.identity.computerId);
  // The builder's computer has no model of its own for the engine: the spawn's (the lead's) is the one it runs.
  const { client } = leadComputer;

  // The person's chat, which leads three builders.
  const lead = await createReady(client, { request_id: "lead", repo: { url: "https://github.com/acme/widgets" }, title: "Lead the work", engine: "claude-agent", options: { model: MODEL } });
  expect(lead.branch).toMatch(/^caveman\/lead-the-work-/);
  // The engine instance the lead's MCP credential names (its thread's model selection, before any builder).
  const instance = (await Effect.runPromise(orchestratorOf(leadComputer.runtime).getThreadShell(ThreadId.make(`caveman:${lead.id}`))))!.modelSelection.instanceId;
  const git = gitIn(leadCheckout);
  // A commit on the lead's branch: builders start from it, here and on the other computer.
  fs.writeFileSync(path.join(leadCheckout, "plan.md"), "the plan\n");
  git("add", "plan.md");
  git("commit", "-qm", "plan");
  const planned = git("rev-parse", "HEAD");

  // Two builders as worktrees of this computer's checkout, each with its own branch and ports.
  const one = await delegate(leadComputer.builders, lead, "k1", "Part one");
  const two = await delegate(leadComputer.builders, lead, "k2", "Part two");
  expect([one?.where, two?.where]).toEqual(["here", "here"]);
  const children = async () => (await client.call("workspace.list", { parent_workspace_id: lead.id })).workspaces;
  await until(async () => (await children()).filter((w) => w.status !== "starting").length === 2, 30_000);
  const made = await children();
  expect(made.map((w) => w.title).sort()).toEqual(["Part one", "Part two"]);
  const chats = path.join(leadComputer.config.worktreesDir, "chats");
  // Made by git from the checkout in a folder the tools container shares (setgid, group-writable).
  expect(fs.statSync(chats).mode & 0o2770).toBe(0o2770);
  const worktrees = git("worktree", "list", "--porcelain").split("\n\n").map((entry) => ({ path: /^worktree (.+)$/m.exec(entry)?.[1], head: /^HEAD (.+)$/m.exec(entry)?.[1], branch: /^branch refs\/heads\/(.+)$/m.exec(entry)?.[1] }));
  expect(worktrees).toHaveLength(3);
  for (const w of made) {
    const at = worktrees.find((entry) => entry.branch === w.branch);
    expect(fs.realpathSync(path.dirname(at!.path!))).toBe(fs.realpathSync(chats));
    expect(at!.head).toBe(planned);
  }
  // The lead keeps the checkout and its branch.
  expect(git("symbolic-ref", "--short", "HEAD")).toBe(lead.branch);
  const ports = [lead, ...made].map((w) => w.ports?.web);
  expect(new Set(ports).size).toBe(3);
  // A retry of one delegation is that builder, not another.
  expect((await delegate(leadComputer.builders, lead, "k1", "Part one"))?.workspaceId).toBe(one?.workspaceId);
  expect(await children()).toHaveLength(2);

  // The computer is full: a person's chat beside the lead is refused in plain words, with no count of worktrees, and
  // the heartbeat tells Cloud so (what its scheduler places by).
  expect(await refusalOf(client.call("workspace.create", { request_id: "w-full", repo: { url: "https://github.com/acme/widgets" }, title: "Another", engine: "claude-agent", options: { model: MODEL } }))).toMatch(
    /^invalid_state\/builders: Cloud is busy\. Trying again\.$/,
  );
  await until(() => cloud.state.heartbeats.some((beat) => beat.capacity?.chats === 3 && beat.capacity.used === 3), 15_000);

  // The third builder goes to a Cloud computer of its own: the lead registers its chat, Cloud spawns.
  const three = await delegate(leadComputer.builders, lead, "k3", "Part three");
  expect(three).toMatchObject({ where: "cloud", computerId: builderComputer.identity.computerId, title: "Part three" });
  const leadCloud = [...cloud.state.tree.workspaces.values()].find((w) => w.parent === null)!;
  expect(leadCloud).toMatchObject({ computer: leadComputer.identity.computerId, repo: "acme/widgets", branch: lead.branch, session_id: lead.session_id });
  expect(cloud.state.tree.spawns).toHaveLength(1);
  expect(cloud.state.tree.spawns[0]!.body).toMatchObject({ request_id: "builder:k3", from_workspace_id: leadCloud.id, title: "Part three", brief: "slow 0: Part three", engine: "claude-agent", model: MODEL, lead_session_id: lead.session_id });
  expect(cloud.state.tree.mail.find((m) => m.verb === "spawn")?.payload).toMatchObject({ model: MODEL, lead_session_id: lead.session_id });
  expect(String(cloud.state.tree.spawns[0]!.body.branch)).toMatch(/^caveman\/part-three-[0-9a-f]{6}$/);
  // The lead's branch went to GitHub through the proxy, so the builder's computer starts from it.
  expect(gitIn(path.join(cloud.state.gitBackend, "acme", "widgets.git"))("rev-parse", `refs/heads/${lead.branch}`)).toBe(planned);
  // (The lead's own number holds builders at work, not ones that finished: builderLimits.integration.test.ts.)

  // The builder's computer takes the spawn: a workspace with Cloud's session and branch, from the lead's commit.
  const spawned = [...cloud.state.tree.workspaces.values()].find((w) => w.parent === leadCloud.id)!;
  let hosted: Workspace | undefined;
  await until(async () => {
    hosted = (await builderComputer.client.call("workspace.list", {})).workspaces.find((w) => w.session_id === spawned.session_id);
    return hosted !== undefined && hosted.status !== "starting";
  }, 30_000);
  expect(hosted).toMatchObject({ title: "Part three", branch: spawned.branch, base_ref: lead.branch, engine: "claude-agent" });
  expect(gitIn(builderCheckout)("rev-parse", "HEAD")).toBe(planned);
  // It runs the lead's model, which only the spawn named on that computer.
  const leadThread = await Effect.runPromise(orchestratorOf(leadComputer.runtime).getThreadShell(ThreadId.make(`caveman:${lead.id}`)));
  const builderThread = await Effect.runPromise(orchestratorOf(builderComputer.runtime).getThreadShell(ThreadId.make(`caveman:${hosted!.id}`)));
  expect(builderThread?.modelSelection.model).toBe(leadThread?.modelSelection.model);
  expect(builderThread?.modelSelection.model).toBe(MODEL);
  await until(() => cloud.state.tree.mail.find((m) => m.verb === "spawn")?.delivered === true, 10_000);

  // Its turn ends: the result goes back by mail and wakes the lead with it inline.
  const leadEvents: Array<SessionEvent> = [];
  await client.attach(lead.session_id, 0, (event) => leadEvents.push(event));
  await until(() => cloud.state.tree.mail.some((m) => m.verb === "task" && m.from_workspace_id === spawned.id), 60_000);
  const result = cloud.state.tree.mail.find((m) => m.verb === "task" && m.from_workspace_id === spawned.id)!;
  expect(result).toMatchObject({ to_workspace_id: leadCloud.id, reply_to: cloud.state.tree.mail.find((m) => m.verb === "spawn")!.id, channel: "tree", wakes: true });
  // The builder's last answer (the stand-in CLI says its prompt back: the computer's boot note, then the brief).
  expect(result.body).toMatch(/^\[completed\] smoke ok: /);
  expect(result.body).toContain("Part three");
  await until(() => userTexts(leadEvents).some((text) => text.includes('Builder "Part three" finished its turn')), 60_000);
  const woke = userTexts(leadEvents).find((text) => text.includes('Builder "Part three"'))!;
  expect(woke).toContain("on its own Cloud computer");
  // Its branch went to GitHub before its lead heard, and the result names it for the lead's runtime alone (BRANCH_TRAILER):
  // the lead's agent reads the builder's words without it.
  const [said, pushed] = result.body.replace(/^\[completed\] /, "").split(BRANCH_TRAILER);
  // With it, the tokens its turns have used so far, which the lead's tree counts toward Settings > Agents' ceiling.
  expect(JSON.parse(pushed!)).toEqual({ branch: spawned.branch, sha: gitIn(path.join(cloud.state.gitBackend, "acme", "widgets.git"))("rev-parse", `refs/heads/${spawned.branch}`), tokens: expect.any(Number) });
  expect(woke).toContain(said);
  expect(woke).not.toContain("[caveman-branch]");
  // Its row is marked ended once the result is taken (just after the wake), not before it: wait for that write.
  await until(async () => (await Effect.runPromise(leadComputer.builders.status(three!.workspaceId)))?.state === "completed", 10_000);
  expect(await Effect.runPromise(leadComputer.builders.status(three!.workspaceId))).toMatchObject({ where: "cloud", state: "completed" });
  // The local builders' results woke the lead too, once each.
  await until(() => ["Part one", "Part two"].every((t) => userTexts(leadEvents).filter((text) => text.includes(`Builder "${t}" finished its turn`)).length === 1), 60_000);

  // After its builders' results woke it, the lead's engine may still act through its MCP in its next turn: the
  // check delegate_task's caller passes (a live run on the instance its MCP credential names) holds, and only
  // between turns does it not (by design: a provider token acts only while its thread runs).
  const leadThreadId = ThreadId.make(`caveman:${lead.id}`);
  const leadOrchestrator = orchestratorOf(leadComputer.runtime);
  await until(async () => (await Effect.runPromise(leadOrchestrator.getThreadShell(leadThreadId)))?.activeRunId === null, 60_000);
  expect(isLiveCallerShell(await Effect.runPromise(leadOrchestrator.getThreadShell(leadThreadId)), instance)).toBe(false);
  const turnsBefore = leadEvents.filter((e) => e.type === "turn.started").length;
  await client.call("turn.submit", { request_id: "after-results", session_id: lead.session_id, kind: "followup", input: { text: "slow 4000: next part" } });
  await until(() => leadEvents.filter((e) => e.type === "turn.started").length > turnsBefore, 30_000);
  const live = await Effect.runPromise(leadOrchestrator.getThreadShell(leadThreadId));
  expect(live?.providerInstanceId).toBe(instance);
  expect(isLiveCallerShell(live, instance)).toBe(true);

  // Nothing to read: each computer holds Cloud's long wait for its tree mail instead of asking every few seconds.
  expect(cloud.state.tree.computerWaits).toBeGreaterThan(0);
  const takes = cloud.state.tree.takes;
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  expect(cloud.state.tree.takes - takes).toBeLessThanOrEqual(2);

  // A builder beside the lead never takes the computer's desktop.
  expect(await Effect.runPromise(leadComputer.builders.sharesComputer(`caveman:${one!.workspaceId}`))).toBe(true);
  expect(await Effect.runPromise(leadComputer.builders.sharesComputer(`caveman:${lead.id}`))).toBe(false);
  expect(await Effect.runPromise(builderComputer.builders.sharesComputer(`caveman:${hosted!.id}`))).toBe(false);

  // Only the lead is registered to move (M-4): its builders sync with their summaries and never move.
  const synced = (sessionId: string) => cloud.state.chats.sessions.get(sessionId);
  await until(() => synced(lead.session_id)?.movable_flag === true && made.every((w) => synced(w.session_id) !== undefined), 30_000);
  expect(made.map((w) => synced(w.session_id)!.movable_flag === true)).toEqual([false, false]);

  // Nothing the app sent was a body Cloud's strict decoder refuses.
  expect(cloud.state.tree.refused).toEqual([]);
  expect(cloud.state.chats.refused).toEqual([]);

  // A builder archived frees its slot and its worktree: the person's chat opens as a worktree now.
  await client.call("workspace.archive", { request_id: "a1", workspace_id: one!.workspaceId });
  expect(git("worktree", "list", "--porcelain").split("\n\n")).toHaveLength(2);
  const beside = await createReady(client, { request_id: "w-beside", repo: { url: "https://github.com/acme/widgets" }, title: "Beside", engine: "claude-agent", options: { model: MODEL } });
  expect(beside.parent_workspace_id).toBeUndefined();
  expect(git("worktree", "list")).toContain(beside.branch);
  expect(git("symbolic-ref", "--short", "HEAD")).toBe(lead.branch);
}, 240_000);

test("a lead on This Mac delegates to Cloud: its builder spawns on a fresh Cloud computer and its result wakes the lead once", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const config = await makeConfig();
  const runtime = await startRuntime(config, "fake-claude");
  cleanups.push(runtime.close);
  const client = connect(runtime.url, runtime.token);
  cleanups.push(() => client.close());
  const enrolled = await client.call("cloud.enroll", { request_id: "e1", cloud_url: cloud.url, token: cloud.state.personToken, name: "Test Mac" });
  expect(enrolled).toMatchObject({ cloud_url: cloud.url });
  cloud.state.tree.laptops.add([...cloud.state.runtimes.values()][0]!.computerId);
  // A Cloud from before the computer-wide wait: This Mac holds the long wait on its lead instead.
  cloud.state.tree.oldCloud = true;
  const builders = Context.get(runtime.context as unknown as Context.Context<Builders>, Builders);

  const repo = makeRepo(tempRoot("builders-mac-"), { "README.md": "widgets\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: repo });
  const lead = await createReady(client, { request_id: "lead", repo: { path: repo }, title: "Lead here", engine: "claude-agent", options: { model: MODEL } });

 // Without asking for Cloud a lead on This Mac keeps upstream own children.
  expect(await delegate(builders, lead, "local", "Stays here")).toBeUndefined();
  expect(cloud.state.tree.spawns).toHaveLength(0);

  const started = await delegate(builders, lead, "k1", "On Cloud", { where: "cloud" });
  expect(started).toMatchObject({ where: "cloud", title: "On Cloud" });
  expect(cloud.state.tree.spawns).toHaveLength(1);
  expect(cloud.state.tree.spawns[0]).toMatchObject({ made: true, body: { where: "cloud", request_id: "builder:k1", brief: "slow 0: On Cloud", model: MODEL, lead_session_id: lead.session_id } });
  const leadCloud = [...cloud.state.tree.workspaces.values()].find((w) => w.parent === null)!;
  expect(leadCloud).toMatchObject({ repo: "acme/widgets", session_id: lead.session_id });
  // This Mac never pushes the person's branch by itself.
  expect(cloud.state.gitRequests).toHaveLength(0);
  // A retry asks Cloud again with the same request id: Cloud's replay, no second builder.
  expect((await delegate(builders, lead, "k1", "On Cloud", { where: "cloud" }))?.workspaceId).toBe(started?.workspaceId);
  expect([...cloud.state.tree.workspaces.values()].filter((w) => w.parent === leadCloud.id)).toHaveLength(1);

  // The tree spans computers now, so its mail and claims go through Cloud: the Session Protocol's mail.* and the
  // lead agent's thread_send to the builder's thread.
  const told = await client.call("mail.task", { request_id: "m1", session_id: lead.session_id, to_workspace_id: started!.workspaceId, body: "Also add tests." });
  expect(told).toMatchObject({ verb: "task", from_workspace_id: lead.id, to_workspace_id: started!.workspaceId, wakes: true });
  expect(cloud.state.tree.mail.find((m) => m.request_id === "m1")).toMatchObject({ from_workspace_id: leadCloud.id, to_workspace_id: started!.workspaceId, channel: "tree", body: "Also add tests." });
  const asked = await Effect.runPromise(builders.message({ fromThreadId: `caveman:${lead.id}`, toThreadId: `cloud:${started!.workspaceId}`, text: "Where are you?", requestKey: "q1", ask: true }));
  expect(cloud.state.tree.mail.find((m) => m.id === asked?.id)).toMatchObject({ verb: "ask", to_workspace_id: started!.workspaceId, body: "Where are you?" });
  await expect(Effect.runPromise(builders.message({ fromThreadId: `caveman:${lead.id}`, toThreadId: "cloud:someone-else", text: "hi", requestKey: "q2", ask: false }))).rejects.toMatchObject({ reason: "invalid_request" });
  // The builder holds src/: the lead's claim inside it conflicts, one beside it is the lead's.
  cloud.state.tree.claims.push({ tree: leadCloud.id, path: "src", workspace_id: started!.workspaceId });
  const claimed = await client.call("mail.claim", { request_id: "c1", session_id: lead.session_id, paths: ["src/a.ts", "docs"] });
  expect(claimed.claims).toEqual([{ path: "docs", workspace_id: lead.id }]);
  expect(claimed.conflicts).toEqual([{ path: "src", workspace_id: started!.workspaceId }]);
  expect((await client.call("mail.release", { request_id: "r1", session_id: lead.session_id, paths: ["docs"] })).released).toEqual(["docs"]);

  // The builder's computer answers by mail (as builders.ts's report does there); This Mac's long wait hears it.
  const events: Array<SessionEvent> = [];
  await client.attach(lead.session_id, 0, (event) => events.push(event));
  const spawnMail = cloud.state.tree.mail.find((m) => m.verb === "spawn")!;
  cloud.state.tree.post({ from: started!.workspaceId, to: leadCloud.id, verb: "task", body: "[completed] The part is done on branch caveman/on-cloud.", reply_to: spawnMail.id, request_id: "result:1" });
  await until(() => userTexts(events).some((text) => text.includes('Builder "On Cloud" finished its turn')), 30_000);
  expect(userTexts(events).find((text) => text.includes("On Cloud"))).toContain("The part is done on branch caveman/on-cloud.");
  await until(() => cloud.state.tree.mail.filter((m) => m.to_workspace_id === leadCloud.id).every((m) => m.delivered), 10_000);
  expect(await Effect.runPromise(builders.status(started!.workspaceId))).toMatchObject({ state: "completed", summary: "The part is done on branch caveman/on-cloud." });
  // The lead's mailbox has it too (mail.wait reads it), from the builder's Cloud workspace.
  const waited = await client.call("mail.wait", { session_id: lead.session_id, timeout_ms: 1_000 });
  expect(waited.messages.find((m) => m.body.includes("The part is done"))).toMatchObject({ from_workspace_id: started!.workspaceId, to_workspace_id: lead.id, wakes: true });
  expect(cloud.state.tree.refused).toEqual([]);
  // Delivered once: a second take finds nothing, and the lead was woken once.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect(userTexts(events).filter((text) => text.includes('Builder "On Cloud"'))).toHaveLength(1);
}, 120_000);

// Skipped on Windows: the builder's computer is a Cloud computer, which is Linux, with its tools channel on a Unix socket.
test.skipIf(process.platform === "win32")("a lead on This Mac sends a builder to a Cloud computer of the person's it names, on another harness and model: it runs there on them and its result wakes the lead once", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  // This Mac first, before the tools channel a Cloud computer has: its CLI runs here.
  const config = await makeConfig();
  const runtime = await startRuntime(config, "fake-claude");
  cleanups.push(runtime.close);
  const client = connect(runtime.url, runtime.token);
  cleanups.push(() => client.close());
  await client.call("cloud.enroll", { request_id: "e1", cloud_url: cloud.url, token: cloud.state.personToken, name: "Test Mac" });
  const mac = [...cloud.state.runtimes.values()][0]!.computerId;
  cloud.state.tree.laptops.add(mac);
  const builders = Context.get(runtime.context as unknown as Context.Context<Builders>, Builders);

  // The lead's repository on GitHub, as the git proxy serves it to the Cloud computer.
  const repo = makeRepo(tempRoot("named-mac-"), { "README.md": "widgets\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: repo });
  cloud.state.gitBackend = githubWith(repo);
  const lead = await createReady(client, { request_id: "lead", repo: { path: repo }, title: "Lead here", engine: "claude-agent", options: { model: MODEL } });

  // The person's Cloud computer "Box", awake, serving Codex with a model of its own (the stand-in CLI behind it).
  const TARGET = "gpt-5.5-box";
  await startTools();
  const providers = Layer.succeed(ProviderRegistry.ProviderRegistry, {
    getProviders: Effect.succeed([
      { instanceId: "claudeAgent", installed: true, auth: { status: "authenticated" }, models: [{ slug: MODEL, name: MODEL, isDefault: true }] },
      { instanceId: "codex", installed: true, auth: { status: "authenticated" }, models: [{ slug: TARGET, name: TARGET, isDefault: true }] },
    ]),
  } as unknown as ProviderRegistry.ProviderRegistry["Service"]);
  const box = await computerRuntime(cloud, checkoutOf(cloud.state.gitBackend, "named-box-"), "box", { alsoAs: ["codex"], providers });
  cloud.state.chats.markCloud(box.identity.computerId, "Box");
  // Beside it: another of the person's laptops, and a colleague's Cloud computer.
  const otherMac = cloud.enrollRuntime({ kind: "laptop", name: "Other Mac" }).computerId;
  const theirs = cloud.enrollRuntime({ kind: "cloud", person: "user-2", name: "Theirs" }).computerId;
  // The person's computer Cloud made for another builder (it names those "builder"), and one asleep that nothing pays for.
  cloud.enrollRuntime({ kind: "cloud", name: "builder" });
  const sleepy = cloud.enrollRuntime({ kind: "cloud", name: "Sleepy" }).computerId;
  Object.assign(cloud.state.chats.computers.get(sleepy)!, { state: "suspended", sleep_reason: "usage" });

  // What orchestrator_capabilities lists for the lead: the person's Cloud computers, never a laptop, someone else's or
  // another builder's; the one nothing pays for listed as taking no builder, and why.
  cloud.state.environments.computers = true;
  const listed = await Effect.runPromise(builders.computers(`caveman:${lead.id}`));
  expect(listed).toEqual({
    computers: [
      { id: box.identity.computerId, name: "Box", kind: "cloud", os: "linux", state: "awake", driverKinds: ["caveman", "claudeAgent", "codex"], canRunBuilder: true },
      { id: sleepy, name: "Sleepy", kind: "cloud", os: "linux", state: "asleep", driverKinds: ["caveman", "claudeAgent", "codex"], canRunBuilder: false },
    ],
    note: `Sleepy (${sleepy}) is asleep because nothing pays for the time, so no builder runs there until credits are added. Pick another computer.`,
  });
  expect(builders.thisComputer()).toBe(mac);

  // Cloud places a named computer as Cloud does: never a laptop, never someone else's; nothing starts.
  await expect(delegate(builders, lead, "laptop", "To a laptop", { computerId: otherMac, engine: "codex" })).rejects.toMatchObject({ reason: "invalid_request", message: NO_SUCH_COMPUTER });
  await expect(delegate(builders, lead, "theirs", "To theirs", { computerId: theirs, engine: "codex" })).rejects.toMatchObject({ reason: "invalid_request", message: expect.stringContaining("never on someone else's") });
  // Nor one it would never wake: refused here, before Cloud is asked.
  await expect(delegate(builders, lead, "sleepy", "To the sleepy one", { computerId: sleepy, engine: "codex" })).rejects.toMatchObject({
    reason: "invalid_request",
    message: "Cloud computer Sleepy is asleep because nothing pays for its time: add credits or pick another computer.",
  });
  expect(cloud.state.tree.spawns).toHaveLength(0);

  // Sent to Box on Codex and its model: the spawn names that computer, not where, and lands there.
  const started = await delegate(builders, lead, "n1", "On the box", { computerId: box.identity.computerId, engine: "codex", model: TARGET });
  expect(started).toMatchObject({ where: "cloud", computerId: box.identity.computerId, computerName: "Box", engine: "codex", model: TARGET, title: "On the box" });
  expect(cloud.state.tree.spawns).toHaveLength(1);
  expect(cloud.state.tree.spawns[0]).toMatchObject({ computer: box.identity.computerId, made: false, body: { request_id: "builder:n1", computer_id: box.identity.computerId, engine: "codex", model: TARGET, lead_session_id: lead.session_id } });
  expect(cloud.state.tree.spawns[0]!.body).not.toHaveProperty("where");

  // Box's runtime takes the spawn: a chat on Codex running the model asked for.
  const spawned = [...cloud.state.tree.workspaces.values()].find((w) => w.id === started!.workspaceId)!;
  let hosted: Workspace | undefined;
  await until(async () => {
    hosted = (await box.client.call("workspace.list", {})).workspaces.find((w) => w.session_id === spawned.session_id);
    return hosted !== undefined && hosted.status !== "starting";
  }, 30_000);
  expect(hosted).toMatchObject({ title: "On the box", engine: "codex", branch: spawned.branch });
  const builderThread = await Effect.runPromise(orchestratorOf(box.runtime).getThreadShell(ThreadId.make(`caveman:${hosted!.id}`)));
  expect(builderThread?.modelSelection).toMatchObject({ instanceId: "codex", model: TARGET });
  const boxEvents: Array<SessionEvent> = [];
  await box.client.attach(hosted!.session_id, 0, (event) => boxEvents.push(event));
  await until(() => boxEvents.some((e) => e.type === "turn.started"), 30_000);
  expect(boxEvents.find((e) => e.type === "turn.started")?.payload).toMatchObject({ engine: "codex", model: TARGET });

  // Its turn ends: the result comes back by mail and wakes the lead on This Mac, once.
  const leadEvents: Array<SessionEvent> = [];
  await client.attach(lead.session_id, 0, (event) => leadEvents.push(event));
  await until(() => userTexts(leadEvents).some((text) => text.includes('Builder "On the box" finished its turn')), 60_000);
  const result = cloud.state.tree.mail.find((m) => m.verb === "task" && m.from_workspace_id === spawned.id)!;
  expect(result.body).toMatch(/^\[completed\] smoke ok: /);
  expect(userTexts(leadEvents).find((text) => text.includes('Builder "On the box"'))).toContain(result.body.replace(/^\[completed\] /, "").split(BRANCH_TRAILER)[0]);
  expect(await Effect.runPromise(builders.status(started!.workspaceId))).toMatchObject({ state: "completed", where: "cloud", computerId: box.identity.computerId, engine: "codex", model: TARGET });
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect(userTexts(leadEvents).filter((text) => text.includes('Builder "On the box"'))).toHaveLength(1);
  expect(cloud.state.tree.refused).toEqual([]);
}, 180_000);

// Skipped on Windows: both computers are Cloud computers, which are Linux, with tools channels on Unix sockets.
test.skipIf(process.platform === "win32")("a chat moved onto a Cloud computer that runs one lands in a worktree beside it with its work, and the computer it left starts its next chat at the checkout (CHAOS-1, CHAOS-10)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  await startTools();
  process.env.CAVEMAN_COMPUTER_CPUS = "4";
  process.env.CAVEMAN_COMPUTER_MEMORY_GIB = "8";
  cleanups.push(() => (delete process.env.CAVEMAN_COMPUTER_CPUS, delete process.env.CAVEMAN_COMPUTER_MEMORY_GIB));
  cloud.state.gitBackend = githubWith(makeRepo(tempRoot("placement-source-"), { "README.md": "widgets\n" }));
  cloud.state.chats.engineLogins.set("user-1", { "claude-agent": { vault_key: true, signed_in_on: [] } });
  const homeCheckout = checkoutOf(cloud.state.gitBackend, "placement-home-");
  const awayCheckout = checkoutOf(cloud.state.gitBackend, "placement-away-");
  const home = await computerRuntime(cloud, homeCheckout, "home");
  const away = await computerRuntime(cloud, awayCheckout, "away");
  const create = (on: typeof home, id: string, title: string) =>
    createReady(on.client, { request_id: id, repo: { url: "https://github.com/acme/widgets" }, title, engine: "claude-agent", options: { model: MODEL } });

  // The home computer runs a chat at its checkout.
  const stays = await create(home, "stays", "Stays home");
  expect(gitIn(homeCheckout)("symbolic-ref", "--short", "HEAD")).toBe(stays.branch);
  // On the other computer a chat works, and leaves an edit not committed.
  const mover = await create(away, "mover", "Moves over");
  const events: Array<SessionEvent> = [];
  await away.client.attach(mover.session_id, 0, (event) => events.push(event));
  await away.client.call("turn.submit", { request_id: "m1", session_id: mover.session_id, kind: "followup", input: { text: "slow 0: first part" } });
  await until(() => events.some((e) => e.type === "turn.done"), 30_000);
  fs.writeFileSync(path.join(awayCheckout, "wip.txt"), "half done\n");
  await until(() => cloud.state.chats.sessions.has(mover.session_id), 15_000);

  // Moved to the home computer: it lands in a worktree beside the chat there (before, the adopt was refused: the
  // computer "already holds" that chat), on its branch, with its edit.
  const moved = await away.client.call("session.move", { request_id: "move-1", session_id: mover.session_id, to: { computer_id: home.identity.computerId } });
  expect(moved).toMatchObject({ pending: false });
  let landed: Workspace | undefined;
  await until(async () => {
    landed = (await home.client.call("workspace.list", {})).workspaces.find((w) => w.session_id === mover.session_id);
    return landed !== undefined && landed.status !== "starting";
  }, 30_000);
  const worktrees = gitIn(homeCheckout)("worktree", "list", "--porcelain").split("\n\n").map((entry) => ({ path: /^worktree (.+)$/m.exec(entry)?.[1], branch: /^branch refs\/heads\/(.+)$/m.exec(entry)?.[1] }));
  expect(worktrees).toHaveLength(2);
  const beside = worktrees.find((entry) => entry.branch === mover.branch);
  expect(fs.realpathSync(path.dirname(beside!.path!))).toBe(fs.realpathSync(path.join(home.config.worktreesDir, "chats")));
  expect(fs.readFileSync(path.join(beside!.path!, "wip.txt"), "utf8")).toBe("half done\n");
  // The chat there keeps its checkout, and the moved one runs its next turn.
  expect(gitIn(homeCheckout)("symbolic-ref", "--short", "HEAD")).toBe(stays.branch);
  const there: Array<SessionEvent> = [];
  await home.client.attach(mover.session_id, 0, (event) => there.push(event));
  await home.client.call("turn.submit", { request_id: "m2", session_id: mover.session_id, kind: "followup", input: { text: "slow 0: second part" } });
  await until(() => there.some((e) => e.type === "message.done" && e.payload.role === "assistant" && e.payload.text.includes("second part")), 60_000);

  // The computer it left starts its next chat at the checkout (before, it was refused: the moved chat still "held" it),
  // and what the moved chat left there is kept on a ref, not in the new chat.
  const next = await create(away, "next", "Next one");
  expect(gitIn(awayCheckout)("symbolic-ref", "--short", "HEAD")).toBe(next.branch);
  expect(fs.existsSync(path.join(awayCheckout, "wip.txt"))).toBe(false);
}, 180_000);

// Skipped on Windows: the chat runs on a Cloud computer, which is Linux, with its tools channel on a Unix socket.
test.skipIf(process.platform === "win32")("a follow-up queued behind a stopped turn rides every copy of the chat, so a move Cloud makes from the copy alone carries it (CHAOS-4)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  await startTools();
  cloud.state.gitBackend = githubWith(makeRepo(tempRoot("queued-source-"), { "README.md": "widgets\n" }));
  const checkout = checkoutOf(cloud.state.gitBackend, "queued-box-");
  const box = await computerRuntime(cloud, checkout, "box");
  const chat = await createReady(box.client, { request_id: "q", repo: { url: "https://github.com/acme/widgets" }, title: "Queues", engine: "claude-agent", options: { model: MODEL } });
  const events: Array<SessionEvent> = [];
  await box.client.attach(chat.session_id, 0, (event) => events.push(event));
  // Every wait is on what the chat and Cloud say, with deadlines that hold on a loaded CI runner: the long turn only
  // ends by its stop, so the follow-up is queued however slow the machine is.
  await box.client.call("turn.submit", { request_id: "q1", session_id: chat.session_id, kind: "followup", input: { text: "slow 60000: long one" } });
  await until(() => userTexts(events).includes("slow 60000: long one"), 60_000);
  expect(await box.client.call("turn.submit", { request_id: "q2", session_id: chat.session_id, kind: "followup", input: { text: "queued behind it" } })).toMatchObject({ disposition: "queued" });
  // The stop holds the queue: the follow-up waits, accepted, and the copy says so (before, only a move's last copy did).
  const stopped = await box.client.call("turn.interrupt", { request_id: "q-stop", session_id: chat.session_id });
  await until(() => events.some((e) => e.type === "turn.done" && e.turn_id === stopped.turn_id), 60_000);
  const lastQueued = () => cloud.state.chats.sessions.get(chat.session_id)?.segments.at(-1)?.body.queued;
  await until(() => JSON.stringify(lastQueued()) === JSON.stringify(["queued behind it"]), 60_000);
  // Sent on, the held follow-up runs after it, the queue empties, and so does the next copy's.
  await box.client.call("turn.submit", { request_id: "q3", session_id: chat.session_id, kind: "followup", input: { text: "slow 0: and on" } });
  const replied = (text: string) => events.some((e) => e.type === "message.done" && e.payload.role === "assistant" && e.payload.text.includes(text));
  await until(() => replied("and on") && replied("queued behind it"), 120_000);
  await until(() => lastQueued() === undefined, 60_000);
}, 420_000);
