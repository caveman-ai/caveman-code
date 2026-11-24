// A project with several sources: what a chat can still add, which sources a new chat works in and what it sends,
// what keeps a start off Cloud, and changed files under their source. A chat in one source is left exactly as it was.
import type { Project, ProjectSource, Workspace } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";
import { chatStage, hasWorkToLand, unmergedWork, type SourceView } from "./model.ts";
import {
  addableSources,
  chatSources,
  cloudLeavesOut,
  cloudPill,
  cloudSources,
  createSources,
  groupChanges,
  leftOutSources,
  pathInSource,
  rememberLeftOut,
  sourceLine,
  sourcePullRequests,
  SEVERAL_REPOSITORIES_MOVE,
  sourcesFor,
  sourcesLabel,
  staysOnMacLine,
  withoutLabel,
  tickedSources,
  toggleSource,
} from "./sources.ts";

const link = (full_name: string, host = "github.com") => ({
  host,
  full_name,
  web_url: `https://${host}/${full_name}`,
  clone_url: `https://${host}/${full_name}.git`,
});
const API: ProjectSource = {
  kind: "repo",
  name: "api",
  repository: link("acme/api"),
  path: "/Users/me/code/api",
};
const WEB: ProjectSource = { kind: "repo", name: "web", repository: link("acme/web") };
const NOTES: ProjectSource = { kind: "folder", name: "notes", path: "/Users/me/notes" };
const TOOLS: ProjectSource = { kind: "repo", name: "tools", path: "/Users/me/code/tools" };
const SOURCES = [API, WEB, NOTES];
const project = (sources?: ReadonlyArray<ProjectSource>): Project =>
  ({
    id: "p1",
    name: "api",
    path: API.path!,
    repository: API.repository!,
    ...(sources ? { sources } : {}),
  }) as Project;

const pr = (number: number, state: "open" | "draft" | "merged" = "open") => ({
  number,
  url: `https://github.com/x/pull/${number}`,
  state,
});
const chat = (over: Partial<Workspace> = {}): Workspace =>
  ({
    id: "w1",
    title: "t",
    repo: { path: API.path! },
    base_ref: "main",
    branch: "caveman/fix",
    engine: "caveman",
    computer: { id: "this_mac", kind: "this_mac", label: "This Mac", status: "online" },
    session_id: "s1",
    status: "idle",
    ...over,
  }) as Workspace;
const SEVERAL = chat({
  source: "api",
  pull_request: pr(12),
  checkouts: [
    {
      name: "web",
      repo: { url: "https://github.com/acme/web.git" },
      repository: link("acme/web"),
      base_ref: "main",
      branch: "caveman/fix",
      pull_request: pr(7, "draft"),
    },
    { name: "notes", repo: { path: NOTES.path! }, base_ref: "", branch: "", folder: true },
  ],
});

function storage(): Pick<Storage, "getItem" | "setItem"> {
  const kept = new Map<string, string>();
  return { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => void kept.set(k, v) };
}

test("a chat in one source reads as no sources at all", () => {
  expect(chatSources(chat())).toBeNull();
  expect(chatSources(undefined)).toBeNull();
  expect(chatSources(SEVERAL)?.checkouts?.map((c) => c.name)).toEqual(["web", "notes"]);
});

test("a chat is offered the sources of its project it does not work in yet", () => {
  expect(addableSources(project(SOURCES), chat()).map((s) => s.name)).toEqual(["web", "notes"]);
  expect(
    addableSources(
      project(SOURCES),
      chat({ source: "api", checkouts: [SEVERAL.checkouts![0]!] }),
    ).map((s) => s.name),
  ).toEqual(["notes"]);
  expect(addableSources(project(SOURCES), SEVERAL)).toEqual([]);
  // A chat that started in another source of the project (workspace.create's project_id) is offered the project's own.
  expect(
    addableSources(
      project(SOURCES),
      chat({ repo: { url: "https://github.com/acme/web.git" } }),
    ).map((s) => s.name),
  ).toEqual(["api", "notes"]);
});

test("nothing is offered where nothing can be added", () => {
  expect(addableSources(project(), chat())).toEqual([]);
  expect(addableSources(undefined, chat())).toEqual([]);
  expect(addableSources(project(SOURCES), chat({ status: "archived" }))).toEqual([]);
  expect(addableSources(project(SOURCES), chat({ kind: "chief" } as Partial<Workspace>))).toEqual(
    [],
  );
  // A plain folder stays on its Mac: a chat on a Cloud computer is offered the repositories only.
  const cloud = chat({
    computer: { id: "c1", kind: "caveman_cloud", label: "Cloud", status: "online" },
  });
  expect(addableSources(project(SOURCES), cloud).map((s) => s.name)).toEqual(["web"]);
});

test("a new chat works in every source until the person leaves one out, and the first is always in", () => {
  expect(tickedSources(SOURCES, []).map((s) => s.name)).toEqual(["api", "web", "notes"]);
  expect(tickedSources(SOURCES, ["notes", "api"]).map((s) => s.name)).toEqual(["api", "web"]);
  expect(toggleSource(SOURCES, [], "notes")).toEqual(["notes"]);
  expect(toggleSource(SOURCES, ["notes"], "notes")).toEqual([]);
  expect(toggleSource(SOURCES, [], "api")).toEqual([]);
  // A source the project no longer has is forgotten with the next change.
  expect(toggleSource(SOURCES, ["gone"], "web")).toEqual(["web"]);
});

test("the pick is remembered per project", () => {
  const kept = storage();
  expect(leftOutSources(kept, "p1")).toEqual([]);
  rememberLeftOut(kept, "p1", ["notes"]);
  rememberLeftOut(kept, "p2", ["web"]);
  expect(leftOutSources(kept, "p1")).toEqual(["notes"]);
  expect(leftOutSources(kept, "p2")).toEqual(["web"]);
  rememberLeftOut(kept, "p1", []);
  expect(leftOutSources(kept, "p1")).toEqual([]);
  expect(leftOutSources(kept, "p2")).toEqual(["web"]);
  expect(leftOutSources({ getItem: () => "not json" }, "p1")).toEqual([]);
});

test('the chip names what the chat works in, never "all" or "only"', () => {
  expect(sourcesLabel(SOURCES)).toBe(SOURCES.map((x) => x.name).join(", "));
  expect(sourcesLabel([API])).toBe("api");
  expect(sourcesLabel([API, NOTES])).toBe("api, notes");
});

test("workspace.create names sources only when more than the first is ticked", () => {
  expect(createSources([API])).toEqual({});
  expect(createSources([API, WEB])).toEqual({ sources: ["api", "web"] });
  expect(createSources(SOURCES)).toEqual({ sources: ["api", "web", "notes"] });
});

test("Cloud is started without what it cannot have, and the pill says so; nothing asks the person to untick", () => {
  expect(cloudLeavesOut([API, WEB])).toEqual([]);
  expect(cloudLeavesOut([API])).toEqual([]);
  expect(cloudLeavesOut([API, WEB, NOTES]).map((x) => x.name)).toEqual(["notes"]);
  expect(cloudLeavesOut([API, NOTES, TOOLS]).map((x) => x.name)).toEqual(["notes", "tools"]);
  // Only GitHub: a repository hosted elsewhere stays on the Mac too.
  expect(
    cloudLeavesOut([
      API,
      { kind: "repo", name: "lab", repository: link("acme/lab", "gitlab.com") },
    ]).map((x) => x.name),
  ).toEqual(["lab"]);
  // The project's own is the Cloud row's to refuse, never left out.
  expect(cloudLeavesOut([NOTES, API])).toEqual([]);

  // Where it runs decides what it works in; the ticks themselves stay the person's.
  expect(sourcesFor([API, WEB, NOTES], false).map((x) => x.name)).toEqual(["api", "web", "notes"]);
  expect(sourcesFor([API, WEB, NOTES], true).map((x) => x.name)).toEqual(["api", "web"]);

  expect(withoutLabel([])).toBeNull();
  expect(withoutLabel([NOTES])).toBe("without notes");
  expect(withoutLabel([NOTES, TOOLS])).toBe("without notes and tools");
  expect(withoutLabel([NOTES, TOOLS, WEB])).toBe("without notes and 2 more");

  expect(cloudPill("Cloud", null)).toBe("Cloud");
  expect(cloudPill("Cloud", "without notes")).toBe("Cloud · without notes");
  expect(cloudPill("Cloud · setting up 3/5", "without notes")).toBe(
    "Cloud · without notes · setting up 3/5",
  );
  expect(cloudPill("Cloud · setup failed", null)).toBe("Cloud · setup failed");
});

test("a chat in several repositories is told it stays on this Mac before Send, only while chats keep going in Cloud", () => {
  expect(staysOnMacLine(2, true, "this Mac")).toBe(
    "Chats in several repositories stay on this Mac.",
  );
  expect(staysOnMacLine(3, true, "this Mac")).toBe(
    "Chats in several repositories stay on this Mac.",
  );
  // One repository moves; and with the setting off nothing moves, so there is nothing to say.
  expect(staysOnMacLine(1, true, "this Mac")).toBeNull();
  expect(staysOnMacLine(2, false, "this Mac")).toBeNull();
  // One switch decides it: the line goes when chats in several repositories move.
  expect(SEVERAL_REPOSITORIES_MOVE).toBe(false);
});

test("a Cloud start names the other repositories as checkouts and every repository as its sources", () => {
  expect(cloudSources([API])).toEqual({});
  expect(cloudSources([API, WEB])).toEqual({
    checkouts: [{ repo: "acme/web" }],
    sources: ["acme/api", "acme/web"],
  });
});

test("changed files sit under their source, in the chat's order, with the path inside it", () => {
  const files = [
    "web/src/app.ts",
    "api/src/server.ts",
    "README.md",
    "api/package.json",
    "notes/todo.md",
  ];
  const groups = groupChanges(chatSources(SEVERAL)!, files, (f) => f);
  expect(groups.map((g) => g.name)).toEqual(["api", "web", "notes", ""]);
  expect(groups[0]!.items.map((i) => i.path)).toEqual(["src/server.ts", "package.json"]);
  expect(groups[0]!.items.map((i) => i.item)).toEqual(["api/src/server.ts", "api/package.json"]);
  expect(groups[0]!.source).toMatchObject({
    name: "api",
    primary: true,
    branch: "caveman/fix",
    pull_request: { number: 12 },
  });
  expect(groups[1]!.source).toMatchObject({
    name: "web",
    primary: false,
    pull_request: { number: 7, state: "draft" },
  });
  expect(groups[2]!.source).toMatchObject({ name: "notes", folder: true });
  // A file in the chat's folder itself is in no source: its path is as given.
  expect(groups[3]).toMatchObject({ name: "", source: null, items: [{ path: "README.md" }] });
  expect(pathInSource(chatSources(SEVERAL)!, "web/src/app.ts")).toBe("src/app.ts");
  expect(pathInSource(chatSources(SEVERAL)!, "README.md")).toBe("README.md");
});

test("each source's pull request, the primary's first, with the repository Review reads another's through", () => {
  expect(sourcePullRequests(chatSources(SEVERAL)!)).toEqual([
    { source: "api", pr: pr(12) },
    { source: "web", pr: pr(7, "draft"), repo: "acme/web", host: "github.com" },
  ]);
});

test("a source in one line: its repository, else what it is", () => {
  expect(sourceLine(API)).toBe("acme/api");
  expect(sourceLine(NOTES)).toBe("Folder");
  expect(sourceLine(TOOLS, "this Mac")).toBe("Repository on this Mac");
});

test("a chat in several sources has work to land while any one of them does", () => {
  const open = { number: 7, url: "u", state: "open" as const };
  const merged = { number: 12, url: "u", state: "merged" as const };
  const view = (sources: ReadonlyArray<SourceView>) => ({
    unread: false,
    sources,
    ...(sources[0]?.pullRequest ? { pullRequest: sources[0].pullRequest } : {}),
  });
  // The primary's pull request merged, another source's still open: not done.
  expect(
    hasWorkToLand(
      view([
        { name: "api", pullRequest: merged },
        { name: "web", pullRequest: open },
      ]),
    ),
  ).toBe(true);
  expect(
    chatStage(
      null,
      view([
        { name: "api", pullRequest: merged },
        { name: "web", pullRequest: open },
      ]),
    ),
  ).toBe("review");
  expect(
    hasWorkToLand(
      view([
        { name: "api", pullRequest: merged },
        { name: "web", pullRequest: merged },
      ]),
    ),
  ).toBe(false);
  expect(
    hasWorkToLand(view([{ name: "api" }, { name: "web", unmerged: { files: 2, commits: 0 } }])),
  ).toBe(true);
  expect(hasWorkToLand(view([{ name: "api" }, { name: "notes" }]))).toBe(false);
  // A chat in one source is read as before.
  expect(hasWorkToLand({ pullRequest: merged, unmerged: { files: 0, commits: 2 } })).toBe(false);
  expect(hasWorkToLand({ unmerged: { files: 1, commits: 0 } })).toBe(true);
});

test("what waits to land with no pull request to say so, summed over the sources that have none", () => {
  const open = { number: 7, url: "u", state: "open" as const };
  expect(unmergedWork({ unmerged: { files: 3, commits: 2 } })).toEqual({ files: 3, commits: 2 });
  expect(unmergedWork({ pullRequest: open, unmerged: { files: 3, commits: 2 } })).toBeUndefined();
  expect(
    unmergedWork({
      sources: [
        { name: "api", pullRequest: open, unmerged: { files: 9, commits: 9 } },
        { name: "web", unmerged: { files: 1, commits: 1 } },
        { name: "docs", unmerged: { files: 2, commits: 0 } },
      ],
    }),
  ).toEqual({ files: 3, commits: 1 });
  expect(
    unmergedWork({ sources: [{ name: "api", pullRequest: open }, { name: "web" }] }),
  ).toBeUndefined();
});
