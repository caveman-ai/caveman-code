import type { Client } from "@caveman-app/session-protocol/client";
import { describe, expect, it } from "vitest";
import { LIST, patch, refresh, remember } from "./data.ts";
import type { Automation, RunSummary } from "./model.ts";

// The Automations page's one cache, around a write: what the page shows once reads from before the write answer.

const digest = {
  id: "task-digest",
  title: "Daily digest",
  enabled: true,
  project_id: "p1",
} as unknown as Automation;
const other = {
  id: "task-other",
  title: "Other",
  enabled: true,
  project_id: "p1",
} as unknown as Automation;

/** A runtime whose list reads answer when the test says, each with what the runtime held when it read. */
function slowList(held: () => ReadonlyArray<Automation>) {
  const reads: Array<() => void> = [];
  const client = {
    call: (method: string) => {
      if (method !== "automation.list") return Promise.resolve({});
      const automations = held();
      return new Promise((resolve) => reads.push(() => resolve({ automations })));
    },
  } as unknown as Client;
  return { client, reads };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const shown = (): ReadonlyArray<Automation> => {
  let seen: ReadonlyArray<Automation> = [];
  patch<ReadonlyArray<Automation>>(LIST, (v) => ((seen = v), v));
  return seen;
};

describe("a read from before a write", () => {
  it("a switch flipped while the list is being read stays flipped when that read answers", async () => {
    remember<ReadonlyArray<Automation>>(LIST, [digest]);
    const { client, reads } = slowList(() => [digest]);
    // Opening the page reads the list; the person turns the automation off before it answers (as setEnabled does).
    refresh(client, LIST);
    patch<ReadonlyArray<Automation>>(LIST, (list) => list.map((x) => ({ ...x, enabled: false })));
    for (const answer of reads) answer();
    await flush();
    expect(shown().map((a) => [a.id, a.enabled])).toEqual([["task-digest", false]]);
  });

  it("a deleted automation stays out of the list when a read from before the delete answers", async () => {
    remember<ReadonlyArray<Automation>>(LIST, [digest, other]);
    let held = [digest, other];
    const { client, reads } = slowList(() => held);
    refresh(client, LIST);
    // The runtime deletes it; the page takes it out and reads again (as remove does).
    held = [other];
    patch<ReadonlyArray<Automation>>(LIST, (list) => list.filter((x) => x.id !== digest.id));
    refresh(client, LIST);
    for (const answer of reads) answer();
    await flush();
    expect(shown().map((a) => a.id)).toEqual(["task-other"]);
  });

  it("a save reads the list again though a read from before it is still out, and the older answer never lands over it", async () => {
    remember<ReadonlyArray<Automation>>(LIST, [digest]);
    let held = [digest];
    const { client, reads } = slowList(() => held);
    refresh(client, LIST);
    // The file is saved with a new description; the page reads the list again (as the File tab's save does).
    held = [{ ...digest, title: "Morning digest" }];
    refresh(client, LIST);
    expect(reads).toHaveLength(2);
    reads[1]!();
    await flush();
    reads[0]!();
    await flush();
    expect(shown().map((a) => a.title)).toEqual(["Morning digest"]);
  });
});

describe("the list's Agent runs", () => {
  const run = (runId: string, automation: string, at: string): RunSummary =>
    ({
      run_id: runId,
      automation_id: automation.startsWith("agent-")
        ? `agent:p1:${automation.slice(6)}`
        : `file:p1:project:${automation}`,
      automation,
      project_id: "p1",
      status: "succeeded",
      trigger: { kind: automation.startsWith("agent-") ? "manual" : "schedule", subject: "s" },
      started_at: at,
      ended_at: at,
      spent_usd: 0,
      steps: [],
    }) as unknown as RunSummary;
  /** automation.runs as the runtime's journal answers it: newest first, `limit` of them, `agent_runs` only agent.run's. */
  const journal = (runs: ReadonlyArray<RunSummary>) =>
    ({
      call: async (method: string, p: { agent_runs?: true; limit?: number }) => {
        if (method !== "automation.runs") return {};
        const asked = runs.filter((r) => !p.agent_runs || r.automation_id.startsWith("agent:"));
        return {
          runs: [...asked]
            .sort((a, b) => b.started_at.localeCompare(a.started_at))
            .slice(0, p.limit ?? 50),
        };
      },
    }) as unknown as Client;

  it("an agent run stays listed after a 5-minute schedule makes 100 newer runs", async () => {
    const start = Date.parse("2026-11-06T09:00:00.000Z");
    const busy = Array.from({ length: 100 }, (_, i) =>
      run(`r_lint_${i}`, "lint", new Date(start + (i + 1) * 300_000).toISOString()),
    );
    const client = journal([
      run("r_agent", "agent-reviewer", new Date(start).toISOString()),
      ...busy,
    ]);
    remember<ReadonlyArray<RunSummary>>("agent-runs", []);
    refresh(client, "agent-runs");
    await flush();
    let seen: ReadonlyArray<RunSummary> = [];
    patch<ReadonlyArray<RunSummary>>("agent-runs", (v) => ((seen = v), v));
    expect(seen.map((r) => r.run_id)).toEqual(["r_agent"]);
  });
});
