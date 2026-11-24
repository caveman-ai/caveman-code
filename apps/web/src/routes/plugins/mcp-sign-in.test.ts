// Signing in to one of your own MCP servers in a browser: connector.connect answers with the server's sign-in page
// after the click (over the relay on the hosted client), when a browser blocks a new tab. The page opens in the tab
// the click opened.
import { button, click, deferred, mount, popups, settle } from "../settings/browser.fixture.ts";

import { createElement } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test } from "vitest";

import { RuntimeFixture, type RuntimeContextValue } from "../../state/runtime.tsx";
import { SignInButton } from "./ServerSetup.tsx";
import type { Server } from "./installed.ts";

const PAGE = "https://mcp.linear.app/authorize?client_id=caveman&state=st_1";

let page: Awaited<ReturnType<typeof mount>> | undefined;
afterEach(async () => {
  await page?.unmount();
  page = undefined;
});

/** Sign in on a server of yours that signs in with OAuth (its page and Needs you show it); connector.connect answers when the test says. */
async function servers(status: "needs_sign_in", engines: ReadonlyArray<unknown> = []) {
  const answer = deferred<{ status: string; authorization_url?: string; problem?: string }>();
  const calls: Array<{ method: string; params: unknown }> = [];
  const linear = {
    name: "linear",
    url: "https://mcp.linear.app/mcp",
    source: "manual",
    auth: "oauth",
    status,
    enabled: true,
    credentials: [],
  };
  const client = {
    on: () => () => undefined,
    call: (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "mcp.list") return Promise.resolve({ servers: [linear] });
      if (method === "plugin.list") return Promise.resolve({ plugins: [] });
      if (method === "marketplace.list") return Promise.resolve({ marketplaces: [] });
      if (method === "connector.connect") return answer.promise;
      return new Promise(() => undefined);
    },
  };
  const value = {
    client,
    connection: 1,
    status: "connected",
    projects: [],
    workspaces: [],
    engines,
    settings: null,
  } as unknown as RuntimeContextValue;
  page = await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(RuntimeFixture, {
        value,
        children: createElement(SignInButton, {
          server: linear as unknown as Server,
          onStarted: async () => undefined,
        }),
      }),
    ),
  );
  await settle();
  return {
    container: page.container,
    answer,
    connects: () => calls.filter((c) => c.method === "connector.connect").map((c) => c.params),
  };
}

const open = () => popups.tabs.filter((t) => !t.closed).map((t) => t.url);

test("Sign in on your own server opens its sign-in page in the tab its click opened", async () => {
  const s = await servers("needs_sign_in");
  await click(button(s.container, "Sign in"));
  expect(s.connects()).toEqual([expect.objectContaining({ id: "linear" })]);
  s.answer.resolve({ status: "signing_in", authorization_url: PAGE });
  await settle();
  expect({ open: open(), refused: popups.refused }).toEqual({ open: [PAGE], refused: [] });
  expect(popups.tabs[0]?.opener).toBeNull();
});

test("a sign-in the runtime refuses closes the tab its click opened and says why", async () => {
  const s = await servers("needs_sign_in");
  await click(button(s.container, "Sign in"));
  s.answer.reject(new Error("linear is not a server that signs in"));
  await settle();
  expect(open()).toEqual([]);
  expect(s.container.textContent).toContain("linear is not a server that signs in");
});

// A Cloud computer that keeps nothing of its person's answers connector.connect with its refusal, not a failure.
const REFUSAL =
  "Connectors are connected and removed in Settings on your Mac, never from inside a Cloud computer.";

test("a sign-in the runtime answers with a refusal closes the tab and says the refusal as it came", async () => {
  const s = await servers("needs_sign_in");
  await click(button(s.container, "Sign in"));
  s.answer.resolve({ status: "error", problem: REFUSAL });
  await settle();
  expect(open()).toEqual([]);
  expect(s.container.querySelector('[role="alert"]')?.textContent).toBe(REFUSAL);
});

test("a refusal with no reason still says the sign-in did not happen", async () => {
  const s = await servers("needs_sign_in");
  await click(button(s.container, "Sign in"));
  s.answer.resolve({ status: "error" });
  await settle();
  expect(s.container.querySelector('[role="alert"]')?.textContent).toBe(
    "The sign-in did not finish. Try again.",
  );
});

test("in a window on a Cloud computer that keeps nothing, a server offers no Sign in: the line says where it is connected", async () => {
  const s = await servers("needs_sign_in", [
    {
      id: "claude-agent",
      label: "Claude Agent",
      auth: { state: "signed_in", accounts: [], no_sign_in_here: true },
    },
  ]);
  expect(s.container.querySelectorAll("button").length).toBe(0);
  expect(s.container.textContent).toBe("Connect it on your own device.");
  expect(s.connects()).toEqual([]);
});
