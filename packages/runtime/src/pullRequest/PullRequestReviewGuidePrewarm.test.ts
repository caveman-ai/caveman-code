import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_SETTINGS, type PullRequestListResult, type ServerProvider } from "@caveman-app/protocol";
import type { SessionEvent } from "@caveman-app/session-protocol";

import {
  engineActivity,
  newlyLinkedPullRequest,
  prewarmCandidates,
  prewarmWriter,
} from "./PullRequestReviewGuidePrewarm.ts";

const entry = (number: number, fields: Record<string, unknown>) => ({
  provider: "github",
  host: "github.com",
  projectId: "p1",
  projectTitle: "app",
  repository: "acme/app",
  number,
  title: `#${number}`,
  url: `https://github.com/acme/app/pull/${number}`,
  author: { login: "someone" },
  headBranch: `b${number}`,
  baseBranch: "main",
  state: "open",
  isDraft: false,
  viewerReviewRequested: false,
  labels: [],
  ...fields,
});

describe("prewarmCandidates", () => {
  it("picks pull requests asking for my review and my own, never drafts or closed ones", () => {
    const listed = {
      viewers: { "github.com": "Julius" },
      entries: [
        entry(1, { viewerReviewRequested: true }),
        entry(2, { author: { login: "julius" } }),
        entry(3, {}),
        entry(4, { author: { login: "julius" }, isDraft: true }),
        entry(5, { viewerReviewRequested: true, isDraft: true }),
        entry(6, { viewerReviewRequested: true, state: "merged" }),
        entry(7, { author: null, host: "gitlab.com", viewerReviewRequested: false }),
      ],
    } as unknown as PullRequestListResult;
    expect(prewarmCandidates(listed)).toEqual([
      { projectId: "p1", repository: "acme/app", number: 1, host: "github.com" },
      { projectId: "p1", repository: "acme/app", number: 2, host: "github.com" },
    ]);
  });
});

const turn = (type: "turn.started" | "turn.done", session: string, at: number, engine = "claude-agent") =>
  ({
    session_id: session,
    cursor: 1,
    at: new Date(at).toISOString(),
    type,
    payload: type === "turn.started" ? { engine } : { status: "completed" },
  }) as unknown as SessionEvent;

describe("engineActivity", () => {
  const twoMinutes = DEFAULT_SERVER_SETTINGS.reviewGuidePrewarmIdleMinutes * 60_000;

  it("is idle two minutes after the engine's last turn ended, never during one", () => {
    const activity = engineActivity();
    expect(activity.idle("claude-agent", 0, twoMinutes)).toBe(true);
    activity.observe(turn("turn.started", "s1", 1_000));
    activity.observe(turn("turn.started", "s2", 2_000, "codex"));
    expect(activity.idle("claude-agent", 10 * 60_000, twoMinutes)).toBe(false);
    activity.observe(turn("turn.done", "s1", 60_000));
    expect(activity.idle("claude-agent", 60_000 + 119_000, twoMinutes)).toBe(false);
    expect(activity.idle("claude-agent", 60_000 + 120_000, twoMinutes)).toBe(true);
    // Another engine's turn in flight does not hold this one.
    expect(activity.idle("codex", 10 * 60_000, twoMinutes)).toBe(false);
  });

  it("waits as long as the setting says, and not at all at 0", () => {
    const activity = engineActivity();
    activity.observe(turn("turn.started", "s1", 1_000));
    activity.observe(turn("turn.done", "s1", 60_000));
    expect(activity.idle("claude-agent", 60_000, 0)).toBe(true);
    expect(activity.idle("claude-agent", 60_000 + 9 * 60_000, 10 * 60_000)).toBe(false);
    expect(activity.idle("claude-agent", 60_000 + 10 * 60_000, 10 * 60_000)).toBe(true);
  });
});

const claude = (fields: Record<string, unknown> = {}) =>
  ({
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    auth: { status: "authenticated", type: "max" },
    usageLimits: { windows: [{ usedPercent: 40 }] },
    ...fields,
  }) as unknown as ServerProvider;
const haiku = { instanceId: "claudeAgent", model: "claude-haiku-5-5" } as never;

describe("prewarmWriter", () => {
  const gate = (overrides: Partial<Parameters<typeof prewarmWriter>[0]> = {}) =>
    prewarmWriter({
      writers: [haiku],
      providers: [claude()],
      idle: () => true,
      runsToday: 0,
      settings: DEFAULT_SERVER_SETTINGS,
      ...overrides,
    });

  it("lets the first writer run on an idle login with room in its plan", () => {
    expect(gate()).toBe(haiku);
    // A login that does not name its plan is still a login.
    expect(gate({ providers: [claude({ auth: { status: "authenticated" } })] })).toBe(haiku);
  });

  it("writes templates only while the engine is busy, the plan is 70% used, or today's cap is spent", () => {
    expect(gate({ idle: () => false })).toBeNull();
    expect(gate({ providers: [claude({ usageLimits: { windows: [{ usedPercent: 10 }, { usedPercent: 70 }] } })] })).toBeNull();
    expect(gate({ runsToday: 19 })).toBe(haiku);
    expect(gate({ runsToday: 20 })).toBeNull();
  });

  it("takes its cap and plan limit from settings, 0 runs a day meaning templates only", () => {
    const settings = (daily: number, planPercent: number) => ({ reviewGuidePrewarmDaily: daily, reviewGuidePrewarmPlanPercent: planPercent });
    expect(gate({ runsToday: 40, settings: settings(50, 70) })).toBe(haiku);
    expect(gate({ settings: settings(0, 70) })).toBeNull();
    // The plan window is 40% used.
    expect(gate({ settings: settings(20, 40) })).toBeNull();
    expect(gate({ settings: settings(20, 41) })).toBe(haiku);
  });

  it("never spends an API key, the Caveman engine's included, or a writer it cannot see", () => {
    expect(gate({ providers: [claude({ auth: { status: "authenticated", type: "apiKey" } })] })).toBeNull();
    const cavemanWith = (subProvider: string) =>
      claude({ instanceId: "caveman", driver: "caveman", models: [{ slug: "deepseek-flash", subProvider }] });
    const flash = { instanceId: "caveman", model: "deepseek-flash" } as never;
    expect(gate({ writers: [flash], providers: [cavemanWith("deepseek")] })).toBeNull();
    // Caveman credits are a subscription the person already pays for.
    expect(gate({ writers: [flash], providers: [cavemanWith("caveman")] })).toBe(flash);
    expect(gate({ providers: [] })).toBeNull();
    expect(gate({ writers: [] })).toBeNull();
  });

  it("asks about the writer's own engine", () => {
    const asked: Array<string> = [];
    gate({ idle: (engine) => (asked.push(engine), true) });
    expect(asked).toEqual(["claude-agent"]);
  });
});

describe("newlyLinkedPullRequest", () => {
  const linkEvent = (fields: Record<string, unknown>) =>
    ({
      type: "thread.pull-request-link-updated",
      threadId: "thread-1",
      payload: { host: "github.com", repository: "acme/app", number: 7, url: "u", source: "agent", snapshot: null, ...fields },
    }) as never;

  it("starts a guide for a pull request a chat just opened or linked, saying which", () => {
    for (const source of ["agent", "created", "manual"]) {
      // The source decides whether its guide is posted: never for one a person linked.
      expect(newlyLinkedPullRequest(linkEvent({ source }))).toEqual({
        threadId: "thread-1",
        host: "github.com",
        repository: "acme/app",
        number: 7,
        source,
      });
    }
  });

  it("leaves stack links, synced links and other events alone", () => {
    expect(newlyLinkedPullRequest(linkEvent({ source: "stack" }))).toBeNull();
    expect(newlyLinkedPullRequest(linkEvent({ source: "stack-dismissed" }))).toBeNull();
    expect(newlyLinkedPullRequest(linkEvent({ snapshot: { state: "open" } }))).toBeNull();
    expect(newlyLinkedPullRequest({ type: "run.updated", threadId: "thread-1", payload: {} } as never)).toBeNull();
  });
});
