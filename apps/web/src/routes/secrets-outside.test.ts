// Settings > Secrets in a window on a Cloud computer that keeps nothing of its person's (every engine there says
// no_sign_in_here): the runtime refuses secret.set, secret.delete and secret.import there, so the page lists the names
// and offers nothing that would add, replace or delete one. It says where that is done.
import { mount, settle } from "./settings/browser.fixture.ts";

import type { EngineDescriptor } from "@caveman-app/session-protocol";
import { createElement } from "react";
import { afterEach, expect, test } from "vitest";

import { RuntimeFixture, type RuntimeContextValue } from "../state/runtime.tsx";
import { KEPT_OUTSIDE, SecretsSettings } from "./Secrets.tsx";

const gadgets = { path: "/workspace/gadgets" };
const ProjectSecrets: (props: {
  readonly repo: typeof gadgets;
}) => ReturnType<typeof SecretsSettings> = SecretsSettings;
const claude = (auth: Partial<EngineDescriptor["auth"]>) =>
  ({
    id: "claude-agent",
    label: "Claude Agent",
    auth: { state: "signed_in", accounts: [], ...auth },
  }) as unknown as EngineDescriptor;

let page: Awaited<ReturnType<typeof mount>> | undefined;
afterEach(async () => {
  await page?.unmount();
  page = undefined;
});

/** The page on a runtime with `stored` names and one .env file not stored yet; every call it makes is kept. */
async function secretsPage(engines: EngineDescriptor[], stored: string[]) {
  const calls: string[] = [];
  const client = {
    on: () => () => undefined,
    call: async (method: string) => {
      calls.push(method);
      if (method === "cloud.profile.status") return { state: "off", items: [] };
      if (method === "secret.env_files")
        return { files: [{ path: ".env.local", names: ["NEW_KEY"] }] };
      if (method === "secret.list")
        return {
          repository: "github.com/acme/gadgets",
          secrets: stored.map((name) => ({
            name,
            hidden: true,
            updated_at: "2026-11-01T00:00:00Z",
          })),
        };
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
    createElement(RuntimeFixture, {
      value,
      children: createElement(ProjectSecrets, { repo: gadgets }),
    }),
  );
  await settle();
  return { container: page.container, calls };
}

const labels = (el: HTMLElement) =>
  [...el.querySelectorAll("button")].map(
    (b) => b.getAttribute("aria-label") ?? b.textContent?.trim(),
  );

test("on a Cloud computer that keeps nothing, Secrets lists the names and offers no add, delete or import", async () => {
  expect(KEPT_OUTSIDE).toBe(
    "Secrets are added and deleted in Settings on your own device, never from inside a Cloud computer. Commands, setup scripts and engines here get them as environment variables, scrubbed from what the agent and the transcript see.",
  );
  const p = await secretsPage([claude({ no_sign_in_here: true })], ["STRIPE_KEY", "AWS_SECRET"]);
  const text = p.container.textContent ?? "";
  expect(text).toContain("2 secrets for github.com/acme/gadgets.");
  expect(text).toContain(KEPT_OUTSIDE);
  // Nothing is stored in this computer's runtime: the page does not say so.
  expect(text).not.toContain("Values stay in this computer's runtime");
  expect(text).toContain("STRIPE_KEY");
  expect(text).toContain("AWS_SECRET");
  expect(labels(p.container)).toEqual([]);
  expect(p.container.querySelector("#secret-paste")).toBeNull();
  expect(text).not.toContain(".env.local");
  expect(text).not.toContain("Add secrets");
});

test("with none there yet, the empty row sends nobody to paste one", async () => {
  const p = await secretsPage([claude({ no_sign_in_here: true })], []);
  expect(p.container.textContent).toContain("No secrets yet");
  expect(p.container.textContent).not.toContain("Paste a .env");
});

test("a Mac, or a Cloud computer that takes secrets, keeps every control", async () => {
  const p = await secretsPage([claude({})], ["STRIPE_KEY"]);
  const text = p.container.textContent ?? "";
  expect(text).toContain("Values stay in this computer's runtime, never shown again.");
  expect(text).not.toContain(KEPT_OUTSIDE);
  expect(labels(p.container)).toEqual(["Review", "Delete STRIPE_KEY", "Add"]);
  expect(p.container.querySelector("#secret-paste")).not.toBeNull();
});
