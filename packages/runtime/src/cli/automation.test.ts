// The real CLI (bin.ts's fast path) on a fixture repository: what a person sees in a terminal.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { testRepo, type TestRepo } from "../automations/testing.ts";
import { runReport } from "./automation.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));
const repos: TestRepo[] = [];
afterEach(() => repos.splice(0).forEach((r) => r.remove()));

/** `caveman-runtime <args>` in `cwd`, with a Caveman Code home where no runtime runs. */
function cli(cwd: string, ...args: string[]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-home-"));
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env: { ...process.env, CAVEMAN_CODE_HOME: home, NODE_NO_WARNINGS: "1" } });
  fs.rmSync(home, { recursive: true, force: true });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

describe("what --wait prints", () => {
  const attempt = (over: Record<string, unknown>) => ({
    n: 1,
    id: "r_1.build.1",
    status: "succeeded",
    reason: null,
    model: { asked: "base", resolved: "claude-sonnet-5-5" },
    started_at: "2026-10-20T09:00:00.000Z",
    ended_at: "2026-10-20T09:04:00.000Z",
    cost: { usd: 0.42, input: 1000, output: 234, cache_read: 0, cache_write: 0, label: "measured" },
    checks: [],
    sha: null,
    ...over,
  });
  const record = (over: Record<string, unknown>) =>
    ({
      run: "r_1",
      automation: "agent-builder",
      revision: "sha256:x",
      trigger: { kind: "manual", subject: "manual:1", received_at: "2026-10-20T09:00:00.000Z" },
      concurrency_key: "k",
      status: "succeeded",
      reason: null,
      started_at: "2026-10-20T09:00:00.000Z",
      ended_at: "2026-10-20T09:04:00.000Z",
      environment: "code",
      population: "agent",
      registry: "r",
      budget: { limit_usd: 6, spent_usd: 0.42, label: "measured" },
      workspace: { computer: "this-mac", branch: "caveman/agent-builder/x", head: "0123456789abcdef" },
      steps: [{ name: "builder", status: "succeeded", reason: null, summary: "Fixed the off-by-one in pager.ts and added a test.", attempts: [attempt({ sha: "0123456789abcdef" })] }],
      outputs: [],
      ...over,
    }) as never;

  it("says what each step did, where its changes are, and what it cost; fails on a failed run or a request for changes", () => {
    const done = runReport(record({}));
    expect(done.ok).toBe(true);
    expect(done.text).toBe(
      "Run r_1 succeeded.\n\nbuilder: succeeded\n  Fixed the off-by-one in pager.ts and added a test.\n\nChanges: branch caveman/agent-builder/x at 0123456789ab\nCost: $0.42 measured of a $6.00 budget, 1,234 tokens.",
    );
    const review = runReport(record({ steps: [{ name: "reviewer", status: "succeeded", reason: null, decision: "request_changes", summary: "The test does not cover page 0.", attempts: [attempt({})] }] }));
    expect(review.ok).toBe(false);
    expect(review.text).toContain("reviewer: succeeded, decided request_changes\n  The test does not cover page 0.\n\nCost: $0.42");
    const failed = runReport(record({ status: "failed", reason: "checks_failed", steps: [{ name: "builder", status: "failed", reason: "checks_failed", attempts: [attempt({ status: "failed" })] }] }));
    expect(failed).toMatchObject({ ok: false, text: expect.stringMatching(/^Run r_1 failed \(checks failed\)\.\n\nbuilder: failed \(checks failed\)/) });
  });
});

describe("caveman-runtime automation", () => {
  it("writes a template, checks it clean, explains a step, and points at the line of a broken key", () => {
    const r = testRepo();
    repos.push(r);
    const listed = cli(r.root, "automation", "new");
    expect(listed.code).toBe(0);
    expect(listed.out).toMatch(/^Templates:\n {2}answer-mentions /);

    const made = cli(r.root, "automation", "new", "issue-to-pr");
    expect(made.code).toBe(0);
    expect(made.out).toContain("wrote .caveman/automations/issue-to-pr.yaml");
    expect(made.out).toContain("Next: caveman-runtime automation explain issue-to-pr");
    expect(fs.readFileSync(path.join(r.root, ".caveman/.gitignore"), "utf8")).toContain("local/");

    expect(cli(r.root, "automation", "check")).toEqual({ code: 0, out: "No problems: 1 automation and 2 agents load clean.\n", err: "" });

    const explained = cli(r.root, "automation", "explain", "issue-to-pr", "implement");
    expect(explained.code).toBe(0);
    expect(explained.out).toMatch(/^issue-to-pr · Project +\.caveman\/automations\/issue-to-pr\.yaml\n/);
    expect(explained.out).toMatch(/\nimplement +automations\/issue-to-pr\.yaml:15\n/);
    expect(explained.out).toContain("Caveman Code is not running, so models show as classes");
    // Offline, classes say when they resolve, and the harness is one row; --levers lists what is behind it (B17).
    const whole = cli(r.root, "automation", "explain", "issue-to-pr").out;
    expect(whole).toContain("fast (resolves when Caveman Code runs)");
    expect(whole.match(/Caveman harness: on/g)).toHaveLength(1);
    expect(whole).not.toContain("MCP tools called from programs");
    expect(cli(r.root, "automation", "explain", "issue-to-pr", "--levers").out).toContain("MCP tools called from programs, so raw results stay out of the conversation: on");

    const file = path.join(r.root, ".caveman/automations/issue-to-pr.yaml");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("    model: base", "    modle: base"));
    const broken = cli(r.root, "automation", "check");
    expect(broken.code).toBe(1);
    expect(broken.out).toContain('.caveman/automations/issue-to-pr.yaml:18:5  Unknown key "modle" in step "implement". Did you mean "model"?');
    expect(broken.out.trimEnd().endsWith("1 error")).toBe(true);
    expect(JSON.parse(cli(r.root, "automation", "check", "--json").out).diagnostics[0]).toMatchObject({ code: "unknown-key", line: 18 });
  });

  it("lists, refuses what is not there with exit 2, and says how to start the runtime for a run", () => {
    const digest = "on: { schedule: { every: 6h } }\nsteps:\n  digest:\n    prompt: Summarise the day.\n    model: fast\n    computer: none\n";
    const r = testRepo({ ".caveman/.gitignore": "local/\n", ".caveman/local/automations/digest.yaml": digest });
    repos.push(r);
    expect(cli(r.root, "automation", "list").out).toBe("digest  Me       Every 6h · By hand\n");
    // A Me file that git tracks came from someone else: it never loads (F-1).
    r.write(".caveman/local/automations/pulled.yaml", digest);
    r.git("add", "-f", ".caveman/local/automations/pulled.yaml");
    expect(cli(r.root, "automation", "check")).toMatchObject({
      code: 1,
      out: expect.stringContaining(".caveman/local/automations/pulled.yaml:1:1  This file is tracked by git; Me automations live only on this Mac. Remove it from git (git rm --cached) to use it."),
    });
    // Out of git, it is the person's again.
    r.git("rm", "-q", "--cached", ".caveman/local/automations/pulled.yaml");
    expect(cli(r.root, "automation", "explain", "nope")).toMatchObject({ code: 2, err: "No automation nope; there is digest, pulled.\n" });
    expect(cli(r.root, "automation", "new", "nope").code).toBe(2);
    expect(cli(r.root, "automation", "bogus").code).toBe(2);
    expect(cli(r.root, "automation", "run", "digest")).toMatchObject({ code: 1, err: "Caveman Code is not running; start it with `caveman code` (or open the app), then run this again.\n" });
    expect(cli(r.root, "agent", "run", "reviewer", "look at the last commit").code).toBe(1);
    // A run on an issue needs this repo's GitHub origin to name it; the flags that pick access exclude each other.
    expect(cli(r.root, "automation", "run", "digest", "--issue", "12")).toMatchObject({ code: 2, err: "This repo has no GitHub origin remote; pass --subject github:<owner>/<repo>#<number>.\n" });
    expect(cli(r.root, "automation", "run", "digest", "--issue", "12", "--pr", "3")).toMatchObject({ code: 2, err: "Name one subject: --subject, --issue or --pr.\n" });
    expect(cli(r.root, "agent", "run", "builder", "fix it", "--write", "--readonly")).toMatchObject({ code: 2, err: "Pick one of --write, --readonly and --computer.\n" });
    // A Me file the CLI writes is off until the person turns it on (F-1).
    expect(cli(r.root, "automation", "new", "morning-digest", "--me").out).toContain("Its triggers start once you turn it on in Caveman Code > Automations.");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
    expect(cli(outside, "automation", "check")).toMatchObject({ code: 2, err: "Not inside a git repository; run this from the repository whose .caveman/ you mean.\n" });
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

describe("caveman-runtime apply", () => {
  const CLOUD_FILE = "host: cloud\non:\n  slack: { mention: true }\nsteps:\n  answer:\n    agent: answerer\noutputs:\n  slack.message: answer.summary\n";
  const AGENT = "---\ndescription: Answers questions\n---\nAnswer it.\n";

  /** `caveman-runtime <args>` without blocking, so a Cloud in this process can answer it. */
  function cliAsync(cwd: string, env: Record<string, string>, ...args: string[]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-home-"));
    return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, CAVEMAN_CODE_HOME: home, NODE_NO_WARNINGS: "1", CAVEMAN_API_KEY: "", ...env } });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => {
        fs.rmSync(home, { recursive: true, force: true });
        resolve({ code, out, err });
      });
    });
  }

  /** A Caveman Cloud that takes apply with one code:run key and answers with a widening revision. */
  async function fakeCloud() {
    const requests: Array<{ path: string; authorization: string | undefined; body: { repo: string; commit_sha: string; files: Record<string, string> } }> = [];
    const server = http.createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      requests.push({ path: req.url ?? "", authorization: req.headers.authorization, body: JSON.parse(raw || "{}") });
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== "Bearer cave_live_good") {
        res.writeHead(403);
        return res.end(JSON.stringify({ error: { code: "cave_forbidden", message: "This key may not apply automations." } }));
      }
      res.end(
        JSON.stringify({
          automations: [
            {
              id: "aut_1",
              name: "answers",
              revision_id: "rev_2",
              state: "pending_approval",
              authority_diff: { widens: true, changes: [{ key: "outputs.slack.message", change: "added", before: null, after: "answer.summary", widens: true }] },
            },
            // A new webhook: its URL and secret, this once (CORRECTNESS M5).
            { id: "aut_2", name: "hooks", revision_id: "rev_9", state: "active", authority_diff: { widens: false, changes: [] }, hook: { id: "hk_1", path: "/api/v1/code/hooks/hk_1", secret: "whsec_once" } },
            // The apply no longer carries it, and one that waits because someone else owns it (L4).
            { id: "aut_3", name: "old", revision_id: null, state: "removed", authority_diff: { widens: false, changes: [] } },
            { id: "aut_4", name: "theirs", revision_id: "rev_4", state: "pending_approval", reason: "not_owner", authority_diff: { widens: false, changes: [] } },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { url, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  it("sends the Cloud automations and their agents with a code:run key and prints the authority diff; a refusal or a broken file exits 1", async () => {
    const r = testRepo({ ".caveman/automations/answers.yaml": CLOUD_FILE, ".caveman/agents/answerer.md": AGENT, ".caveman/automations/digest.yaml": DIGEST_FILE });
    repos.push(r);
    r.git("remote", "add", "origin", "git@github.com:acme/api.git");
    const cloud = await fakeCloud();
    try {
      const applied = await cliAsync(r.root, { CAVEMAN_API_KEY: "cave_live_good" }, "apply", "--cloud-url", cloud.url);
      expect(applied).toMatchObject({ code: 0, err: "" });
      expect(applied.out).toBe(
        [
          "acme/api",
          "answers  waiting for the owner's approval, because it widens what it may do (revision rev_2)",
          "  outputs.slack.message  added answer.summary  (widens)",
          "hooks  active: it fires from now on (revision rev_9)",
          `  webhook  POST ${cloud.url}/api/v1/code/hooks/hk_1`,
          "  secret   whsec_once",
          "  Sign each body with it: X-Caveman-Signature: sha256=<hex HMAC-SHA256 of the body>. Caveman shows it this once; keep it where the sender reads it.",
          "  no change to what it may do",
          "old  removed: this apply no longer carries its file, so Cloud stopped it",
          "  no change to what it may do",
          "theirs  waiting for its owner's approval, because you are not its owner (revision rev_4)",
          "  no change to what it may do",
          "",
          "The owner approves a widening revision on the Automations page in Caveman Platform; until then the active one keeps running.",
          "",
          "Stayed here:",
          "  .caveman/automations/digest.yaml  runs on This Mac (add host: cloud to run it on Cloud)",
          "",
        ].join("\n"),
      );
      expect(cloud.requests).toHaveLength(1);
      expect(cloud.requests[0]).toMatchObject({ path: "/api/v1/code/automations/apply", authorization: "Bearer cave_live_good" });
      expect(cloud.requests[0]!.body.repo).toBe("acme/api");
      expect(cloud.requests[0]!.body.commit_sha).toBe(r.git("rev-parse", "HEAD").trim());
      expect(Object.keys(cloud.requests[0]!.body.files).sort()).toEqual([".caveman/agents/answerer.md", ".caveman/automations/answers.yaml"]);
      // The same under `automation apply`, with --key and --json.
      const asJson = await cliAsync(r.root, {}, "automation", "apply", "--key", "cave_live_good", "--cloud-url", cloud.url, "--json");
      expect(JSON.parse(asJson.out)).toMatchObject({
        repo: "acme/api",
        automations: [
          { id: "aut_1", state: "pending_approval" },
          { id: "aut_2", hook: { path: "/api/v1/code/hooks/hk_1", secret: "whsec_once" } },
          { id: "aut_3", state: "removed" },
          { id: "aut_4", state: "pending_approval", reason: "not_owner" },
        ],
        skipped: [{ path: ".caveman/automations/digest.yaml" }],
      });
      // The secret is said, never kept: no file of the repository holds it.
      expect(spawnSync("git", ["grep", "-I", "--untracked", "-l", "whsec_once"], { cwd: r.root, encoding: "utf8" }).stdout.trim()).toBe("");

      // Cloud's refusal is said, and exits 1.
      expect(await cliAsync(r.root, { CAVEMAN_API_KEY: "cave_live_bad" }, "apply", "--cloud-url", cloud.url)).toMatchObject({
        code: 1,
        err: "Caveman refused the files: This key may not apply automations.\n",
      });
      // A broken file never leaves this computer.
      r.write(".caveman/automations/answers.yaml", CLOUD_FILE.replace("agent: answerer", "agent: answrer"));
      const broken = await cliAsync(r.root, { CAVEMAN_API_KEY: "cave_live_good" }, "apply", "--cloud-url", cloud.url);
      expect(broken.code).toBe(1);
      expect(broken.err).toContain('.caveman/automations/answers.yaml:6:12  No agent "answrer". Did you mean "answerer"?');
      expect(cloud.requests).toHaveLength(3);
    } finally {
      await cloud.close();
    }
  });

  it("without a key and no Caveman Code running, says how to apply; check and explain stand at the top too", async () => {
    const r = testRepo({ ".caveman/automations/answers.yaml": CLOUD_FILE, ".caveman/agents/answerer.md": AGENT });
    repos.push(r);
    r.git("remote", "add", "origin", "https://github.com/acme/api.git");
    expect(await cliAsync(r.root, {}, "apply")).toMatchObject({
      code: 1,
      err: "Give a code:run key (--key, or CAVEMAN_API_KEY), or start Caveman Code signed in to Caveman (`caveman code`), then apply again.\n",
    });
    // Slack text is anyone's, but the answer goes back to its thread, so nothing waits for the owner (SECURITY M1).
    expect(cli(r.root, "check")).toEqual({ code: 0, out: "No problems: 1 automation and 1 agent load clean.\n", err: "" });
    const explained = cli(r.root, "explain", "answers").out;
    expect(explained).toMatch(/\n {2}runs on +Cloud +line 1\n/);
    expect(explained).toMatch(/\n {2}untrusted +text anyone may write can start it \(on\.slack\) +line 3\n/);
    expect(explained).toContain("posts anywhere but the thread or issue the text came from, so nothing waits for the owner.");
    // Posted to another channel, the answer's step waits for the owner.
    const file = path.join(r.root, ".caveman/automations/answers.yaml");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/slack\.message: .*/, 'slack.message: { from: answer, channel: "#ops" }'));
    expect(cli(r.root, "check").out).toContain('warning: This run can start from text anyone may write (on.slack), so step "answer" waits for the owner\'s approval each time, before it runs.');
    expect(cli(r.root, "explain", "answers").out).toContain("step answer waits for the owner's approval before it runs.");
  });
});

const DIGEST_FILE = "on: { schedule: { every: 6h } }\nsteps:\n  digest:\n    prompt: Sum up.\n    model: fast\n    computer: none\n";
