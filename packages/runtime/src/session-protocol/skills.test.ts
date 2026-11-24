// Manage > Skills: which skills each engine loads.
import * as fs from "node:fs";
import * as path from "node:path";

import { afterAll, expect, test } from "vitest";

import { loadSpace } from "../plugins/load.ts";
import { listSkills, readListedSkill } from "./skills.ts";
import { tempRoot } from "./testHarness.ts";

const root = tempRoot("sp-skills-");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\nDo it.\n`;
function write(dir: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
}

test("lists plugin, home and project skills with the engines that load each", async () => {
  const home = path.join(root, "home");
  write(home, {
    ".claude/skills/review/SKILL.md": skill("review", "Review a diff."),
    ".agents/skills/deploy/SKILL.md": skill("deploy", "Deploy it."),
    ".codex/skills/codex-only/SKILL.md": skill("codex-only", "Only on the person's own Codex home."),
  });
  // An installer's symlink into ~/.agents/skills: Claude follows it, so the one file is both engines' (one row).
  fs.symlinkSync(path.join(home, ".agents/skills/deploy"), path.join(home, ".claude/skills/deploy"));
  const repo = path.join(root, "repo");
  write(repo, { ".claude/skills/migrate/SKILL.md": skill("migrate", "Write a migration."), ".agents/skills/lint/SKILL.md": skill("lint", "Lint.") });
  // A cloned repo's SKILL.md linked to a file outside the repo is never listed (so never read).
  const secret = path.join(root, "secret.txt");
  fs.writeFileSync(secret, "aws_secret_access_key = x\n");
  fs.mkdirSync(path.join(repo, ".claude/skills/leak"), { recursive: true });
  fs.symlinkSync(secret, path.join(repo, ".claude/skills/leak/SKILL.md"));
  const spaceDir = path.join(root, "spaces", "kit-1234abcd", "a".repeat(40));
  write(spaceDir, { ".claude-plugin/plugin.json": JSON.stringify({ name: "kit" }), "skills/ship/SKILL.md": skill("ship", "Ship a change.") });
  const { plugins } = await loadSpace(spaceDir, "kit-1234abcd");
  const homes = { claudeJson: path.join(home, ".claude.json"), claudeDir: path.join(home, ".claude"), codexHome: path.join(home, ".codex") };

  const listed = await listSkills({ homes, home, codexOwnHome: false, projects: [{ id: "p1", root: repo }], plugins: plugins.map((plugin) => ({ plugin, enabled: false })) });
  expect(listed.map((s) => [s.name, s.scope, s.engines, s.enabled, s.project_id ?? s.marketplace ?? null])).toEqual([
    ["ship", "plugin", ["claude-agent", "codex", "caveman"], false, "kit-1234abcd"],
    // ~/.agents/skills reaches every engine: Codex itself, Claude Agent and the Caveman engine through the runtime.
    ["deploy", "me", ["claude-agent", "codex", "caveman"], true, null],
    ["review", "me", ["claude-agent"], true, null],
    // The Caveman engine reads the repository's own folders too (PluginRegistry repoSkillRoots).
    ["migrate", "project", ["claude-agent", "caveman"], true, "p1"],
    ["lint", "project", ["codex", "caveman"], true, "p1"],
  ]);
  // C13: on a Cloud computer the Caveman engine does not read them (repoSkillRoots), and the list says so.
  const onComputer = await listSkills({ homes, home, codexOwnHome: false, projects: [{ id: "p1", root: repo }], plugins: [], onComputer: true });
  expect(onComputer.filter((s) => s.scope === "project").map((s) => [s.name, s.engines])).toEqual([
    ["migrate", ["claude-agent"]],
    ["lint", ["codex"]],
  ]);
  const ship = listed[0]!;
  expect(ship.idle_tokens_estimate).toBe(Math.ceil(Buffer.byteLength(`- ship: Ship a change. (${ship.path})`) / 4));

  // Codex's own home counts only when Codex runs on the person's own login.
  const own = await listSkills({ homes, home, codexOwnHome: true, projects: [], plugins: [] });
  expect(own.find((s) => s.name === "codex-only")?.engines).toEqual(["codex"]);
});

test("skill.read's file: exactly the listed real path, at most 1 MiB, never through a link swapped in later", async () => {
  const repo = path.join(root, "read-repo");
  write(repo, { ".claude/skills/ok/SKILL.md": skill("ok", "Fine."), ".claude/skills/big/SKILL.md": `${skill("big", "Too big.")}${"x".repeat(1024 * 1024)}` });
  const homes = { claudeJson: path.join(root, "nohome/.claude.json"), claudeDir: path.join(root, "nohome/.claude"), codexHome: path.join(root, "nohome/.codex") };
  const listed = await listSkills({ homes, home: path.join(root, "nohome"), codexOwnHome: false, projects: [{ id: "p", root: repo }], plugins: [] });
  // Over 1 MiB is never listed, so never read.
  expect(listed.map((s) => s.name)).toEqual(["ok"]);
  const ok = listed[0]!;
  expect(ok.path).toBe(fs.realpathSync(path.join(repo, ".claude/skills/ok/SKILL.md")));
  expect(await readListedSkill(ok.path)).toBe(skill("ok", "Fine."));
  await expect(readListedSkill(fs.realpathSync(path.join(repo, ".claude/skills/big/SKILL.md")))).rejects.toThrow(/over 1 MiB/);
  // The folder swapped for a link to a secret after listing: the read refuses.
  const secret = path.join(root, "read-secret");
  write(secret, { "SKILL.md": "aws_secret_access_key = x\n" });
  fs.rmSync(path.join(repo, ".claude/skills/ok"), { recursive: true });
  fs.symlinkSync(secret, path.join(repo, ".claude/skills/ok"));
  await expect(readListedSkill(ok.path)).rejects.toThrow(/moved/);
});
