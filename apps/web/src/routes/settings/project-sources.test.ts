// Settings > Projects > Sources: the project's sources with where each sits on this computer, one added by its
// GitHub owner/name or URL or as a folder, one removed; the project's own stays, and a refusal shows as it is.
import { buttons, click, container, settle, submit, type } from "../../lib/dom.test-support.ts";
import { ErrorCodes, type Project, type ProjectSource } from "@caveman-app/session-protocol";
import { SessionProtocolError } from "@caveman-app/session-protocol/client";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import { thisComputer } from "../../lib/platform.ts";
import { RuntimeFixture, type RuntimeContextValue } from "../../state/runtime.tsx";
import { sourcePlace, sourceToAdd, SourcesSettings } from "./Projects.tsx";

const link = (full_name: string) => ({
  host: "github.com",
  full_name,
  web_url: `https://github.com/${full_name}`,
  clone_url: `https://github.com/${full_name}.git`,
});
const SOURCES: ReadonlyArray<ProjectSource> = [
  {
    kind: "repo",
    name: "api",
    repository: link("acme/api"),
    path: "/Users/me/code/api",
    focus: "services/billing",
  },
  { kind: "repo", name: "web", repository: link("acme/web") },
  { kind: "folder", name: "notes", path: "/Users/me/notes" },
];
const project = (sources?: ReadonlyArray<ProjectSource>) =>
  ({
    id: "p1",
    name: "acme",
    path: "/Users/me/code/api",
    repository: link("acme/api"),
    ...(sources ? { sources } : {}),
  }) as Project;

async function mount(p: Project, refusal?: string) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let refreshed = 0;
  const client = {
    call: (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      return refusal
        ? Promise.reject(
            new SessionProtocolError({
              code: ErrorCodes.invalid_state,
              message: refusal,
              data: { reason: "invalid_state" },
            }),
          )
        : Promise.resolve(p);
    },
    on: () => () => undefined,
  };
  const value = {
    status: "connected",
    error: null,
    client,
    identity: {},
    connection: 1,
    workspaces: [],
    raw: new Map(),
    projects: [p],
    engines: [],
    settings: null,
    refresh: async () => void refreshed++,
    markSeen: () => undefined,
  } as unknown as RuntimeContextValue;
  const host = container();
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(RuntimeFixture, {
          value,
          children: createElement(SourcesSettings, { project: p }),
        }),
      ),
    ),
  );
  const sent = () => calls.map((c) => ({ method: c.method, ...c.params, request_id: undefined }));
  return { host, sent, refreshed: () => refreshed, unmount: () => act(async () => root.unmount()) };
}

test("each source says what it is, where it sits here and what part of it the project is about", async () => {
  const page = await mount(project(SOURCES));
  const text = page.host.textContent ?? "";
  expect(text).toContain("acme/api · ~/code/api · Focus on services/billing");
  expect(text).toContain(
    `acme/web · Not on ${thisComputer} yet: cloned when a chat first works in it`,
  );
  expect(text).toContain("Folder · ~/notes");
  // The project's own source stays: only the others can be removed.
  expect(buttons(page.host, "Remove").map((b) => b.getAttribute("aria-label"))).toEqual([
    "Remove web",
    "Remove notes",
  ]);
  await page.unmount();
});

test("a project with one source lists its own repository, with nothing to remove", async () => {
  const page = await mount(project());
  expect(page.host.textContent).toContain("acme/api · ~/code/api");
  expect(buttons(page.host, "Remove")).toEqual([]);
  expect(buttons(page.host, "Add")[0]?.disabled).toBe(true);
  await page.unmount();
});

test("what is typed is added as a repository, or as a folder when it is a path", async () => {
  expect(sourceToAdd("  acme/docs ")).toEqual({ repository: "acme/docs" });
  expect(sourceToAdd("https://github.com/acme/docs")).toEqual({
    repository: "https://github.com/acme/docs",
  });
  expect(sourceToAdd("/Users/me/design")).toEqual({ path: "/Users/me/design" });
  expect(sourceToAdd("~/design")).toEqual({ path: "~/design" });
  expect(sourceToAdd("   ")).toBeNull();
  expect(sourcePlace({ kind: "folder", name: "notes", path: "/Users/me/notes" })).toBe("~/notes");

  const page = await mount(project(SOURCES));
  const field = page.host.querySelector("input");
  await type(field, "acme/docs");
  await submit(page.host.querySelector("form"));
  await settle();
  expect(page.sent()).toEqual([
    {
      method: "project.add_source",
      project_id: "p1",
      repository: "acme/docs",
      request_id: undefined,
    },
  ]);
  expect(page.refreshed()).toBe(1);
  // The field empties once it is added.
  expect(page.host.querySelector("input")?.value).toBe("");
  await type(page.host.querySelector("input"), "~/design");
  await submit(page.host.querySelector("form"));
  await settle();
  expect(page.sent()[1]).toEqual({
    method: "project.add_source",
    project_id: "p1",
    path: "~/design",
    request_id: undefined,
  });
  await page.unmount();
});

test("Remove takes a source out by its name", async () => {
  const page = await mount(project(SOURCES));
  await click(buttons(page.host, "Remove")[1]);
  await settle();
  expect(page.sent()).toEqual([
    { method: "project.remove_source", project_id: "p1", name: "notes", request_id: undefined },
  ]);
  await page.unmount();
});

test("the runtime's refusal shows in its own words, and what was typed stays", async () => {
  const why = "acme/docs is already a source of Docs. A source belongs to one project.";
  const page = await mount(project(SOURCES), why);
  await type(page.host.querySelector("input"), "acme/docs");
  await submit(page.host.querySelector("form"));
  await settle();
  expect(page.host.textContent).toContain(why);
  expect(page.host.querySelector("input")?.value).toBe("acme/docs");
  expect(page.refreshed()).toBe(0);
  await page.unmount();
});
