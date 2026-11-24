import { describe, expect, it } from "vitest";
import {
  agentView,
  appliedFor,
  authorityWord,
  cloudFor,
  cloudRunsOf,
  cloudStatus,
  consoleUrl,
  CONSOLE,
  deployedWords,
  deployView,
  gateWords,
  hostOf,
  isAgentFile,
  isCloud,
  cloudRunName,
  cloudTriggerWords,
  gateDeadline,
  localGate,
  mergeRuns,
  readApplied,
  readCloudRun,
  notServed,
  sha256,
  shortRevision,
  signedOut,
  waitingApprovals,
  type Applied,
  type CloudRun,
} from "./cloud.ts";
import { filterAutomations, filterTemplates, isLive, NO_FILTER, templateTabs, whereOf, type Automation, type RunSummary } from "./model.ts";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const BASE = "https://app.caveman.so";

const automation = (o: Partial<Automation> & { host?: string } = {}): Automation =>
  ({
    id: "file:p1:project:issue-to-pr",
    title: "issue-to-pr",
    prompt: "",
    enabled: true,
    trigger: { type: "file", kinds: ["manual", "github"], words: ["Issue labelled caveman"] },
    project_id: "p1",
    engine: "caveman",
    model: "auto",
    next_run_at: null,
    last_run_at: null,
    last_status: "never",
    last_error: null,
    run_count: 0,
    source: "file",
    scope: "project",
    path: ".caveman/automations/issue-to-pr.yaml",
    ...o,
  }) as Automation;

const applied = (o: Partial<Applied> = {}): Applied => ({ id: "auto_1", name: "issue-to-pr", revision_id: "rev_01jc2k9f8a7b", state: "active", authority_diff: { widens: false, changes: [] }, ...o });

const cloudRun = (o: Partial<CloudRun> = {}): CloudRun => ({
  run_id: "crun_1",
  automation_id: "auto_1",
  automation: "issue-to-pr",
  repo: "acme/api",
  status: "running",
  outcome: null,
  trigger: { kind: "github", event: "issues.labeled", subject: "github:acme/api#12", subject_title: "Fix the export" },
  started_at: "2026-10-21T11:50:00Z",
  ended_at: null,
  cost_usd: 0.42,
  session_id: "ses_1",
  ...o,
});

describe("where it runs", () => {
  it("is Cloud only for a file that says host: cloud", () => {
    expect(hostOf({ host: "cloud" })).toBe("cloud");
    expect(hostOf({})).toBe("this-mac");
    expect(isCloud(automation({ host: "cloud" }))).toBe(true);
    expect(isCloud(automation())).toBe(false);
    expect(isCloud(automation({ host: "cloud", source: "app" }))).toBe(false);
  });

  it("wins over GitHub Actions in the list's Runs on, and filters", () => {
    expect(whereOf(automation({ host: "cloud", runs_on: "github_actions" }))).toBe("cloud");
    expect(whereOf(automation({ runs_on: "github_actions" }))).toBe("github_actions");
    expect(whereOf(automation())).toBe("this_mac");
    const list = [automation({ host: "cloud" }), automation({ id: "file:p1:project:b", title: "b" })];
    expect(filterAutomations(list, { ...NO_FILTER, where: ["cloud"] }, () => "api").map((a) => a.title)).toEqual(["issue-to-pr"]);
  });
});

describe("the Deploy panel's states", () => {
  it("not deployed yet says what Deploy does", () => {
    const v = deployView(undefined, NOW);
    expect(v.kind).toBe("none");
    expect(v.title).toBe("Not on Cloud yet");
    expect(v.detail).toContain("Deploy sends this file and the agents it names");
  });

  it("deployed names its revision and when", () => {
    const v = deployView({ ...applied(), repo: "acme/api", applied_at: "2026-10-21T10:00:00Z", from_here: true }, NOW);
    expect(v.kind).toBe("active");
    expect(v.title).toBe("On Cloud");
    expect(v.detail).toBe("Revision k9f8a7b, deployed from here 2h ago.");
  });

  it("the same files again are on Cloud as they were; a revision Cloud did not name still reads", () => {
    const same = deployView(applied({ state: "unchanged", applied_at: "2026-10-21T11:59:00Z", from_here: true }), NOW);
    expect(same.kind).toBe("active");
    expect(same.detail).toBe("Revision k9f8a7b, deployed from here 1m ago. Cloud already runs these exact files.");
    expect(deployView(applied({ revision_id: null }), NOW).detail).toBe("Deployed.");
  });

  it("Cloud's own list says when it was deployed without claiming it was from here; no diff is no changes", () => {
    const listed = { ...applied(), repo: "acme/api", path: ".caveman/automations/issue-to-pr.yaml", enabled: true, applied_at: "2026-10-21T10:00:00Z" };
    expect(deployView(listed, NOW).detail).toBe("Revision k9f8a7b, deployed 2h ago.");
    const { authority_diff: _, ...noDiff } = listed;
    expect(deployView(noDiff, NOW).changes).toEqual([]);
  });

  it("waiting for approval puts what widens first and says Cloud keeps the approved one", () => {
    const v = deployView(
      applied({
        state: "pending_approval",
        authority_diff: {
          widens: true,
          changes: [
            { key: "budget", change: "changed", before: "$6", after: "$4", widens: false },
            { key: "outputs.slack.message", change: "added", before: null, after: "#eng", widens: true },
          ],
        },
      }),
      NOW,
    );
    expect(v.kind).toBe("pending");
    expect(v.title).toBe("Waiting for approval");
    expect(v.detail).toContain("its owner approves it in Caveman Platform first");
    expect(v.changes.map((c) => c.key)).toEqual(["outputs.slack.message", "budget"]);
  });

  it("short revisions: a sha256 by its head, an id by its tail", () => {
    expect(shortRevision("sha256:4be1c09d7a33e1")).toBe("4be1c09");
    expect(shortRevision("rev_01jc2k9f8a7b")).toBe("k9f8a7b");
    expect(shortRevision("r1")).toBe("r1");
  });

  it("authority keys read as words", () => {
    expect(authorityWord("on.github")).toBe("Trigger: github");
    expect(authorityWord("outputs.slack.message")).toBe("Output: slack.message");
    expect(authorityWord("steps.implement.engine")).toBe("implement's engine");
    expect(authorityWord("budget")).toBe("Budget");
    expect(authorityWord("x.y")).toBe("x.y");
  });

  it("finds its own apply result by path, else by name; Cloud's copy by repo and name", () => {
    const list = [applied({ name: "other", path: ".caveman/automations/other.yaml" }), applied({ path: ".caveman/automations/issue-to-pr.yaml" })];
    expect(appliedFor(list, automation(), "issue-to-pr")?.path).toBe(".caveman/automations/issue-to-pr.yaml");
    expect(appliedFor([applied()], { title: "issue-to-pr" }, "issue-to-pr")?.id).toBe("auto_1");
    const listed = (o: Partial<Applied>, repo: string) => ({ ...applied(o), repo, path: ".caveman/automations/issue-to-pr.yaml", enabled: true });
    const cloud = [listed({}, "acme/web"), listed({ id: "auto_2" }, "Acme/API")];
    expect(cloudFor(cloud, "acme/api", "issue-to-pr")?.id).toBe("auto_2");
  });

  it("a new webhook's URL and secret come out of the answer to show once; what this computer keeps has no secret", () => {
    const hook = { id: "hk_01jabcdefghijklmnopqrstuvw", path: "/api/v1/code/hooks/hk_01jabcdefghijklmnopqrstuvw", secret: "one-time-secret" };
    const answer = { repo: "acme/api", automations: [applied({ id: "aut_1", name: "intake", state: "active", hook } as never), applied({ id: "aut_2", name: "triage" })] };
    const { kept, hooks } = readApplied(answer as never, "2026-10-21T12:00:00Z", `${BASE}/`);
    expect(hooks).toEqual([{ automation: "intake", url: `${BASE}/api/v1/code/hooks/hk_01jabcdefghijklmnopqrstuvw`, secret: "one-time-secret" }]);
    expect(kept.map((x) => [x.id, x.repo, x.from_here, x.applied_at])).toEqual([
      ["aut_1", "acme/api", true, "2026-10-21T12:00:00Z"],
      ["aut_2", "acme/api", true, "2026-10-21T12:00:00Z"],
    ]);
    expect(JSON.stringify(kept)).not.toContain(hook.secret);
    expect(kept[0]).not.toHaveProperty("hook");
    expect(readApplied({ repo: "acme/api", automations: [applied()] } as never, "t", BASE).hooks).toEqual([]);
  });

  it("the notice after Deploy says what was held", () => {
    expect(deployedWords([])).toBe("Cloud found no host: cloud automations in this repo.");
    expect(deployedWords([applied()])).toBe("Deployed issue-to-pr to Cloud.");
    expect(deployedWords([applied({ state: "pending_approval" })])).toBe("issue-to-pr waits for approval in Caveman Platform.");
    expect(deployedWords([applied(), applied({ name: "triage", state: "pending_approval" })])).toBe("Deployed issue-to-pr. triage waits for approval.");
  });
});

describe("errors", () => {
  it("an older runtime is told apart from a refusal", () => {
    expect(notServed({ error: { code: -32601 } })).toBe(true);
    expect(notServed({ error: { code: -32011, data: { reason: "unsupported" } } })).toBe(true);
    expect(notServed({ error: { code: -32004, data: { reason: "invalid_state" } } })).toBe(false);
    expect(signedOut({ error: { data: { reason: "cloud_unauthorized" } } })).toBe(true);
  });
});

describe("runs, This Mac and Cloud together", () => {
  const local: RunSummary = {
    run_id: "r_1",
    automation_id: "file:p1:project:issue-to-pr",
    automation: "issue-to-pr",
    project_id: "p1",
    status: "succeeded",
    reason: null,
    trigger: { kind: "manual", subject: "manual:r_1" },
    started_at: "2026-10-21T11:00:00Z",
    ended_at: "2026-10-21T11:05:00Z",
    spent_usd: 0.3,
    steps: [{ name: "triage", status: "succeeded" }],
  };

  it("newest first, a Cloud run opening its session in the console", () => {
    const rows = mergeRuns([local], [cloudRun()], BASE);
    expect(rows.map((r) => [r.where, r.run_id])).toEqual([
      ["cloud", "crun_1"],
      ["this_mac", "r_1"],
    ]);
    expect(rows[0]!.console).toBe(`${BASE}/code-sessions/ses_1`);
    expect(rows[0]!.spent_usd).toBe(0.42);
    expect(rows[1]!.console).toBeUndefined();
  });

  it("a Cloud run waiting on a gate carries its ask; one with no session opens its automation", () => {
    const ask = { ask_id: "ask_1", kind: "approval" as const, step: "implement" };
    const [row] = mergeRuns([], [cloudRun({ status: "requires_action", requires_action: ask })], BASE);
    expect(row!.status).toBe("waiting");
    expect(row!.ask).toEqual(ask);
    expect(row!.console).toBe(`${BASE}/code-sessions/ses_1`);
    expect(mergeRuns([], [cloudRun({ session_id: null })], BASE)[0]!.console).toBe(`${BASE}/code-automations/auto_1`);
    expect(consoleUrl(`${BASE}/`, CONSOLE.board)).toBe(`${BASE}/code-automations?view=board`);
  });

  it("a skipped schedule tick reads Skipped, with why, and is over: never live, never polled", () => {
    // As Cloud records an overlapping tick: skipped_overlap, finished at once, never started.
    const r = readCloudRun({ id: "crun_s", automation_id: "auto_1", revision_id: "rev_1", trigger: "schedule", status: "skipped", outcome: "skipped_overlap", session_id: null, cost_usd: 0, started_at: null, finished_at: "2026-10-21T11:00:00Z" });
    expect(cloudStatus(r.status)).toBe("skipped");
    expect(isLive(cloudStatus(r.status))).toBe(false);
    const [row] = mergeRuns([], [r], BASE);
    expect(row).toMatchObject({ status: "skipped", why: "A run on the same subject was still going", label: "On schedule", started_at: "2026-10-21T11:00:00Z", ended_at: "2026-10-21T11:00:00Z" });
    expect(row!.ask).toBeUndefined();
    // An outcome that is no reason this page knows says nothing, rather than an object's own keys.
    expect(mergeRuns([], [cloudRun({ status: "failed", outcome: "constructor" })], BASE)[0]).not.toHaveProperty("why");
  });

  it("Cloud's real waiting row (C3: status waiting, requires_action with its step and who) is a gate and an Inbox approval", () => {
    // What automation.cloud_runs answers for Cloud's row once the run's session waits at an approve: step.
    const r = readCloudRun({
      id: "0193a1b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b",
      automation_id: "aut_1",
      revision_id: "rev_1",
      trigger: "github.issues.labeled",
      status: "waiting",
      outcome: null,
      session_id: "ses_1",
      cost_usd: 0.12,
      started_at: "2026-10-21T11:30:00Z",
      finished_at: null,
      name: "issue-to-pr",
      repo: "acme/api",
      requires_action: { ask_id: "automation:0193a1b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b:implement", kind: "approval", step: "implement", by: "owner" },
    });
    expect(waitingApprovals([r]).map((x) => x.run_id)).toEqual(["0193a1b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b"]);
    expect(gateWords(r.requires_action!)).toBe("implement waits for the owner's approval");
    const [row] = mergeRuns([], [r], BASE);
    expect(row).toMatchObject({ status: "waiting", label: "GitHub issue labelled", console: `${BASE}/code-sessions/ses_1`, ask: { ask_id: "automation:0193a1b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b:implement", kind: "approval" } });
    expect(cloudRunsOf([r], "acme/api", "issue-to-pr")).toHaveLength(1);
  });

  it("Cloud's session words map onto the run words", () => {
    expect(cloudStatus("starting")).toBe("queued");
    expect(cloudStatus("idle")).toBe("succeeded");
    expect(cloudStatus("terminated")).toBe("failed");
    expect(cloudStatus("interrupted")).toBe("cancelled");
    expect(cloudStatus("failed")).toBe("failed");
  });

  it("an automation's Cloud runs are its name in its repo", () => {
    const runs = [cloudRun(), cloudRun({ run_id: "x", repo: "acme/web" }), cloudRun({ run_id: "y", automation: "pr-review" })];
    expect(cloudRunsOf(runs, "ACME/api", "issue-to-pr").map((r) => r.run_id)).toEqual(["crun_1"]);
  });

  it("the Inbox lists only runs stopped at an approval, oldest first", () => {
    const gate = { ask_id: "a", kind: "approval" as const, step: "implement" };
    const runs = [
      cloudRun({ run_id: "late", status: "waiting", requires_action: gate, started_at: "2026-10-21T11:59:00Z" }),
      cloudRun({ run_id: "q", status: "waiting", requires_action: { ask_id: "b", kind: "question" } }),
      cloudRun({ run_id: "early", status: "requires_action", requires_action: gate, started_at: "2026-10-21T09:00:00Z" }),
      cloudRun({ run_id: "done", status: "succeeded", requires_action: gate }),
    ];
    expect(waitingApprovals(runs).map((r) => r.run_id)).toEqual(["early", "late"]);
  });

  it("a gate says what waits and on whom", () => {
    expect(gateWords({ step: "implement" })).toBe("implement waits for the owner's approval");
    expect(gateWords({ step: "deploy", by: "members" })).toBe("deploy waits for a member's approval");
    expect(gateWords({ question: "Merge the release branch?" })).toBe("Merge the release branch?");
  });

  it("a This Mac run's gate is its waiting step whose approval has no answer yet", () => {
    const approval = { by: "members", asked_at: "2026-10-21T11:00:00Z", expires_at: "2026-10-22T11:00:00Z" };
    const steps = [
      { name: "triage", status: "succeeded" },
      { name: "ship", status: "waiting", approval },
    ];
    expect(localGate({ steps })).toEqual({ step: "ship", by: "members", expires_at: "2026-10-22T11:00:00Z" });
    // A wait step's timer waits too, with no approval.
    expect(localGate({ steps: [{ name: "cool-off", status: "waiting" }] })).toBeNull();
    expect(localGate({ steps: [{ name: "ship", status: "waiting", approval: { ...approval, decision: "approve" } }] as never })).toBeNull();
  });

  it("says how long a gate still waits", () => {
    expect(gateDeadline("2026-10-22T11:00:00Z", NOW)).toBe("It waits 23h more, then the step fails.");
    expect(gateDeadline("2026-10-21T12:40:00Z", NOW)).toBe("It waits 40m more, then the step fails.");
    expect(gateDeadline("2026-10-21T13:30:00Z", NOW)).toBe("It waits 1h 30m more, then the step fails.");
    expect(gateDeadline("2026-10-21T11:00:00Z", NOW)).toBe("Its time to answer is up.");
    expect(gateDeadline(undefined, NOW)).toBeNull();
  });

  it("reads A2's run rows: the trigger split, times settled, a name from what this computer deployed", () => {
    const r = readCloudRun({ id: "crun_9", automation_id: "auto_7", revision_id: null, trigger: "slack.app_mention", status: "running", outcome: null, session_id: "ses_9", cost_usd: 0.2, started_at: "2026-10-21T11:00:00Z", finished_at: null });
    expect(r).toEqual({ run_id: "crun_9", automation_id: "auto_7", status: "running", outcome: null, trigger: { kind: "slack", event: "app_mention" }, started_at: "2026-10-21T11:00:00Z", ended_at: null, cost_usd: 0.2, session_id: "ses_9" });
    expect(cloudTriggerWords(r.trigger)).toBe("Slack mention");
    expect(cloudTriggerWords({ kind: "schedule" })).toBe("On schedule");
    expect(cloudTriggerWords({ kind: "github", event: "issues.labeled" })).toBe("GitHub issue labelled");
    expect(cloudRunName(r, new Map([["auto_7", "slack-triage"]]))).toBe("slack-triage");
    expect(cloudRunName(r, new Map())).toBe("A Cloud automation");
    const [row] = mergeRuns([], [r], BASE);
    expect(row).toMatchObject({ where: "cloud", label: "Slack mention", trigger: { subject: "" }, console: `${BASE}/code-sessions/ses_9` });
    expect(cloudRunsOf([r], "acme/api", "slack-triage", "auto_7")).toHaveLength(1);
    expect(cloudRunsOf([r], "acme/api", "slack-triage")).toHaveLength(0);
  });
});

describe("agents", () => {
  const published = { id: "agt_1", name: "triager", latest_version: 3, file_sha256: "abc", archived: false };

  it("unpublished, the same file, or changed here since", () => {
    expect(agentView(null, undefined)).toEqual({ label: "Not published", tone: "none", action: "Publish" });
    expect(agentView("abc", published)).toEqual({ label: "v3", tone: "published", action: null });
    expect(agentView("def", published)).toEqual({ label: "v3, changed here", tone: "changed", action: "Publish v4" });
    expect(agentView("abc", { ...published, file_sha256: "sha256:abc" }).action).toBeNull();
    expect(agentView(null, published)).toEqual({ label: "v3", tone: "published", action: "Publish" });
  });

  it("only the repo's own .caveman/agents files are listed", () => {
    expect(isAgentFile({ source: "project", path: ".caveman/agents/triager.md" })).toBe(true);
    expect(isAgentFile({ source: "project", path: ".claude/agents/triager.md" })).toBe(false);
    expect(isAgentFile({ source: "builtin" })).toBe(false);
    expect(isAgentFile({ source: "project", path: ".caveman/agents/nested/x.md" })).toBe(false);
  });

  it("hashes a file as Cloud does, hex sha256", async () => {
    expect(await sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("the templates gallery", () => {
  const t = (id: string, category: string, host?: string) =>
    ({ id, title: id, category, summary: "", chips: [], scope: "project", paths: [], steps: [], ...(host ? { host } : {}) }) as never;

  it("filters by where they run and keeps a category a newer runtime adds", () => {
    const list = [t("a", "Review"), t("b", "Chat and tickets", "cloud"), t("c", "Monitoring", "cloud")];
    expect(filterTemplates(list, "all", "", "cloud").map((x: { id: string }) => x.id)).toEqual(["c", "b"]);
    expect(filterTemplates(list, "all", "", "this-mac").map((x: { id: string }) => x.id)).toEqual(["a"]);
    expect(templateTabs(list).map((x) => x.label)).toEqual(["All", "Review", "Monitoring", "Chat and tickets"]);
  });
});

describe("Cloud's subjects", () => {
  it("a Slack thread and a Linear or Jira issue read as themselves", async () => {
    const { subjectView } = await import("./model.ts");
    expect(subjectView("slack:#eng/1729411", "Fix the flaky export test").label).toBe("Slack #eng");
    expect(subjectView("linear:ENG-142").label).toBe("ENG-142");
    expect(subjectView("jira:OPS-9").label).toBe("OPS-9");
  });
});
