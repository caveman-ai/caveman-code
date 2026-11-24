// Customize -> Rules: which instruction files each engine reads, and editing
// only those, never through a link that leads elsewhere.
import * as fs from "node:fs";
import * as path from "node:path";

import { execFileSync } from "node:child_process";

import { createScrubber } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import { afterAll, expect, test } from "vitest";

import type { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import { listRules, makeRuleHandlers, readRule, saveRule } from "./rules.ts";
import { tempRoot } from "./testHarness.ts";

const root = tempRoot("sp-rules-");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function write(dir: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
}

test("lists home and project rule files with the engines that read each, missing ones included", async () => {
  const home = path.join(root, "home");
  write(home, { ".claude/CLAUDE.md": "1234", ".codex/AGENTS.md": "x", ".codex/AGENTS.override.md": "y" });
  const homes = { claudeJson: path.join(home, ".claude.json"), claudeDir: path.join(home, ".claude"), codexHome: path.join(home, ".codex") };
  // Only AGENTS.md: Claude reads it in place of CLAUDE.md; a CLAUDE.md written later goes to Claude only.
  const agentsOnly = path.join(root, "agents-only");
  write(agentsOnly, { "AGENTS.md": "a".repeat(40) });
  // Both, plus Claude's extras and Codex's override.
  const both = path.join(root, "both");
  write(both, { "CLAUDE.md": "c", "AGENTS.md": "a", "CLAUDE.local.md": "l", ".claude/CLAUDE.md": "d", "AGENTS.override.md": "o" });
  // Only CLAUDE.md: Codex is told it as its fallback (CODEX_THREAD_CONFIG), as the Caveman engine reads it.
  const claudeOnly = path.join(root, "claude-only");
  write(claudeOnly, { "CLAUDE.md": "c".repeat(8) });
  // CLAUDE.md beside Codex's override only: Codex reads the override, never the fallback.
  const overrideOnly = path.join(root, "override-only");
  write(overrideOnly, { "CLAUDE.md": "c", "AGENTS.override.md": "o" });

  const rows = (codexOwnHome: boolean) =>
    listRules({
      homes,
      codexOwnHome,
      projects: [
        { id: "p1", root: agentsOnly },
        { id: "p2", root: both },
        { id: "p3", root: claudeOnly },
        { id: "p4", root: overrideOnly },
      ],
    }).then((rules) =>
      rules.map((r) => [r.scope, r.project_id ?? null, r.name, r.engines, r.exists, r.idle_tokens_estimate]),
    );
  expect(await rows(false)).toEqual([
    ["me", null, "CLAUDE.md", ["claude-agent"], true, 1],
    ["project", "p1", "CLAUDE.md", ["claude-agent"], false, 0],
    ["project", "p1", "AGENTS.md", ["claude-agent", "codex", "caveman"], true, 10],
    ["project", "p2", "CLAUDE.md", ["claude-agent"], true, 1],
    ["project", "p2", "AGENTS.md", ["caveman"], true, 1],
    ["project", "p2", ".claude/CLAUDE.md", ["claude-agent"], true, 1],
    ["project", "p2", "CLAUDE.local.md", ["claude-agent"], true, 1],
    ["project", "p2", "AGENTS.override.md", ["codex"], true, 1],
    ["project", "p3", "CLAUDE.md", ["claude-agent", "codex", "caveman"], true, 2],
    ["project", "p3", "AGENTS.md", ["codex", "caveman"], false, 0],
    ["project", "p4", "CLAUDE.md", ["claude-agent", "caveman"], true, 1],
    ["project", "p4", "AGENTS.md", ["caveman"], false, 0],
    ["project", "p4", "AGENTS.override.md", ["codex"], true, 1],
  ]);
  // Codex's own home counts only on the person's own login; its override shadows its AGENTS.md.
  expect((await rows(true)).slice(1, 3)).toEqual([
    ["me", null, "AGENTS.md", [], true, 1],
    ["me", null, "AGENTS.override.md", ["codex"], true, 1],
  ]);
});

test("saves in place through a link inside the project, creates a missing file, and refuses a link that leads out", async () => {
  const project = path.join(root, "linked");
  write(project, { "AGENTS.md": "old\n" });
  fs.symlinkSync("AGENTS.md", path.join(project, "CLAUDE.md"));
  await saveRule(path.join(project, "CLAUDE.md"), "new\n", [project]);
  expect(fs.lstatSync(path.join(project, "CLAUDE.md")).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(path.join(project, "AGENTS.md"), "utf8")).toBe("new\n");
  expect(fs.readdirSync(project).sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);

  const fresh = path.join(root, "fresh");
  fs.mkdirSync(fresh);
  expect(await readRule(path.join(fresh, "CLAUDE.md"), [fresh])).toBe("");
  await saveRule(path.join(fresh, "CLAUDE.md"), "hello\n", [fresh]);
  expect(await readRule(path.join(fresh, "CLAUDE.md"), [fresh])).toBe("hello\n");

  // A cloned repo's CLAUDE.md linked to a file outside it: never read, never written.
  const outside = path.join(root, "bashrc");
  fs.writeFileSync(outside, "export X=1\n");
  const evil = path.join(root, "evil");
  fs.mkdirSync(evil);
  fs.symlinkSync(outside, path.join(evil, "CLAUDE.md"));
  await expect(readRule(path.join(evil, "CLAUDE.md"), [evil])).rejects.toThrow(/outside/);
  await expect(saveRule(path.join(evil, "CLAUDE.md"), "pwned\n", [evil])).rejects.toThrow(/outside/);
  // So is a folder on the way linked out (.claude -> elsewhere).
  fs.symlinkSync(root, path.join(evil, ".claude"));
  await expect(saveRule(path.join(evil, ".claude/CLAUDE.md"), "pwned\n", [evil])).rejects.toThrow(/outside/);
  expect(fs.readFileSync(outside, "utf8")).toBe("export X=1\n");
  expect(fs.existsSync(path.join(root, "CLAUDE.md"))).toBe(false);
});

test("keeps an existing file's mode, makes a missing home folder, and refuses .git, non-Markdown and FIFO targets", async () => {
  const project = path.join(root, "modes");
  write(project, { "CLAUDE.md": "old\n", "package.json": "{}\n", ".git/config": "[core]\n" });
  fs.chmodSync(path.join(project, "CLAUDE.md"), 0o664);
  await saveRule(path.join(project, "CLAUDE.md"), "new\n", [project]);
  // Skipped on Windows: no POSIX mode bits to keep (only a read-only flag).
  if (process.platform !== "win32") expect(fs.statSync(path.join(project, "CLAUDE.md")).mode & 0o7777).toBe(0o664);

  // ~/.claude before Claude ever ran: made inside the home.
  const home = path.join(root, "bare-home");
  fs.mkdirSync(home);
  await saveRule(path.join(home, ".claude/CLAUDE.md"), "mine\n", [home, path.join(home, ".claude")]);
  expect(fs.readFileSync(path.join(home, ".claude/CLAUDE.md"), "utf8")).toBe("mine\n");

  // A CLAUDE.md linked to another file of the project that is no instruction file.
  for (const [i, target] of ["package.json", ".git/config"].entries()) {
    const dir = path.join(project, `link-${i}`);
    fs.mkdirSync(dir);
    fs.symlinkSync(path.join(project, target), path.join(dir, "CLAUDE.md"));
    await expect(saveRule(path.join(dir, "CLAUDE.md"), "pwned", [project])).rejects.toThrow(/not an instruction file/);
    await expect(readRule(path.join(dir, "CLAUDE.md"), [project])).rejects.toThrow(/not an instruction file/);
  }
  expect(fs.readFileSync(path.join(project, "package.json"), "utf8")).toBe("{}\n");
  // A FIFO named AGENTS.md: refused, never opened (which would hang). Skipped on Windows: no FIFOs in its filesystem.
  if (process.platform !== "win32") {
    execFileSync("mkfifo", [path.join(project, "AGENTS.md")]);
    await expect(readRule(path.join(project, "AGENTS.md"), [project])).rejects.toThrow(/not a file/);
  }
});

const SECRET = "zq8Xv3pL0mN7rT2wY5kB";
const secrets = { scrubber: Effect.succeed(createScrubber([{ name: "API_KEY", value: SECRET }])) } as unknown as ProjectSecrets["Service"];
const reason = <A>(effect: Effect.Effect<A, { readonly reason: string }>) =>
  Effect.runPromise(effect.pipe(Effect.match({ onFailure: (e) => e.reason, onSuccess: () => "ok" })));

test("the handlers: owner only, only listed paths, and a file holding a stored secret is never saved over", async () => {
  const home = path.join(root, "handler-home");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const project = path.join(root, "handler-project");
  write(project, { "CLAUDE.md": `Deploy with API_KEY=${SECRET}\n` });
  const handlers = makeRuleHandlers({
    allowed: (principal) => principal === undefined || principal === "local" || principal === "cloud:owner",
    secrets,
    scope: Effect.succeed({
      homes: { claudeJson: path.join(home, ".claude.json"), claudeDir: path.join(home, ".claude"), codexHome: path.join(home, ".codex") },
      home,
      codexOwnHome: false,
      projects: [{ id: "p1", root: project }],
    }),
  });
  const local = { connectionId: "c", principal: "local" };
  const claudeMd = path.join(project, "CLAUDE.md");
  const homeMd = path.join(home, ".claude/CLAUDE.md");

  // Another Cloud user through the relay reaches none of it.
  const intruder = { connectionId: "c", principal: "cloud:someone-else" };
  expect(await reason(handlers["rule.list"]({}, intruder))).toBe("forbidden");
  expect(await reason(handlers["rule.read"]({ path: homeMd }, intruder))).toBe("forbidden");
  expect(await reason(handlers["rule.save"]({ request_id: "x", path: homeMd, text: "pwned" }, intruder))).toBe("forbidden");
  expect(fs.existsSync(homeMd)).toBe(false);
  expect(await reason(handlers["rule.list"]({}, { connectionId: "c", principal: "cloud:owner" }))).toBe("ok");

  expect(await reason(handlers["rule.list"]({ project_id: "nope" }, local))).toBe("not_found");
  for (const other of [path.join(project, "README.md"), path.join(project, "sub/../../CLAUDE.md"), "/etc/hosts"]) {
    expect(await reason(handlers["rule.save"]({ request_id: "x", path: other, text: "pwned" }, local))).toBe("not_found");
  }

  // Read, then save back what was read: refused, and the stored value stays in the file.
  const read = await Effect.runPromise(handlers["rule.read"]({ path: claudeMd }, local));
  expect(read).toEqual({ text: "Deploy with API_KEY=[secret:API_KEY]\n", redacted: true });
  expect(await reason(handlers["rule.save"]({ request_id: "s1", path: claudeMd, text: read.text }, local))).toBe("invalid_state");
  expect(fs.readFileSync(claudeMd, "utf8")).toBe(`Deploy with API_KEY=${SECRET}\n`);

  // New text holding a stored secret, or over 1 MiB, is refused; plain text is written.
  expect(await reason(handlers["rule.save"]({ request_id: "s2", path: homeMd, text: `key ${SECRET}` }, local))).toBe("secret_in_input");
  expect(await reason(handlers["rule.save"]({ request_id: "s3", path: homeMd, text: "x".repeat(1024 * 1024 + 1) }, local))).toBe("invalid_params");
  expect(await Effect.runPromise(handlers["rule.save"]({ request_id: "s4", path: homeMd, text: "Be brief.\n" }, local))).toMatchObject({ path: homeMd, exists: true });
  expect(await Effect.runPromise(handlers["rule.read"]({ path: homeMd }, local))).toEqual({ text: "Be brief.\n", redacted: false });
});
