import type { Client } from "@caveman-app/session-protocol/client";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { PublishOfferView } from "../../components/pane/PublishOffer.tsx";
import { RuntimeContext, type RuntimeContextValue } from "../../state/runtime.tsx";
import { CloudConsoleView, CONSOLE_PAGES } from "../settings/CloudConsole.tsx";
import { AgentCardView, AgentsView, PublishView, type AgentsViewProps, type CloudReach } from "./Agents.tsx";
import { deployView, readCloudRun, unlistedView, unreadView } from "./cloud.ts";
import { ApprovalRow, Approvals, CloudGates, CloudPanelView, GateCard, hookTitle, HookSecretsView } from "./CloudParts.tsx";
import { refresh, remember, type AgentFile } from "./data.ts";
import { THIS_COMPUTER, thisComputer } from "../../lib/platform.ts";

// Every new Cloud state on the Automations pages, the Inbox, a chat's box and Settings, rendered as the person sees it.
const NOW = Date.parse("2026-10-21T12:00:00Z");
const runtime = { client: null, settings: null, engines: [], workspaces: [], projects: [], refresh: async () => undefined } as unknown as RuntimeContextValue;
const html = (el: ReactElement) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(RuntimeContext.Provider, { value: runtime }, el)));
const noop = () => undefined;

describe("the Deploy panel", () => {
  const panel = (props: Partial<Parameters<typeof CloudPanelView>[0]>) =>
    html(createElement(CloudPanelView, { view: deployView(undefined, NOW), unavailable: false, error: null, consoleHref: null, ...props }));

  it("loading: a placeholder while Cloud's copy is read", () => {
    const out = panel({ view: null });
    expect(out).toContain('aria-label="Reading Cloud&#x27;s copy"');
    expect(out).not.toContain("Not on Cloud yet");
  });

  it("empty: not deployed yet, with what Deploy does", () => {
    const out = panel({});
    expect(out).toContain("Not on Cloud yet");
    expect(out).toContain("Deploy sends this file and the agents it names.");
    expect(out).not.toContain("Open in Platform");
  });

  it("deployed: its revision and the way to its console page", () => {
    const out = panel({ view: deployView({ id: "auto_1", name: "x", repo: "a/b", revision_id: "sha256:4be1c09d7a33", state: "active", applied_at: "2026-10-21T11:00:00Z", from_here: true }, NOW), consoleHref: "https://app.caveman.so/code-automations/auto_1" });
    expect(out).toContain("On Cloud");
    expect(out).toContain("Revision 4be1c09, deployed from here 1h ago.");
    expect(out).toContain('href="https://app.caveman.so/code-automations/auto_1"');
    expect(out).toContain("Open in Platform");
  });

  it("pending approval: says so, and lists what it may now do, wider rows marked", () => {
    const view = deployView(
      {
        id: "auto_1",
        name: "x",
        revision_id: "rev_2",
        state: "pending_approval",
        authority_diff: {
          widens: true,
          changes: [
            { key: "on.slack", change: "added", before: null, after: "mention in #eng", widens: true },
            { key: "budget", change: "changed", before: "$6", after: "$4", widens: false },
          ],
        },
      },
      NOW,
    );
    const out = panel({ view, consoleHref: "https://app.caveman.so/code-automations/auto_1" });
    expect(out).toContain("Waiting for approval");
    expect(out).toContain("What changed in what it may do, against the version Cloud runs now");
    expect(out).toContain("Trigger: slack");
    expect(out).toContain("mention in #eng");
    expect(out.match(/>Wider</g)).toHaveLength(1);
    expect(out.indexOf("Trigger: slack")).toBeLessThan(out.indexOf("Budget"));
  });

  it("error: Cloud's copy could not be read, so it says so instead of 'not deployed'", () => {
    const out = panel({ view: unreadView("Caveman needs you to sign in again.") });
    expect(out).toContain("Can&#x27;t see Cloud&#x27;s copy");
    expect(out).toContain("Caveman needs you to sign in again. Deploy still works once Cloud answers.");
    expect(out).not.toContain("Not on Cloud yet");
    expect(panel({ error: "Couldn't read it." })).toContain('role="alert"');
  });

  it("a runtime that can't list Cloud's automations: says a merge applies it and Deploy sends it now", () => {
    const out = panel({ view: unlistedView("main") });
    expect(out).toContain("Runs on Cloud");
    expect(out).toContain("Cloud takes it in when it reaches main. Deploy sends it now and shows what Cloud did with it.");
    expect(out).not.toContain("Not on Cloud yet");
  });

  it("an older runtime: says to update, offers nothing", () => {
    const out = panel({ unavailable: true });
    expect(out).toContain("can&#x27;t deploy to Cloud yet");
    expect(out).not.toContain("Not on Cloud yet");
  });
});

describe("a new webhook's one-time URL and secret", () => {
  const hook = { automation: "intake", url: "https://app.caveman.so/api/v1/code/hooks/hk_01jabcdefghijklmnopqrstuvw", secret: "one-time-secret" };

  it("shows the URL and the secret in full, each with its own Copy, and how a sender signs", () => {
    const out = html(createElement(HookSecretsView, { hooks: [hook] }));
    expect(out).toContain(hook.url);
    expect(out).toContain(hook.secret);
    expect(out).toContain('aria-label="Copy the url"');
    expect(out).toContain('aria-label="Copy the secret"');
    expect(out.match(/>Copy</g)).toHaveLength(2);
    expect(out).toContain("X-Caveman-Signature: sha256=");
    expect(out).toContain("X-Caveman-Delivery");
    // One webhook: the dialog's title names it, so the rows don't repeat the name.
    expect(hookTitle([hook])).toBe("intake's webhook");
    expect(out).not.toContain(">intake<");
  });

  it("several at once: each under its automation's name", () => {
    const two = [hook, { automation: "billing-hook", url: "https://app.caveman.so/api/v1/code/hooks/hk_2", secret: "second-secret" }];
    const out = html(createElement(HookSecretsView, { hooks: two }));
    expect(out).toContain(">intake<");
    expect(out).toContain(">billing-hook<");
    expect(out).toContain("second-secret");
    expect(out.match(/>Copy</g)).toHaveLength(4);
    expect(hookTitle(two)).toBe("2 new webhooks");
  });
});

describe("Cloud's gates from Cloud's real run rows (status waiting, requires_action)", () => {
  // A run row as automation.cloud_runs answers it once the run's session waits at an approve: step.
  const waiting = readCloudRun({
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
  const running = readCloudRun({ ...{ id: "r2", automation_id: "aut_1", revision_id: "rev_1", trigger: "schedule", status: "running", outcome: null, session_id: "ses_2", cost_usd: 0, started_at: "2026-10-21T11:00:00Z", finished_at: null }, name: "issue-to-pr" });

  it("the Runs tab: a gate card for the waiting run only, answerable here, its session a click away", () => {
    const out = html(createElement(CloudGates, { runs: [running, waiting], name: "issue-to-pr" }));
    expect(out).toContain("implement waits for the owner&#x27;s approval");
    expect(out).toContain("GitHub issue labelled");
    expect(out).toContain(">Approve<");
    expect(out).toContain(">Reject<");
    expect(out).toContain('href="https://app.caveman.so/code-sessions/ses_1"');
    expect(out.match(/>Approve</g)).toHaveLength(1);
    expect(html(createElement(CloudGates, { runs: [running], name: "issue-to-pr" }))).toBe("");
  });

  it("the Inbox: its Approve group lists the waiting Cloud run under its automation's name", () => {
    remember("gates", []);
    remember("cloud-runs", [running, waiting]);
    const out = html(createElement(Approvals));
    expect(out).toContain('aria-label="Automation runs waiting on you"');
    expect(out).toContain("issue-to-pr");
    expect(out).toContain("implement waits for the owner&#x27;s approval · GitHub issue labelled");
    expect(out).toContain('aria-label="Runs on Cloud"');
    expect(out.match(/role="listitem"/g)).toHaveLength(1);
    remember("cloud-runs", [running]);
    expect(html(createElement(Approvals))).not.toContain("Automation runs waiting on you");
  });
});

describe("approval gates", () => {
  it("a run's gate: what waits, Approve and Reject, busy while the answer goes out", () => {
    const out = html(createElement(GateCard, { title: "implement waits for the owner's approval", where: "this_mac", busy: null, onAnswer: noop }));
    expect(out).toContain("implement waits for the owner&#x27;s approval");
    expect(out).toContain(`The run waits on ${thisComputer} until you answer.`);
    expect(out).toContain(">Approve<");
    expect(out).toContain(">Reject<");
    const busy = html(createElement(GateCard, { title: "t", where: "cloud", busy: "allow", onAnswer: noop }));
    expect(busy).toContain("Approving…");
    expect(busy).toContain("The run waits on Cloud until someone answers.");
  });

  it("an Inbox row: where, the automation, what waits on what, and both answers", () => {
    const row = (where: "this_mac" | "cloud") =>
      html(
        createElement(ApprovalRow, {
          where,
          name: "release-train",
          line: "ship waits for the owner's approval · #12 · Cut 4.2",
          since: "2026-10-21T11:40:00Z",
          now: NOW,
          busy: null,
          runHref: where === "this_mac" ? "/automations/x/runs/r1" : null,
          consoleHref: where === "cloud" ? "https://app.caveman.so/code-sessions/s1" : null,
          onAnswer: noop,
        }),
      );
    const cloud = row("cloud");
    expect(cloud).toContain("release-train");
    expect(cloud).toContain("ship waits for the owner&#x27;s approval · #12 · Cut 4.2");
    expect(cloud).toContain("20m");
    expect(cloud).toContain('aria-label="Runs on Cloud"');
    expect(cloud).toContain('href="https://app.caveman.so/code-sessions/s1"');
    const mac = row("this_mac");
    expect(mac).toContain(`aria-label="Runs on ${THIS_COMPUTER}"`);
    expect(mac).toContain('href="/automations/x/runs/r1"');
    expect(mac).toContain(">Approve<");
  });

  it(`the Inbox lists a ${THIS_COMPUTER} run waiting at its gate however many runs started after it`, async () => {
    const at = (min: number) => new Date(Date.parse("2026-11-06T00:00:00Z") + min * 60_000).toISOString();
    const summary = (run_id: string, automation: string, status: "waiting" | "succeeded", min: number) => ({
      run_id,
      automation_id: `file:p1:project:${automation}`,
      automation,
      project_id: "p1",
      status,
      reason: null,
      trigger: { kind: status === "waiting" ? "github" : "schedule", subject: status === "waiting" ? "github:acme/api#12" : `schedule:${min}` },
      started_at: at(min),
      ended_at: status === "waiting" ? null : at(min + 1),
      spent_usd: 0,
      steps: [{ name: "implement", status }],
    });
    // The gate, then a 5-minute schedule's 200 finished runs after it (about 17 hours of a gate's 72).
    const runs = [summary("run_gate", "issue-to-pr", "waiting", 0), ...Array.from({ length: 200 }, (_, i) => summary(`run_s${i}`, "nightly-check", "succeeded", 5 * (i + 1)))];
    // automation.runs as the runtime answers it: its status filter, newest first, at most `limit`.
    const client = {
      call: async (method: string, p: { status?: string; limit?: number; run_id?: string }) => {
        if (method === "automation.runs") {
          const newest = runs.filter((r) => p.status === undefined || r.status === p.status).sort((a, b) => b.started_at.localeCompare(a.started_at));
          return { runs: newest.slice(0, p.limit ?? 50) };
        }
        if (method === "automation.run_get") {
          const s = runs.find((r) => r.run_id === p.run_id)!;
          return { run: { ...s, steps: [{ ...s.steps[0]!, ...(s.status === "waiting" ? { approval: { by: "owner", expires_at: at(72 * 60) } } : {}) }] } };
        }
        throw new Error(`unexpected ${method}`);
      },
    } as unknown as Client;
    remember("gates", []);
    remember("cloud-runs", []);
    refresh(client, "gates");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const out = html(createElement(Approvals));
    expect(out).toContain('aria-label="Automation runs waiting on you"');
    expect(out).toContain("issue-to-pr");
    expect(out.match(/role="listitem"/g)).toHaveLength(1);
  });
});

describe("the Agents page", () => {
  const file = (o: Partial<AgentFile> = {}): AgentFile => ({ name: "triager", description: "Sorts new issues", source: "project", path: ".caveman/agents/triager.md", project_id: "p1", engine: "caveman", model: "fast", ...o });
  const column = (props: Partial<AgentsViewProps>) =>
    html(createElement(AgentsView, { files: [file()], error: null, cloud: { kind: "ok", agents: [] }, byName: new Map(), card: (f) => createElement("div", { key: f.name }, f.name), ...props }));

  it("loading: placeholder cards, never the empty state", () => {
    const out = column({ files: undefined });
    expect(out).toContain('aria-hidden="true"');
    expect(out).not.toContain("No agents yet");
  });

  it("empty: what an agent is, and where to make one", () => {
    const out = column({ files: [] });
    expect(out).toContain("No agents yet");
    expect(out).toContain("An agent is one Markdown file in .caveman/agents");
  });

  it("error: why the files could not be read", () => {
    const out = column({ files: undefined, error: "runtime gone" });
    expect(out).toContain("Couldn&#x27;t read the agent files");
    expect(out).toContain("runtime gone");
  });

  it("Cloud not served or refused: one quiet line, the files still listed", () => {
    expect(column({ cloud: { kind: "unavailable" } })).toContain("can&#x27;t publish to Cloud yet");
    const refused = column({ cloud: { kind: "error", message: "Caveman needs you to sign in again." } });
    expect(refused).toContain("Cloud didn&#x27;t answer:");
    expect(refused).toContain('href="/settings/account"');
    expect(refused).toContain("triager");
  });

  const card = (view: Parameters<typeof AgentCardView>[0]["view"], cloud: CloudReach = { kind: "ok", agents: [] }) =>
    html(createElement(AgentCardView, { file: file(), projectName: "api", view, cloud, selected: false }));

  it("a card: its name, project, and the version Cloud runs", () => {
    const changed = card({ label: "v3, changed here", tone: "changed", action: "Publish v4" });
    expect(changed).toContain("triager");
    expect(changed).toContain("api");
    expect(changed).toContain("v3, changed here");
    expect(changed).toContain('href="/automations/agents/p1/triager"');
    expect(card({ label: "Not published", tone: "none", action: "Publish" })).toContain("Not published");
    expect(card(null, { kind: "unavailable" })).not.toContain("Publish");
  });

  const publish = (view: Parameters<typeof PublishView>[0]["view"], cloud: CloudReach = { kind: "ok", agents: [] }, busy = false) => html(createElement(PublishView, { view, cloud, busy, onPublish: noop }));

  it("Publish: unpublished, changed since its version, up to date, publishing", () => {
    expect(publish({ label: "Not published", tone: "none", action: "Publish" })).toContain(">Publish<");
    expect(publish({ label: "v3, changed here", tone: "changed", action: "Publish v4" })).toContain(">Publish v4<");
    expect(publish({ label: "v3", tone: "published", action: null })).toContain("Up to date");
    expect(publish({ label: "Not published", tone: "none", action: "Publish" }, undefined, true)).toContain("Publishing…");
    expect(publish(null, { kind: "unavailable" })).toBe("");
  });
});

describe("a chat's offer to publish the agent it wrote", () => {
  const strip = (state: Parameters<typeof PublishOfferView>[0]["state"]) => html(createElement(PublishOfferView, { path: ".caveman/agents/triager.md", state, onPublish: noop, onDismiss: noop }));

  it("offers, publishes, says the version, or why not", () => {
    expect(strip({ kind: "offer" })).toContain("is written. Publish it so Cloud can run it on its own.");
    expect(strip({ kind: "offer" })).toContain("Publish to Cloud");
    expect(strip({ kind: "busy" })).toContain("Publishing…");
    const done = strip({ kind: "done", version: 1, href: "https://app.caveman.so/code-agents/agt_1" });
    expect(done).toContain("as v1.");
    expect(done).toContain("Open in Platform");
    expect(strip({ kind: "failed", message: "Caveman needs you to sign in again." })).toContain("Try again");
  });
});

describe("Settings > Account > Caveman Platform", () => {
  it("links each console page on the Cloud this runtime signs in to", () => {
    const out = html(createElement(CloudConsoleView, { base: "https://cloud.acme.internal" }));
    for (const p of CONSOLE_PAGES) expect(out).toContain(`href="https://cloud.acme.internal${p.path.replace(/&/g, "&amp;")}"`);
    expect(out).toContain("Service accounts and keys");
    expect(out).toContain("Code policy");
    expect(out).toContain("Automations board");
    expect(out).toContain("Caveman Platform");
  });
});
