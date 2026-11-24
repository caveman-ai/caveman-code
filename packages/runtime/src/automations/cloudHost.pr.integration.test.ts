// A Cloud-hosted automation opens a pull request, end to end on the real runtime against the stand-in Cloud
// (CORRECTNESS C1). The computer runs git in its tools container (a tools server over a socket, as on a Cloud
// computer): the step's change is committed there, the caveman/* branch is pushed from the tools side's checkout
// through the runtime's mirror to Cloud's git proxy (here `git http-backend` over a bare repository, taking only the
// runtime's token), and Cloud opens the pull request and posts the issue comment as the repository's App through
// `/runtime/pull-requests` and `/runtime/comments`. The run record carries both, applied. A branch this computer did
// not make through the proxy may only fast-forward there (Cloud's relay/gitproxy.go): its run pushes to
// `<branch>-cloud` instead, once, and Cloud opens the pull request from that head.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { ProjectId } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { afterAll, beforeAll, expect, test } from "vitest";

import { enroll } from "../cloudLink/identity.ts";
import { CloudComputer, CloudLinkState } from "../cloudLink/index.ts";
import { startTestCloud, type TestCloud } from "../cloudLink/testCloud.ts";
import { TOOLS_EXEC } from "../cloudLink/tools.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import { makeConfig, makeRepo, startRuntime, tempRoot, until } from "../session-protocol/testHarness.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { makeJournal } from "./journal.ts";
import { makeRunner } from "./runner.ts";
import { AutomationRunner } from "./services.ts";
import { gitOf, type StepEngine } from "./steps.ts";

const FILE = [
  "host: cloud",
  "on:",
  "  github: { event: issues.labeled, label: caveman }",
  "steps:",
  "  fix:",
  "    prompt: Fix the answer.",
  "    computer: full",
  "outputs:",
  "  github.pull_request: { from: fix }",
  "  github.comment: fix.summary",
  "",
].join("\n");
const SUMMARY = "The answer is 42 now.";

/** Plays the agent: the fix step writes its change into the run's worktree, as an agent on the computer would. */
const engine: StepEngine = {
  select: (input) =>
    Effect.succeed({ engine: "caveman", modelSelection: { instanceId: "caveman", model: "fake" } as never, runtimeMode: "auto-accept-edits", model: { asked: input.asked, resolved: "fake", via: "default" } }),
  start: (input) => Effect.sync(() => (fs.writeFileSync(path.join(input.cwd, "answer.txt"), "42\n"), { runId: input.threadId })),
  send: (input) => Effect.succeed({ runId: `${input.threadId}:${input.key}` }),
  wait: () => Effect.succeed({ status: "completed" as const, text: SUMMARY }),
  stop: () => Effect.void,
  settle: () => Effect.void,
  close: () => Effect.void,
  usage: () => Effect.succeed(new Map()),
  workspaces: () => Effect.succeed(new Map()),
};

let cloud: TestCloud;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let tools: ChildProcess;
let bare: string;
let stateDir: string;
const cleanups: Array<() => unknown> = [];

// Skipped on Windows: each test runs a Cloud computer's runtime, and a Cloud computer is Linux; its git runs in the tools
// container over a Unix socket.
const WIN = process.platform === "win32";
const onComputer = test.skipIf(WIN);

beforeAll(async () => {
  if (WIN) return;
  // The tools container: every git the runtime runs goes there, as on a Cloud computer.
  const socket = path.join(tempRoot("automation-pr-tools-"), "tools.sock");
  tools = spawn(process.execPath, [TOOLS_EXEC, "serve", socket], { env: { ...process.env, TOOLS_SIDE: "yes" }, stdio: "ignore" });
  cleanups.push(() => tools.kill());
  for (const deadline = Date.now() + 10_000; !fs.existsSync(socket) && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 50));
  process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS = socket;

  cloud = await startTestCloud();
  cleanups.push(cloud.close);
  // GitHub, as Cloud's git proxy reaches it: a bare repository the proxy serves to the runtime's token.
  const remotes = tempRoot("automation-pr-github-");
  bare = path.join(remotes, "acme/widgets.git");
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  execFileSync("git", ["init", "--bare", "-q", bare]);
  // Cloud's proxy rule, as its pre-receive hook says it: a branch made elsewhere (listed) may only fast-forward.
  fs.writeFileSync(
    path.join(bare, "hooks", "pre-receive"),
    [
      "#!/bin/sh",
      "zero=0000000000000000000000000000000000000000",
      "while read old new ref; do",
      '  if [ "$old" != "$zero" ] && grep -qxF "$ref" made-elsewhere 2>/dev/null && ! git merge-base --is-ancestor "$old" "$new"; then',
      `    echo "caveman git proxy: $ref refused: a computer working for someone else made it, or it was not made through Cloud's git proxy, so a push may only fast-forward it; push to a new caveman/ branch instead" >&2`,
      "    exit 1",
      "  fi",
      "done",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  cloud.state.gitBackend = remotes;

  const linkDir = path.join(tempRoot("automation-pr-link-"), "link");
  const identity = await enroll({ dir: linkDir, cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "computer" });
  const checkout = makeRepo(tempRoot("automation-pr-checkout-"), { "answer.txt": "41\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: checkout });
  process.env.CAVEMAN_SESSION_MOUNT = tempRoot("automation-pr-mount-");
  const config = await makeConfig();
  stateDir = config.stateDir;
  const runner = Layer.effect(
    AutomationRunner,
    Effect.gen(function* () {
      const projects = yield* ProjectStore.make;
      return yield* makeRunner({
        journal: yield* makeJournal,
        engine,
        git: gitOf(yield* GitVcsDriver.GitVcsDriver),
        processRunner: yield* ProcessRunner.ProcessRunner,
        github: undefined,
        projectRoot: (id) => projects.get(ProjectId.make(id)).pipe(Effect.map((row) => Option.getOrUndefined(row)?.workspaceRoot), Effect.orElseSucceed(() => undefined)),
        worktreesDir: path.join(config.stateDir, "automation-worktrees"),
        coAuthor: Effect.succeed(true),
        pollMs: 50,
        outputRetryBase: "50 millis",
      });
    }),
  ).pipe(Layer.provide(ProcessRunner.layer));
  const provide = Layer.mergeAll(
    ProjectStore.layer,
    runner,
    Layer.succeed(CloudComputer, { linkDir, computerId: identity.computerId, workspaceRoot: checkout }),
    Layer.succeed(CloudLinkState, {}),
  ) as unknown as Layer.Layer<any>;
  runtime = await startRuntime(config, "fake-claude", undefined, { provide });
  cleanups.push(runtime.close);
}, 60_000);

afterAll(async () => {
  delete process.env.CAVEMAN_SESSION_MOUNT;
  delete process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

onComputer("an issue-to-pr run on a Cloud computer pushes its branch from the tools container through the git proxy, and Cloud opens the pull request and the comment", async () => {
  cloud.state.automations.revisions.set("rev_pr", { files: { ".caveman/automations/fix-answers.yaml": FILE }, sha256: "sha256:pr" });
  cloud.state.sessions.post({
    verb: "task",
    authority: "automation",
    to_workspace_id: "ws-pr-1",
    body: "Run the fix-answers automation.",
    payload: {
      kind: "session_start",
      session_id: "sesn_pr",
      agent: null,
      repo: "acme/widgets",
      automation: {
        automation_id: "aut_pr",
        revision_id: "rev_pr",
        run_id: "run_pr",
        trigger: "github.issues.labeled",
        subject: "github:acme/widgets#7",
        event: { source: "github", event: "issues.labeled", repo: "acme/widgets", label: "caveman", issue: { number: 7, title: "The answer is wrong", url: "https://github.com/acme/widgets/issues/7" }, trusted: true },
      },
    },
  });
  await until(() => cloud.state.automations.runs.some((r) => r.session_id === "sesn_pr"), 90_000);
  const posted = cloud.state.automations.runs.find((r) => r.session_id === "sesn_pr")!;
  expect(posted.record, JSON.stringify(posted.record, null, 2)).toMatchObject({
    run: "run_pr",
    status: "succeeded",
    environment: "cloud",
    trigger: { kind: "github", event: "issues.labeled", subject: "github:acme/widgets#7" },
    outputs: [
      { kind: "github.pull_request", status: "applied", url: "https://github.com/acme/widgets/pull/100" },
      { kind: "github.comment", status: "applied" },
    ],
  });

  // The branch reached GitHub through the proxy, with the runtime's token, at exactly the commit Cloud was told.
  const [pr] = cloud.state.automations.pullRequests;
  expect(pr).toMatchObject({ session_id: "sesn_pr", repo: "acme/widgets", head: "caveman/fix-answers/acme-widgets-7", base: "main", draft: false, idempotency_key: "run_pr.fix.github.pull_request" });
  expect(execFileSync("git", ["rev-parse", `refs/heads/${pr!.head}`], { cwd: bare, encoding: "utf8" }).trim()).toBe(pr!.sha);
  expect(execFileSync("git", ["show", `${pr!.sha}:answer.txt`], { cwd: bare, encoding: "utf8" })).toBe("42\n");
  const pushes = cloud.state.gitRequests.filter((r) => r.url.includes("git-receive-pack"));
  expect(pushes.length).toBeGreaterThan(0);
  expect(pushes.every((r) => r.authorization?.startsWith("Bearer "))).toBe(true);
  // Pushed by the runtime's mirror, which took the branch from the tools side as a bundle (and kept none).
  expect(fs.readdirSync(path.join(stateDir, "git-mirror")).filter((f) => f.endsWith(".bundle"))).toEqual([]);
  // It staged exactly that commit, under a ref of that push's own, which it removed once done (tools.ts, audit K).
  const mirror = path.join(stateDir, "git-mirror");
  expect(execFileSync("git", ["cat-file", "-t", pr!.sha], { cwd: mirror, encoding: "utf8" }).trim()).toBe("commit");
  expect(execFileSync("git", ["for-each-ref", "refs/caveman/push"], { cwd: mirror, encoding: "utf8" }).trim()).toBe("");

  // The comment went to the issue that started the run, carrying this automation's marker for later edits.
  expect(cloud.state.automations.comments).toEqual([
    expect.objectContaining({ session_id: "sesn_pr", repo: "acme/widgets", issue_number: 7, marker: "<!-- caveman:automation=fix-answers subject=github:acme/widgets#7 -->", idempotency_key: "run_pr.fix.github.comment" }),
  ]);
  expect(cloud.state.automations.comments[0]!.body).toContain(SUMMARY);
}, 120_000);

/** A branch on GitHub this computer did not make through the proxy (someone else's, or there before the deploy). */
const madeElsewhere = (branch: string) => {
  const env = { ...process.env, GIT_AUTHOR_NAME: "someone", GIT_AUTHOR_EMAIL: "someone@example.com", GIT_COMMITTER_NAME: "someone", GIT_COMMITTER_EMAIL: "someone@example.com" };
  const tree = execFileSync("git", ["mktree"], { cwd: bare, input: "", encoding: "utf8" }).trim();
  const commit = execFileSync("git", ["commit-tree", tree, "-m", `someone's ${branch}`], { cwd: bare, env, encoding: "utf8" }).trim();
  execFileSync("git", ["update-ref", `refs/heads/${branch}`, commit], { cwd: bare });
  fs.appendFileSync(path.join(bare, "made-elsewhere"), `refs/heads/${branch}\n`);
  return commit;
};
const refOf = (branch: string) => execFileSync("git", ["rev-parse", `refs/heads/${branch}`], { cwd: bare, encoding: "utf8" }).trim();
const startFix = (issue: number) =>
  cloud.state.sessions.post({
    verb: "task",
    authority: "automation",
    to_workspace_id: `ws-pr-${issue}`,
    body: "Run the fix-answers automation.",
    payload: {
      kind: "session_start",
      session_id: `sesn_pr${issue}`,
      agent: null,
      repo: "acme/widgets",
      automation: {
        automation_id: "aut_pr",
        revision_id: "rev_pr",
        run_id: `run_pr${issue}`,
        trigger: "github.issues.labeled",
        subject: `github:acme/widgets#${issue}`,
        event: { source: "github", event: "issues.labeled", repo: "acme/widgets", label: "caveman", issue: { number: issue, title: "The answer is wrong", url: `https://github.com/acme/widgets/issues/${issue}` }, trusted: true },
      },
    },
  });

onComputer("a branch the proxy lets only fast-forward is left alone: the run pushes <branch>-cloud, and Cloud opens the pull request from it", async () => {
  const someones = madeElsewhere("caveman/fix-answers/acme-widgets-8");
  startFix(8);
  await until(() => cloud.state.automations.runs.some((r) => r.session_id === "sesn_pr8"), 90_000);
  const posted = cloud.state.automations.runs.find((r) => r.session_id === "sesn_pr8")!;
  expect(posted.record, JSON.stringify(posted.record, null, 2)).toMatchObject({
    run: "run_pr8",
    status: "succeeded",
    outputs: [{ kind: "github.pull_request", status: "applied", url: expect.stringMatching(/^https:\/\/github\.com\/acme\/widgets\/pull\/\d+$/) }, { kind: "github.comment", status: "applied" }],
  });
  const pr = cloud.state.automations.pullRequests.find((p) => p.session_id === "sesn_pr8");
  expect(pr).toMatchObject({ repo: "acme/widgets", head: "caveman/fix-answers/acme-widgets-8-cloud", base: "main", idempotency_key: "run_pr8.fix.github.pull_request" });
  expect(refOf("caveman/fix-answers/acme-widgets-8-cloud")).toBe(pr!.sha);
  expect(execFileSync("git", ["show", `${pr!.sha}:answer.txt`], { cwd: bare, encoding: "utf8" })).toBe("42\n");
  // The branch made elsewhere is where it was.
  expect(refOf("caveman/fix-answers/acme-widgets-8")).toBe(someones);
}, 120_000);

onComputer("when <branch>-cloud is refused too, the pull request fails with the proxy's text and none is opened", async () => {
  const someones = madeElsewhere("caveman/fix-answers/acme-widgets-9");
  const someonesCloud = madeElsewhere("caveman/fix-answers/acme-widgets-9-cloud");
  startFix(9);
  await until(() => cloud.state.automations.runs.some((r) => r.session_id === "sesn_pr9"), 90_000);
  const posted = cloud.state.automations.runs.find((r) => r.session_id === "sesn_pr9")!;
  expect(posted.record, JSON.stringify(posted.record, null, 2)).toMatchObject({ run: "run_pr9", status: "failed", reason: "output_failed", outputs: [{ kind: "github.pull_request", status: "failed" }, {}] });
  const error = String((posted.record.outputs as Array<{ error?: string }>)[0]!.error);
  expect(error).toContain("refs/heads/caveman/fix-answers/acme-widgets-9-cloud refused: ");
  expect(error).toContain("may only fast-forward it; push to a new caveman/ branch instead");
  expect(cloud.state.automations.pullRequests.filter((p) => p.session_id === "sesn_pr9")).toEqual([]);
  expect(refOf("caveman/fix-answers/acme-widgets-9")).toBe(someones);
  expect(refOf("caveman/fix-answers/acme-widgets-9-cloud")).toBe(someonesCloud);
}, 120_000);
