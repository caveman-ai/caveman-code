import type { ProjectCandidate } from "@caveman-app/session-protocol";
import { describe, expect, test } from "vitest";
import { ago, answers, candidatesFor, candidateSections, parentLabel, parseAddQuery, readAddField } from "./project-candidates.ts";

const repo = (full_name: string) => ({ host: "github.com", full_name, web_url: `https://github.com/${full_name}`, clone_url: `https://github.com/${full_name}.git` });
const local = (name: string, path: string, extra: Partial<ProjectCandidate> = {}): ProjectCandidate => ({ name, path, sources: ["claude"], sessions: 3, ...extra });

describe("parseAddQuery", () => {
  test("paths, URLs and owner/name", () => {
    expect(parseAddQuery("~/code/app")).toEqual({ kind: "path", path: "~/code/app" });
    expect(parseAddQuery("/Users/me/app")).toEqual({ kind: "path", path: "/Users/me/app" });
    expect(parseAddQuery("https://github.com/acme/widget/tree/main/src")).toEqual({ kind: "url", url: "https://github.com/acme/widget/tree/main/src", fullName: "acme/widget" });
    expect(parseAddQuery("git@github.com:acme/widget.git")).toMatchObject({ fullName: "acme/widget" });
    expect(parseAddQuery("https://gitlab.com/acme/widget.git")).toMatchObject({ kind: "url", fullName: null });
    expect(parseAddQuery("acme/widget")).toEqual({ kind: "url", url: "acme/widget", fullName: "acme/widget" });
    expect(parseAddQuery("github.com/acme/widget")).toMatchObject({ url: "https://github.com/acme/widget", fullName: "acme/widget" });
    // Windows: a drive or a network share, either separator.
    expect(parseAddQuery("C:\\Users\\me\\app")).toEqual({ kind: "path", path: "C:\\Users\\me\\app" });
    expect(parseAddQuery("d:/src/app")).toEqual({ kind: "path", path: "d:/src/app" });
    expect(parseAddQuery("\\\\server\\share\\app")).toEqual({ kind: "path", path: "\\\\server\\share\\app" });
    expect(parseAddQuery("widget")).toBeNull();
    expect(parseAddQuery("acme widget")).toBeNull();
  });
});

describe("answers", () => {
  const item = { name: "widget", full_name: "acme/widget", path: "/Users/me/code/widget" };
  test("word search over name, owner/name and path", () => {
    expect(answers("", item)).toBe(true);
    expect(answers("acme wid", item)).toBe(true);
    expect(answers("gadget", item)).toBe(false);
  });
  test("a URL finds its repository only", () => {
    expect(answers("https://github.com/ACME/widget", item)).toBe(true);
    expect(answers("acme/gadget", item)).toBe(false);
  });
  test("a path finds checkouts under it, ~ or not", () => {
    expect(answers("~/code/wi", item)).toBe(true);
    expect(answers("/Users/me/code", item)).toBe(true);
    expect(answers("~/src", item)).toBe(false);
  });
  test("a Windows path finds checkouts under it, in either separator and any case, ~ or not", () => {
    const windows = { name: "widget", full_name: "acme/widget", path: "C:\\Users\\Me\\code\\widget" };
    expect(answers("C:\\Users\\Me\\code", windows)).toBe(true);
    expect(answers("c:/users/me/code/wid", windows)).toBe(true);
    expect(answers("~\\code\\wi", windows)).toBe(true);
    expect(answers("D:\\code", windows)).toBe(false);
  });
});

describe("candidateSections", () => {
  const candidates: ProjectCandidate[] = [
    { name: "api", sources: ["github"], sessions: 0, repository: repo("acme/api") },
    local("widget", "/Users/me/code/widget", { repository: repo("acme/widget") }),
    local("added", "/Users/me/code/added", { project_id: "p1" }),
    local("notes", "/Users/me/notes", { sources: ["folder"], sessions: 0 }),
  ];
  test("checkouts first, GitHub-only after, projects left out", () => {
    expect(candidateSections(candidates, "").map((r) => `${r.section}:${r.candidate.name}`)).toEqual(["Suggested:widget", "Suggested:notes", "On GitHub:api"]);
  });
  test("a pasted URL narrows to that repository", () => {
    expect(candidateSections(candidates, "https://github.com/acme/api").map((r) => r.candidate.name)).toEqual(["api"]);
    expect(candidateSections(candidates, "github.com/acme/widget").map((r) => r.candidate.name)).toEqual(["widget"]);
    expect(candidateSections(candidates, "acme/nothing")).toEqual([]);
  });
});

describe("readAddField", () => {
  test("This Mac takes a path, searches anything else, and hands a link to GitHub", () => {
    expect(readAddField("folder", " ~/code/app ")).toEqual({ kind: "path", path: "~/code/app" });
    expect(readAddField("folder", "widget")).toEqual({ kind: "search" });
    // A bare owner/name is a search here: it names the checkout of that repository.
    expect(readAddField("folder", "acme/widget")).toEqual({ kind: "search" });
    expect(readAddField("folder", "https://github.com/acme/widget")).toEqual({ kind: "elsewhere", to: "github" });
    expect(readAddField("folder", "github.com/acme/widget")).toEqual({ kind: "elsewhere", to: "github" });
    expect(readAddField("folder", "git@github.com:acme/widget.git")).toEqual({ kind: "elsewhere", to: "github" });
  });
  test("GitHub takes a link or owner/name, searches words, and hands a path to This Mac", () => {
    expect(readAddField("github", "acme/widget")).toEqual({ kind: "url", url: "acme/widget", fullName: "acme/widget" });
    expect(readAddField("github", "https://github.com/acme/widget/pull/7")).toMatchObject({ kind: "url", fullName: "acme/widget" });
    expect(readAddField("github", "widget")).toEqual({ kind: "search" });
    expect(readAddField("github", "")).toEqual({ kind: "search" });
    expect(readAddField("github", "/Users/me/code/widget")).toEqual({ kind: "elsewhere", to: "folder" });
    expect(readAddField("github", "C:\\code\\widget")).toEqual({ kind: "elsewhere", to: "folder" });
  });
});

describe("candidatesFor", () => {
  const candidates: ProjectCandidate[] = [
    { name: "api", sources: ["github"], sessions: 0, repository: repo("acme/api") },
    local("widget", "/Users/me/code/widget", { repository: repo("acme/widget"), sources: ["claude", "github"] }),
    local("added", "/Users/me/code/added", { project_id: "p1", repository: repo("acme/added") }),
    local("notes", "/Users/me/notes", { sources: ["folder"], sessions: 0 }),
    local("lab", "/Users/me/code/lab", { repository: { host: "gitlab.com", full_name: "acme/lab", web_url: "https://gitlab.com/acme/lab", clone_url: "https://gitlab.com/acme/lab.git" } }),
  ];
  const names = (from: "folder" | "github", q = "") => candidatesFor(from, candidates, q).map((c) => c.name);
  test("This Mac lists every checkout here; GitHub every GitHub repository, cloned or not; neither a project", () => {
    expect(names("folder")).toEqual(["widget", "notes", "lab"]);
    expect(names("github")).toEqual(["api", "widget"]);
  });
  test("the field narrows each list", () => {
    expect(names("folder", "~/code")).toEqual(["widget", "lab"]);
    expect(names("folder", "note")).toEqual(["notes"]);
    expect(names("github", "acme/api")).toEqual(["api"]);
    expect(names("github", "wid")).toEqual(["widget"]);
  });
});

test("ago and parentLabel", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  expect(ago("2026-10-15T11:59:40Z", now)).toBe("now");
  expect(ago("2026-10-15T11:15:00Z", now)).toBe("45m");
  expect(ago("2026-10-15T02:00:00Z", now)).toBe("10h");
  expect(ago("2026-10-10T12:00:00Z", now)).toBe("5d");
  expect(ago("2026-09-10T12:00:00Z", now)).toBe("5w");
  expect(parentLabel("/Users/me/Desktop/GitHub/app")).toBe("~/Desktop/GitHub");
  expect(parentLabel("/home/me/app")).toBe("~");
  expect(parentLabel("/srv/app")).toBe("/srv");
  expect(parentLabel("C:\\Users\\me\\code\\app")).toBe("~\\code");
  expect(parentLabel("D:\\app")).toBe("D:\\");
});
