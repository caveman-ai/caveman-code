// Settings > Secret providers in a window on a Cloud computer that keeps nothing of its person's (every engine there
// says no_sign_in_here): the runtime refuses secret_provider.save and a secret_slot.set that points a setting at a
// secret manager there, so the page offers neither. It says where 1Password is connected, and what an earlier
// version connected there can still be checked, taken off a setting and removed. On a Mac every control is as it was.
import { mount, settle } from "./browser.fixture.ts";

import type { EngineDescriptor, Result } from "@caveman-app/session-protocol";
import { createElement } from "react";
import { afterEach, expect, test } from "vitest";

import { RuntimeFixture, type RuntimeContextValue } from "../../state/runtime.tsx";
import { MANAGER_ELSEWHERE, SecretProvidersSettings } from "./SecretProviders.tsx";

type View = Result<"secret_provider.list">;
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

const github = {
  target: { kind: "source_control", host: "github", field: "tokens", server_host: "github.com" },
  label: "GitHub token · github.com",
  group: "source_control",
  has_value: false,
} as const;
const cursor = {
  target: { kind: "engine_env", instance_id: "cursor", name: "CURSOR_API_KEY" },
  label: "Cursor · CURSOR_API_KEY",
  group: "engine",
  has_value: true,
} as const;
const NONE: View = { providers: [], slots: [github, cursor] };
/** As an earlier version left it: 1Password connected, and the GitHub token read from it. */
const BEFORE: View = {
  providers: [
    {
      id: "work",
      kind: "one_password",
      label: "Work 1Password",
      supported: true,
      account: "my.1password.com",
    },
  ],
  slots: [{ ...github, ref: { provider: "work", reference: "op://Dev/GitHub/token" } }, cursor],
};

let page: Awaited<ReturnType<typeof mount>> | undefined;
afterEach(async () => {
  await page?.unmount();
  page = undefined;
});

async function providersPage(engines: EngineDescriptor[], view: View) {
  const client = {
    on: () => () => undefined,
    call: async (method: string) => {
      if (method === "secret_provider.list") return view;
      throw new Error(`unexpected ${method}`);
    },
  };
  const value = {
    client,
    workspaces: [],
    projects: [],
    engines,
    settings: null,
    status: "connected",
    connection: 1,
  } as unknown as RuntimeContextValue;
  page = await mount(
    createElement(RuntimeFixture, { value, children: createElement(SecretProvidersSettings) }),
  );
  await settle();
  return page.container;
}

const labels = (el: HTMLElement) =>
  [...el.querySelectorAll("button")].map(
    (b) => b.getAttribute("aria-label") ?? b.textContent?.trim(),
  );

test("on a Cloud computer that keeps nothing, Secret providers offers no way to connect 1Password or point a setting at it", async () => {
  expect(MANAGER_ELSEWHERE).toBe("Connect 1Password on your Mac (Settings > Secret providers).");
  const there = await providersPage(OUTSIDE, NONE);
  expect(there.textContent).toBe(`Secret managers${MANAGER_ELSEWHERE}`);
  expect(labels(there)).toEqual([]);
  expect(there.querySelectorAll("input, form")).toHaveLength(0);
});

test("what an earlier version connected there is still checked, taken off a setting and removed, and nothing new is pointed at it", async () => {
  const there = await providersPage(OUTSIDE, BEFORE);
  const text = there.textContent ?? "";
  expect(text).toContain(MANAGER_ELSEWHERE);
  expect(text).toContain("Work 1Password");
  expect(text).toContain("op://Dev/GitHub/token");
  // The engine key that reads from no secret manager has no row: nothing can be done with it here.
  expect(text).not.toContain("Cursor · CURSOR_API_KEY");
  // The sentence says where it is connected; no button here connects it (the labels below).
  expect(labels(there)).toEqual([
    "Read again",
    "Check",
    "Remove Work 1Password",
    "Stop reading GitHub token · github.com from 1Password",
  ]);
  expect(there.querySelectorAll("input, form")).toHaveLength(0);
});

test("a Mac keeps every control", async () => {
  const mac = await providersPage(MAC, BEFORE);
  const text = mac.textContent ?? "";
  expect(text).not.toContain(MANAGER_ELSEWHERE);
  expect(text).toContain("Keep keys and tokens in 1Password instead of pasting them here.");
  expect(text).toContain("Cursor · CURSOR_API_KEY");
  expect(labels(mac)).toEqual([
    "Read again",
    "Check",
    "Remove Work 1Password",
    "1Password app",
    "Service account",
    "Connect",
    "Use",
    "Stop reading GitHub token · github.com from 1Password",
  ]);
  expect(mac.querySelectorAll("form")).toHaveLength(2);
});
