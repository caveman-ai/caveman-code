// Models & keys, a Caveman subscription's sign-in in a browser: engine.account.signin answers after the click (over the
// relay on the hosted client, and after the provider's device-code request), when a browser blocks a new tab and a
// clipboard write. The provider's page still opens, stays a link in the dialog, and "copied" is said only when it was.
import { button, click, clipboard, mount, popups, settle } from "./browser.fixture.ts";

import type { EngineDescriptor, EngineProvider } from "@caveman-app/session-protocol";
import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { RuntimeFixture, type RuntimeContextValue } from "../../state/runtime.tsx";
import { CavemanProviders } from "./CavemanProviders.tsx";

// Radix's dialog needs more of a browser than linkedom has (focus scope, scroll lock); the form inside it is what runs.
vi.mock("@caveman-app/ui/components/dialog", async () => {
  const { createElement: h } = await import("react");
  const pass = (tag: string) => (p: { children?: unknown }) => h(tag, null, p.children as never);
  return {
    Dialog: (p: { open: boolean; children?: unknown }) =>
      p.open ? h("div", { role: "dialog" }, p.children as never) : null,
    DialogContent: pass("div"),
    DialogHeader: pass("div"),
    DialogTitle: pass("h2"),
    DialogDescription: pass("p"),
  };
});

// The runtime's GitHub Copilot entry (provider-caveman providers.ts, through engine.providers).
const COPILOT = {
  id: "github-copilot",
  label: "GitHub Copilot",
  group: "featured",
  auth: "key",
  sign_in: true,
  sign_in_label: "Sign in with GitHub",
  sign_in_plan: "GitHub Copilot",
  sign_in_only: true,
} as unknown as EngineProvider;
const PAGE = "https://github.com/login/device";
const engine = {
  id: "caveman",
  label: "Caveman",
  capabilities: {},
  models: [],
  auth: { state: "signed_out", accounts: [] },
} as unknown as EngineDescriptor;

let page: Awaited<ReturnType<typeof mount>> | undefined;
afterEach(async () => {
  await page?.unmount();
  page = undefined;
});

/** The card on a runtime whose engine.account.signin answers `answer`, which lands once the click has returned. */
async function card(answer: { url?: string; code?: string }) {
  const client = {
    on: () => () => undefined,
    call: async (method: string) => {
      if (method === "engine.providers") return { providers: [COPILOT] };
      if (method === "engine.account.signin") return answer;
      throw new Error(`unexpected ${method}`);
    },
  };
  const value = {
    status: "connected",
    client,
    connection: 1,
    refresh: async () => undefined,
    settings: null,
    engines: [engine],
    workspaces: [],
  } as unknown as RuntimeContextValue;
  page = await mount(
    createElement(RuntimeFixture, { value, children: createElement(CavemanProviders, { engine }) }),
  );
  await click(button(page.container, /^GitHub Copilot/));
  await click(button(page.container, "Sign in with GitHub"));
  await settle();
  return page.container;
}

const links = (el: Element) => [...el.querySelectorAll("a")].map((a) => a.getAttribute("href"));
const status = (el: Element) => el.querySelector('[role="status"]')?.textContent ?? "";

test("a subscription's sign-in opens the provider's page from its click and keeps it as a link", async () => {
  const body = await card({ url: PAGE, code: "ABCD-1234" });
  expect({
    open: popups.tabs.filter((t) => !t.closed).map((t) => t.url),
    refused: popups.refused,
  }).toEqual({ open: [PAGE], refused: [] });
  expect(links(body)).toContain(PAGE);
  expect(status(body)).toContain("ABCD-1234");
});

test("a sign-in never says its code was copied when the browser refused the clipboard", async () => {
  const body = await card({ url: PAGE, code: "ABCD-1234" });
  expect(clipboard).toEqual([{ text: "ABCD-1234", ok: false }]);
  expect(status(body)).not.toContain("copied");
});
