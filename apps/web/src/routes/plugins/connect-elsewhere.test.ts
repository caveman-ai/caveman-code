// Connecting in a window on a Cloud computer that keeps nothing of its person's (every engine there says
// no_sign_in_here): the runtime connects and removes no connector and no GitHub login there, so a plugin's Connect
// list, the install dialog's setup step and first run's GitHub row offer no button that would only be refused, and
// say where it is done. A connector connected through Caveman runs there (through Cloud's connector proxy), and its
// row says so. Nor does it keep a key for a server (credential.grant is refused there): a server's key has no paste
// field, on its page or as it is added. On a Mac every control is as it was.
import { button, click, mount, settle } from "../settings/browser.fixture.ts";

import type { EngineDescriptor } from "@caveman-app/session-protocol";
import { createElement, type ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";

import { RuntimeFixture, type RuntimeContextValue } from "../../state/runtime.tsx";
import { ConnectGithub, GITHUB_ELSEWHERE } from "../onboarding/ProjectStep.tsx";
import type { ConnectTarget, PluginDetail, PluginSummary } from "./api.ts";
import { ConnectRow } from "./Detail.tsx";
import { AddServerDialog, SERVER_KEYS_ELSEWHERE } from "./Dialogs.tsx";
import { SignInStep } from "./InstallDialog.tsx";
import { KeyField } from "./ServerSetup.tsx";
import { CONNECT_ELSEWHERE, KEY_ELSEWHERE } from "./shared.tsx";

// Radix's dialog needs more of a browser than linkedom has (focus scope, scroll lock); the step inside it is what runs.
vi.mock("@caveman-app/ui/components/dialog", async () => {
  const { createElement: h } = await import("react");
  const pass = (tag: string) => (p: { children?: unknown }) => h(tag, null, p.children as never);
  return {
    Dialog: pass("div"),
    DialogContent: pass("div"),
    DialogHeader: pass("div"),
    DialogTitle: pass("h2"),
    DialogDescription: pass("p"),
    DialogFooter: pass("div"),
  };
});

const OUTSIDE = [
  {
    id: "claude-agent",
    label: "Claude Agent",
    auth: { state: "signed_in", accounts: [], no_sign_in_here: true },
  },
] as unknown as EngineDescriptor[];
const MAC = [
  { id: "claude-agent", label: "Claude Agent", auth: { state: "signed_in", accounts: [] } },
] as unknown as EngineDescriptor[];
// What a connector's row says there when its sign-in stopped working (the runtime's connectorProxy.ts
// RECONNECT_ELSEWHERE_TEXT), and when its Cloud does not run connectors on Cloud computers (NO_PROXY_TEXT).
const RECONNECT_ON_MAC = "Its sign-in expired. Reconnect it on your Mac (Plugins).";
const NOT_ON_CLOUD = "Connectors don't work in Cloud yet. Use this one in a chat on your Mac.";

let page: Awaited<ReturnType<typeof mount>> | undefined;
afterEach(async () => {
  await page?.unmount();
  page = undefined;
});

/** `element` in a window whose runtime reports `engines`; every call it makes is kept. */
async function show(engines: EngineDescriptor[], element: ReactElement) {
  const calls: string[] = [];
  const client = {
    on: () => () => undefined,
    call: (method: string) => {
      calls.push(method);
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
    createElement(MemoryRouter, null, createElement(RuntimeFixture, { value, children: element })),
  );
  await settle();
  return { container: page.container, calls };
}

const buttons = (el: HTMLElement) =>
  [...el.querySelectorAll("button")].map((b) => ({
    name: b.textContent?.trim(),
    disabled: b.disabled,
  }));
type Server = PluginDetail["server_details"][number];
const row = (server: Partial<Server>, admin = false, onDisconnect?: () => void) =>
  createElement(ConnectRow, {
    pluginId: "linear",
    server: { name: "linear", transport: "http", auth: "oauth", ...server } as Server,
    installed: true,
    admin,
    onConnected: () => undefined,
    onDisconnect,
  });

test("a plugin's Connect row there has no button, and says the runtime's reason, or where it is connected", async () => {
  expect(CONNECT_ELSEWHERE).toBe("Connect it on your own device.");
  for (const reason of [RECONNECT_ON_MAC, NOT_ON_CLOUD]) {
    const said = await show(OUTSIDE, row({ problem: reason }));
    expect(said.container.textContent).toBe(`linear${reason}`);
    expect(buttons(said.container)).toEqual([]);
    await page!.unmount();
  }

  // One connected through Caveman runs there: the row says so, and still offers nothing to press.
  const connected = await show(OUTSIDE, row({ connected: true, held_by: "cloud" }));
  expect(connected.container.textContent).toBe("linearConnected through Caveman");
  expect(buttons(connected.container)).toEqual([]);
  await page!.unmount();

  const unsaid = await show(OUTSIDE, row({}));
  expect(unsaid.container.textContent).toBe(`linear${CONNECT_ELSEWHERE}`);
  expect(buttons(unsaid.container)).toEqual([]);
  await page!.unmount();

  // An admin's Disconnect would be refused there too.
  const team = await show(
    OUTSIDE,
    row({ shared: true, connected: true, shared_by: "Ada" }, true, () => undefined),
  );
  expect(buttons(team.container)).toEqual([]);
  expect(team.calls).toEqual([]);
});

test("on a Mac the same rows keep Connect, Reconnect and the admin's Disconnect", async () => {
  const first = await show(MAC, row({}));
  expect(first.container.textContent).toContain("Not connected");
  expect(buttons(first.container)).toEqual([{ name: "Connect", disabled: false }]);
  await page!.unmount();

  const again = await show(MAC, row({ problem: "Linear signed you out." }));
  expect(buttons(again.container)).toEqual([{ name: "Reconnect", disabled: false }]);
  await page!.unmount();

  const team = await show(
    MAC,
    row({ shared: true, connected: true, shared_by: "Ada" }, true, () => undefined),
  );
  expect(buttons(team.container)).toEqual([
    { name: "Disconnect the team's account", disabled: false },
  ]);
});

const key = (granted: boolean) =>
  createElement(KeyField, {
    server: "datadog",
    credential: { name: "DD_API_KEY", granted },
    onChanged: async () => undefined,
  });

test("a server's key there has no paste field and no Replace: it says where it is added, and one kept from before can be removed", async () => {
  expect(KEY_ELSEWHERE).toBe("Add it on your own device.");
  // The runtime refuses credential.grant there.
  const none = await show(OUTSIDE, key(false));
  expect(none.container.textContent).toBe(`DD_API_KEY${KEY_ELSEWHERE}`);
  expect(buttons(none.container)).toEqual([]);
  expect(none.container.querySelector("input")).toBeNull();
  await page!.unmount();

  const kept = await show(OUTSIDE, key(true));
  expect(kept.container.textContent).toContain("Stored on this computer");
  expect(buttons(kept.container)).toEqual([{ name: "Remove", disabled: false }]);
  await page!.unmount();

  const mac = await show(MAC, key(false));
  expect(mac.container.querySelector("input")).not.toBeNull();
  expect(buttons(mac.container).map((b) => b.name)).toEqual(["Save"]);
  await page!.unmount();
  const macKept = await show(MAC, key(true));
  expect(buttons(macKept.container).map((b) => b.name)).toEqual(["Replace", "Remove"]);
});

const addServer = () =>
  createElement(AddServerDialog, {
    open: true,
    onOpenChange: () => undefined,
    onAdded: () => undefined,
    onImport: () => undefined,
  });

test("adding a server there names its keys without their values, and says where a key or sign-in is added", async () => {
  expect(SERVER_KEYS_ELSEWHERE).toBe("A key or sign-in it needs is added on your own device.");
  const there = await show(OUTSIDE, addServer());
  await click(button(there.container, "Add a key"));
  const fields = () =>
    [...page!.container.querySelectorAll("input")].map((i) => i.getAttribute("aria-label"));
  expect(fields()).toEqual(["URL or command", "Server name", "Variable name"]);
  expect(there.container.textContent).toContain(SERVER_KEYS_ELSEWHERE);
  expect(there.container.textContent).not.toContain("Values are kept on this computer");
  await page!.unmount();

  const mac = await show(MAC, addServer());
  await click(button(mac.container, "Add a key"));
  expect(fields()).toEqual([
    "URL or command",
    "Server name",
    "Variable name",
    "Value for this key",
  ]);
  expect(mac.container.textContent).toContain(
    "Values are kept on this computer and never shown again.",
  );
  expect(mac.container.textContent).not.toContain(SERVER_KEYS_ELSEWHERE);
});

const plugin = { id: "linear", name: "linear", interface: {} } as unknown as PluginSummary;
const target = {
  plugin_id: "linear",
  server: "linear",
  title: "Linear",
  auth: "oauth",
} as ConnectTarget;
const step = () =>
  createElement(SignInStep, {
    plugin,
    target,
    where: "you",
    step: null,
    next: undefined,
    onNext: () => undefined,
  });

test("the install dialog's setup step there says where to connect, and its Connect is off", async () => {
  const there = await show(OUTSIDE, step());
  expect(there.container.querySelector("p")?.textContent).toBe(CONNECT_ELSEWHERE);
  expect(buttons(there.container)).toEqual([
    { name: "Skip", disabled: false },
    { name: "Connect", disabled: true },
  ]);
  await page!.unmount();

  const mac = await show(MAC, step());
  expect(mac.container.querySelector("p")?.textContent).toBe(
    "Sign in to Linear so every engine can use linear.",
  );
  expect(buttons(mac.container)).toEqual([
    { name: "Skip", disabled: false },
    { name: "Connect", disabled: false },
  ]);
});

test("first run's GitHub row there offers no Connect and no gh login: it says where GitHub is connected, or the runtime's reason", async () => {
  expect(GITHUB_ELSEWHERE).toBe("Connect GitHub on your own device.");
  const there = await show(OUTSIDE, createElement(ConnectGithub, {}));
  expect(there.container.textContent).toBe(`Connect GitHub${GITHUB_ELSEWHERE}`);
  expect(buttons(there.container)).toEqual([]);
  await page!.unmount();

  // The runtime's connectors.ts OUTSIDE_GITHUB_TEXT: GitHub is read there once it is connected to Caveman.
  const reason =
    "Connect GitHub on your Mac to read issues here. Pushing and pull requests already work.";
  const said = await show(OUTSIDE, createElement(ConnectGithub, { problem: reason }));
  expect(said.container.textContent).toBe(`Connect GitHub${reason}`);
  expect(buttons(said.container)).toEqual([]);
  await page!.unmount();

  const mac = await show(MAC, createElement(ConnectGithub, {}));
  expect(mac.container.textContent).toContain(
    "Through Caveman, or run gh auth login in a terminal",
  );
  expect(buttons(mac.container).map((b) => b.name)).toEqual(["", "Connect"]);
});
