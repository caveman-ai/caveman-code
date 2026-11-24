// automation.apply, automation.cloud_runs, agent.publish and agent.published against a stand-in for Caveman
// Cloud's runtime twins: what is sent, what is refused before anything leaves, and how Cloud's answers read.
import { afterEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";

import { BUILTIN_AGENT_TYPES } from "../agents/agentTypes.ts";
import { testRepo, type TestRepo } from "../automations/testing.ts";
import { makeAutomationCloudHandlers, makeDeployer } from "./automationCloud.ts";
import { ProtocolError } from "./handlers.ts";

const repos: TestRepo[] = [];
afterEach(() => repos.splice(0).forEach((r) => r.remove()));

const CLOUD_FILE = `host: cloud
description: Answer Slack mentions
on:
  slack: { mention: true }
budget: $1
steps:
  answer:
    agent: answerer
    model: base
outputs:
  slack.message: answer.summary
`;
const AGENT = "---\ndescription: Answers questions\n---\nAnswer it.\n";
const MAC_FILE = "on: { schedule: { every: 6h } }\nsteps:\n  digest:\n    prompt: Sum up.\n    model: fast\n    computer: none\n";

/** A Cloud that records each call and answers from `answer`. */
function fakeCloud(answer: (method: string, path: string, body: unknown) => unknown) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const cloud = <A>(method: "GET" | "POST", path: string, body?: unknown) =>
    Effect.suspend(() => {
      calls.push({ method, path, body });
      const out = answer(method, path, body);
      return out instanceof ProtocolError ? Effect.fail(out) : Effect.succeed(out as A);
    });
  return { calls, cloud };
}

const handlers = (cloud: ReturnType<typeof fakeCloud>, roots: Record<string, string> = {}) =>
  makeAutomationCloudHandlers({
    cloud: cloud.cloud,
    projectRoot: (id) => Effect.succeed(roots[id]),
    registry: Effect.succeed(BUILTIN_AGENT_TYPES.map((t) => ({ ...t, ignoredKeys: [] }))),
  });
const run = <A>(effect: Effect.Effect<A, ProtocolError>) => Effect.runPromise(effect);
const refused = (effect: Effect.Effect<unknown, ProtocolError>) => Effect.runPromise(Effect.flip(effect));

describe("automation.apply", () => {
  it("sends the cloud automations and the agents they name, keeps This Mac's here, and reads the authority diff", async () => {
    const r = testRepo({
      ".caveman/automations/slack-answers.yaml": CLOUD_FILE,
      ".caveman/automations/digest.yaml": MAC_FILE,
      ".caveman/agents/answerer.md": AGENT,
      ".caveman/agents/unused.md": "---\ndescription: Not named\n---\nNo.\n",
    });
    repos.push(r);
    r.git("remote", "add", "origin", "git@github.com:acme/api.git");
    const cloud = fakeCloud(() => ({
      automations: [
        {
          id: "aut_1",
          name: "slack-answers",
          revision_id: "rev_1",
          state: "pending_approval",
          authority_diff: {
            widens: true,
            changes: [
              { key: "on.slack", change: "added", before: null, after: { mention: true }, widens: true },
              { key: "budget", change: "changed", before: "$0.50", after: "$1", widens: true },
            ],
          },
          extra: "ignored",
        },
      ],
    }));
    const out = await run(handlers(cloud)["automation.apply"]({ request_id: "a1", repo_root: r.root }));
    expect(cloud.calls).toHaveLength(1);
    expect(cloud.calls[0]).toMatchObject({ method: "POST", path: "automations/apply" });
    const body = cloud.calls[0]!.body as { repo: string; commit_sha: string; files: Record<string, string> };
    expect(body.repo).toBe("acme/api");
    expect(body.commit_sha).toBe(r.git("rev-parse", "HEAD").trim());
    expect(Object.keys(body.files).sort()).toEqual([".caveman/agents/answerer.md", ".caveman/automations/slack-answers.yaml"]);
    expect(out.skipped).toEqual([{ path: ".caveman/automations/digest.yaml", reason: "runs on This Mac (add host: cloud to run it on Cloud)" }]);
    expect(out.automations).toEqual([
      {
        id: "aut_1",
        name: "slack-answers",
        revision_id: "rev_1",
        state: "pending_approval",
        authority_diff: {
          widens: true,
          changes: [
            { key: "on.slack", change: "added", before: null, after: '{"mention":true}', widens: true },
            { key: "budget", change: "changed", before: "$0.50", after: "$1", widens: true },
          ],
        },
      },
    ]);
    expect(out.text).toBe(
      [
        "acme/api",
        "slack-answers  waiting for the owner's approval, because it widens what it may do (revision rev_1)",
        '  on.slack  added {"mention":true}  (widens)',
        "  budget    $1, was $0.50  (widens)",
        "",
        "The owner approves a widening revision on the Automations page in Caveman Platform; until then the active one keeps running.",
        "",
        "Stayed here:",
        "  .caveman/automations/digest.yaml  runs on This Mac (add host: cloud to run it on Cloud)",
      ].join("\n"),
    );
  });

  it("passes a new webhook's one-time path and secret to the client, and keeps the secret out of the printed text", async () => {
    const r = testRepo({ ".caveman/automations/slack-answers.yaml": CLOUD_FILE, ".caveman/agents/answerer.md": AGENT });
    repos.push(r);
    r.git("remote", "add", "origin", "git@github.com:acme/api.git");
    const hook = { id: "hk_01jabcdefghijklmnopqrstuvw", path: "/api/v1/code/hooks/hk_01jabcdefghijklmnopqrstuvw", secret: "one-time-secret" };
    const cloud = fakeCloud(() => ({
      automations: [
        { id: "aut_1", name: "slack-answers", revision_id: "rev_1", state: "active", authority_diff: { widens: false, changes: [] }, hook },
        { id: "aut_2", name: "other", revision_id: "rev_2", state: "active", authority_diff: { widens: false, changes: [] }, hook: { id: "hk_2", path: "/x" } },
      ],
    }));
    const out = await run(handlers(cloud)["automation.apply"]({ request_id: "a2", repo_root: r.root }));
    expect(out.automations[0]?.hook).toEqual(hook);
    // A hook without its secret is no use to a sender, so none is passed.
    expect(out.automations[1]).not.toHaveProperty("hook");
    expect(out.text).not.toContain(hook.secret);
  });

  it("refuses files with errors, and a repository with nothing for Cloud, before anything is sent", async () => {
    const broken = testRepo({ ".caveman/automations/x.yaml": CLOUD_FILE.replace("agent: answerer", "agent: answrer"), ".caveman/agents/answerer.md": AGENT });
    repos.push(broken);
    broken.git("remote", "add", "origin", "https://github.com/acme/api");
    const cloud = fakeCloud(() => ({ automations: [] }));
    const error = await refused(handlers(cloud)["automation.apply"]({ request_id: "a2", repo_root: broken.root }));
    expect(error).toMatchObject({ reason: "invalid_params", message: expect.stringContaining('.caveman/automations/x.yaml:8:12  No agent "answrer". Did you mean "answerer"?') });
    const mac = testRepo({ ".caveman/automations/digest.yaml": MAC_FILE });
    repos.push(mac);
    mac.git("remote", "add", "origin", "https://github.com/acme/api.git");
    expect(await refused(handlers(cloud)["automation.apply"]({ request_id: "a3", repo_root: mac.root }))).toMatchObject({ reason: "not_found" });
    expect(cloud.calls).toEqual([]);
  });

  it("finds a project's checkout, and says so when there is none", async () => {
    const r = testRepo({ ".caveman/automations/slack-answers.yaml": CLOUD_FILE, ".caveman/agents/answerer.md": AGENT });
    repos.push(r);
    r.git("remote", "add", "origin", "https://github.com/acme/api.git");
    const cloud = fakeCloud(() => ({ automations: [{ id: "aut_1", name: "slack-answers", revision_id: "rev_2", state: "active", authority_diff: { widens: false, changes: [] } }] }));
    const out = await run(handlers(cloud, { p1: r.root })["automation.apply"]({ request_id: "a4", project_id: "p1" }));
    expect(out.text).toContain("slack-answers  active: it fires from now on (revision rev_2)\n  no change to what it may do");
    expect(await refused(handlers(cloud)["automation.apply"]({ request_id: "a5", project_id: "nope" }))).toMatchObject({ reason: "not_found" });
  });
});

describe("automation.cloud_runs", () => {
  it("asks for one automation's runs and reads them tolerantly", async () => {
    const cloud = fakeCloud(() => ({
      runs: [
        { id: "run_1", automation_id: "aut_1", revision_id: "rev_1", trigger: "slack.app_mention", status: "succeeded", outcome: "replied", session_id: "ses_1", cost_usd: "0.12", started_at: "2026-10-21T01:00:00Z", finished_at: "2026-10-21T01:02:00Z" },
        { id: "run_2", automation_id: "aut_1", status: "running" },
        { automation_id: "no id" },
      ],
    }));
    const out = await run(handlers(cloud)["automation.cloud_runs"]({ automation_id: "aut_1", limit: 10 }));
    expect(cloud.calls[0]).toMatchObject({ method: "GET", path: "automations/runs?automation_id=aut_1&limit=10" });
    expect(out.runs).toEqual([
      { id: "run_1", automation_id: "aut_1", revision_id: "rev_1", trigger: "slack.app_mention", status: "succeeded", outcome: "replied", session_id: "ses_1", cost_usd: 0.12, started_at: "2026-10-21T01:00:00Z", finished_at: "2026-10-21T01:02:00Z" },
      { id: "run_2", automation_id: "aut_1", revision_id: null, trigger: "manual", status: "running", outcome: null, session_id: null, cost_usd: 0, started_at: null, finished_at: null },
    ]);
  });
});

describe("automation.cloud_list and automation.cloud_answer", () => {
  it("lists what Cloud holds, with a pending revision's diff, and passes a run's ask and file name through", async () => {
    const cloud = fakeCloud((method, path) => {
      if (path === "automations") {
        return [{ id: "aut_1", name: "issue-to-pr", repo: "acme/api", path: ".caveman/automations/issue-to-pr.yaml", enabled: true, state: "pending_approval", active_revision_id: "rev_1", authority_diff: [{ key: "on.slack", before: null, after: "mention", widens: true }] }];
      }
      return {
        runs: [
          {
            run_id: "run_9",
            automation_id: "aut_1",
            automation: "issue-to-pr",
            repo: "acme/api",
            status: "waiting",
            session_id: "ses_9",
            cost_usd: 0.3,
            requires_action: { ask_id: "automation:run_9:deploy", kind: "approval", step: "deploy", by: "owner" },
          },
        ],
      };
    });
    const h = handlers(cloud);
    expect(await run(h["automation.cloud_list"]())).toEqual({
      automations: [
        {
          id: "aut_1",
          name: "issue-to-pr",
          repo: "acme/api",
          path: ".caveman/automations/issue-to-pr.yaml",
          enabled: true,
          state: "pending_approval",
          revision_id: "rev_1",
          authority_diff: { widens: true, changes: [{ key: "on.slack", change: "added", before: null, after: "mention", widens: true }] },
        },
      ],
    });
    const [waiting] = (await run(h["automation.cloud_runs"]({}))).runs;
    expect(waiting).toMatchObject({ id: "run_9", name: "issue-to-pr", repo: "acme/api", requires_action: { ask_id: "automation:run_9:deploy", kind: "approval", step: "deploy", by: "owner" } });

    // Answering finds the run's session when the client does not name it, and posts the person's approval to it.
    expect(await run(h["automation.cloud_answer"]({ request_id: "q1", run_id: "run_9", ask_id: "automation:run_9:deploy", decision: "allow", message: "ship it" }))).toEqual({});
    expect(cloud.calls.at(-1)).toEqual({
      method: "POST",
      path: "sessions/ses_9/user-events",
      body: { request_id: "q1", type: "user.approval", ask_id: "automation:run_9:deploy", decision: "allow", message: "ship it" },
    });
    expect(await refused(h["automation.cloud_answer"]({ request_id: "q2", run_id: "run_404", ask_id: "a", decision: "deny" }))).toMatchObject({ reason: "not_found" });
  });
});

describe("agent.publish and agent.published", () => {
  it("creates an agent the first time, adds a version after, and refuses a broken file or a file that is no agent", async () => {
    const r = testRepo({ ".caveman/agents/answerer.md": AGENT, "notes.md": "secret plans" });
    repos.push(r);
    const store: Array<{ id: string; name: string; latest_version: number; file: string }> = [];
    const cloud = fakeCloud((method, path, body) => {
      const b = body as { name?: string; file: string } | undefined;
      if (method === "GET" && path === "agents") return { agents: store.map(({ file: _f, ...a }) => ({ ...a, summary: { description: "Answers questions" } })) };
      if (method === "POST" && path === "agents") {
        store.push({ id: "agt_1", name: b!.name!, latest_version: 1, file: b!.file });
        return { id: "agt_1", name: b!.name, latest_version: 1 };
      }
      const existing = store.find((a) => path === `agents/${a.id}`)!;
      if (existing.file !== b!.file) existing.latest_version += 1;
      existing.file = b!.file;
      return { agent: { id: existing.id, name: existing.name, latest_version: existing.latest_version } };
    });
    const h = handlers(cloud, { p1: r.root });
    expect(await run(h["agent.publish"]({ request_id: "p1", project_id: "p1", path: ".caveman/agents/answerer.md" }))).toEqual({ agent_id: "agt_1", name: "answerer", version: 1, unchanged: false });
    expect(await run(h["agent.publish"]({ request_id: "p2", path: `${r.root}/.caveman/agents/answerer.md` }))).toEqual({ agent_id: "agt_1", name: "answerer", version: 1, unchanged: true });
    r.write(".caveman/agents/answerer.md", AGENT.replace("Answer it.", "Answer it, briefly."));
    expect(await run(h["agent.publish"]({ request_id: "p3", project_id: "p1", path: ".caveman/agents/answerer.md" }))).toMatchObject({ version: 2, unchanged: false });
    expect(await run(h["agent.published"]())).toEqual({ agents: [{ id: "agt_1", name: "answerer", latest_version: 2, description: "Answers questions", archived: false }] });

    r.write(".caveman/agents/broken.md", "---\nengine: claude-code\n---\nHi.\n");
    expect(await refused(h["agent.publish"]({ request_id: "p4", project_id: "p1", path: ".caveman/agents/broken.md" }))).toMatchObject({
      reason: "invalid_params",
      message: expect.stringContaining('engine "claude-code" is not an engine'),
    });
    expect(await refused(h["agent.publish"]({ request_id: "p5", project_id: "p1", path: "notes.md" }))).toMatchObject({ reason: "invalid_params" });
    expect(cloud.calls.filter((c) => c.method === "POST")).toHaveLength(3);
  });
});

describe("deploy on merge", () => {
  const registry = Effect.succeed(BUILTIN_AGENT_TYPES.map((t) => ({ ...t, ignoredKeys: [] })));
  it("sends the default branch's Cloud automations once per change, never an unmerged edit", async () => {
    const r = testRepo({ ".caveman/automations/slack-answers.yaml": CLOUD_FILE, ".caveman/agents/answerer.md": AGENT });
    repos.push(r);
    r.git("remote", "add", "origin", "git@github.com:acme/api.git");
    const cloud = fakeCloud(() => ({ automations: [{ id: "aut_1", name: "slack-answers", revision_id: "rev_1", state: "active" }] }));
    const deploy = makeDeployer({ cloud: cloud.cloud, registry });
    await Effect.runPromise(deploy(r.root));
    expect(cloud.calls).toHaveLength(1);
    const body = cloud.calls[0]!.body as { repo: string; commit_sha: string; files: Record<string, string> };
    expect(body).toMatchObject({ repo: "acme/api", commit_sha: r.git("rev-parse", "main").trim() });
    expect(Object.keys(body.files).sort()).toEqual([".caveman/agents/answerer.md", ".caveman/automations/slack-answers.yaml"]);

    // Nothing new on the branch (an unrelated commit, an uncommitted edit): nothing is sent again.
    r.write("README.md", "# changed\n");
    r.commit("readme");
    r.write(".caveman/automations/slack-answers.yaml", CLOUD_FILE.replace("$1", "$2"));
    await Effect.runPromise(deploy(r.root));
    expect(cloud.calls).toHaveLength(1);

    // The edit merges: it goes.
    r.commit("raise budget");
    await Effect.runPromise(deploy(r.root));
    expect(cloud.calls).toHaveLength(2);
    expect((cloud.calls[1]!.body as { files: Record<string, string> }).files[".caveman/automations/slack-answers.yaml"]).toContain("$2");
  });

  it("survives a restart without resending, retires the last automation, and waits after a refusal", async () => {
    const r = testRepo({ ".caveman/automations/slack-answers.yaml": CLOUD_FILE, ".caveman/agents/answerer.md": AGENT });
    repos.push(r);
    r.git("remote", "add", "origin", "git@github.com:acme/api.git");
    const stateFile = `${r.root}/.git/deploys.json`;
    let refuse = false;
    const cloud = fakeCloud(() => (refuse ? new ProtocolError({ reason: "forbidden", message: "no" }) : { automations: [] }));
    await Effect.runPromise(makeDeployer({ cloud: cloud.cloud, registry, stateFile })(r.root));
    expect(cloud.calls).toHaveLength(1);
    // A new runtime with the same state: nothing new to send.
    await Effect.runPromise(makeDeployer({ cloud: cloud.cloud, registry, stateFile })(r.root));
    expect(cloud.calls).toHaveLength(1);

    // The last Cloud automation leaves the branch: an empty set retires it in Cloud.
    r.git("rm", "-q", ".caveman/automations/slack-answers.yaml");
    r.commit("drop it");
    const deploy = makeDeployer({ cloud: cloud.cloud, registry, stateFile });
    await Effect.runPromise(deploy(r.root));
    expect(cloud.calls).toHaveLength(2);
    expect((cloud.calls[1]!.body as { files: Record<string, string> }).files).toEqual({});
    await Effect.runPromise(deploy(r.root));
    expect(cloud.calls).toHaveLength(2);

    // Back again, but Cloud refuses: the same files are not tried again right away.
    r.write(".caveman/automations/slack-answers.yaml", CLOUD_FILE);
    r.commit("back");
    refuse = true;
    await Effect.runPromise(deploy(r.root));
    await Effect.runPromise(deploy(r.root));
    expect(cloud.calls).toHaveLength(3);
  });

  it("sends nothing for a repository without Cloud automations, or with errors in one", async () => {
    const mac = testRepo({ ".caveman/automations/digest.yaml": MAC_FILE });
    const broken = testRepo({ ".caveman/automations/slack-answers.yaml": CLOUD_FILE });
    repos.push(mac, broken);
    for (const r of [mac, broken]) r.git("remote", "add", "origin", "git@github.com:acme/api.git");
    const cloud = fakeCloud(() => ({ automations: [] }));
    const deploy = makeDeployer({ cloud: cloud.cloud, registry });
    await Effect.runPromise(deploy(mac.root));
    // The answerer agent is missing, so check fails and nothing leaves.
    await Effect.runPromise(deploy(broken.root));
    expect(cloud.calls).toHaveLength(0);
  });
});
