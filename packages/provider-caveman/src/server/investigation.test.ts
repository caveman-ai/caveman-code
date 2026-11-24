/** The investigation's tools on a real checkout: what each reads, what each refuses, and that nothing reaches a shell. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { assert, describe, it } from "@effect/vitest";
import type * as Harness from "@caveman-ai/harness";
import { CAVEMAN_PLAN_SLOTS } from "@caveman-app/shared/serverSettings";

import { CHATGPT_PLAN_PROVIDER, CREDITS_PROVIDER } from "./credits.ts";
import { grepTool, investigationTools, readFileTool, readOnlyGitTool, refuseGitArgs } from "./investigation.ts";

const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), "caveman-investigation-"));
  const git = (...args: Array<string>) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  // What a token in a remote's URL looks like: never readable through read_file or grep.
  git("config", "remote.origin.url", "https://x-access-token:ghs_secret_token@github.com/acme/app.git");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "--quiet", "-m", "first");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "main.ts"), Array.from({ length: 30 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join("\n") + "\n");
  mkdirSync(join(dir, ".github"));
  writeFileSync(join(dir, ".github", "ci.yml"), "run: npm test -- --two\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "second");
  return dir;
};

const call = async (tool: Harness.HarnessTool, params: unknown, signal?: AbortSignal) => {
  const result = await tool.execute("call-1", params, signal);
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
};
const refusal = async (tool: Harness.HarnessTool, params: unknown) => {
  try {
    return `ran: ${await call(tool, params)}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

describe("git", () => {
  it("runs only git's read commands, and none that writes a file or reads outside the checkout", () => {
    assert.isUndefined(refuseGitArgs(["diff", "--stat", "HEAD~1...HEAD"]));
    assert.isUndefined(refuseGitArgs(["log", "--oneline"]));
    assert.isUndefined(refuseGitArgs(["show", "HEAD:a.txt"]));
    for (const args of [["checkout", "main"], ["commit", "-m", "x"], ["config", "x", "y"], [], ["-c", "a=b", "diff"], ["-C", "/", "diff"], ["--git-dir=/x", "log"]]) {
      assert.include(refuseGitArgs(args) ?? "", "Only git diff");
    }
    for (const args of [["diff", "--output=/tmp/x"], ["log", "--output", "/tmp/x"], ["show", "-o/tmp/x"], ["diff", "-o", "/tmp/x"]]) {
      assert.include(refuseGitArgs(args) ?? "", "--output");
    }
    assert.include(refuseGitArgs(["diff", "--no-index", "/etc/hosts", "/dev/null"]) ?? "", "outside the checkout");
  });

  it("reads the change in the checkout and writes nothing", async () => {
    const dir = repo();
    const git = readOnlyGitTool(dir);
    assert.include(await call(git, { args: ["diff", "HEAD~1...HEAD"] }), "+two");
    assert.include(await call(git, { args: ["log", "--oneline"] }), "second");
    assert.strictEqual(await call(git, { args: ["show", "HEAD~1:a.txt"] }), "one\n");
    // A bad revision is git's own words, not a failed tool.
    assert.include(await call(git, { args: ["show", "nope:a.txt"] }), "nope");
    const out = join(dir, "written.patch");
    assert.include(await refusal(git, { args: ["diff", `--output=${out}`, "HEAD~1"] }), "--output");
    assert.isFalse(existsSync(out));
    assert.include(await refusal(git, { args: ["checkout", "-b", "x"] }), "Only git diff");
  });
});

describe("read_file", () => {
  it("reads a file's lines numbered, a range at a time", async () => {
    const dir = repo();
    const read = readFileTool(dir);
    assert.strictEqual(await call(read, { path: "a.txt" }), "1\tone\n2\ttwo");
    assert.strictEqual(await call(read, { path: "src/main.ts", offset: 10, limit: 2 }), "10\texport const line10 = 10;\n11\texport const line11 = 11;");
    assert.include(await call(read, { path: "a.txt", offset: 9 }), "has 2 lines");
    // An absolute path inside the checkout reads too.
    assert.strictEqual(await call(read, { path: join(dir, "a.txt"), limit: 1 }), "1\tone");
  });

  it("caps a large file and says where to read on", async () => {
    const dir = repo();
    writeFileSync(join(dir, "big.txt"), Array.from({ length: 5_000 }, (_, i) => `line ${i + 1} ${"x".repeat(40)}`).join("\n"));
    const text = await call(readFileTool(dir), { path: "big.txt" });
    assert.isBelow(Buffer.byteLength(text), 24_200);
    const next = /read on with offset (\d+)/.exec(text)?.[1];
    assert.ok(next !== undefined, text.slice(-200));
    assert.include(await call(readFileTool(dir), { path: "big.txt", offset: Number(next), limit: 1 }), `${next}\tline ${next} `);
  });

  it("lists a directory, never .git, and shows no binary bytes", async () => {
    const dir = repo();
    writeFileSync(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
    const listing = await call(readFileTool(dir), { path: "." });
    assert.deepStrictEqual(listing.split("\n"), [".github/", "a.txt", "logo.png", "src/"]);
    assert.include(await call(readFileTool(dir), { path: "logo.png" }), "binary file");
  });

  it("reaches nothing outside the checkout: not by .., an absolute path, a symlink, nor .git", async () => {
    const dir = repo();
    const elsewhere = mkdtempSync(join(tmpdir(), "caveman-elsewhere-"));
    writeFileSync(join(elsewhere, "secret.txt"), "the secret\n");
    symlinkSync(join(elsewhere, "secret.txt"), join(dir, "link.txt"));
    symlinkSync(elsewhere, join(dir, "linkdir"));
    const read = readFileTool(dir);
    for (const path of ["../" + basename(elsewhere) + "/secret.txt", join(elsewhere, "secret.txt"), "link.txt", "linkdir/secret.txt", "linkdir"]) {
      assert.include(await refusal(read, { path }), "outside the checkout", path);
    }
    for (const path of [".git/config", ".git", "src/../.git/config"]) assert.include(await refusal(read, { path }), ".git is not read here", path);
    assert.include(await refusal(read, { path: "missing.txt" }), "no such file");
  });
});

describe("grep", () => {
  it("finds a pattern by file and line, hidden files included, and narrows by path, glob and case", async () => {
    const dir = repo();
    const grep = grepTool(dir);
    const all = (await call(grep, { pattern: "two" })).split("\n").sort();
    assert.deepStrictEqual(all, [".github/ci.yml:1:run: npm test -- --two", "a.txt:2:two"]);
    assert.deepStrictEqual((await call(grep, { pattern: "line2[0-9]? =", path: "src/main.ts" })).split("\n").map((line) => line.split(":")[0]), [
      "2", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29",
    ]);
    assert.strictEqual(await call(grep, { pattern: "TWO", glob: "*.txt", ignore_case: true }), "a.txt:2:two");
    assert.strictEqual(await call(grep, { pattern: "nothing-like-this" }), "no matches");
    // A pattern that looks like a flag is a pattern.
    assert.include(await call(grep, { pattern: "--two" }), ".github/ci.yml:1:");
  });

  it("never searches .git or outside the checkout, whatever the path or glob", async () => {
    const dir = repo();
    const grep = grepTool(dir);
    assert.strictEqual(await call(grep, { pattern: "ghs_secret_token" }), "no matches");
    assert.strictEqual(await call(grep, { pattern: "ghs_secret_token", glob: ".git/**" }), "no matches");
    assert.strictEqual(await call(grep, { pattern: "ghs_secret_token", glob: "config" }), "no matches");
    assert.include(await refusal(grep, { pattern: "x", path: ".git" }), ".git is not read here");
    assert.include(await refusal(grep, { pattern: "root", path: process.platform === "win32" ? tmpdir() : "/etc" }), "outside the checkout");
    assert.include(await refusal(grep, { pattern: "x", path: "../" }), "outside the checkout");
  });

  it.skipIf(process.platform === "win32")("falls back to grep where rg is missing, with the same answers and the same fences", async () => {
    const dir = repo();
    const path = process.env.PATH;
    // The system's own directories only: grep is there, a Homebrew or cargo rg is not.
    process.env.PATH = "/usr/bin:/bin";
    try {
      assert.deepStrictEqual((await call(grepTool(dir), { pattern: "two" })).split("\n").sort(), [".github/ci.yml:1:run: npm test -- --two", "a.txt:2:two"]);
      assert.strictEqual(await call(grepTool(dir), { pattern: "TWO", glob: "*.txt", ignore_case: true }), "a.txt:2:two");
      assert.strictEqual(await call(grepTool(dir), { pattern: "ghs_secret_token" }), "no matches");
    } finally {
      process.env.PATH = path;
    }
  });

  it("hands the pattern to rg as one argument, never to a shell", async () => {
    const dir = repo();
    const marker = join(dir, "pwned");
    // Forward slashes in the pattern: a Windows path's backslashes would read to rg as escapes.
    const target = marker.replaceAll("\\", "/");
    assert.strictEqual(await call(grepTool(dir), { pattern: `$(touch ${target})` }), "no matches");
    assert.strictEqual(await call(grepTool(dir), { pattern: `x'; touch ${target}; echo '` }), "no matches");
    assert.isFalse(existsSync(marker));
    assert.match(await refusal(grepTool(dir), { pattern: "(" }), /regex|parse|unclosed|unmatched/i);
  });
});

it("gives an investigation read_file, grep and git, and no tool that writes or runs a shell", () => {
  const tools = investigationTools(repo());
  assert.deepStrictEqual(tools.map((tool) => tool.name), ["read_file", "grep", "git"]);
  for (const tool of tools) assert.strictEqual((tool.parameters as { additionalProperties?: boolean }).additionalProperties, false, tool.name);
});

it("counts the same key slots as a plan that the guide ranking does", () => {
  assert.isTrue(CAVEMAN_PLAN_SLOTS.has(CREDITS_PROVIDER));
  assert.isTrue(CAVEMAN_PLAN_SLOTS.has(CHATGPT_PLAN_PROVIDER));
});
