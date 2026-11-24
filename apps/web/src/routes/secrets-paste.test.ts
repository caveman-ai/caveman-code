// Settings > Secrets' Add row: the person asked to store what they paste, so a single value is stored however plain it
// looks (a passphrase made of words, a key of letters only), named in the sheet. Text that is neither a key nor
// NAME=value lines is still turned away.
import { button, click, mount, settle, type } from "./settings/browser.fixture.ts";

import { act, createElement } from "react";
import { afterEach, expect, test } from "vitest";

import { RuntimeFixture, type RuntimeContextValue } from "../state/runtime.tsx";
import { SecretsSettings } from "./Secrets.tsx";

const repo = { path: "/repos/gadgets" };
// As Settings > Projects renders it, for one project's checkout.
const ProjectSecrets: (props: {
  readonly repo: typeof repo;
}) => ReturnType<typeof SecretsSettings> = SecretsSettings;

let page: Awaited<ReturnType<typeof mount>> | undefined;
afterEach(async () => {
  await page?.unmount();
  page = undefined;
});

async function secretsPage() {
  const stored: Array<{ name: string; value: string }> = [];
  const client = {
    on: () => () => undefined,
    call: async (method: string, params: { secrets?: Array<{ name: string; value: string }> }) => {
      if (method === "cloud.profile.status") return { state: "off" };
      if (method === "secret.env_files") return { files: [] };
      if (method === "secret.list")
        return {
          repository: "github.com/acme/gadgets",
          secrets: stored.map(({ name }) => ({
            name,
            hidden: true,
            updated_at: "2026-11-01T00:00:00Z",
          })),
        };
      if (method === "secret.set") return void stored.push(...params.secrets!);
      throw new Error(`unexpected ${method}`);
    },
  };
  const value = {
    client,
    workspaces: [],
    projects: [],
    engines: [],
    settings: null,
    status: "connected",
    connection: 1,
  } as unknown as RuntimeContextValue;
  page = await mount(
    createElement(RuntimeFixture, { value, children: createElement(ProjectSecrets, { repo }) }),
  );
  await settle();
  const container = page.container;
  const add = async (text: string) => {
    await type(container.querySelector<HTMLTextAreaElement>("#secret-paste")!, text);
    await act(
      async () =>
        void container
          .querySelector("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
  };
  return { container, stored, add };
}

const turnedAway = (container: HTMLElement) =>
  container.querySelector('[role="alert"]')?.textContent ?? null;

test("a single value pasted to store is stored however plain it looks, under the name given in the sheet", async () => {
  const { container, stored, add } = await secretsPage();
  const values = [
    "correct-horse-battery-staple-xyz",
    "wLgbxStbfegYulBwcuIrdbguzQQOLXvB",
    "hunter2",
  ];
  for (const [i, value] of values.entries()) {
    await add(`  ${value}\n`);
    expect(turnedAway(container), value).toBeNull();
    expect(
      container.querySelector('[role="dialog"][aria-label="Store as secrets"]'),
      value,
    ).not.toBeNull();
    const name = container.querySelector<HTMLInputElement>('[data-row="0"]')!;
    // A browser reads an input with no type as a text field; linkedom needs it said for React to see the typing.
    name.setAttribute("type", "text");
    await type(name, `PASSPHRASE_${i}`);
    await click(button(container, /^Save secret/));
  }
  expect(stored).toEqual(values.map((value, i) => ({ name: `PASSPHRASE_${i}`, value })));
});

test("text that is neither a key nor NAME=value lines is turned away", async () => {
  const { container, stored, add } = await secretsPage();
  await add("please keep this safe");
  expect(turnedAway(container)).toBe("Paste NAME=value lines or a single key.");
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(stored).toEqual([]);
});
