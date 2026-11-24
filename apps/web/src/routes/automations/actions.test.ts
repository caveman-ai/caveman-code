import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { CallTimeout, DEFAULT_TIMEOUT_MS } from "@caveman-app/session-protocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeFixture, type RuntimeContextValue } from "../../state/runtime.tsx";
import { Notices, useActions } from "./actions.tsx";
import { LIST, patch, refresh, remember } from "./data.ts";
import type { Automation } from "./model.ts";

// What a row's menu and an automation's page do, through the real useActions() over a scripted runtime.

type Call = { method: string; params: Record<string, unknown> };
type Answer = (method: string, params: Record<string, unknown>) => unknown;

/** `deadlines`: each call is held to its deadline as the real client holds it (DEFAULT_TIMEOUT_MS unless it names one). */
function runtimeWith(
  answer: Answer | null,
  world: { projects?: ReadonlyArray<{ id: string; path: string }>; deadlines?: boolean } = {},
) {
  const calls: Call[] = [];
  const client =
    answer &&
    ({
      call: async (
        method: string,
        params: Record<string, unknown>,
        options?: { timeoutMs?: number },
      ) => {
        calls.push({ method, params });
        if (!world.deadlines) return answer(method, params);
        const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new CallTimeout(method as never, timeoutMs)),
            timeoutMs,
          );
          Promise.resolve()
            .then(() => answer(method, params))
            .then(resolve, reject)
            .finally(() => clearTimeout(timer));
        });
      },
      on: () => () => undefined,
    } as unknown as RuntimeContextValue["client"]);
  let actions: ReturnType<typeof useActions> | undefined;
  const Probe = () => {
    actions = useActions();
    return null;
  };
  const value = {
    status: "connected",
    client,
    projects: world.projects ?? [],
    engines: [],
    settings: null,
    workspaces: [],
    adopt: () => undefined,
  } as unknown as RuntimeContextValue;
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(RuntimeFixture, { value, children: createElement(Probe) }),
    ),
  );
  return { actions: actions!, calls, client };
}

const notice = () => renderToStaticMarkup(createElement(Notices));
/** What the list shows now. */
const listed = (): ReadonlyArray<string> => {
  let seen: ReadonlyArray<Automation> = [];
  patch<ReadonlyArray<Automation>>(LIST, (v) => ((seen = v), v));
  return seen.map((a) => a.id);
};
const NAME = /^(?!.*__)[a-z][a-z0-9_-]{0,39}$/;

describe("Duplicate", () => {
  const file = (name: string) =>
    ({
      id: `file:p1:project:${name}`,
      path: `.caveman/automations/${name}.yaml`,
      project_id: "p1",
      source: "file",
      scope: "project",
      title: name,
      enabled: true,
    }) as unknown as Automation;
  const answer: Answer = (method, params) => {
    if (method === "automation.file_read")
      return { text: "version: 1\nsteps:\n  run:\n    prompt: hi\n" };
    if (method === "automation.create") {
      const { name } = params.from as { name: string };
      return { automation: file(name), written: [`.caveman/automations/${name}.yaml`] };
    }
    if (method === "automation.list") return { automations: [] };
    return {};
  };
  const createdName = (calls: ReadonlyArray<Call>) =>
    (
      calls.find((c) => c.method === "automation.create")?.params.from as
        | { name?: string }
        | undefined
    )?.name;

  // The free-name search is synchronous: had it no end, the test worker would hang instead of failing, as the window did.
  const realHas = Set.prototype.has;
  let lookups = 0;
  beforeEach(() => {
    lookups = 0;
    // oxlint-disable-next-line no-extend-native -- counts the free-name lookups; afterEach puts the real one back.
    Set.prototype.has = function (this: Set<unknown>, v: unknown) {
      if (typeof v === "string" && /^(review|label)-/.test(v) && ++lookups > 10_000)
        throw new Error(`no free name after ${lookups} tries (last: ${v})`);
      return realHas.call(this, v);
    };
  });
  afterEach(() => {
    // oxlint-disable-next-line no-extend-native -- puts the real one back.
    Set.prototype.has = realHas;
  });

  it("a 40-character name (New automation's slug of a long title) gets a copy under a free name", async () => {
    const a = file("review-every-new-pull-request-for-securi");
    const { actions, calls } = runtimeWith(answer);
    await actions.duplicate(a, [a]);
    expect(notice()).not.toContain("Couldn&#x27;t duplicate");
    const name = createdName(calls);
    expect(name).toBe("review-every-new-pull-request-for-s-copy");
    expect(name).toMatch(NAME);
  });

  it("a 37-character name duplicates twice into two different copies", async () => {
    const a = file("label-new-issues-by-area-and-priority");
    const first = runtimeWith(answer);
    await first.actions.duplicate(a, [a]);
    const one = createdName(first.calls)!;
    const second = runtimeWith(answer);
    await second.actions.duplicate(a, [a, file(one)]);
    expect(notice()).not.toContain("Couldn&#x27;t duplicate");
    const two = createdName(second.calls)!;
    expect([one, two]).toEqual([
      "label-new-issues-by-area-and-priori-copy",
      "label-new-issues-by-area-and-prio-copy-2",
    ]);
    for (const n of [one, two]) expect(n).toMatch(NAME);
  });

  it("a short name keeps its whole name before -copy", async () => {
    const a = file("triage");
    const { actions, calls } = runtimeWith(answer);
    await actions.duplicate(a, [a, file("triage-copy")]);
    expect(createdName(calls)).toBe("triage-copy-2");
  });
});

describe("Delete", () => {
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
  beforeEach(() => remember<ReadonlyArray<Automation>>(LIST, [digest, other]));

  it("the runtime refuses: the automation stays in the list, and the page is told it is still there", async () => {
    const { actions } = runtimeWith((method) => {
      if (method === "automation.delete")
        throw {
          error: {
            code: "invalid_state",
            message: ".caveman/automations/digest.yaml could not be deleted: EACCES.",
          },
        };
      if (method === "automation.list") return new Promise(() => undefined);
      return {};
    });
    const deleted = await actions.remove(digest);
    expect(notice()).toContain("Couldn&#x27;t delete Daily digest");
    expect(listed()).toEqual(["task-digest", "task-other"]);
    expect(deleted).toBe(false);
  });

  it("no runtime to ask: the automation stays in the list", async () => {
    const { actions } = runtimeWith(null);
    const deleted = await actions.remove(digest);
    expect(notice()).toContain("Not connected to a runtime.");
    expect(listed()).toEqual(["task-digest", "task-other"]);
    expect(deleted).toBe(false);
  });

  it("the runtime deletes it: it leaves the list", async () => {
    const { actions, calls } = runtimeWith((method) =>
      method === "automation.list" ? new Promise(() => undefined) : {},
    );
    const deleted = await actions.remove(digest);
    expect(calls.map((c) => c.method)).toEqual(["automation.delete", "automation.list"]);
    expect(listed()).toEqual(["task-other"]);
    expect(deleted).toBe(true);
  });
});

describe("The on switch", () => {
  const digest = {
    id: "task-digest",
    title: "Daily digest",
    enabled: true,
    project_id: "p1",
  } as unknown as Automation;

  it("a list read that starts while the switch's write is out never flips it back", async () => {
    remember<ReadonlyArray<Automation>>(LIST, [digest]);
    let held = [digest];
    let applied!: () => void;
    const reads: Array<() => void> = [];
    const { actions, client } = runtimeWith((method) => {
      if (method === "automation.set_enabled")
        return new Promise(
          (resolve) => (applied = () => ((held = [{ ...digest, enabled: false }]), resolve({}))),
        );
      if (method !== "automation.list") return {};
      const automations = held;
      return new Promise((resolve) => reads.push(() => resolve({ automations })));
    });
    const toggling = actions.setEnabled(digest, false);
    // A list read (a poll, another page mounting) reaches the runtime before the write does.
    refresh(client, LIST);
    applied();
    await toggling;
    for (const answer of reads) answer();
    await new Promise((resolve) => setTimeout(resolve, 0));
    let shown: ReadonlyArray<Automation> = [];
    patch<ReadonlyArray<Automation>>(LIST, (v) => ((shown = v), v));
    expect(shown.map((a) => [a.id, a.enabled])).toEqual([["task-digest", false]]);
  });
});

describe("Save as file", () => {
  const app = {
    id: "task-standup",
    source: "app",
    title: "Standup summary",
    prompt: "Summarise the notes.",
    enabled: true,
    trigger: { type: "daily", time: "09:00" },
    project_id: "p1",
  } as unknown as Automation;
  const saving = (errors: number) =>
    runtimeWith((method, params) => {
      if (method === "automation.create") {
        const { name } = params.from as { name: string };
        const path = `.caveman/local/automations/${name}.yaml`;
        return {
          automation: {
            id: `file:p1:me:${name}`,
            source: "file",
            scope: "me",
            path,
            title: name,
            diagnostics: errors,
            errors,
          },
          written: [path],
        };
      }
      if (method === "automation.list") return new Promise(() => undefined);
      return {};
    });

  it("the new file loads: the app's copy turns off, so nothing runs twice", async () => {
    const { actions, calls } = saving(0);
    await actions.saveAsFile(app);
    expect(calls.find((c) => c.method === "automation.set_enabled")?.params).toMatchObject({
      id: "task-standup",
      enabled: false,
    });
  });

  it("the new file has errors: the app's copy stays on, so the schedule keeps running", async () => {
    const { actions, calls } = saving(1);
    await actions.saveAsFile(app);
    expect(calls.map((c) => c.method)).not.toContain("automation.set_enabled");
    expect(notice()).toContain("the app&#x27;s copy stays on");
  });
});

describe("Commit and open PR", () => {
  // A repository whose commit hooks (husky, lint-staged, tsc) take six minutes: the runtime gives a commit ten.
  const HOOKS_MS = 6 * 60_000;
  const nightly = {
    id: "file:p1:project:nightly",
    path: ".caveman/automations/nightly.yaml",
    project_id: "p1",
    source: "file",
    scope: "project",
    title: "Nightly",
    enabled: true,
  } as unknown as Automation;
  const answer: Answer = (method) => {
    if (method === "automation.explain") return { explanation: null };
    if (method === "agent.types") return { types: [] };
    if (method === "automation.file_read")
      return { text: "version: 1\nsteps:\n  run:\n    prompt: hi\n" };
    if (method === "workspace.create") return { id: "w1", branch: "caveman/automation-nightly" };
    if (method === "git.commit")
      return new Promise((resolve) =>
        setTimeout(() => resolve({ sha: "0123456789abcdef" }), HOOKS_MS),
      );
    if (method === "git.push")
      return { branch: "caveman/automation-nightly", sha: "0123456789abcdef" };
    if (method === "git.pr")
      return { number: 7, url: "https://github.com/acme/app/pull/7", state: "open" };
    return {};
  };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a commit whose hooks take six minutes still pushes and opens the pull request", async () => {
    const { actions, calls } = runtimeWith(answer, {
      projects: [{ id: "p1", path: "/repo" }],
      deadlines: true,
    });
    const opening = actions.openPr(nightly);
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    expect(notice()).not.toContain("Couldn&#x27;t open a pull request");
    await vi.advanceTimersByTimeAsync(HOOKS_MS - DEFAULT_TIMEOUT_MS);
    expect(await opening).toBe("https://github.com/acme/app/pull/7");
    expect(notice()).toContain("Opened pull request #7.");
    expect(calls.map((c) => c.method).slice(-3)).toEqual(["git.commit", "git.push", "git.pr"]);
  });
});
