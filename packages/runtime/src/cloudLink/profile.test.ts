// The profile's edges: what Cloud would refuse is left out here with a reason (C1), a computer keeps the
// grants it gave a git marketplace, where a server can run (C9), and profile skills swap generations under
// one stable folder (I2).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createScrubber } from "@caveman-app/session-protocol";
import type { PluginSettings } from "@caveman-app/protocol";
import { expect, test } from "vitest";

import { applyProfile, buildProfile, canonicalJson, classifyServer, fitProfile, writeProfileSkills, type Profile } from "./profile.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "profile-test-"));
const plugins = (over: Partial<PluginSettings> = {}): PluginSettings =>
  ({ marketplaces: [], installed: [], projects: [], spaces: [], disabled: [], envAllowlist: [], servers: [], trusted: [], repoEnabled: [], repoSwitches: [], repoServerSwitches: [], ...over }) as PluginSettings;
const commit = "a".repeat(40);

test("C1: items Cloud refuses are left out with a reason; the rest still syncs", () => {
  const home = tmp();
  const skill = (name: string, files: Record<string, string>) => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(home, ".claude/skills", name, rel)), { recursive: true });
      fs.writeFileSync(path.join(home, ".claude/skills", name, rel), text);
    }
  };
  skill("ok", { "SKILL.md": "---\nname: ok\n---\nfine\n" });
  skill("a..b", { "SKILL.md": "---\nname: x\n---\n" });
  skill("slash", { "SKILL.md": "---\nname: s\n---\n", "odd\\name.md": "x" });
  skill("many", Object.fromEntries([["SKILL.md", "x"], ...Array.from({ length: 501 }, (_, i) => [`f${i}.md`, "x"])]));
  const { profile, items } = buildProfile({
    plugins: plugins({
      marketplaces: [{ name: "kit", source: { kind: "git", url: "https://github.com/acme/kit.git", commit: "" }, added_at: "2026-10-17T00:00:00Z" }],
      servers: [
        { name: "long", command: "npx", args: ["x".repeat(5000)], source: "manual", enabled: true },
        { name: "brew", command: "/opt/homebrew/bin/npx", args: ["-y", "some-mcp"], source: "manual", enabled: true },
        // A header name the app takes and Cloud's profile does not yet (letters, digits and - only there).
        { name: "context7", url: "https://mcp.context7.com/mcp", headers: ["CONTEXT7_API_KEY"], source: "claude", enabled: true },
      ],
    }),
    homes: { claudeJson: path.join(home, ".claude.json"), claudeDir: path.join(home, ".claude"), codexHome: path.join(home, ".codex") },
    home,
    scrubber: createScrubber([]),
    spacesDir: path.join(home, "spaces"),
  });
  const reason = (kind: string, id: string) => items.find((i) => i.kind === kind && i.id === id);
  expect(profile.skills.map((s) => s.name)).toEqual(["ok", "slash"]);
  expect(reason("skill", "a..b")).toMatchObject({ cloud: "skipped" });
  expect(reason("skill", "many")).toMatchObject({ cloud: "skipped", reason: "it has over 500 files" });
  if (process.platform === "win32") {
    // On Windows a backslash separates folders, so no file name holds one: odd\name.md is name.md in odd, sent as odd/name.md.
    expect(reason("skill", "slash")).toEqual({ kind: "skill", id: "slash", cloud: "runs", path: path.join(fs.realpathSync(path.join(home, ".claude/skills/slash")), "SKILL.md") });
    expect(profile.skills.find((s) => s.name === "slash")!.files.map((f) => f.path)).toEqual(["odd/name.md", "SKILL.md"]);
  } else {
    expect(reason("skill", "slash")!.reason).toContain("odd\\name.md (its name is not a portable path)");
    expect(profile.skills.find((s) => s.name === "slash")!.files.map((f) => f.path)).toEqual(["SKILL.md"]);
  }
  expect(items.find((i) => i.kind === "marketplace")).toMatchObject({ cloud: "skipped", reason: "it is not checked out at a commit yet" });
  expect(reason("server", "long")).toMatchObject({ cloud: "skipped", reason: "an argument is over 4 KiB" });
  expect(reason("server", "context7")).toMatchObject({ cloud: "skipped", reason: "Caveman Cloud does not take its header CONTEXT7_API_KEY yet, so it stays on This Mac" });
  // C9: a Homebrew npx goes as `npx`, which the image has.
  expect(profile.plugins.servers).toEqual([expect.objectContaining({ name: "brew", command: "npx", cloud: "runs" })]);
});

test("C1: over the 2 MiB cap, the largest skills go first and say so", () => {
  const big = (name: string, kib: number) => ({ name, source: "claude-home" as const, files: [{ path: "SKILL.md", content: "x".repeat(kib * 1024) }] });
  const profile: Profile = { version: 2, plugins: { spaces: [], disabled: [], servers: [] }, skills: [big("small", 10), big("huge", 200), big("mid", 100)] };
  const items = profile.skills.map((s) => ({ kind: "skill" as const, id: s.name, cloud: "runs" as const }));
  const out = fitProfile(profile, items, 150 * 1024);
  expect(out.profile.skills.map((s) => s.name)).toEqual(["small", "mid"]);
  expect(out.items.find((i) => i.id === "huge")).toMatchObject({ cloud: "skipped", reason: expect.stringContaining("2 MiB profile cap") });
  expect(Buffer.byteLength(JSON.stringify(out.profile))).toBeLessThanOrEqual(150 * 1024);
});

test("a computer keeps the grants it gave a git marketplace; no profile runs no space", () => {
  const mine = "https://github.com/acme/mine.git";
  const profile: Profile = { version: 2, plugins: { spaces: [{ url: mine, commit, enabled: true }], disabled: [], servers: [] }, skills: [] };
  const out = applyProfile({
    profile,
    onPath: () => false,
    current: { installed: [], marketplaces: [{ name: "mine", source: { kind: "git", url: mine, commit }, added_at: "2026-10-17T00:00:00Z", granted: ["API_KEY"] }] },
  });
  expect(out.plugins.spaces).toEqual([{ url: mine, commit, enabled: true, granted: ["API_KEY"] }]);
  // No profile at all (refused, none yet): no space runs.
  expect(applyProfile({ profile: undefined, onPath: () => true }).plugins.spaces).toEqual([]);
});

test("C9: a computer trusts its own PATH, not the image list", () => {
  const server = (command: string) => ({ name: "s", command, source: "manual" as const, enabled: true });
  expect(classifyServer(server("bunx"), () => false)).toMatchObject({ cloud: "needs_runtime" });
  expect(classifyServer(server("npx"), (c) => c === "npx")).toMatchObject({ cloud: "runs" });
  // This Mac guesses from the image; bun and deno are not on it.
  expect(classifyServer(server("deno"))).toMatchObject({ cloud: "needs_runtime" });
  expect(classifyServer(server("/usr/local/bin/uvx"))).toMatchObject({ cloud: "runs" });
  expect(classifyServer(server("/Users/me/bin/tool"))).toMatchObject({ cloud: "mac_only" });
});

// Skipped on Windows: profile skills are written only on a Cloud computer (Linux), whose `current` symlink is renamed over the last.
test.skipIf(process.platform === "win32")("I2: profile skills swap generations under one folder that is never replaced", () => {
  const dir = path.join(tmp(), "profile-skills");
  const skill = (body: string) => [{ name: "deploy", source: "claude-home" as const, files: [{ path: "SKILL.md", content: body }] }];
  writeProfileSkills(dir, skill("one"));
  const inode = fs.statSync(dir).ino;
  const first = fs.readlinkSync(path.join(dir, "current"));
  expect(fs.readFileSync(path.join(dir, "current", "deploy", "SKILL.md"), "utf8")).toBe("one");
  writeProfileSkills(dir, skill("two"));
  const second = fs.readlinkSync(path.join(dir, "current"));
  expect(second).not.toBe(first);
  expect(path.isAbsolute(second)).toBe(false);
  expect(fs.statSync(dir).ino).toBe(inode);
  expect(fs.readFileSync(path.join(dir, "current", "deploy", "SKILL.md"), "utf8")).toBe("two");
  // The generation before stays for sessions still reading it; the one before that goes.
  expect(fs.existsSync(path.join(dir, first))).toBe(true);
  writeProfileSkills(dir, skill("three"));
  expect(fs.existsSync(path.join(dir, first))).toBe(false);
  expect(fs.existsSync(path.join(dir, second))).toBe(true);
  // Unchanged: the same generation, nothing rewritten.
  const third = fs.readlinkSync(path.join(dir, "current"));
  writeProfileSkills(dir, skill("three"));
  expect(fs.readlinkSync(path.join(dir, "current"))).toBe(third);
});

// ------------------------------------------------------------ import fidelity (H08, H09, H10)

const homesOf = (home: string) => ({ claudeJson: path.join(home, ".claude.json"), claudeDir: path.join(home, ".claude"), codexHome: path.join(home, ".codex") });
const put = (root: string, rel: string, text: string | Buffer, mode = 0o644) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text, { mode });
  fs.chmodSync(path.join(root, rel), mode);
};

test("H10: runs means definition and launcher, never a laptop's loopback or a file the computer may lack", () => {
  const server = (over: Record<string, unknown>) => ({ name: "s", source: "manual" as const, enabled: true, ...over });
  for (const url of ["http://127.0.0.1:9999/mcp", "http://localhost:3000/mcp", "http://[::1]:8080/mcp", "https://dev.localhost/mcp"]) {
    expect(classifyServer(server({ url }))).toMatchObject({ cloud: "mac_only", cloudReason: expect.stringContaining("a service on This Mac") });
    // A computer's own view agrees: that address is the computer, not the laptop.
    expect(classifyServer(server({ url }), () => true).cloud).toBe("mac_only");
  }
  for (const url of ["https://192.168.1.20/mcp", "https://10.0.0.5/mcp", "https://nas.local/mcp", "https://box.tail1234.ts.net/mcp", "https://intranet/mcp", "https://100.101.102.103/mcp"]) {
    expect(classifyServer(server({ url }))).toMatchObject({ cloud: "needs_runtime", cloudReason: expect.stringContaining("on your own network") });
  }
  expect(classifyServer(server({ url: "https://mcp.example.com/mcp" }))).toEqual({ cloud: "runs" });
  for (const args of [["./missing-server.js"], ["../tools/server.mjs"], ["dist/index.js"], ["--inspect", "server.py"]]) {
    const command = args.at(-1)!.endsWith(".py") ? "python3" : "node";
    expect(classifyServer(server({ command, args }))).toMatchObject({ cloud: "needs_runtime", cloudReason: `it runs ${args.at(-1)} from the folder it starts in, so a Cloud computer needs that file too` });
    expect(classifyServer(server({ command, args }), () => true).cloud).toBe("needs_runtime");
  }
  // Packages, code and the server's own folder argument are not files it looks for.
  expect(classifyServer(server({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] }))).toEqual({ cloud: "runs" });
  expect(classifyServer(server({ command: "node", args: ["-e", "require('x')"] }))).toEqual({ cloud: "runs" });
  expect(classifyServer(server({ command: "uvx", args: ["mcp-server-fetch"] }))).toEqual({ cloud: "runs" });
});

test.skipIf(process.platform === "win32")("H08: a 0755 text helper runs from the applied skill; 0644 data, binaries and keys do not", () => {
  const home = tmp();
  put(home, ".claude/skills/launch/SKILL.md", "---\nname: launch\n---\nRun scripts/check.sh directly.\n");
  put(home, ".claude/skills/launch/scripts/check.sh", "#!/bin/sh\necho skill-ok\n", 0o755);
  // A script kept as data (0644) stays data, shebang or not; an executable without one is not a helper.
  put(home, ".claude/skills/launch/templates/hook.sh", "#!/bin/sh\necho data\n", 0o644);
  put(home, ".claude/skills/launch/notes.txt", "plain notes\n", 0o755);
  put(home, ".claude/skills/launch/bin/tool", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1]), 0o755);
  put(home, ".claude/skills/launch/deploy.pem", "-----BEGIN-----\n", 0o600);
  const { profile, items } = buildProfile({ plugins: plugins(), homes: homesOf(home), home, scrubber: createScrubber([]), spacesDir: path.join(home, "spaces") });
  const launch = profile.skills.find((s) => s.name === "launch")!;
  expect(JSON.parse(launch.files.find((f) => f.path === ".caveman-skill.json")!.content)).toEqual({ executable: ["scripts/check.sh"] });
  expect(launch.files.map((f) => f.path)).not.toEqual(expect.arrayContaining(["bin/tool", "deploy.pem"]));
  // Each omitted file is named with its reason.
  expect(items.find((i) => i.kind === "skill" && i.id === "launch")).toMatchObject({ cloud: "runs", reason: "left out: bin/tool (a binary file: only text syncs), deploy.pem (a key or env file)" });

  const dir = path.join(tmp(), "profile-skills");
  writeProfileSkills(dir, JSON.parse(JSON.stringify(profile.skills)) as Profile["skills"]);
  const applied = path.join(dir, "current", "launch");
  const mode = (rel: string) => fs.statSync(path.join(applied, rel)).mode & 0o777;
  expect(mode("scripts/check.sh")).toBe(0o755);
  expect(mode("templates/hook.sh")).toBe(0o644);
  expect(mode("notes.txt")).toBe(0o644);
  expect(mode("SKILL.md")).toBe(0o644);
  expect(fs.existsSync(path.join(applied, ".caveman-skill.json"))).toBe(false);
  // Run as the skill's instructions say, from the synced layout.
  expect(spawnSync(path.join(applied, "scripts/check.sh"), { encoding: "utf8" }).stdout).toBe("skill-ok\n");
  expect(spawnSync(path.join(applied, "templates/hook.sh")).error).toMatchObject({ code: "EACCES" });
});

test("H08: a computer makes executable only the text helpers a manifest names, whatever Cloud sent", () => {
  const dir = path.join(tmp(), "profile-skills");
  writeProfileSkills(dir, [
    {
      name: "odd",
      source: "claude-home",
      files: [
        { path: "SKILL.md", content: "x" },
        { path: "run.sh", content: "#!/bin/sh\necho ok\n" },
        { path: "data.txt", content: "no shebang" },
        { path: "secret.key", content: "#!/bin/sh\n" },
        { path: ".caveman-skill.json", content: JSON.stringify({ executable: ["run.sh", "data.txt", "secret.key", "../escape.sh", "missing.sh", 7] }) },
      ],
    },
  ]);
  // Windows has no execute bit (a file runs there by its extension), so only the files written are checked there.
  if (process.platform !== "win32") {
    const mode = (rel: string) => fs.statSync(path.join(dir, "current", "odd", rel)).mode & 0o777;
    expect(mode("run.sh")).toBe(0o755);
    expect(mode("data.txt")).toBe(0o644);
    expect(mode("secret.key")).toBe(0o644);
  }
  expect(fs.readdirSync(path.join(dir, "current", "odd")).sort()).toEqual(["SKILL.md", "data.txt", "run.sh", "secret.key"]);
});

test.skipIf(process.platform === "win32")("H08: a generation an older runtime wrote for the same profile is written again, with modes", () => {
  const dir = path.join(tmp(), "profile-skills");
  const skills: Profile["skills"] = [
    { name: "s", source: "claude-home", files: [{ path: "SKILL.md", content: "x" }, { path: "run.sh", content: "#!/bin/sh\n" }, { path: ".caveman-skill.json", content: JSON.stringify({ executable: ["run.sh"] }) }] },
  ];
  // What a runtime before modes wrote: every file 0644, the manifest on disk, under its digest of the same skills.
  const old = `gen-${createHash("sha256").update(canonicalJson(skills.map((s) => ({ name: s.name, files: s.files })))).digest("hex").slice(0, 16)}`;
  for (const f of skills[0]!.files) put(path.join(dir, old, "s"), f.path, f.content);
  fs.symlinkSync(old, path.join(dir, "current"));
  writeProfileSkills(dir, skills);
  expect(fs.readlinkSync(path.join(dir, "current"))).not.toBe(old);
  expect(fs.statSync(path.join(dir, "current", "s", "run.sh")).mode & 0o777).toBe(0o755);
  expect(fs.existsSync(path.join(dir, "current", "s", ".caveman-skill.json"))).toBe(false);
});

test("H08: a skill's own file at the manifest's name is left out, never sent twice", () => {
  const home = tmp();
  put(home, ".claude/skills/own/SKILL.md", "x");
  put(home, ".claude/skills/own/.caveman-skill.json", JSON.stringify({ executable: ["SKILL.md"] }));
  const { profile, items } = buildProfile({ plugins: plugins(), homes: homesOf(home), home, scrubber: createScrubber([]), spacesDir: path.join(home, "spaces") });
  expect(profile.skills.find((s) => s.name === "own")!.files.map((f) => f.path)).toEqual(["SKILL.md"]);
  expect(items.find((i) => i.id === "own")?.reason).toBe("left out: .caveman-skill.json (Caveman Code keeps that name for itself)");
});

test.skipIf(process.platform === "win32")("H09: same-named skills with other files each say what happens; one real folder or the same files is one skill", () => {
  const home = tmp();
  put(home, ".claude/skills/deploy/SKILL.md", "---\nname: deploy\n---\nClaude's way.\n");
  put(home, ".agents/skills/deploy/SKILL.md", "---\nname: deploy\n---\nThe shared way.\n");
  put(home, ".codex/skills/deploy/SKILL.md", "---\nname: deploy\n---\nCodex's way.\n");
  // One real folder linked into Claude's root, and a byte-identical copy in Codex's.
  put(home, ".agents/skills/shared/SKILL.md", "---\nname: shared\n---\nSame.\n");
  fs.mkdirSync(path.join(home, ".claude/skills"), { recursive: true });
  fs.symlinkSync(path.join(home, ".agents/skills/shared"), path.join(home, ".claude/skills/shared"));
  put(home, ".codex/skills/shared/SKILL.md", "---\nname: shared\n---\nSame.\n");
  const { profile, items } = buildProfile({ plugins: plugins(), homes: homesOf(home), home, scrubber: createScrubber([]), spacesDir: path.join(home, "spaces") });
  const real = (rel: string) => path.join(fs.realpathSync(path.join(home, rel)), "SKILL.md");

  // Cloud keeps one per name: Claude's deploy goes, and every folder has its own line.
  expect(profile.skills.filter((s) => s.name === "deploy").map((s) => [s.source, s.files[0]!.content])).toEqual([["claude-home", "---\nname: deploy\n---\nClaude's way.\n"]]);
  const lines = items.filter((i) => i.kind === "skill" && i.id === "deploy");
  expect(lines).toEqual([
    { kind: "skill", id: "deploy", path: real(".claude/skills/deploy"), cloud: "runs", reason: "~/.agents/skills/deploy and ~/.codex/skills/deploy, named the same with other files, stay on This Mac" },
    { kind: "skill", id: "deploy", path: real(".agents/skills/deploy"), cloud: "skipped", reason: "~/.claude/skills/deploy has a skill of the same name with other files, and Cloud keeps one per name: rename this folder to sync it too" },
    { kind: "skill", id: "deploy", path: real(".codex/skills/deploy"), cloud: "skipped", reason: "~/.claude/skills/deploy has a skill of the same name with other files, and Cloud keeps one per name: rename this folder to sync it too" },
  ]);
  // The linked folder is one skill with one line; the identical copy goes as the same skill, and says it is there.
  expect(profile.skills.filter((s) => s.name === "shared")).toHaveLength(1);
  expect(items.filter((i) => i.id === "shared")).toEqual([
    { kind: "skill", id: "shared", path: real(".claude/skills/shared"), cloud: "runs" },
    { kind: "skill", id: "shared", path: real(".codex/skills/shared"), cloud: "runs" },
  ]);
});
