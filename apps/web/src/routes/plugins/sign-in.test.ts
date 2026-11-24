// Connecting a plugin's server in a browser (a plugin's Connect list, the install dialog's setup step): plugin.connect
// answers with the service's page after the click (over the relay on the hosted client), when a browser blocks a new
// tab. The page opens in the tab the click opened, on the first click.
import { button, click, deferred, mount, popups, settle } from "../settings/browser.fixture.ts";

import { createElement, Fragment } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test } from "vitest";

import { RuntimeFixture, type RuntimeContextValue } from "../../state/runtime.tsx";
import { useSignIn } from "./signIn.ts";

const PAGE = "https://linear.app/oauth/authorize?client_id=caveman&state=st_1";

let page: Awaited<ReturnType<typeof mount>> | undefined;
afterEach(async () => {
  await page?.unmount();
  page = undefined;
});

/** A server's Connect row as Detail and the install dialog draw it: Connect, then Open the page again while waiting. */
function Row() {
  const signIn = useSignIn({ pluginId: "linear", server: "linear" });
  return createElement(
    Fragment,
    null,
    createElement("output", null, signIn.phase === "failed" ? signIn.problem : signIn.phase),
    signIn.reopen
      ? createElement("button", { type: "button", onClick: signIn.reopen }, "Open the page again")
      : createElement(
          "button",
          { type: "button", onClick: () => void signIn.connect() },
          "Connect",
        ),
  );
}

/** The row on a runtime whose plugin.connect answers when the test says; plugin.read never says it connected. */
async function row() {
  const answer = deferred<{ status: string; authorization_url?: string; problem?: string }>();
  const client = {
    on: () => () => undefined,
    call: (method: string) =>
      method === "plugin.connect"
        ? answer.promise
        : method === "plugin.read"
          ? Promise.resolve({ plugin: { server_details: [{ name: "linear", connected: false }] } })
          : new Promise(() => undefined),
  };
  const value = {
    client,
    connection: 1,
    status: "connected",
    projects: [],
    workspaces: [],
  } as unknown as RuntimeContextValue;
  page = await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(RuntimeFixture, { value, children: createElement(Row) }),
    ),
  );
  return {
    container: page.container,
    answer,
    phase: () => page!.container.querySelector("output")?.textContent,
  };
}

const open = () => popups.tabs.filter((t) => !t.closed).map((t) => t.url);

test("Connect opens the service's page in the tab its click opened, and Open the page again opens it again", async () => {
  const r = await row();
  await click(button(r.container, "Connect"));
  r.answer.resolve({ status: "signing_in", authorization_url: PAGE });
  await settle();
  expect({ open: open(), refused: popups.refused }).toEqual({ open: [PAGE], refused: [] });
  expect(popups.tabs[0]?.opener).toBeNull();
  expect(r.phase()).toBe("waiting");
  await click(button(r.container, "Open the page again"));
  expect({ open: open(), refused: popups.refused }).toEqual({ open: [PAGE, PAGE], refused: [] });
});

test("a Connect that needs no page, or is refused, closes the tab its click opened", async () => {
  const connected = await row();
  await click(button(connected.container, "Connect"));
  connected.answer.resolve({ status: "connected" });
  await settle();
  expect(open()).toEqual([]);
  expect(connected.phase()).toBe("connected");
  await page!.unmount();

  const refused = await row();
  await click(button(refused.container, "Connect"));
  refused.answer.resolve({ status: "error", problem: "Linear refused the sign-in." });
  await settle();
  expect(open()).toEqual([]);
  expect(refused.phase()).toBe("Linear refused the sign-in.");
  await page!.unmount();

  const failed = await row();
  await click(button(failed.container, "Connect"));
  failed.answer.reject(new Error("The runtime did not answer."));
  await settle();
  expect(open()).toEqual([]);
  expect(failed.phase()).toBe("The runtime did not answer.");
});
