// A pull request keeps one address however it is opened: a Review queue row opens its project's own repository's
// pull request where the sidebar, its mark and a chat's link do, so its read marks, part marks and cached reads are
// the same ones. Another repository's still names its repository.
import { render, settle } from "../dom.test-support.ts";
import type { PrSummary } from "@caveman-app/session-protocol";
import type { Client } from "@caveman-app/session-protocol/client";
import { act, createElement } from "react";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import { RuntimeFixture, type RuntimeContextValue } from "../../state/runtime.tsx";
import { prFromUrl, prPath } from "./model.ts";
import { ReviewQueue } from "./Queue.tsx";

const project = {
  id: "p1",
  name: "app",
  path: "/Users/me/app",
  repository: { host: "github.com", full_name: "acme/app" },
};
const summary = (repo: string, number: number): PrSummary => ({
  project_id: "p1",
  repo,
  host: "github.com",
  number,
  title: `Change ${number}`,
  url: `https://github.com/${repo}/pull/${number}`,
  head_branch: `feat/${number}`,
  base_branch: "main",
  state: "open",
  additions: 1,
  deletions: 1,
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-01T00:00:00.000Z",
  review_requested: false,
  mine: true,
});
// pr.list as the runtime answers it: repo and host on every row, the project's own repository's too (reviews.ts summaryOf).
const own = summary("acme/app", 12);
const other = summary("acme/lib", 7);

test("a queue row opens the project's own pull request at the address the sidebar and a chat link use, and warms what that page reads", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = {
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      if (method === "pr.list") return { prs: [own, other], viewers: {}, errors: [] };
      return new Promise(() => undefined);
    },
  } as unknown as Client;
  const value = {
    status: "connected",
    error: null,
    client,
    identity: {},
    connection: 1,
    workspaces: [],
    raw: new Map(),
    projects: [project],
    engines: [],
    settings: null,
    refresh: async () => undefined,
    markSeen: () => undefined,
  } as unknown as RuntimeContextValue;
  const page = await render(
    createElement(
      MemoryRouter,
      null,
      createElement(RuntimeFixture, { value, children: createElement(ReviewQueue) }),
    ),
  );
  await settle(3);
  const row = (n: number) => page.host.querySelector(`a[data-pr-row][href*="/${n}"]`);
  expect(row(12)).not.toBeNull();

  // The sidebar's menu and the pull request's mark (prPath of project and number), and a chat's link to it (prFromUrl).
  const sidebar = prPath({ project_id: "p1", number: 12 });
  const chat = prPath(prFromUrl(own.url, [project])!);
  expect(row(12)?.getAttribute("href")).toBe(sidebar);
  expect(chat).toBe(sidebar);
  expect(row(7)?.getAttribute("href")).toBe(
    prPath({ project_id: "p1", number: 7, repo: "acme/lib", host: "github.com" }),
  );

  // Focusing the row warms the reads the page it opens makes: the same address, with no repository named.
  await act(async () => void row(12)!.dispatchEvent(new Event("focusin", { bubbles: true })));
  await settle();
  expect(calls.filter((c) => c.method === "pr.get").map((c) => c.params)).toEqual([
    { project_id: "p1", number: 12 },
  ]);
  await page.unmount();
});
