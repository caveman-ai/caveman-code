// A guide run the page started that ends with no guide and no failure (the runtime keeps runs in memory, so a restart
// drops one in progress): the Guide tab says so and offers the run again, rather than "Starting the guide…" for good.
// No second run starts by itself (a run costs a model call; the reader presses for it).
import { buttons, render, window } from "../dom.test-support.ts";
import type { PrDetail, PrGuide, PrGuideResult } from "@caveman-app/session-protocol";
import type { Client } from "@caveman-app/session-protocol/client";
import { act, createElement } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import { GUIDE_RUN_LOST, invalidatePr, usePrGuide } from "./data.ts";
import { Guide } from "./Guide.tsx";

afterEach(() => void vi.useRealTimers());

const detail: PrDetail = {
  project_id: "p1",
  repo: "acme/app",
  host: "github.com",
  number: 61,
  title: "Close the handle",
  url: "https://github.com/acme/app/pull/61",
  head_branch: "fix/handle",
  base_branch: "main",
  state: "open",
  additions: 180,
  deletions: 40,
  created_at: "2026-11-05T09:00:00.000Z",
  updated_at: "2026-11-05T10:00:00.000Z",
  review_requested: true,
  mine: false,
  body: "",
  head_sha: "abc",
  mergeable: "clean",
  checks_list: [],
  reviewers: [],
  commits: 1,
  files: [{ path: "src/app.ts", status: "modified", additions: 180, deletions: 40, viewed: false }],
  can: { merge: false, review: true, comment: true, merge_methods: [], ready: false },
};

/**
 * A runtime whose guide runs live in memory, as PullRequestReviewGuideService's do: `restart` drops them. With
 * `refuse`, the first press is refused with it, as generate() refuses one when the head moves under the claim.
 */
function runtime(stored: PrGuide | null = null, refuse?: string) {
  let running = false;
  const presses: Array<Record<string, unknown>> = [];
  const client = {
    call: (method: string, params: Record<string, unknown>) => {
      if (method !== "pr.guide") return Promise.resolve({ prs: [], viewers: {}, errors: [] });
      if (params.generate === true) {
        presses.push(params);
        if (refuse && presses.length === 1) return Promise.reject(new Error(refuse));
        running = true;
      }
      return Promise.resolve({ guide: stored, running, head_sha: "abc" } satisfies PrGuideResult);
    },
  } as unknown as Client;
  return { client, presses, restart: () => void (running = false) };
}

/** The Guide tab as PrPage wires it, on a long change. */
function GuideTab({ client, number }: { client: Client; number: number }) {
  const guide = usePrGuide(
    client,
    { project_id: "p1", number, repo: "acme/app", host: "github.com" },
    { short: false },
  );
  return createElement(Guide, {
    detail,
    guide: guide.value,
    guideError: guide.error,
    files: new Map(),
    diffLoading: false,
    read: new Set<number>(),
    onRead: () => undefined,
    onGenerate: () => guide.generate(),
    onPost: async () => undefined,
    onOpenFile: () => undefined,
    onAsk: async () => undefined,
    depth: "tour",
    lines: 220,
    limit: 30,
    diff: null,
    onWriteTour: () => undefined,
    tourAsked: false,
  });
}

const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
const press = async (el: Element | undefined) => {
  if (!el) throw new Error("nothing to press");
  await act(async () => {
    const e = new (window.Event as unknown as typeof Event)("click", {
      bubbles: true,
      cancelable: true,
    });
    Object.assign(e, {
      button: 0,
      buttons: 0,
      detail: 1,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    });
    el.dispatchEvent(e);
  });
  await flush();
};

test("a guide run the runtime dropped on a restart is offered again, and none starts by itself", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const host = runtime();
  const open = () =>
    render(
      createElement(
        MemoryRouter,
        null,
        createElement(GuideTab, { client: host.client, number: 61 }),
      ),
    );

  // Opened with no guide: the page starts the one run for this head, and polls it.
  let page = await open();
  await flush();
  expect(host.presses).toHaveLength(1);
  expect(page.host.textContent).toContain("Caveman is reading the change…");

  // The runtime restarts mid-run; the poll's next read finds no guide, no run and no failure.
  host.restart();
  await act(() => vi.advanceTimersByTimeAsync(2500));
  await flush();
  expect(page.host.textContent).not.toContain("Starting the guide…");
  expect(page.host.textContent).toContain(GUIDE_RUN_LOST);
  expect(buttons(page.host, "Try again")).toHaveLength(1);
  expect(host.presses).toHaveLength(1);

  // Leaving the page and coming back offers it too.
  await page.unmount();
  page = await open();
  await flush();
  expect(buttons(page.host, "Try again")).toHaveLength(1);
  expect(host.presses).toHaveLength(1);

  await press(buttons(page.host, "Try again")[0]);
  expect(host.presses).toHaveLength(2);
  expect(page.host.textContent).toContain("Caveman is reading the change…");
});

test("the tour a long change's chat TL;DR waits for, dropped on a restart, is offered again", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const tldr: PrGuide = {
    head_sha: "abc",
    generated_at: "2026-11-05T10:01:00.000Z",
    tldr: "Closes the handle on every path.",
    depth: "tldr",
    by: "chat",
    stops: [],
  };
  const host = runtime(tldr);
  const page = await render(
    createElement(MemoryRouter, null, createElement(GuideTab, { client: host.client, number: 62 })),
  );
  await flush();
  expect(host.presses).toHaveLength(1);
  expect(page.host.textContent).toContain("Caveman is reading the change…");

  host.restart();
  await act(() => vi.advanceTimersByTimeAsync(2500));
  await flush();
  expect(page.host.textContent).toContain(GUIDE_RUN_LOST);
  expect(host.presses).toHaveLength(1);
  await press(buttons(page.host, "Try again")[0]);
  expect(host.presses).toHaveLength(2);
});

test("a guide run that never started, read again later, still says why it did not start, not that a run stopped", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const refusal = "The pull request changed while the guide was starting. Try again.";
  const host = runtime(null, refusal);
  const pr = { project_id: "p1", number: 63, repo: "acme/app", host: "github.com" };
  const page = await render(
    createElement(MemoryRouter, null, createElement(GuideTab, { client: host.client, number: 63 })),
  );
  await flush();
  expect(host.presses).toHaveLength(1);
  expect(page.host.textContent).toContain(refusal);

  // A write on the page reads the guide again: no guide, no run, no failure, and the refusal no longer the read's error.
  invalidatePr(host.client, pr, "guide");
  await flush();
  expect(page.host.textContent).toContain(refusal);
  expect(page.host.textContent).not.toContain(GUIDE_RUN_LOST);
  expect(buttons(page.host, "Try again")).toHaveLength(1);
  expect(host.presses).toHaveLength(1);

  await press(buttons(page.host, "Try again")[0]);
  expect(host.presses).toHaveLength(2);
  expect(page.host.textContent).toContain("Caveman is reading the change…");
});
