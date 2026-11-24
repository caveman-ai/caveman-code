import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { decodeMcpFile, parseFrontmatter } from "./format.ts";
import { loadSpace } from "./load.ts";

// The Caveman catalog (`catalog/` at the repo root), shipped as marketplace `caveman`.
const ROOT = path.resolve(import.meta.dirname, "../../../../catalog");
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8")) as Record<string, any>;

const marketplace = readJson(".agents/plugins/marketplace.json");
const entries = marketplace.plugins as Array<{ name: string; source: string; category: string }>;
const CATEGORIES = new Set(["Developer tools", "Productivity", "Communication", "Design", "Data"]);
const CAPABILITIES = new Set(["Read", "Write", "Interactive"]);

/** `rel` must start `./`, exist, and resolve (symlinks too) inside `root`. */
function inside(root: string, rel: string): string {
  expect(rel.startsWith("./"), rel).toBe(true);
  const real = fs.realpathSync(path.join(root, rel));
  expect(real.startsWith(fs.realpathSync(root) + path.sep), rel).toBe(true);
  return real;
}

describe("Caveman catalog", () => {
  it("ships one marketplace file for Codex and Claude Code, named caveman-curated (the OSS caveman marketplace is caveman)", () => {
    expect(marketplace.name).toBe("caveman-curated");
    expect(readJson(".claude-plugin/marketplace.json")).toEqual(marketplace);
  });

  it("lists every plugin folder once, in its own folder", () => {
    const folders = fs.readdirSync(path.join(ROOT, "plugins")).sort();
    expect(entries.map((e) => e.name).sort()).toEqual(folders);
    for (const entry of entries) {
      expect(entry.source).toBe(`./plugins/${entry.name}`);
      expect(CATEGORIES.has(entry.category), entry.name).toBe(true);
    }
  });

  it("loads every plugin with the runtime's loader, without problems", async () => {
    const space = await loadSpace(ROOT, "caveman");
    expect(space.problems).toEqual([]);
    expect(space.plugins.map((p) => p.name)).toEqual(entries.map((e) => e.name));
    for (const plugin of space.plugins) {
      expect(plugin.skills.length, plugin.name).toBeGreaterThanOrEqual(1);
      expect(plugin.skills.length, plugin.name).toBeLessThanOrEqual(3);
      expect(Object.keys(plugin.mcpServers).length, plugin.name).toBeGreaterThanOrEqual(1);
      // The Codex interface block is read: the logo arrives as a data: URL the Plugins page can show.
      expect(plugin.interface?.display_name, plugin.name).toBeTruthy();
      expect(plugin.interface?.logo, plugin.name).toMatch(/^data:image\/(png|svg\+xml);base64,/);
    }
  });

  describe.each(entries.map((e) => e.name))("%s", (name) => {
    const dir = path.join(ROOT, "plugins", name);
    const codex = readJson(`plugins/${name}/.codex-plugin/plugin.json`);
    const claude = readJson(`plugins/${name}/.claude-plugin/plugin.json`);
    const ui = codex.interface;

    it("has matching manifests with a full interface block", () => {
      expect(codex.name).toBe(name);
      expect(claude.name).toBe(name);
      expect(claude.version).toBe(codex.version);
      for (const key of ["displayName", "shortDescription", "longDescription", "developerName", "brandColor"]) {
        expect(typeof ui[key] === "string" && ui[key].length > 0, key).toBe(true);
      }
      expect(ui.category).toBe(entries.find((e) => e.name === name)!.category);
      expect(ui.capabilities.every((c: string) => CAPABILITIES.has(c))).toBe(true);
      for (const key of ["websiteURL", "privacyPolicyURL", "termsOfServiceURL"]) expect(ui[key]).toMatch(/^https:\/\//);
      expect(ui.defaultPrompt.length).toBeGreaterThanOrEqual(1);
      expect(ui.defaultPrompt.length).toBeLessThanOrEqual(3);
      for (const prompt of ui.defaultPrompt) expect(prompt.length).toBeLessThanOrEqual(128);
      for (const color of [ui.brandColor, ui.brandColorDark ?? "#000000"]) expect(color).toMatch(/^#[0-9A-F]{6}$/);
    });

    it("keeps paths inside the plugin and logos small", () => {
      inside(dir, codex.skills);
      inside(dir, codex.mcpServers);
      for (const logo of [ui.logo, ui.logoDark].filter(Boolean)) {
        expect(logo).toMatch(/\.(png|svg)$/);
        expect(fs.statSync(inside(dir, logo)).size).toBeLessThanOrEqual(64 * 1024);
      }
    });

    it("declares well-formed MCP servers", () => {
      const raw = readJson(`plugins/${name}/.mcp.json`).mcpServers as Record<string, Record<string, unknown>>;
      const servers = decodeMcpFile(raw);
      // .mcp.json stays standard (a valid Claude Code and Codex plugin); what only Caveman reads is in caveman.json.
      const sidecar = fs.existsSync(path.join(dir, "caveman.json")) ? (readJson(`plugins/${name}/caveman.json`).mcpServers as Record<string, Record<string, unknown>>) : {};
      for (const extra of Object.values(raw)) for (const key of ["auth", "unavailable", "note"]) expect(key in extra, `${name} .mcp.json ${key}`).toBe(false);
      for (const [server, config] of Object.entries(servers)) {
        const extra = sidecar[server] ?? {};
        if ("url" in config) {
          expect(config.type, server).toBe("http");
          expect(new URL(config.url).protocol).toBe("https:");
          expect(config.headers, "no credentials in the catalog").toBeUndefined();
          expect([undefined, "oauth", "github"]).toContain(extra.auth);
        } else {
          expect(config.command).toBe("npx");
          // A pinned package version: never @latest or a bare name.
          expect(config.args?.some((arg) => /^@?[\w./-]+@\d+\.\d+\.\d+/.test(arg)), server).toBe(true);
          expect(extra.auth).toBeUndefined();
        }
        for (const key of ["unavailable", "note"]) if (key in extra) expect(typeof extra[key]).toBe("string");
      }
    });

    it("has skills whose name matches their folder", () => {
      for (const skill of fs.readdirSync(path.join(dir, "skills"))) {
        const { data, body } = parseFrontmatter(fs.readFileSync(path.join(dir, "skills", skill, "SKILL.md"), "utf8"));
        expect(data.name).toBe(skill);
        expect(String(data.description).length).toBeGreaterThan(40);
        expect(String(data.description).length).toBeLessThanOrEqual(1024);
        expect(body.trim().length).toBeGreaterThan(0);
      }
    });
  });
});
