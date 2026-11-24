import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeContextValue } from "../../state/runtime.tsx";
import type { Applied, CloudAutomation } from "./cloud.ts";
import type { Automation } from "./model.ts";

// An automation's Cloud panel, through the real useCloudState: this computer's last Deploy answer against Cloud's own
// list. The answer is kept in localStorage, which outlives a restart (here, a module reload).
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const automation = {
  id: "file:p1:project:issue-to-pr",
  title: "issue-to-pr",
  enabled: true,
  trigger: { type: "file", kinds: ["manual", "github"], words: [] },
  project_id: "p1",
  source: "file",
  scope: "project",
  host: "cloud",
  path: ".caveman/automations/issue-to-pr.yaml",
} as unknown as Automation;

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

/** What Deploy answered here: revision 2 may do more, so it waits for the owner. */
const deployed = (o: Partial<Applied> = {}): Applied => ({
  id: "auto_1",
  name: "issue-to-pr",
  revision_id: "rev_000000000002",
  state: "pending_approval",
  reason: "widens",
  authority_diff: {
    widens: true,
    changes: [
      { key: "on.slack", change: "added", before: null, after: "mention in #eng", widens: true },
    ],
  },
  applied_at: hoursAgo(2),
  from_here: true,
  repo: "acme/api",
  ...o,
});

/** What Cloud's list says (automation.cloud_list). */
const listed = (o: Partial<CloudAutomation> = {}): CloudAutomation => ({
  id: "auto_1",
  name: "issue-to-pr",
  repo: "acme/api",
  path: ".caveman/automations/issue-to-pr.yaml",
  enabled: true,
  state: "active",
  revision_id: "rev_000000000002",
  applied_at: hoursAgo(2),
  ...o,
});

async function app() {
  const data = await import("./data.ts");
  const { CloudPanel } = await import("./CloudParts.tsx");
  const { RuntimeContext } = await import("../../state/runtime.tsx");
  const runtime = {
    client: null,
    settings: null,
    engines: [],
    workspaces: [],
    projects: [{ id: "p1", path: "/repo", repository: { full_name: "acme/api" } }],
    refresh: async () => undefined,
  } as unknown as RuntimeContextValue;
  const panel = () =>
    renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(
          RuntimeContext.Provider,
          { value: runtime },
          createElement(CloudPanel, { automation }),
        ),
      ),
    );
  return { data, panel };
}

describe("the Cloud panel says what Cloud holds", () => {
  beforeEach(() => {
    store.clear();
    vi.resetModules();
  });

  it("the owner approved the revision deployed from here: after a restart it is on Cloud, no longer waiting", async () => {
    (await app()).data.rememberApplied("p1", [deployed()]);
    vi.resetModules();
    const { data, panel } = await app();
    data.remember("cloud-runs", []);
    data.remember("cloud-list", [listed({ state: "active" })]);
    const out = panel();
    expect(out).not.toContain("Waiting for approval");
    expect(out).toContain("On Cloud");
    expect(out).toContain("Revision 0000002, deployed from here 2h ago.");
  });

  it("a merge applied a newer revision since: the panel names Cloud's revision, not the one deployed from here", async () => {
    const { data, panel } = await app();
    data.rememberApplied("p1", [
      deployed({ state: "active", authority_diff: { widens: false, changes: [] } }),
    ]);
    data.remember("cloud-runs", []);
    data.remember("cloud-list", [
      listed({ revision_id: "rev_000000000003", applied_at: hoursAgo(1) }),
    ]);
    expect(panel()).toContain("Revision 0000003, deployed 1h ago.");
  });

  it("just deployed, and Cloud's list was read before that: the panel shows what the Deploy answered", async () => {
    const { data, panel } = await app();
    data.remember("cloud-runs", []);
    data.remember("cloud-list", [
      listed({ revision_id: "rev_000000000001", applied_at: hoursAgo(30) }),
    ]);
    data.rememberApplied("p1", [deployed({ applied_at: new Date().toISOString() })]);
    const out = panel();
    expect(out).toContain("Waiting for approval");
    expect(out).toContain("Revision 0000002, deployed from here");
  });

  it("this runtime serves no Cloud list: the panel shows what the last Deploy answered", async () => {
    const { data, panel } = await app();
    data.rememberApplied("p1", [deployed()]);
    data.remember("cloud-runs", []);
    data.remember("cloud-list", null);
    expect(panel()).toContain("Waiting for approval");
  });
});
