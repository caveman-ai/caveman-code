// Settings > Projects' Secrets row moves to another project without remounting (one SecretsSettings, a new repo), and
// the runtime answers reads concurrently: whatever the previous repository's calls answer late, and whatever it showed,
// had open or still had running, the page shows only the repository its buttons act on.
import { button, click, deferred, mount, rendered, settle } from "./settings/browser.fixture.ts";

import { SessionProtocolError } from "@caveman-app/session-protocol";
import { createElement } from "react";
import { afterEach, expect, test } from "vitest";

import { RuntimeFixture, type RuntimeContextValue } from "../state/runtime.tsx";
import { SecretsSettings } from "./Secrets.tsx";

type Repo = { readonly path: string };
const A: Repo = { path: "/repos/a" };
const B: Repo = { path: "/repos/b" };
// As Settings > Projects renders it, for one project's checkout.
const ProjectSecrets: (props: { readonly repo: Repo }) => ReturnType<typeof SecretsSettings> =
  SecretsSettings;
const secret = (name: string) => ({ name, hidden: true, updated_at: "2026-11-01T00:00:00Z" });

let page: Awaited<ReturnType<typeof mount>> | undefined;
afterEach(async () => {
  await page?.unmount();
  page = undefined;
});

/** The row on a runtime whose every call waits until the test answers it, by method and repository. */
async function secretsOf(repo: Repo) {
  const pending = new Map<string, ReturnType<typeof deferred<unknown>>>();
  const calls: Array<{ method: string; params: { repo?: Repo; name?: string } }> = [];
  const client = {
    on: () => () => undefined,
    call: (method: string, params: { repo?: Repo; name?: string }) => {
      calls.push({ method, params });
      if (method === "cloud.profile.status") return Promise.resolve({ state: "off" });
      const d = deferred<unknown>();
      pending.set(`${method} ${params.repo?.path}`, d);
      return d.promise;
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
  const row = (r: Repo) =>
    createElement(RuntimeFixture, { value, children: createElement(ProjectSecrets, { repo: r }) });
  page = await mount(row(repo));
  const waiting = (key: string) => {
    const d = pending.get(key);
    if (!d)
      throw new Error(
        `no ${key} waiting; asked: ${calls.map((c) => `${c.method} ${c.params.repo?.path}`).join(", ")}`,
      );
    pending.delete(key);
    return d;
  };
  const answer = async (key: string, result: unknown) => {
    waiting(key).resolve(result);
    await settle();
  };
  const refuse = async (key: string, error: unknown) => {
    waiting(key).reject(error);
    await settle();
  };
  const list = async (
    r: Repo,
    repository: string,
    names: string[],
    envFiles: Array<{ path: string; names: string[] }> = [],
  ) => {
    await answer(`secret.list ${r.path}`, { repository, secrets: names.map(secret) });
    await answer(`secret.env_files ${r.path}`, { files: envFiles });
  };
  return {
    container: page.container,
    switchTo: (r: Repo) => page!.rerender(row(r)),
    answer,
    refuse,
    list,
    calls,
  };
}

const shows = (el: Element, ...what: string[]) =>
  Object.fromEntries(what.map((w) => [w, el.textContent?.includes(w) ?? false]));
const buttons = (el: Element) =>
  [...el.querySelectorAll("button")].map(
    (b) => b.getAttribute("aria-label") ?? b.textContent?.trim() ?? "",
  );

test("the previous repository's late answer does not replace the current one's", async () => {
  const p = await secretsOf(A);
  await p.switchTo(B);
  await p.list(B, "github.com/acme/b", ["B_TOKEN"]);
  await p.list(A, "github.com/acme/a", ["A_ONLY_SECRET"], [{ path: ".env.a", names: ["A_ENV"] }]);
  expect(
    shows(
      p.container,
      "B_TOKEN",
      "github.com/acme/b",
      "A_ONLY_SECRET",
      "github.com/acme/a",
      ".env.a",
    ),
  ).toEqual({
    B_TOKEN: true,
    "github.com/acme/b": true,
    A_ONLY_SECRET: false,
    "github.com/acme/a": false,
    ".env.a": false,
  });
});

test("Delete names a secret of the repository it deletes from", async () => {
  const p = await secretsOf(A);
  await p.switchTo(B);
  await p.list(B, "github.com/acme/b", ["B_TOKEN"]);
  await p.list(A, "github.com/acme/a", ["A_ONLY_SECRET"]);
  await click(button(p.container, /^Delete /));
  expect(
    p.calls
      .filter((c) => c.method === "secret.delete")
      .map((c) => ({ repo: c.params.repo, name: c.params.name })),
  ).toEqual([{ repo: B, name: "B_TOKEN" }]);
});

test("a deletion still running when the project changes does not bring its repository's list back", async () => {
  const p = await secretsOf(A);
  await p.list(A, "github.com/acme/a", ["A_ONLY_SECRET"]);
  await click(button(p.container, "Delete A_ONLY_SECRET"));
  await p.switchTo(B);
  await p.list(B, "github.com/acme/b", ["B_TOKEN"]);
  // A's deletion lands, and the page reads A again.
  await p.answer("secret.delete /repos/a", {});
  await p.list(A, "github.com/acme/a", ["A_OTHER"]);
  expect(
    shows(p.container, "B_TOKEN", "github.com/acme/b", "A_OTHER", "github.com/acme/a"),
  ).toEqual({
    B_TOKEN: true,
    "github.com/acme/b": true,
    A_OTHER: false,
    "github.com/acme/a": false,
  });
});

test("the previous repository's .env files and the import it had open are gone the moment the project changes", async () => {
  const p = await secretsOf(A);
  await p.list(A, "github.com/acme/a", ["A_ONLY_SECRET"], [{ path: ".env.a", names: ["A_ENV"] }]);
  await click(button(p.container, "Review"));
  expect(buttons(p.container)).toContain("Store 1 secret ↵");
  await p.switchTo(B);
  // B has not answered yet: nothing of A's is left to import, delete or label B with.
  expect(
    shows(p.container, ".env.a", "A_ENV", "A_ONLY_SECRET", "github.com/acme/a", "Loading…"),
  ).toEqual({
    ".env.a": false,
    A_ENV: false,
    A_ONLY_SECRET: false,
    "github.com/acme/a": false,
    "Loading…": true,
  });
  expect(buttons(p.container).filter((b) => /^(Review|Store|Delete)/.test(b))).toEqual([]);
});

test("an origin change on the previous repository is not offered on the next one", async () => {
  const p = await secretsOf(A);
  const moved = new SessionProtocolError({
    code: -32000,
    message: "github.com/acme/a moved: its origin is now github.com/other/a",
    data: { reason: "invalid_state" },
  });
  await p.refuse("secret.list /repos/a", moved);
  expect(buttons(p.container)).toContain("Accept new origin");
  await p.switchTo(B);
  expect(shows(p.container, "Origin changed", "moved: its origin")).toEqual({
    "Origin changed": false,
    "moved: its origin": false,
  });
  expect(buttons(p.container)).not.toContain("Accept new origin");
});

test("a deletion that fails after the project changes neither says so on the next project nor holds its buttons", async () => {
  const p = await secretsOf(A);
  await p.list(A, "github.com/acme/a", ["A_ONLY_SECRET"]);
  await click(button(p.container, "Delete A_ONLY_SECRET"));
  await p.switchTo(B);
  await p.list(B, "github.com/acme/b", ["B_TOKEN"]);
  // A's deletion is still running: B's own buttons work.
  expect(rendered(button(p.container, "Delete B_TOKEN")).disabled).toBe(false);
  await p.refuse(
    "secret.delete /repos/a",
    new Error("A_ONLY_SECRET is in use by a running command"),
  );
  expect(shows(p.container, "in use by a running command")).toEqual({
    "in use by a running command": false,
  });
  expect(p.container.querySelector('[role="alert"]')).toBeNull();
  expect(rendered(button(p.container, "Delete B_TOKEN")).disabled).toBe(false);
});
