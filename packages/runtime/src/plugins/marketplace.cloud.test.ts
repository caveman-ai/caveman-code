// The Plugins marketplace against a stand-in Caveman Cloud (cloudLink/testCloud.ts, which answers as the
// fix round's Cloud does: repository keys lower-case, a project found by its repository, team installs and
// pins and shared accounts for admins only, a lease that serves the person's own connection first): a
// project install for a mixed-case repository, a teammate's runtime in the project's other repository, a
// shared account leased there, org rows that never pass for a person's own, Cloud going down, a git
// marketplace added to the team with an install, and a Cloud computer after the connector migration.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SessionPlugins } from "@caveman-app/engine-core/server/SessionPlugins";
import { ThreadId } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { enroll, RECORD_FILE } from "../cloudLink/identity.ts";
import { linkDirOf } from "../cloudLink/index.ts";
import { applyProfile, buildProfile, type Profile } from "../cloudLink/profile.ts";
import { startTestCloud, type TestCloud } from "../cloudLink/testCloud.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EgressScrub from "../secrets/EgressScrub.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import * as ProjectSecretsLive from "../secrets/ProjectSecretsLive.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { ACCOUNT_SECRETS } from "../session-protocol/account.ts";
import { setupHomes } from "../session-protocol/setupScan.ts";
import * as SessionStore from "../session-protocol/store.ts";
import { layerSecretStore } from "./CredentialBroker.ts";
import { Connectors, layer as connectorsLayer } from "./connectors.ts";
import { layer as hubLayer, McpHubAuth } from "./McpHub.ts";
import * as PluginRegistry from "./PluginRegistry.ts";
import { makePluginHandlersWith, type ProjectRef } from "./protocolHandlers.ts";
import { makeSpaceRepo, writeTree } from "./testing.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-mkt-cloud-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const LINEAR = "linear@caveman-curated";
const NOTION = "notion@caveman-curated";
const LINEAR_URL = "https://mcp.linear.app/mcp";

const layer = (prefix: string) =>
  PluginRegistry.layerSessionPlugins.pipe(
    Layer.provideMerge(hubLayer),
    Layer.provideMerge(connectorsLayer),
    Layer.provideMerge(PluginRegistry.layer),
    Layer.provideMerge(SessionStore.layer),
    Layer.provideMerge(layerSecretStore),
    Layer.provideMerge(ServerSettingsModule.layer),
    Layer.provideMerge(EgressScrub.layer.pipe(Layer.provideMerge(ProjectSecretsLive.layer))),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix }))),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

/** A checkout whose origin is `origin`. */
const workRepo = (name: string, origin: string) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir });
  return dir;
};

/** Signs this runtime in to the stand-in Cloud as `role`: its identity (runtime routes) and the person's own sign-in (person routes). */
const signIn = (cloud: TestCloud, role: "admin" | "member") =>
  Effect.gen(function* () {
    const dir = linkDirOf((yield* ServerConfig.ServerConfig).stateDir);
    yield* Effect.promise(() => enroll({ dir, cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "test" }));
    const record = JSON.parse(fs.readFileSync(path.join(dir, RECORD_FILE), "utf8"));
    fs.writeFileSync(path.join(dir, RECORD_FILE), JSON.stringify({ ...record, account: { email: `${role}@example.com`, role } }));
    yield* (yield* ProjectSecrets).set(ACCOUNT_SECRETS, [
      { name: "PUBLIC_CAVEMAN_CLOUD_URL", value: Redacted.make(cloud.url) },
      { name: "CAVEMAN_CLOUD_ACCESS_TOKEN", value: Redacted.make(cloud.state.personToken) },
    ]);
  });

/** The Plugins page's handlers, with the project at `cwd` as the project store would answer it. */
const handlersAt = (projects: ReadonlyArray<ProjectRef>) =>
  makePluginHandlersWith({ projectOf: (id) => Effect.succeed(projects.find((p) => p.id === id)), projectAt: (cwd) => Effect.succeed(projects.find((p) => p.path === cwd)) });


describe("plugins with Caveman", () => {
  let cloud: TestCloud;
  beforeEach(async () => {
    cloud = await startTestCloud();
  });
  afterEach(async () => {
    await cloud.close();
  });

  it("installs for a project of a mixed-case repository; a teammate in its other repository gets it Required, leases the shared account, keeps it while Cloud is down", async () => {
    const api = workRepo("api", "https://github.com/JuliusBrussee/Caveman Cloud.git");
    const web = workRepo("web", "git@github.com:JuliusBrussee/Caveman-Code-App.git");
    const projectA: ProjectRef = { id: "local-api", name: "Caveman Cloud", path: api, repository: "github.com/juliusbrussee/caveman-cloud" };

    // ---------------------------------------------------------------- the admin, in Caveman Cloud
    const admin = await Effect.runPromise(
      Effect.gen(function* () {
        yield* signIn(cloud, "admin");
        const handlers = yield* handlersAt([projectA]);
        // The Plugins page names the project by its path; the first install makes the Cloud project.
        const linear = yield* handlers["plugin.install"]({ request_id: "i1", id: LINEAR, scope: "project", cwd: api, policy: "required", connection: "shared" });
        // The second install finds that project again (keys compared lower-case), not a 409 for its name.
        yield* handlers["plugin.install"]({ request_id: "i2", id: NOTION, scope: "project", cwd: api, policy: "default" });
        // The admin connects the team's account.
        const started = yield* handlers["plugin.connect"]({ request_id: "c1", id: LINEAR, server: "linear", cwd: api });
        yield* Effect.promise(() => fetch(started.authorization_url!).then((r) => r.text()));
        return { linear, started };
      }).pipe(Effect.scoped, Effect.provide(layer("mkt-admin-"))),
    );
    expect(admin.linear.needs_connect).toEqual([{ plugin_id: LINEAR, server: "linear", title: "Linear", auth: "oauth", shared: true }]);
    expect(cloud.state.plugins.projects).toEqual([{ id: expect.any(String), name: "Caveman Cloud", repos: ["github.com/juliusbrussee/caveman-cloud"] }]);
    const projectId = cloud.state.plugins.projects[0]!.id;
    expect(cloud.state.plugins.installs.map((i) => [i.plugin_id, i.scope, i.project_id, i.policy, i.connection])).toEqual([
      [LINEAR, "project", projectId, "required", "shared"],
      [NOTION, "project", projectId, "default", "personal"],
    ]);
    // A catalog plugin is in the catalog: no source or commit goes with it.
    expect(cloud.state.plugins.writes.filter((w) => w.path === "/api/v1/code/plugins/installs").every((w) => w.body.source === undefined && w.body.commit === undefined)).toBe(true);
    expect(cloud.state.starts).toEqual([{ resource: LINEAR_URL, owner: "org", plugin_id: LINEAR }]);
    const orgRow = [...cloud.state.connections.values()][0]!;
    expect(orgRow).toMatchObject({ owner: "org", plugin_id: LINEAR, status: "connected" });

    // The admin adds the second repository to the project (project.add_repo).
    cloud.state.plugins.projects[0]!.repos.push("github.com/juliusbrussee/caveman-code");

    // ---------------------------------------------------------------- a member, in Caveman-Code-App
    cloud.state.role = "member";
    const member = await Effect.runPromise(
      Effect.gen(function* () {
        yield* signIn(cloud, "member");
        const registry = yield* PluginRegistry.PluginRegistry;
        const handlers = yield* handlersAt([{ id: "local-web", name: "Caveman-Code-App", path: web, repository: "github.com/juliusbrussee/caveman-code" }]);
        const on = Effect.map(registry.knownAt(web), (k) => k.plugins.filter((p) => p.enabled).map((p) => p.plugin.id).sort());
        const before = yield* on;
        const refused = yield* Effect.flip(registry.setEnabled(LINEAR, false, web));
        yield* registry.setEnabled(NOTION, false, web);
        const after = yield* on;
        const read = (yield* handlers["plugin.read"]({ id: LINEAR, cwd: web })).plugin;
        const listed = (yield* handlers["plugin.list"]({ cwd: web, marketplace: "caveman-curated" })).plugins.find((p) => p.id === LINEAR)!;
        // The hub's sign-in for the shared server: the plugin and the repository go with the lease, never a project.
        const session = yield* registry.session(web);
        const key = Object.keys(session.remoteAuth).find((k) => session.remoteAuth[k]!.plugin === LINEAR)!;
        const auth = yield* McpHubAuth;
        const transport = yield* auth.transportAuth({ key, server: session.bundle.mcpServers[key]!, auth: session.remoteAuth[key]! });
        const leased = yield* Effect.promise(() => transport.authProvider!.token());
        // A member's own sign-in that needs a reconnect wins: it says so, it never becomes the team's.
        cloud.state.connections.set("own", { connection_id: "own", resource: LINEAR_URL, status: "needs_reconnect", problem: "Linear refused the refresh.", updated_at: new Date().toISOString() });
        yield* Effect.sleep("2100 millis");
        const own = yield* (yield* Connectors).status({ name: "linear", url: LINEAR_URL, auth: "oauth" }, { shared: { pluginId: LINEAR } });
        // Members cannot choose a shared account.
        const sharedByMember = yield* Effect.flip(handlers["plugin.install"]({ request_id: "m1", id: "sentry@caveman-curated", scope: "project", cwd: web, connection: "shared" }));
        // Cloud goes down: the last answer for the repository stays, Required and all, and the list says so.
        cloud.state.plugins.down = 503;
        yield* registry.refreshCloud;
        const down = { on: yield* on, problem: ((yield* handlers["plugin.list"]({ cwd: web })) as { cloud_problem?: string }).cloud_problem };
        return { before, refused, after, read, listed, session: session.remoteAuth[key], leased, own, sharedByMember, down };
      }).pipe(Effect.scoped, Effect.provide(layer("mkt-member-"))),
    );
    expect(member.before).toEqual([LINEAR, NOTION]);
    expect(member.refused.forbidden).toBe(true);
    expect(member.after).toEqual([LINEAR]);
    expect(member.listed).toMatchObject({ installed: true, scope: "project", policy: "required", required: true, connection: "shared", needs_connect: false });
    expect(member.read.server_details).toEqual([{ name: "linear", transport: "http", auth: "oauth", connected: true, held_by: "cloud", shared: true, shared_by: "Ada Admin" }]);
    expect(member.session).toEqual({ auth: "oauth", url: LINEAR_URL, plugin: LINEAR, repository: "github.com/juliusbrussee/caveman-code" });
    expect(member.leased).toBe(orgRow.token);
    expect(cloud.state.leases.at(-1)).toMatchObject({ owner: "org", body: { resource: LINEAR_URL, plugin_id: LINEAR, repository: "github.com/juliusbrussee/caveman-code" } });
    expect(cloud.state.leases.at(-1)!.body).not.toHaveProperty("project_id");
    expect(member.own).toEqual({ status: "needs_sign_in", problem: "Linear refused the refresh." });
    expect(member.sharedByMember.message).toContain("Admin or Owner");
    expect(member.down.on).toEqual([LINEAR]);
    expect(member.down.problem).toMatch(/^Couldn't reach Caveman/);
  });

  it("never reads an org account as the person's own, and a person's Sign out leaves it", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        yield* signIn(cloud, "admin");
        const registry = yield* PluginRegistry.PluginRegistry;
        const handlers = yield* handlersAt([]);
        // The team's Linear account exists (for a shared install elsewhere); this person installed Linear for themselves.
        cloud.state.connections.set("team", { connection_id: "team", resource: LINEAR_URL, owner: "org", plugin_id: LINEAR, status: "connected", token: "team-token", updated_at: new Date().toISOString() });
        yield* registry.install({ id: LINEAR, scope: "me" });
        const status = yield* (yield* Connectors).status({ name: "linear", url: LINEAR_URL, auth: "oauth" });
        const listed = (yield* handlers["plugin.list"]({ marketplace: "caveman-curated" })).plugins.find((p) => p.id === LINEAR)!;
        // Connect starts the person's own, not "already connected".
        const started = yield* handlers["plugin.connect"]({ request_id: "c1", id: LINEAR, server: "linear" });
        yield* handlers["connector.disconnect"]({ request_id: "d1", id: "linear" });
        return { status, needs: listed.needs_connect, started };
      }).pipe(Effect.scoped, Effect.provide(layer("mkt-org-rows-"))),
    );
    expect(out.status).toEqual({ status: "needs_sign_in" });
    expect(out.needs).toBe(true);
    expect(out.started.status).toBe("signing_in");
    expect(cloud.state.starts).toEqual([{ resource: LINEAR_URL }]);
    // Sign out deleted the person's own (pending) row; the team's account is still there.
    expect([...cloud.state.connections.values()].map((r) => [r.connection_id, r.owner ?? "person"])).toEqual([["team", "org"]]);
  });

  it("keeps Cloud's last answer per org: another org's team plugins never stand in while Cloud is down", async () => {
    cloud.state.plugins.installs.push({ scope: "team", plugin_id: LINEAR, policy: "required" } as never);
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        yield* signIn(cloud, "member");
        const registry = yield* PluginRegistry.PluginRegistry;
        const on = Effect.map(registry.known, (k) => k.plugins.filter((p) => p.enabled).map((p) => p.plugin.id));
        const up = yield* on;
        cloud.state.plugins.down = 503;
        yield* registry.refreshCloud;
        const down = yield* on;
        // This computer is signed in to another org now; Cloud is still down.
        const record = path.join(linkDirOf((yield* ServerConfig.ServerConfig).stateDir), RECORD_FILE);
        fs.writeFileSync(record, JSON.stringify({ ...JSON.parse(fs.readFileSync(record, "utf8")), organization_id: "0b0e9a8e-5a4e-4a37-9f1a-6f1c2d3e4f50" }));
        yield* registry.refreshCloud;
        return { up, down, otherOrg: yield* on };
      }).pipe(Effect.scoped, Effect.provide(layer("mkt-last-good-org-"))),
    );
    expect(out.up).toContain(LINEAR);
    expect(out.down).toContain(LINEAR);
    expect(out.otherOrg).not.toContain(LINEAR);
  });

  it("shows an admin who connected personally the team's account apart from their own, and asks them to connect it", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        yield* signIn(cloud, "admin");
        cloud.state.connections.set("own", { connection_id: "own", resource: LINEAR_URL, status: "connected", token: "own-token", updated_at: new Date().toISOString() });
        const handlers = yield* handlersAt([]);
        const installed = yield* handlers["plugin.install"]({ request_id: "i1", id: LINEAR, scope: "team", policy: "default", connection: "shared" });
        const before = (yield* handlers["plugin.read"]({ id: LINEAR })).plugin.server_details;
        const started = yield* handlers["plugin.connect"]({ request_id: "c1", id: LINEAR, server: "linear" });
        yield* Effect.promise(() => fetch(started.authorization_url!).then((r) => r.text()));
        const after = (yield* handlers["plugin.read"]({ id: LINEAR })).plugin.server_details;
        // The admin removes the team's account; their own stays.
        yield* handlers["plugin.disconnect"]({ request_id: "d1", id: LINEAR, server: "linear" });
        const removed = (yield* handlers["plugin.read"]({ id: LINEAR })).plugin.server_details;
        return { needs: installed.needs_connect, before, after, removed };
      }).pipe(Effect.scoped, Effect.provide(layer("mkt-admin-own-"))),
    );
    expect(out.needs).toEqual([{ plugin_id: LINEAR, server: "linear", title: "Linear", auth: "oauth", shared: true }]);
    expect(out.before).toEqual([expect.objectContaining({ name: "linear", connected: false, shared: true })]);
    expect(out.after).toEqual([expect.objectContaining({ name: "linear", connected: true, held_by: "cloud", shared: true, shared_by: "Ada Admin" })]);
    expect(out.removed).toEqual([expect.objectContaining({ name: "linear", connected: false, shared: true })]);
    expect(cloud.state.starts).toEqual([{ resource: LINEAR_URL, owner: "org", plugin_id: LINEAR }]);
    expect([...cloud.state.connections.values()].map((r) => [r.connection_id, r.owner ?? "person"])).toEqual([["own", "person"]]);
  });

  it("offers a member's project install unless they name a policy (Cloud refuses their Default)", async () => {
    cloud.state.role = "member";
    const api = workRepo("member-policy", "https://github.com/acme/api.git");
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        yield* signIn(cloud, "member");
        const handlers = yield* handlersAt([{ id: "local-api", name: "api", path: api, repository: "github.com/acme/api" }]);
        yield* handlers["plugin.install"]({ request_id: "i1", id: NOTION, scope: "project", cwd: api });
        return yield* Effect.flip(handlers["plugin.install"]({ request_id: "i2", id: LINEAR, scope: "project", cwd: api, policy: "default" }));
      }).pipe(Effect.scoped, Effect.provide(layer("mkt-member-policy-"))),
    );
    expect(cloud.state.plugins.installs.map((i) => [i.plugin_id, i.policy])).toEqual([[NOTION, "available"]]);
    expect(out.message).toContain("Admin or Owner");
  });

  it("lets only an admin remove the team's account", async () => {
    cloud.state.connections.set("team", { connection_id: "team", resource: LINEAR_URL, owner: "org", plugin_id: LINEAR, status: "connected", token: "team-token", updated_at: new Date().toISOString() });
    cloud.state.plugins.installs.push({ scope: "team", plugin_id: LINEAR, policy: "default", connection: "shared" } as never);
    cloud.state.role = "member";
    const refused = await Effect.runPromise(
      Effect.gen(function* () {
        yield* signIn(cloud, "member");
        const handlers = yield* handlersAt([]);
        return yield* Effect.flip(handlers["plugin.disconnect"]({ request_id: "d1", id: LINEAR, server: "linear" }));
      }).pipe(Effect.scoped, Effect.provide(layer("mkt-member-disconnect-"))),
    );
    expect(refused.reason).toBe("forbidden");
    expect(cloud.state.connections.has("team")).toBe(true);
  });

  it("adds a git marketplace to the team with an install, only when asked; a folder never goes", async () => {
    const [bare] = makeSpaceRepo(path.join(tmp, "team-kit"), {
      ".claude-plugin/marketplace.json": JSON.stringify({ name: "kit", plugins: [{ name: "lint", source: "./lint" }] }),
      "lint/.claude-plugin/plugin.json": JSON.stringify({ name: "lint" }),
    });
    // The marketplace at an https URL (as a teammate fetches it, with or without .git), served from the bare repository.
    const served = path.join(tmp, "served");
    fs.mkdirSync(served);
    fs.symlinkSync(bare, path.join(served, "kit.git"));
    fs.symlinkSync(bare, path.join(served, "kit"));
    const gitEnv = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${served}/.insteadOf`, GIT_CONFIG_VALUE_0: "https://mkt.example.test/" };
    Object.assign(process.env, gitEnv);
    const folder = path.join(tmp, "folder-kit");
    writeTree(folder, { ".claude-plugin/plugin.json": JSON.stringify({ name: "solo" }) });
    try {
      const out = await Effect.runPromise(
        Effect.gen(function* () {
          yield* signIn(cloud, "admin");
          const registry = yield* PluginRegistry.PluginRegistry;
          const handlers = yield* handlersAt([]);
          yield* registry.addMarketplace("https://mkt.example.test/kit.git");
          yield* registry.addMarketplace(folder);
          const markets = (yield* handlers["marketplace.list"]({})).marketplaces.map((m) => [m.name, m.shareable]);
          const unasked = yield* Effect.flip(handlers["plugin.install"]({ request_id: "t1", id: "lint@kit", scope: "team" }));
          const fromFolder = yield* Effect.flip(handlers["plugin.install"]({ request_id: "t2", id: "solo@folder-kit", scope: "team", add_to_team: true }));
          yield* handlers["plugin.install"]({ request_id: "t3", id: "lint@kit", scope: "team", add_to_team: true });
          return { markets, unasked, fromFolder };
        }).pipe(Effect.scoped, Effect.provide(layer("mkt-add-to-team-"))),
      );
      expect(out.markets).toEqual(expect.arrayContaining([["caveman-curated", "yes"], ["kit", "add_to_team"], ["folder-kit", "no"]]));
      expect(out.unasked).toMatchObject({ reason: "invalid_params", message: expect.stringContaining("add it to the team and install") });
      expect(out.fromFolder.reason).toBe("invalid_params");
      expect(cloud.state.plugins.marketplaces).toEqual([{ name: "kit", repo: "https://mkt.example.test/kit", commit: expect.stringMatching(/^[0-9a-f]{40}$/) }]);
      expect(cloud.state.plugins.installs.map((i) => [i.plugin_id, i.scope])).toEqual([["lint@kit", "team"]]);
    } finally {
      for (const name of Object.keys(gitEnv)) delete process.env[name];
    }
  });
});

describe("a Cloud computer after the connector migration (profile v2)", () => {
  it("keeps This Mac's catalog installs and its own, drops what This Mac uninstalled, and trusts by digest", async () => {
    const mac = await Effect.runPromise(
      Effect.gen(function* () {
        const settings = yield* ServerSettingsModule.ServerSettingsService;
        const registry = yield* PluginRegistry.PluginRegistry;
        // Before plugins: Linear connected as a connector, and a folder marketplace of mine.
        const folder = path.join(tmp, "mine");
        writeTree(folder, { ".claude-plugin/plugin.json": JSON.stringify({ name: "notes" }) });
        yield* settings.updateSettings({ plugins: { servers: [{ name: "linear", url: LINEAR_URL, auth: "oauth", source: "connector", enabled: true }] } });
        yield* registry.known; // migrates the connector to the catalog plugin
        yield* registry.addMarketplace(folder);
        yield* registry.install({ id: "notes@mine", scope: "me" });
        const plugins = (yield* settings.getSettings).plugins;
        const config = yield* ServerConfig.ServerConfig;
        const built = buildProfile({ plugins, homes: setupHomes({}, tmp), home: tmp, scrubber: { scrub: (t: string) => t } as never, spacesDir: path.join(config.stateDir, "spaces") });
        return { plugins, built };
      }).pipe(Effect.scoped, Effect.provide(layer("mkt-profile-mac-"))),
    );
    expect(mac.plugins.servers).toEqual([]);
    expect(mac.plugins.installed.map((i) => i.id)).toEqual([LINEAR, "notes@mine"]);
    const profile = JSON.parse(JSON.stringify(mac.built.profile)) as Profile;
    expect(profile).toMatchObject({ version: 2, plugins: { installed: [{ id: LINEAR, enabled: true, cloud: "runs" }, { id: "notes@mine", cloud: "mac_only" }] } });
    expect(mac.built.items).toEqual(expect.arrayContaining([{ kind: "plugin", id: "notes@mine", cloud: "mac_only", reason: "only on This Mac: it is in a folder here" }]));

    const computer = await Effect.runPromise(
      Effect.gen(function* () {
        const settings = yield* ServerSettingsModule.ServerSettingsService;
        const registry = yield* PluginRegistry.PluginRegistry;
        // Installed on the computer itself before the pull.
        yield* registry.install({ id: "context7@caveman-curated", scope: "me" });
        const pull = (p: Profile) =>
          Effect.gen(function* () {
            const current = (yield* settings.getSettings).plugins;
            const applied = applyProfile({ profile: p, onPath: () => true, current });
            yield* settings.updateSettings({ plugins: applied.plugins });
            return { items: applied.items, on: (yield* registry.known).plugins.filter((x) => x.enabled).map((x) => x.plugin.id).sort() };
          });
        const first = yield* pull(profile);
        const again = yield* pull(profile);
        // This Mac uninstalled Linear.
        const second = yield* pull({ ...profile, plugins: { ...profile.plugins, installed: profile.plugins.installed!.filter((i) => i.id !== LINEAR) } });
        return { first, again, second, installed: (yield* settings.getSettings).plugins.installed };
      }).pipe(Effect.scoped, Effect.provide(layer("mkt-profile-computer-"))),
    );
    expect(computer.first.on).toEqual(["context7@caveman-curated", LINEAR]);
    expect(computer.first.items).toEqual(expect.arrayContaining([{ kind: "plugin", id: "notes@mine", cloud: "mac_only", reason: "only on This Mac: it is in a folder here" }]));
    // Pulling again changes nothing.
    expect(computer.again.on).toEqual(computer.first.on);
    expect(computer.second.on).toEqual(["context7@caveman-curated"]);
    expect(computer.installed.map((i) => [i.id, i.profile ?? false])).toEqual([["context7@caveman-curated", false]]);
  });
});

describe("a Cloud computer's profile pull", () => {
  it("takes a SHA-256 repository's commit, as Cloud does", () => {
    const commit = "c".repeat(64);
    const profile = { version: 2, plugins: { spaces: [{ url: "https://github.com/acme/kit.git", commit, enabled: true }], disabled: [], servers: [], installed: [{ id: "lint@kit", url: "https://github.com/acme/kit.git", commit, cloud: "runs" }], trustedHooks: [] } } as unknown as Profile;
    const applied = applyProfile({ profile, onPath: () => true });
    expect(applied.plugins.installed).toEqual([expect.objectContaining({ id: "lint@kit", commit })]);
    expect(applied.plugins.spaces).toEqual([expect.objectContaining({ commit })]);
  });
});

describe("my ~/.agents/skills", () => {
  it("reach Claude Agent (as a plugin, no links or key files) and the Caveman engine; skills Claude reads already are not copied twice", async () => {
    const home = path.join(tmp, "skills-home");
    writeTree(home, {
      ".agents/skills/release/SKILL.md": "---\nname: release\ndescription: Cut a release\n---\nShip it.\n",
      ".agents/skills/release/.env": "TOKEN=x\n",
      ".agents/skills/both/SKILL.md": "---\nname: both\ndescription: Linked into Claude's too\n---\n",
    });
    fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
    fs.symlinkSync(path.join(home, ".agents/skills/both"), path.join(home, ".claude/skills/both"));
    fs.symlinkSync("/etc/hosts", path.join(home, ".agents/skills/release/hosts"));
    // os.homedir() reads USERPROFILE on Windows, HOME elsewhere.
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
    process.env.HOME = home;
    if (process.platform === "win32") process.env.USERPROFILE = home;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      const out = await Effect.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionPlugins;
          const claude = yield* sessions.claudeAgent!(ThreadId.make("home-skills-claude"));
          const caveman = yield* sessions.caveman!(ThreadId.make("home-skills-caveman"), tmp);
          // Read before the scope ends: the state dir goes with it.
          const copies = claude.plugins.map((p) =>
            fs
              .readdirSync(p.path, { recursive: true })
              .map((f) => String(f).split(path.sep).join("/"))
              .filter((f) => f.startsWith("skills"))
              .sort(),
          );
          return { copies, roots: caveman.skillRoots };
        }).pipe(Effect.scoped, Effect.provide(layer("mkt-home-skills-"))),
      );
      expect(out.copies).toEqual([["skills", "skills/release", "skills/release/SKILL.md"]]);
      expect(out.roots).toContain(fs.realpathSync(path.join(home, ".agents", "skills")));
    } finally {
      for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value);
    }
  });
});
