import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, describe, expect, it } from "vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectSecretsLive from "../secrets/ProjectSecretsLive.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as SessionStore from "../session-protocol/store.ts";
import { layerDenyAll } from "./CredentialBroker.ts";
import { makeImportHandlers } from "./importHandlers.ts";
import * as PluginRegistry from "./PluginRegistry.ts";
import { writeTree } from "./testing.ts";

const CANARY = "canary5Kd8Wq2Zp7Lm3Rt9Vx1";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-import-handlers-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const registryLayer = () =>
  PluginRegistry.layerSessionPlugins.pipe(
    Layer.provideMerge(PluginRegistry.layer),
    Layer.provideMerge(SessionStore.layer),
    Layer.provideMerge(layerDenyAll),
    Layer.provideMerge(ServerSettingsModule.layer),
    Layer.provideMerge(ProjectSecretsLive.layer),
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "caveman-import-handlers-" }))),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const plugin = (name: string) => ({
  ".claude-plugin/plugin.json": JSON.stringify({ name, version: "1.0.0", description: `${name} plugin` }),
  ".mcp.json": JSON.stringify({ mcpServers: { [`${name}-db`]: { command: "node", args: ["./server.js"] } } }),
  "hooks/hooks.json": JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "./start.sh" }] }] } }),
  [`skills/${name}-skill/SKILL.md`]: `---\nname: ${name}-skill\ndescription: does ${name}\n---\nbody\n`,
});

describe("import handlers on a real registry", () => {
  it("imports a Claude Code folder marketplace, its enabled plugin and servers; folders without git; no secret values", async () => {
    const home = path.join(tmp, "home");
    const claude = path.join(home, ".claude");
    const market = path.join(home, "work", "team-market");
    writeTree(market, {
      ".claude-plugin/marketplace.json": JSON.stringify({ name: "team-market", owner: { name: "Team" }, plugins: [{ name: "tool", source: "./tool" }] }),
      ...Object.fromEntries(Object.entries(plugin("tool")).map(([file, text]) => [`tool/${file}`, text])),
    });
    writeTree(claude, {
      "plugins/known_marketplaces.json": JSON.stringify({ "team-market": { source: { source: "directory", path: market }, installLocation: market } }),
      "settings.json": JSON.stringify({ enabledPlugins: { "tool@team-market": true }, env: { SECRET: CANARY } }),
    });
    writeTree(home, {
      ".claude.json": JSON.stringify({ mcpServers: { docs: { command: "docs-mcp", env: { DOCS_TOKEN: CANARY } } } }),
      ".cursor/mcp.json": JSON.stringify({ mcpServers: { tracker: { url: "https://mcp.tracker.example/mcp" } } }),
    });
    const single = path.join(tmp, "single-plugin");
    writeTree(single, plugin("solo"));
    const skills = path.join(tmp, "loose-skills");
    writeTree(skills, { "skills/notes/SKILL.md": "---\nname: notes\ndescription: take notes\n---\n", "skills/notes/.env": `KEY=${CANARY}`, "skills/notes/id_ed25519": CANARY });
    // A link inside a skill would reach whatever it names from ~/.agents/skills.
    fs.mkdirSync(path.join(home, ".aws"), { recursive: true });
    fs.writeFileSync(path.join(home, ".aws", "credentials"), CANARY);
    fs.symlinkSync(path.join(home, ".aws", "credentials"), path.join(skills, "skills", "notes", "ref"));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const handlers = yield* makeImportHandlers({ home, codexOwnHome: Effect.succeed(false), env: {}, probe: async () => true });
        const ctx = { connectionId: "test" };
        const scanned = yield* handlers["import.scan"]({}, ctx);
        const claudeItems = scanned.sources.find((s) => s.from === "claude")!.items;
        const applied = yield* handlers["import.apply"]({ request_id: "r1", items: claudeItems.map(({ from, kind, name }) => ({ from, kind, name })).concat([{ from: "cursor", kind: "mcp_server", name: "tracker" }]) }, ctx);
        const again = yield* handlers["import.scan"]({}, ctx);
        // Without confirm it only says what the folder brings; nothing is added.
        const preview = yield* handlers["import.folder"]({ request_id: "r2", path: single }, ctx);
        const before = [...(yield* (yield* PluginRegistry.PluginRegistry).known).installs.keys()];
        const solo = yield* handlers["import.folder"]({ request_id: "r2", path: single, confirm: true }, ctx);
        const loose = yield* handlers["import.folder"]({ request_id: "r3", path: skills, confirm: true }, ctx);
        const bad = yield* Effect.flip(handlers["import.folder"]({ request_id: "r4", path: path.join(tmp, "missing") }, ctx));
        const settings = (yield* (yield* ServerSettingsModule.ServerSettingsService).getSettings).plugins;
        const known = yield* (yield* PluginRegistry.PluginRegistry).known;
        return { scanned, applied, again, preview, before, solo, loose, bad, settings, installs: [...known.installs.keys()] };
      }).pipe(Effect.scoped, Effect.provide(registryLayer())),
    );

    expect(result.scanned.sources.find((s) => s.from === "claude")!.items.map((i) => [i.kind, i.name, i.action])).toEqual([
      ["marketplace", "team-market", "add"],
      ["plugin", "tool@team-market", "install"],
      ["mcp_server", "docs", "import"],
    ]);
    expect(result.applied).toEqual({ imported: 4, failed: [] });
    expect(result.settings.marketplaces.map((m) => [m.name, m.source])).toContainEqual(["team-market", { kind: "folder", path: market }]);
    expect(result.settings.servers.map((s) => [s.name, s.source, s.env ?? s.auth])).toEqual([
      ["docs", "claude", ["DOCS_TOKEN"]],
      ["tracker", "cursor", "oauth"],
    ]);
    // Imported once: a second scan says it is all there.
    expect(result.again.sources.find((s) => s.from === "claude")!.items.map((i) => i.action)).toEqual(["available", "available", "available"]);

    expect(result.preview).toEqual({
      kind: "plugin",
      preview: { name: "solo", skills: ["solo-skill"], mcp_servers: [{ name: "solo-db", command: "node", args: ["./server.js"] }], hooks: [{ event: "SessionStart", command: "./start.sh" }], rules: [] },
    });
    expect(result.before).not.toContain("solo@single-plugin");
    expect(result.solo).toMatchObject({ kind: "plugin", added: "solo@single-plugin" });
    expect(result.loose).toMatchObject({ kind: "skills", added: "notes" });
    const copied = path.join(home, ".agents", "skills", "notes");
    expect(fs.readdirSync(copied)).toEqual(["SKILL.md"]);
    expect(result.bad.reason).toBe("invalid_params");
    expect(result.installs).toEqual(expect.arrayContaining(["tool@team-market", "solo@single-plugin"]));

    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it("previews a folder's hooks from skill, command and agent frontmatter too, which Claude Agent runs", async () => {
    const hooked = (event: string, command: string) =>
      ["---", "name: x", "description: x", "hooks:", `  ${event}:`, "    - hooks:", "        - type: command", `          command: ${command}`, "---", "x"].join("\n");
    const folder = path.join(tmp, "frontmatter-hooks");
    writeTree(folder, {
      ".claude-plugin/plugin.json": JSON.stringify({ name: "guard" }),
      "hooks/hooks.json": JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "./stop.sh" }] }] } }),
      "skills/deploy/SKILL.md": hooked("PreToolUse", "./collect.sh"),
      "commands/ship.md": hooked("PostToolUse", "./after.sh"),
      "agents/helper.md": hooked("SubagentStop", "./done.sh"),
    });
    const preview = await Effect.runPromise(
      Effect.gen(function* () {
        const handlers = yield* makeImportHandlers({ home: path.join(tmp, "frontmatter-home"), codexOwnHome: Effect.succeed(false), env: {} });
        return yield* handlers["import.folder"]({ request_id: "f1", path: folder }, { connectionId: "test" });
      }).pipe(Effect.scoped, Effect.provide(registryLayer())),
    );
    expect(preview).toMatchObject({ kind: "plugin" });
    expect(preview.preview.hooks).toEqual([
      { event: "Stop", command: "./stop.sh" },
      { event: "PreToolUse", command: "./collect.sh" },
      { event: "PostToolUse", command: "./after.sh" },
      { event: "SubagentStop", command: "./done.sh" },
    ]);
  });
});
