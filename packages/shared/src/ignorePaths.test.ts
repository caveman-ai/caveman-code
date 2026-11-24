import { describe, expect, it } from "vitest";
import { claudeReadDenyRules, compileIgnore } from "./ignorePaths.ts";

describe("compileIgnore", () => {
  it("follows gitignore: unanchored names match at any depth, dotfiles included", () => {
    const hidden = compileIgnore(["*.pem", ".env"]);
    expect(hidden("keys/server.pem")).toBe(true);
    expect(hidden(".env")).toBe(true);
    expect(hidden("app/.env")).toBe(true);
    expect(hidden("app/.envrc")).toBe(false);
  });

  it("anchors a pattern with a slash and hides everything in a hidden directory", () => {
    const hidden = compileIgnore(["/secrets/", "docs/internal"]);
    expect(hidden("secrets/prod/.env")).toBe(true);
    expect(hidden("secrets", true)).toBe(true);
    expect(hidden("secrets")).toBe(false); // a file named secrets is not the directory
    expect(hidden("app/secrets/x")).toBe(false);
    expect(hidden("docs/internal/plan.md")).toBe(true);
    expect(hidden("app/docs/internal/plan.md")).toBe(false);
  });

  it("handles ** and negation, last match wins", () => {
    const hidden = compileIgnore(["fixtures/**/big-*.json", "logs/", "!logs/keep.txt", "# a comment", ""]);
    expect(hidden("fixtures/big-1.json")).toBe(true);
    expect(hidden("fixtures/a/b/big-2.json")).toBe(true);
    expect(hidden("fixtures/small.json")).toBe(false);
    // As in git, a file inside an excluded directory cannot be re-included.
    expect(hidden("logs/keep.txt")).toBe(true);
    expect(compileIgnore(["*.log", "!keep.log"])("a/keep.log")).toBe(false);
  });

  it("reads several lines from one string and hides nothing when empty", () => {
    expect(compileIgnore(["a\nb/"])("b/c")).toBe(true);
    expect(compileIgnore([])("anything")).toBe(false);
  });
});

describe("claudeReadDenyRules", () => {
  it("maps lines onto Read rules relative to the session directory", () => {
    expect(claudeReadDenyRules(["*.pem", "/secrets/", "!keep", "# x"])).toEqual(["Read(./**/*.pem)", "Read(./**/*.pem/**)", "Read(./secrets/**)"]);
  });
});
