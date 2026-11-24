import { describe, expect, test } from "vitest";
import type { DiffFile } from "../../panels/diff/parsePatch.ts";
import { findInDiff, isDefinition, isSymbol, repoHits, wordAt } from "./symbols.ts";

describe("what a click names", () => {
  test("the identifier under the caret, never a keyword or a number", () => {
    const line = "function resolveSetting(envValue, readFile) {";
    expect(wordAt(line, 12)).toBe("resolveSetting");
    expect(wordAt(line, 23)).toBe("resolveSetting"); // just after the last letter
    expect(wordAt(line, 3)).toBeNull(); // "function"
    expect(wordAt(line, 22 + 3)).toBe("envValue");
    expect(wordAt("x = 42", 5)).toBeNull();
    expect(isSymbol("$scope")).toBe(true);
    expect(isSymbol("return")).toBe(false);
  });
});

describe("isDefinition", () => {
  const yes: Array<[string, string]> = [
    ["function getDefaultMode(startDir) {", "getDefaultMode"],
    ["export async function resolveSetting(a) {", "resolveSetting"],
    ["const fs = require('fs');", "fs"],
    ["export const reviewGuide = (pr) => pr.guide;", "reviewGuide"],
    ["  const { files, omitted } = diff;", "omitted"],
    ["class PullRequestService extends Base {", "PullRequestService"],
    ["export type PrAddress = { a: 1 };", "PrAddress"],
    ["interface Hunk {", "Hunk"],
    ["  async readFile(path: string): Promise<string> {", "readFile"],
    ["  parseArgs(argv) {", "parseArgs"],
    ["  onSave: (anchor, text) => save(anchor),", "onSave"],
    ["  readonly oldStart: number;", "oldStart"],
    ["def resolve_setting(env_value):", "resolve_setting"],
    ["    def __init__(self):", "__init__"],
    ["func (s *Server) Handle(w http.ResponseWriter) {", "Handle"],
    ["func main() {", "main"],
    ["pub fn parse_patch(diff: &str) -> Vec<Line> {", "parse_patch"],
    ["install_hooks() {", "install_hooks"],
    ["  public static String render(Model m) {", "render"],
    ["CAVEMAN_HOME=/opt/caveman", "CAVEMAN_HOME"],
  ];
  test.each(yes)("%s defines %s", (line, name) => expect(isDefinition(line, name)).toBe(true));

  const no: Array<[string, string]> = [
    ["  const mode = getDefaultMode(dir);", "getDefaultMode"],
    ["  if (envValue !== null) return envValue;", "envValue"],
    ["  return resolveSetting(process.env.X, readFile);", "resolveSetting"],
    ["// resolveSetting walks the repo config", "resolveSetting"],
    ["  foo.bar = 1;", "bar"],
    ["  if (a == b) {", "a"],
  ];
  test.each(no)("%s only uses %s", (line, name) => expect(isDefinition(line, name)).toBe(false));
});

describe("findInDiff and repoHits", () => {
  const f: DiffFile = {
    path: "src/config.js",
    status: "modified",
    additions: 2,
    deletions: 1,
    patch: ["@@ -10,3 +10,4 @@", "-function getDefaultMode(dir) {", "+function resolveSetting(env, dir) {", "+  return resolveSetting(env);", " }", "+resolveSettingx();"].join("\n"),
  };

  test("whole words, new side first, removed lines last", () => {
    expect(findInDiff([f], "resolveSetting").map((h) => [h.line, h.side, h.definition])).toEqual([
      [10, "new", true],
      [11, "new", false],
    ]);
    expect(findInDiff([f], "getDefaultMode")).toEqual([{ path: "src/config.js", line: 10, side: "old", text: "function getDefaultMode(dir) {", definition: true }]);
  });

  test("the repository's lines, less what the diff shows", () => {
    const inDiff = findInDiff([f], "resolveSetting");
    const hits = [
      { path: "src/config.js", line: 10, text: "function resolveSetting(env, dir) {" },
      { path: "src/config.js", line: 80, text: "  resolveSetting(a);" },
      { path: "src/hooks/mode.js", line: 4, text: "const { resolveSetting } = require('./config');" },
    ];
    expect(repoHits(hits, "resolveSetting", "head", new Set([f.path]), inDiff).map((h) => `${h.path}:${h.line}`)).toEqual(["src/hooks/mode.js:4", "src/config.js:80"]);
    expect(repoHits(hits, "resolveSetting", "base", new Set([f.path]), inDiff).map((h) => `${h.path}:${h.line}`)).toEqual(["src/hooks/mode.js:4"]);
  });
});
