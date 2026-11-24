// The Enter that ends an IME conversion (Japanese, Chinese, Korean) is part of typing. In Settings' search, the
// providers picker, an account's tag, a number setting or Review's search it opens, picks or saves nothing; a plain
// Enter still does. Chromium and Electron send that Enter with isComposing; Safari fires compositionend first, so its
// Enter has isComposing false and keyCode 229 (chrome.tsx isComposing). A Chinese pinyin typist commits the Latin
// letters they typed with that Enter too.
import { buttons, click, IME, press, render, settle, type } from "./dom.test-support.ts";
import type {
  EngineAccount,
  EngineDescriptor,
  EngineProvider,
  PrSummary,
} from "@caveman-app/session-protocol";
import type { Client } from "@caveman-app/session-protocol/client";
import { createElement, type ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { expect, test } from "vitest";
import { RuntimeFixture, type RuntimeContextValue } from "../state/runtime.tsx";
import { TagInput } from "./EngineAccounts.tsx";
import { ReviewQueue } from "./review/Queue.tsx";
import { SettingsNav } from "./Settings.tsx";
import { CavemanProviders } from "./settings/CavemanProviders.tsx";
import { NumberInput } from "./settings/rows.tsx";

/** The page's address after every render: what an Enter opened. */
function Where({ seen }: { seen: string[] }) {
  const at = useLocation();
  const path = at.pathname + at.search;
  if (seen.at(-1) !== path) seen.push(path);
  return null;
}

const runtime = (client: unknown, rest: Partial<Record<string, unknown>> = {}) =>
  ({
    status: "connected",
    error: null,
    client,
    identity: {},
    connection: 1,
    workspaces: [],
    raw: new Map(),
    projects: [],
    engines: [],
    settings: null,
    refresh: async () => undefined,
    markSeen: () => undefined,
    ...rest,
  }) as unknown as RuntimeContextValue;

const page = (value: RuntimeContextValue, children: ReactNode, at = "/") =>
  render(
    createElement(
      MemoryRouter,
      { initialEntries: [at] },
      createElement(RuntimeFixture, { value, children }),
    ),
  );

test("Settings' search: the Enter of a conversion opens no section; a plain Enter opens the first match", async () => {
  const seen: string[] = [];
  const view = await page(
    runtime(null),
    [createElement(SettingsNav, { key: "nav" }), createElement(Where, { key: "where", seen })],
    "/settings/general",
  );
  const field = view.host.querySelector('input[aria-label="Search settings"]')!;
  await type(field, "keyboard");
  for (const ime of IME) await press(field, "Enter", { ime });
  expect(seen).toEqual(["/settings/general"]);
  expect((field as HTMLInputElement).value, "the search keeps what was typed").toBe("keyboard");

  await press(field, "Enter");
  expect(seen).toEqual(["/settings/general", "/settings/keyboard"]);
});

test("adding a key: the Enter of a conversion in the providers search picks none; a plain Enter picks the first", async () => {
  const providers = [
    { id: "openai", label: "OpenAI", group: "featured", section: "keys", auth: "key" },
    { id: "openrouter", label: "OpenRouter", group: "featured", section: "gateways", auth: "key" },
  ] as unknown as EngineProvider[];
  const client = {
    on: () => () => undefined,
    call: async (method: string) => {
      if (method === "engine.providers") return { providers };
      throw new Error(`${method} is not part of this test`);
    },
  };
  const engine = {
    id: "caveman",
    label: "Caveman",
    capabilities: {},
    models: [],
    auth: { state: "signed_out", accounts: [] },
  } as unknown as EngineDescriptor;
  await page(runtime(client, { engines: [engine] }), createElement(CavemanProviders, { engine }));
  await settle();
  await click(buttons(document.body, "Add")[0]);
  const search = () =>
    document.querySelector<HTMLInputElement>('input[aria-label="Search providers"]');
  expect(search(), "the picker").not.toBeNull();
  await type(search(), "openr");
  for (const ime of IME) {
    await press(search(), "Enter", { ime });
    expect(search(), `still picking after ${ime}'s Enter`).not.toBeNull();
  }

  await press(search(), "Enter");
  expect(search(), "the picker gave way to OpenRouter's form").toBeNull();
  expect(document.body.textContent).toContain("Paste an OpenRouter key");
});

test("an account's tag: the Enter of a conversion leaves it being typed; a plain Enter is done with it", async () => {
  const account = {
    id: "work",
    label: "Work",
    kind: "key",
    active: true,
    tag: "WK",
  } as unknown as EngineAccount;
  const view = await render(
    createElement(TagInput, {
      engine: "caveman",
      account,
      busy: false,
      run: async () => undefined,
    }),
  );
  const field = view.host.querySelector("input")!;
  let blurs = 0;
  field.addEventListener("blur", () => blurs++);
  await type(field, "AB");
  for (const ime of IME) await press(field, "Enter", { ime });
  expect(blurs).toBe(0);

  await press(field, "Enter");
  expect(blurs).toBe(1);
});

test("a number setting: the Enter of a conversion leaves it being typed; a plain Enter is done with it", async () => {
  const view = await render(
    createElement(NumberInput, { id: "n", value: 4, min: 1, max: 16, onCommit: () => undefined }),
  );
  const field = view.host.querySelector("input")!;
  let blurs = 0;
  field.addEventListener("blur", () => blurs++);
  await type(field, "12");
  for (const ime of IME) await press(field, "Enter", { ime });
  expect(blurs).toBe(0);

  await press(field, "Enter");
  expect(blurs).toBe(1);
});

test("Review's search: the Enter of a conversion opens no pull request; a plain Enter opens a pasted one", async () => {
  const project = {
    id: "p1",
    name: "app",
    path: "/Users/me/app",
    repository: { host: "github.com", full_name: "acme/app" },
  };
  const client = {
    call: async (method: string) =>
      method === "pr.list"
        ? { prs: [] as PrSummary[], viewers: {}, errors: [] }
        : new Promise(() => undefined),
  } as unknown as Client;
  const seen: string[] = [];
  const view = await page(
    runtime(client, { projects: [project] }),
    [createElement(ReviewQueue, { key: "queue" }), createElement(Where, { key: "where", seen })],
    "/review",
  );
  await settle(3);
  const field = view.host.querySelector('input[aria-label="Search pull requests"]')!;
  await type(field, "https://github.com/acme/app/pull/12");
  for (const ime of IME) await press(field, "Enter", { ime });
  expect(seen).toEqual(["/review"]);

  await press(field, "Enter");
  expect(seen.at(-1)).toMatch(/\/12$/);
});
