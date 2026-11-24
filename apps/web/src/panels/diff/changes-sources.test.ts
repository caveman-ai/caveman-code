// The Changes tab of a chat in several sources: its files sit under a heading per source (name, branch, pull
// request) in the chat's source order, each with its path inside the source, in the diffs and in the file list alike.
// A chat in one source lists its files as they are, under no heading.
import { document as doc } from "../../testing/dom.ts";
import type { Workspace } from "@caveman-app/session-protocol";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("../../state/runtime.tsx", async (real) => ({
  ...(await real<object>()),
  useSession: () => ({
    view: { diffVersion: 0, checkpoints: [] },
    model: null,
    historyVersion: 0,
    feed: null,
  }),
}));
// Each file's diff is a marker that says the path its header shows.
vi.mock("./FileDiff.tsx", async (real) => {
  const { createElement } = await import("react");
  return {
    ...(await real<object>()),
    FileDiff: ({ file, shownPath }: { file: { path: string }; shownPath?: string }) =>
      createElement("section", { "data-diff-path": file.path, "data-shown": shownPath ?? "" }),
  };
});

const { RuntimeFixture } = await import("../../state/runtime.tsx");
const { Changes } = await import("./DiffSurface.tsx");
const { chatSources } = await import("../../state/sources.ts");

const noop = () => undefined;
const link = (full_name: string) => ({
  host: "github.com",
  full_name,
  web_url: `https://github.com/${full_name}`,
  clone_url: `https://github.com/${full_name}.git`,
});
const file = (path: string) => ({
  path,
  status: "modified",
  additions: 2,
  deletions: 1,
  patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,2 @@\n x\n+y\n`,
});
const SEVERAL = {
  source: "api",
  base_ref: "main",
  branch: "caveman/rename",
  pull_request: { number: 128, url: "https://github.com/acme/api/pull/128", state: "open" },
  checkouts: [
    {
      name: "web",
      repo: { url: "https://github.com/acme/web.git" },
      repository: link("acme/web"),
      base_ref: "main",
      branch: "caveman/rename",
      pull_request: { number: 57, url: "https://github.com/acme/web/pull/57", state: "draft" },
    },
    { name: "notes", repo: { path: "/Users/me/notes" }, base_ref: "", branch: "", folder: true },
  ],
} as unknown as Workspace;

let unmount = noop as () => Promise<void> | void;
afterEach(() => unmount());

async function mount(files: ReadonlyArray<string>, workspace: Workspace | undefined) {
  localStorage.setItem("caveman.diff.files", "1");
  localStorage.setItem("caveman.diff.files.narrow", "1");
  const client = {
    call: async (method: string) =>
      method === "fs.diff"
        ? { from: "main", to: "WORKTREE", files: files.map(file) }
        : method === "actions.list"
          ? { actions: [] }
          : { terminals: [] },
    on: () => noop,
    subscribe: () => noop,
  };
  const runtime = {
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
  };
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host);
  const tab = { id: "t1", kind: "diff", params: {} };
  const surface = createElement(Changes, {
    workspaceId: "W1",
    tab,
    active: true,
    sessionId: "S1",
    sources: chatSources(workspace),
    projectId: "p1",
  } as never);
  await act(async () =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(
          MemoryRouter,
          null,
          createElement(RuntimeFixture, { value: runtime as never, children: surface }),
        ),
      ),
    ),
  );
  for (let i = 0; i < 10; i++) await act(() => new Promise((r) => setTimeout(r, 2)));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  const scroller = host.querySelector("[data-diff-scroller]")!;
  const list = host.querySelector("aside")!;
  // What each column reads, top to bottom: a heading as "# name", a file as the path it shows.
  const column = (within: Element, fileOf: (el: Element) => string | null) =>
    [...within.children].map((el) =>
      el.hasAttribute("data-source-heading")
        ? `# ${el.firstElementChild?.textContent}`
        : fileOf(el),
    );
  return {
    host,
    diffs: () =>
      column(scroller, (el) => el.getAttribute("data-shown") || el.getAttribute("data-diff-path")),
    listed: () => column(list, (el) => el.querySelector("span > span")!.parentElement!.textContent),
    headings: () => [...scroller.querySelectorAll("[data-source-heading]")],
  };
}

test("a chat in several sources lists its changes under each source, in the chat's order, with paths inside the source", async () => {
  const shown = await mount(
    ["web/src/app.ts", "api/src/server.ts", "notes/todo.md", "api/package.json", "README.md"],
    SEVERAL,
  );
  expect(shown.diffs()).toEqual([
    "# api",
    "src/server.ts",
    "package.json",
    "# web",
    "src/app.ts",
    "# notes",
    "todo.md",
    "# Chat's folder",
    "README.md",
  ]);
  // The file list beside them reads the same: the name, then its folder inside the source.
  expect(shown.listed()).toEqual([
    "# api",
    "server.tssrc",
    "package.json",
    "# web",
    "app.tssrc",
    "# notes",
    "todo.md",
    "# Chat's folder",
    "README.md",
  ]);
  // Each heading: the branch the chat works on there and its own pull request; a plain folder says what it is.
  const [api, web, notes] = shown.headings();
  expect(api!.textContent).toBe("apicaveman/rename");
  expect(api!.querySelector("[role='img']")?.getAttribute("aria-label")).toBe(
    "api: pull request #128, open",
  );
  expect(web!.querySelector("[role='img']")?.getAttribute("aria-label")).toBe(
    "web: pull request #57, draft",
  );
  expect(notes!.textContent).toBe("notesFolder");
  expect(notes!.querySelector("[role='img']")).toBeNull();
  // The count in the bar is every source's.
  expect(shown.host.textContent).toContain("5 files");
});

test("a chat in one source lists its files as they are, under no heading", async () => {
  const shown = await mount(["src/a.ts", "api/b.ts"], undefined);
  expect(shown.headings()).toEqual([]);
  expect(shown.diffs()).toEqual(["src/a.ts", "api/b.ts"]);
  expect(shown.listed()).toEqual(["a.tssrc", "b.tsapi"]);
});
