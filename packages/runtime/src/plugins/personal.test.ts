import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SessionPlugins } from "@caveman-app/engine-core/server/SessionPlugins";
import { ThreadId } from "@caveman-app/protocol";
import { McpImportCandidate, McpServerInfo, PluginInfo } from "@caveman-app/session-protocol/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { afterAll, describe, expect, it } from "vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { OUTSIDE_SERVER_KEY, outsideLine } from "../cloudLink/credentialRule.ts";
import { cloudComputerUnderRule } from "../cloudLink/credentialRule.testkit.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { CredentialGrants, layerSecretStore } from "./CredentialBroker.ts";
import { makeImportHandlers } from "./importHandlers.ts";
import { headerCredential, holdsCredential, PERSONAL_SPACE_ID, PERSONAL_SPACE_URL, settleSignIn, signInNeeded } from "./personal.ts";
import * as http from "node:http";
import * as PluginRegistry from "./PluginRegistry.ts";
import { makePluginHandlers } from "./protocolHandlers.ts";
import { SANDBOX_LAUNCHER } from "./resolve.ts";
import { spaceIdFor } from "./spaces.ts";
import { makeSpaceRepo } from "./testing.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-personal-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Values that must never come out of an import. */
const SECRETS = [("gh" + "p_1234567890abcdefABCDEF"), "Bearer sk-live-abc", "hunter2", "codex-token-value"];

function homes() {
  const dir = fs.mkdtempSync(path.join(tmp, "home-"));
  const claudeJson = path.join(dir, ".claude.json");
  fs.writeFileSync(
    claudeJson,
    JSON.stringify({
      mcpServers: {
        github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: SECRETS[0] } },
        pg: { command: "npx", args: ["-y", "pg-mcp", "postgres://app:hunter2@db/app"] },
        keyflag: { command: "tool-mcp", args: ["--api-key", "abcd"] },
        remote: { type: "http", url: "https://mcp.example.com/mcp" },
        hdr: { type: "http", url: "https://mcp.example.com/other", headers: { Authorization: SECRETS[1] } },
        old: { type: "sse", url: "https://mcp.example.com/sse" },
        "bad name!": { command: "x" },
        // Context7 as its docs write it: a header named like a variable, which Settings once refused for the whole import.
        context7: { type: "http", url: "https://mcp.context7.com/mcp", headers: { CONTEXT7_API_KEY: SECRETS[1] } },
        oddenv: { command: "odd-mcp", env: { "MY-VAR": "x" } },
      },
      projects: { "/repo": { mcpServers: { local: { command: "local-only" } } } },
    }),
  );
  const codexHome = path.join(dir, ".codex");
  fs.mkdirSync(codexHome);
  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    [
      "[mcp_servers.docs]",
      'command = "npx"',
      'args = ["-y", "docs-mcp"]',
      "[mcp_servers.docs.env]",
      `TOKEN = "${SECRETS[3]}"`,
      "[mcp_servers.github]",
      'command = "other"',
      "[mcp_servers.search]",
      'url = "https://search.example.com/mcp"',
      'bearer_token_env_var = "SEARCH_TOKEN"',
      // The same Context7 in Codex: one server, not a clash.
      "[mcp_servers.context7]",
      'url = "https://mcp.context7.com/mcp"',
      "[mcp_servers.context7.http_headers]",
      `CONTEXT7_API_KEY = "${SECRETS[3]}"`,
    ].join("\n"),
  );
  return { home: dir, claudeJson, codexHome };
}

describe("importing the user's MCP servers", () => {
  it("spots credentials in argv and URLs", () => {
    expect(holdsCredential(["npx", "-y", "server"])).toBe(false);
    expect(holdsCredential(["--api-key", "abcd"])).toBe(true);
    expect(holdsCredential(["--token=abcd"])).toBe(true);
    // A short password inside a connection string still counts.
    expect(holdsCredential(["--conn=Server=db;Password=hunter2"])).toBe(true);
    expect(holdsCredential(["DSN", "host=db pwd=x1"])).toBe(true);
    expect(holdsCredential(["--db", "Server=db;Database=app"])).toBe(false);
    expect(holdsCredential(["--header", "Authorization: Bearer x"])).toBe(true);
    expect(holdsCredential(["postgres://u:p@h/db"])).toBe(true);
    expect(holdsCredential(["https://x.example/mcp?api_key=1"])).toBe(true);
    expect(holdsCredential(["https://hooks.zapier.com/a1b2c3d4e5f6g7h8i9j0k1l2/mcp"])).toBe(true);
    expect(holdsCredential(["https://mcp.linear.app/mcp"])).toBe(false);
  });

  it("asks a URL server once whether it signs in: 401 or 403 does, an answer doesn't, silence can't tell", async () => {
    const result = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "t", version: "1" } } });
    const server = http.createServer((req, res) => {
      // An event stream that stays open after its result, like Cloudflare's docs server.
      if (req.url === "/open") return void res.writeHead(200, { "content-type": "text/event-stream" }).write(`event: message\ndata: ${result}\n\n`);
      // Answers, and offers a sign-in that may unlock more (Hugging Face, Context7).
      if (req.url === "/offers") return void res.writeHead(200, { "content-type": "application/json" }).end(result);
      if (req.url === "/.well-known/oauth-protected-resource/offers") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ resource: "x", authorization_servers: ["https://auth.example"] }));
      // A catch-all page answers 200 to anything; it is not an MCP server saying it needs no sign-in.
      if (req.url === "/page") return void res.writeHead(200, { "content-type": "text/html" }).end("<html>hello</html>");
      if (req.url === "/locked") return void res.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="x"' }).end();
      if (req.url === "/gone" || req.url?.startsWith("/.well-known/")) return void res.writeHead(404).end();
      // /slow never answers.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      expect(await signInNeeded(`${base}/open`)).toBe(false);
      expect(await signInNeeded(`${base}/offers`)).toBe(true);
      expect(await signInNeeded(`${base}/page`)).toBeUndefined();
      expect(await signInNeeded(`${base}/locked`)).toBe(true);
      expect(await signInNeeded(`${base}/gone`)).toBeUndefined();
      expect(await signInNeeded(`${base}/slow`, 200)).toBeUndefined();
    } finally {
      server.closeAllConnections();
      server.close();
    }
    const oauth = { name: "docs", url: "https://docs.example/mcp", auth: "oauth" as const, source: "codex" as const, enabled: true };
    expect(await settleSignIn(oauth, async () => false)).toEqual({ name: "docs", url: "https://docs.example/mcp", source: "codex", enabled: true });
    expect(await settleSignIn(oauth, async () => true)).toBe(oauth);
    expect(await settleSignIn(oauth, async () => undefined)).toBe(oauth);
    // Headers or a command: nothing to ask.
    const asked: string[] = [];
    const probe = async (url: string) => (asked.push(url), false);
    await settleSignIn({ ...oauth, headers: ["Authorization"] }, probe);
    await settleSignIn({ name: "cmd", command: "x", source: "manual", enabled: true }, probe);
    expect(asked).toEqual([]);
  });

  it("reads names, commands and URLs from Claude Code and Codex, never a value, and imports what it can", async () => {
    const h = homes();
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        // remote answers without credentials, so it comes in without a sign-in; search asks for one.
        const handlers = yield* makeImportHandlers({ home: h.home, codexOwnHome: Effect.succeed(false), env: {}, probe: async (url) => !url.includes("mcp.example.com/mcp") });
        const ctx = { connectionId: "test" };
        const scan = yield* handlers["mcp.import_scan"]({}, ctx);
        const imported = yield* handlers["mcp.import"]({ request_id: "r1" }, ctx);
        const listed = yield* (yield* makePluginHandlers)["mcp.list"]({});
        return { scan, imported, listed };
      }).pipe(Effect.scoped, Effect.provide(layer())),
    );
    const ok = out.scan.candidates.filter((c) => c.reason === undefined);
    expect(ok.map((c) => [c.from, c.name])).toEqual([
      ["claude", "github"],
      ["claude", "remote"],
      ["claude", "hdr"],
      ["claude", "bad-name"],
      ["claude", "context7"],
      ["codex", "docs"],
      ["codex", "search"],
    ]);
    const byName = Object.fromEntries(ok.map((c) => [c.name, c]));
    expect(byName.github).toEqual({ name: "github", from: "claude", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], credentials: ["GITHUB_TOKEN"] });
    expect(byName.context7).toMatchObject({ url: "https://mcp.context7.com/mcp", credentials: ["CONTEXT7_CONTEXT7_API_KEY"] });
    expect(out.scan.candidates.filter((c) => c.reason !== undefined).map((c) => [c.from, c.name, c.reason!.split(";")[0]])).toEqual([
      ["claude", "pg", "its command line or URL holds a credential"],
      ["claude", "keyflag", "its command line or URL holds a credential"],
      ["claude", "old", "SSE servers are not supported"],
      ["claude", "oddenv", 'oddenv: "MY-VAR" is not an environment variable name'],
      ["codex", "github", "Claude Code has a different server named github"],
      ["codex", "context7", "another setup brings the same server"],
    ]);
    // One server Settings would refuse never fails the others: every importable one is added.
    expect(out.imported.added).toEqual(ok.map((c) => c.name));
    expect(out.listed.servers.map((s) => s.name)).toEqual(ok.map((c) => c.name));
    expect(out.listed.servers.find((s) => s.name === "remote")).not.toHaveProperty("auth");
    expect(out.listed.servers.find((s) => s.name === "context7")).toMatchObject({ source: "claude", credentials: [{ name: "CONTEXT7_CONTEXT7_API_KEY", granted: false, header: "CONTEXT7_API_KEY" }] });
    for (const s of out.listed.servers) expect(Schema.is(McpServerInfo)(s)).toBe(true);
    for (const c of out.scan.candidates) expect(Schema.is(McpImportCandidate)(c)).toBe(true);
    const text = JSON.stringify(out);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    // Local scope (one repository's) is not the user's own setup.
    expect(text).not.toContain("local-only");
  });

  it("imports the servers an older client names as the scan offered them, and asks every URL its question at once", async () => {
    const h = homes();
    const config = JSON.parse(fs.readFileSync(h.claudeJson, "utf8"));
    config.mcpServers.wiki = { type: "http", url: "https://wiki.example.com/mcp" };
    fs.writeFileSync(h.claudeJson, JSON.stringify(config));
    const asked: string[] = [];
    const waiting: Array<(answer: boolean | undefined) => void> = [];
    // Answers only once both URLs were asked: saving one at a time and asking each just before its save would never
    // get there, and the deadline's undefined would keep remote's sign-in.
    const probe = (url: string) =>
      new Promise<boolean | undefined>((resolve) => {
        asked.push(url);
        waiting.push(resolve);
        if (asked.length === 2) for (const answer of waiting) answer(false);
        setTimeout(() => resolve(undefined), 1500);
      });
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const handlers = yield* makeImportHandlers({ home: h.home, codexOwnHome: Effect.succeed(false), env: {}, probe });
        // "bad name!" in the config was offered as bad-name.
        const imported = yield* handlers["mcp.import"]({ request_id: "r2", names: ["bad-name", "remote", "wiki"] }, { connectionId: "test" });
        const listed = yield* (yield* makePluginHandlers)["mcp.list"]({});
        return { imported, listed };
      }).pipe(Effect.scoped, Effect.provide(layer())),
    );
    expect([...out.imported.added].sort()).toEqual(["bad-name", "remote", "wiki"]);
    expect(asked.sort()).toEqual(["https://mcp.example.com/mcp", "https://wiki.example.com/mcp"]);
    expect(out.listed.servers.filter((s) => s.auth !== undefined)).toEqual([]);
  });
});

const layer = () =>
  PluginRegistry.layerSessionPlugins.pipe(
    Layer.provideMerge(PluginRegistry.layer),
    Layer.provideMerge(layerSecretStore),
    Layer.provideMerge(ServerSettingsModule.layer),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "caveman-personal-registry-" }))),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

describe("personal servers in the registry", () => {
  it("reach every engine through the bundle, with granted credentials brokered and revoked on removal", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        const sessions = yield* SessionPlugins;
        yield* registry.saveServer({ name: "fs", command: "npx", args: ["-y", "fs-mcp"], env: ["FS_TOKEN"], source: "manual", enabled: true }, false);
        yield* registry.saveServer({ name: "linear", url: "https://mcp.linear.app/mcp", auth: "oauth", source: "manual", enabled: true }, false);
        yield* registry.saveServer({ name: "hdr", url: "https://mcp.example.com/mcp", headers: ["Authorization"], source: "manual", enabled: true }, false);
        const duplicate = yield* Effect.flip(registry.saveServer({ name: "FS", command: "x", source: "manual", enabled: true }, false));
        const reserved = yield* Effect.flip(registry.saveServer({ name: "caveman-code", command: "x", source: "manual", enabled: true }, false));
        const both = yield* Effect.flip(registry.saveServer({ name: "both", command: "x", url: "https://x.example", source: "manual", enabled: true }, false));
        const undeclared = yield* Effect.flip(registry.grant(PERSONAL_SPACE_ID, "OTHER", Redacted.make("x")));
        yield* registry.grant(PERSONAL_SPACE_ID, "FS_TOKEN", Redacted.make("fs-granted"));
        yield* registry.grant(PERSONAL_SPACE_ID, headerCredential("hdr", "Authorization"), Redacted.make("Bearer hdr-granted"));
        const listed = yield* registry.servers;
        const session = yield* registry.session();
        const codex = yield* sessions.codex(ThreadId.make("p-1"), "startup");
        const claude = yield* sessions.claudeAgent(ThreadId.make("p-1"));
        const fsServer = codex.config.mcp_servers["fs"] as { args: string[] };
        const policy = JSON.parse(fsServer.args[fsServer.args.indexOf(SANDBOX_LAUNCHER) + 1]!);
        const fileBefore = fs.readFileSync(policy.secrets, "utf8");
        yield* registry.removeServer("fs");
        return {
          duplicate: duplicate.message,
          reserved: reserved.message,
          both: both.message,
          undeclared: undeclared.message,
          listed,
          hubOnly: session.hubOnly,
          remoteAuth: session.remoteAuth,
          bundleKeys: Object.keys(session.bundle.mcpServers),
          hdrHeaders: session.bundle.mcpServers["hdr"],
          codexKeys: Object.keys(codex.config.mcp_servers),
          claudeKeys: Object.keys(claude.mcpServers),
          claudeCopies: claude.plugins.length,
          fileBefore,
          afterRemove: {
            granted: yield* (yield* CredentialGrants).isGranted(PERSONAL_SPACE_URL, "FS_TOKEN"),
            names: (yield* registry.servers).map((s) => s.server.name),
            installed: (yield* registry.list).map((p) => p.id),
          },
        };
      }).pipe(Effect.scoped, Effect.provide(layer())),
    );
    expect(out.duplicate).toContain("already one of your servers");
    expect(out.reserved).toContain("reserved");
    expect(out.both).toContain("not both");
    expect(out.undeclared).toBe("no server of yours asks for OTHER");
    expect(out.listed.map((s) => [s.server.name, s.credentials])).toEqual([
      ["fs", [{ name: "FS_TOKEN", granted: true }]],
      ["linear", []],
      ["hdr", [{ name: "HDR_AUTHORIZATION", granted: true }]],
    ]);
    for (const s of out.listed) expect(Schema.is(McpServerInfo)({ ...s.server, credentials: s.credentials })).toBe(true);
    // Personal servers keep their own names, not my-servers__<name>.
    expect(out.bundleKeys).toEqual(["fs", "linear", "hdr"]);
    expect(out.hubOnly).toEqual(["linear"]);
    expect(out.remoteAuth).toEqual({ linear: { auth: "oauth", url: "https://mcp.linear.app/mcp" } });
    expect(out.hdrHeaders).toEqual({ type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer hdr-granted" } });
    expect(JSON.parse(out.fileBefore)).toEqual({ FS_TOKEN: "fs-granted" });
    // A hub-only server never reaches an engine directly; with no runtime MCP credential, not at all.
    expect(out.codexKeys).toEqual(["fs", "hdr"]);
    expect(out.claudeKeys).toEqual(["fs", "hdr"]);
    // No plugin directory is copied for personal servers.
    expect(out.claudeCopies).toBe(0);
    expect(out.afterRemove).toEqual({ granted: false, names: ["linear", "hdr"], installed: [] });
  });

  it("on a Cloud computer that keeps nothing of its person's, take no key, pasted in its field or in a command line; one an earlier run kept can still be revoked", async () => {
    // The rule comes on while the computer runs (Cloud refuses a credential route).
    const computer = cloudComputerUnderRule(false);
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const handlers = yield* makePluginHandlers;
        const grants = yield* CredentialGrants;
        const secretsDir = (yield* ServerConfig.ServerConfig).secretsDir;
        const stored = () => fs.readdirSync(secretsDir).map((file) => fs.readFileSync(path.join(secretsDir, file), "latin1")).join("\n");
        yield* handlers["mcp.add"]({ request_id: "a1", name: "fs", command: "fs-mcp", env: ["FS_TOKEN", "FS_OTHER"] });
        yield* handlers["credential.grant"]({ request_id: "g1", marketplace: PERSONAL_SPACE_ID, name: "FS_TOKEN", value: "fs-granted-before" });
        // A key in a command line is taken as it always was, until the rule is on.
        yield* handlers["mcp.add"]({ request_id: "a2", name: "flag-before", command: "tool-mcp", args: ["--api-key", "abcd"] });
        computer.turnOn();
        const lines = [
          yield* Effect.flip(handlers["mcp.add"]({ request_id: "a3", name: "flag", command: "tool-mcp", args: ["--api-key", "line-under-the-rule"] })),
          yield* Effect.flip(handlers["mcp.add"]({ request_id: "a4", name: "pg", command: "npx", args: ["-y", "pg-mcp", "postgres://app:line-under-the-rule@db/app"] })),
          yield* Effect.flip(handlers["mcp.add"]({ request_id: "a5", name: "remote", url: "https://mcp.example.com/mcp?api_key=line-under-the-rule" })),
          yield* Effect.flip(handlers["marketplace.add"]({ request_id: "m1", source: "https://x-access-token:line-under-the-rule@github.com/acme/market.git" })),
        ].map((e) => ({ reason: e.reason, message: e.message }));
        // One with no key in it is still added.
        const plain = yield* handlers["mcp.add"]({ request_id: "a6", name: "plain", command: "npx", args: ["-y", "plain-mcp"] });
        const settingsFile = fs.readFileSync((yield* ServerConfig.ServerConfig).settingsPath, "utf8");
        const added = yield* Effect.flip(handlers["credential.grant"]({ request_id: "g2", marketplace: PERSONAL_SPACE_ID, name: "FS_OTHER", value: "fs-pasted-under-the-rule" }));
        const replaced = yield* Effect.flip(handlers["credential.grant"]({ request_id: "g3", marketplace: PERSONAL_SPACE_ID, name: "FS_TOKEN", value: "fs-replaced-under-the-rule" }));
        const kept = { text: stored(), token: yield* grants.isGranted(PERSONAL_SPACE_URL, "FS_TOKEN"), other: yield* grants.isGranted(PERSONAL_SPACE_URL, "FS_OTHER") };
        yield* handlers["credential.revoke"]({ request_id: "r1", marketplace: PERSONAL_SPACE_ID, name: "FS_TOKEN" });
        return {
          refusals: [added, replaced].map((e) => ({ reason: e.reason, message: e.message })),
          kept,
          after: { text: stored(), token: yield* grants.isGranted(PERSONAL_SPACE_URL, "FS_TOKEN") },
          lines,
          plain: plain.name,
          settingsFile,
          names: (yield* handlers["mcp.list"]({})).servers.map((s) => s.name),
          rows: (yield* handlers["mcp.list"]({})).servers.map((s) => [s.name, s.problem]),
        };
      }).pipe(Effect.scoped, Effect.provide(computer.layer), Effect.provide(layer())),
    );
    // A server or marketplace whose command line or URL carries a key is a key too: none is saved, or asked anything.
    expect(out.lines).toEqual([
      { reason: "unsupported", message: outsideLine("server") },
      { reason: "unsupported", message: outsideLine("server") },
      { reason: "unsupported", message: outsideLine("server") },
      { reason: "unsupported", message: outsideLine("marketplace") },
    ]);
    expect(out.plain).toBe("plain");
    expect(out.names).toEqual(["fs", "flag-before", "plain"]);
    // The one whose key is not here says so on its row, where servers are listed; the ones that need none say nothing.
    expect(out.rows).toEqual([["fs", "fs needs a key that stays on your Mac, so it isn't in Cloud."], ["flag-before", undefined], ["plain", undefined]]);
    expect(out.settingsFile).toContain("flag-before");
    expect(out.settingsFile).not.toContain("line-under-the-rule");
    expect(out.refusals).toEqual([
      { reason: "unsupported", message: OUTSIDE_SERVER_KEY },
      { reason: "unsupported", message: OUTSIDE_SERVER_KEY },
    ]);
    // The secret store holds the key from before, as it was, and neither refused one.
    expect(out.kept).toMatchObject({ token: true, other: false });
    expect(out.kept.text).toContain("fs-granted-before");
    expect(out.kept.text).not.toContain("under-the-rule");
    expect(out.after).toMatchObject({ token: false });
    expect(out.after.text).not.toContain("fs-granted-before");
  });

  it("keep their sign-in when a plugin's server takes their name, and never lend it to that server", async () => {
    const [bare, commit] = makeSpaceRepo(path.join(tmp, "acme-repo"), {
      ".claude-plugin/plugin.json": JSON.stringify({ name: "acme" }),
      ".mcp.json": JSON.stringify({ mcpServers: { api: { type: "http", url: "https://mcp.acme-plugin.example/mcp" } } }),
    });
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        const settings = yield* ServerSettingsModule.ServerSettingsService;
        // A name the plugin's server key also takes (acme__api), so the personal server moves to its full-id key.
        yield* registry.saveServer({ name: "acme__api", url: "https://mcp.personal.example/mcp", auth: "oauth", source: "manual", enabled: true }, false);
        yield* settings.updateSettings({ plugins: { spaces: [{ url: bare, commit, enabled: true }] } });
        const session = yield* registry.session();
        return {
          urls: Object.fromEntries(Object.entries(session.bundle.mcpServers).map(([key, server]) => [key, server.type === "http" ? server.url : server.type])),
          remoteAuth: session.remoteAuth,
          hubOnly: session.hubOnly,
        };
      }).pipe(Effect.scoped, Effect.provide(layer())),
    );
    expect(out.urls).toEqual({ acme__api: "https://mcp.acme-plugin.example/mcp", "my-servers_personal__acme__api": "https://mcp.personal.example/mcp" });
    // A sign-in is for the server at its own key: the plugin's server gets none, the person's keeps theirs and the hub.
    expect(out.remoteAuth).toEqual({ "my-servers_personal__acme__api": { auth: "oauth", url: "https://mcp.personal.example/mcp" } });
    expect(out.hubOnly).toEqual(["my-servers_personal__acme__api"]);
  });

  it("runs a plugin's hooks only once the user trusts it", async () => {
    const [bare, commit] = makeSpaceRepo(path.join(tmp, "trust-repo"), {
      ".claude-plugin/plugin.json": JSON.stringify({ name: "guard" }),
      "hooks/hooks.json": JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "true" }] }] } }),
      "skills/s/SKILL.md": "---\nname: s\ndescription: d\nhooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: echo stop\n---\nbody",
    });
    const plugin = "guard@space"; // a space migrates to a marketplace named after its repository
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        const settings = yield* ServerSettingsModule.ServerSettingsService;
        yield* settings.updateSettings({ plugins: { spaces: [{ url: bare, commit, enabled: true }] } });
        const before = yield* registry.session();
        const beforeCopy = yield* registry.claudeAgent(before);
        const listedBefore = (yield* registry.list)[0]!;
        yield* registry.setTrusted(plugin, true);
        const unknown = yield* Effect.flip(registry.setTrusted("nope@x", true));
        const after = yield* registry.session();
        const afterCopy = yield* registry.claudeAgent(after);
        return {
          before: before.bundle.hooks.length,
          beforeSkill: fs.readFileSync(path.join(beforeCopy.plugins[0]!.path, "skills/s/SKILL.md"), "utf8"),
          listedBefore,
          after: after.bundle.hooks.map((h) => h.event),
          afterSkill: fs.readFileSync(path.join(afterCopy.plugins[0]!.path, "skills/s/SKILL.md"), "utf8"),
          listedAfter: (yield* registry.list)[0]!.trusted,
          unknown: unknown.invalid,
        };
      }).pipe(Effect.scoped, Effect.provide(layer())),
    );
    expect(out.before).toBe(0);
    expect(out.beforeSkill).not.toContain("echo stop");
    expect(out.listedBefore.trusted).toBe(false);
    expect(Schema.is(PluginInfo)(out.listedBefore)).toBe(true);
    expect(out.after).toEqual(["PreToolUse"]);
    expect(out.afterSkill).toContain("echo stop");
    expect(out.listedAfter).toBe(true);
    expect(out.unknown).toBe(true);
  });
});
