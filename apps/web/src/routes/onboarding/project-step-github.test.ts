// The project step's GitHub row by who is looking (ProjectStep.tsx Pick): signed out, or a member below admin, is offered
// the gh CLI way and no Connect through Caveman (its GitHub App needs an admin); an owner or admin keeps Connect first.
import { render, settle } from "../dom.test-support.ts";
import type { EngineDescriptor } from "@caveman-app/session-protocol";
import { createElement } from "react";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";

vi.mock("../../components/ProjectPicker.tsx", () => ({ ProjectChooserPanel: () => null }));
vi.mock("../../components/GazeMascot.tsx", () => ({ GazeMascot: () => null }));
vi.mock("../../panes/drag.ts", () => ({}));

import { RuntimeFixture, type RuntimeContextValue } from "../../state/runtime.tsx";
import { ProjectStep } from "./ProjectStep.tsx";

Object.assign(globalThis, {
  addEventListener: window.addEventListener.bind(window),
  removeEventListener: window.removeEventListener.bind(window),
});

const engine = {
  id: "caveman",
  label: "Caveman",
  version: "1",
  auth: { state: "signed_in", accounts: [] },
} as unknown as EngineDescriptor;

async function row(
  account: Record<string, unknown>,
  github: Record<string, unknown> = { login: null, source: null },
) {
  const client = {
    call: async (method: string) =>
      method === "account.get" ? account : method === "github.status" ? github : {},
  };
  const value = {
    status: "connected",
    client,
    engines: [engine],
    settings: null,
    projects: [],
    workspaces: [],
    refresh: async () => undefined,
  } as unknown as RuntimeContextValue;
  const view = await render(
    createElement(
      MemoryRouter,
      null,
      createElement(RuntimeFixture, {
        value,
        children: createElement(ProjectStep, {
          onBack: () => undefined,
          onDone: () => undefined,
          onUnlock: () => undefined,
          plans: 0,
        }),
      }),
    ),
  );
  await settle(4);
  return view.host;
}
const names = (host: Element) =>
  [...host.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");

test("signed out: the gh way only, with a Copy command button and no Connect", async () => {
  const host = await row({ signed_in: false });
  expect(host.textContent).toContain("Run gh auth login in a terminal");
  expect(names(host)).toContain("Copy command");
  expect(names(host)).not.toContain("Connect");
});

test("a member: the gh way only", async () => {
  const host = await row({ signed_in: true, role: "member", email: "a@b.c" });
  expect(names(host)).toContain("Copy command");
  expect(names(host)).not.toContain("Connect");
});

test("an admin or an owner: Connect through Caveman stays, with the gh copy beside it", async () => {
  for (const role of ["admin", "owner"]) {
    const host = await row({ signed_in: true, role, email: "a@b.c" });
    expect(host.textContent).toContain("Through Caveman, or run gh auth login in a terminal");
    expect(names(host)).toContain("Connect");
    expect(names(host)).not.toContain("Copy command");
  }
});

test("a member with a gh login is not offered to use it through Caveman; an admin is", async () => {
  const gh = { login: "octocat", source: "gh" };
  const member = await row({ signed_in: true, role: "member", email: "a@b.c" }, gh);
  expect(member.textContent).toContain("From the GitHub CLI");
  expect(member.textContent).not.toContain("Use it on Cloud computers");
  const admin = await row({ signed_in: true, role: "admin", email: "a@b.c" }, gh);
  expect(admin.textContent).toContain("Use it on Cloud computers");
});
