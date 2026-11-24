// Move to Cloud in a browser: connector.connect answers with Cloud's sign-in page after the click (over the relay on
// the hosted client), when a browser blocks a new tab. The page still opens, and stays a link while the sign-in is
// under way, once the list reads the server as signing in.
import {
  button,
  click,
  deferred,
  mount,
  popups,
  settle,
} from "../../routes/settings/browser.fixture.ts";

import { createElement } from "react";
import { afterEach, expect, test } from "vitest";

import { RuntimeFixture, type RuntimeContextValue } from "../../state/runtime.tsx";
import { ConnectorCloudBadge, type ConnectorCloud } from "./trust.tsx";

const PAGE = "https://app.caveman.so/connect/linear?state=st_1";
// A sign-in this Mac made before it linked to Cloud, as mcp.list says it.
const ON_THIS_MAC: ConnectorCloud = {
  status: "connected",
  held_by: "this_computer",
  auth: "oauth",
};

let page: Awaited<ReturnType<typeof mount>> | undefined;
afterEach(async () => {
  await page?.unmount();
  page = undefined;
});

/** The linear server's badge on a runtime signed in to Cloud, whose connector.connect answers when the test says. */
async function badge() {
  const answer = deferred<{ status: string; authorization_url?: string; problem?: string }>();
  const calls: Array<{ method: string; params: unknown }> = [];
  const client = {
    on: () => () => undefined,
    call: (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "cloud.profile.status")
        return Promise.resolve({
          state: "ok",
          items: [{ kind: "server", id: "linear", cloud: "runs" }],
        });
      if (method === "connector.connect") return answer.promise;
      return new Promise(() => undefined);
    },
  };
  const value = { client, connection: 1, status: "connected" } as unknown as RuntimeContextValue;
  const row = (c: ConnectorCloud) =>
    createElement(RuntimeFixture, {
      value,
      children: createElement(ConnectorCloudBadge, { ...c, id: "linear" }),
    });
  page = await mount(row(ON_THIS_MAC));
  return {
    container: page.container,
    answer,
    calls,
    listed: (c: ConnectorCloud) => page!.rerender(row(c)),
  };
}

const open = () => popups.tabs.filter((t) => !t.closed).map((t) => t.url);
const links = (el: Element) => [...el.querySelectorAll("a")].map((a) => a.getAttribute("href"));

test("Move to Cloud opens Cloud's sign-in page in the tab its click opened, and keeps it as a link", async () => {
  const b = await badge();
  await click(button(b.container, "Move to Cloud"));
  expect(b.calls.filter((c) => c.method === "connector.connect").map((c) => c.params)).toEqual([
    expect.objectContaining({ id: "linear", move_to_cloud: true }),
  ]);
  b.answer.resolve({ status: "signing_in", authorization_url: PAGE });
  await settle();
  expect({ open: open(), refused: popups.refused }).toEqual({ open: [PAGE], refused: [] });
  expect(popups.tabs[0]?.opener).toBeNull();
  expect(links(b.container)).toEqual([PAGE]);
  // The row reloads: the server now reads signing_in, and the page is still there to open again.
  await b.listed({ status: "signing_in", auth: "oauth" });
  expect(links(b.container)).toEqual([PAGE]);
  // Cloud holds it now: nothing left to open.
  await b.listed({ status: "connected", held_by: "cloud", auth: "oauth" });
  expect(links(b.container)).toEqual([]);
  expect(b.container.textContent).toContain("Sign-in on Cloud");
});

test("a Move to Cloud that Cloud refuses closes the tab its click opened and says why", async () => {
  const b = await badge();
  await click(button(b.container, "Move to Cloud"));
  b.answer.reject(new Error("Caveman did not answer: 503"));
  await settle();
  expect(open()).toEqual([]);
  expect(links(b.container)).toEqual([]);
  expect(b.container.querySelector('[role="alert"]')?.textContent).toBe(
    "Caveman did not answer: 503",
  );
});
