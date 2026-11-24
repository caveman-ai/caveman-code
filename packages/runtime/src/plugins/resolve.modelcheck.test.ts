// Plugins get no ambient secrets (.claude/skills/secret-containment): resolveBundle runs over every generated MCP
// server config with a broker that grants whatever it is asked, as a canary per name. A brokered value may reach only
// the names a connector declares, and only as a header, the 0600 credentials file or (brokeredInEnv) the launcher's
// prefixed env; never a command, argv, URL or cwd. Every stdio server and command hook starts through the launcher
// argv with the loader variables cleared; hook strings are re-parsed by /bin/sh to prove it.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { PluginMcpServer } from "@caveman-app/engine-core/server/SessionPlugins";
import { sequences } from "@caveman-app/model-check";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { afterAll, describe, expect, it } from "vitest";

import { CredentialBroker, type CredentialRequest } from "./CredentialBroker.ts";
import type { McpServerConfig } from "./format.ts";
import type { LoadedPlugin } from "./load.ts";
import {
  BASE_ENV_ALLOWLIST,
  type LaunchPolicy,
  PLUGIN_ENV_PREFIX,
  resolveBundle,
  SANDBOX_LAUNCHER,
} from "./resolve.ts";

const POSIX = process.platform !== "win32";
/** resolve.ts's LOADER_ENV: what `/usr/bin/env -u` must clear before the launcher's node starts. */
const LOADER_ENV = [
  "NODE_OPTIONS",
  "NODE_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
];
const launcherPrefix = (policy: LaunchPolicy) => [
  "/usr/bin/env",
  ...LOADER_ENV.flatMap((name) => ["-u", name]),
  process.execPath,
  "--disable-sigusr1",
  SANDBOX_LAUNCHER,
  JSON.stringify(policy),
];

const SERVER = "srv";
/** Names by how the plugin declares them (contributes.connectors), plus PATH, which the base allowlist passes through. */
const NAMES = ["GRANTED", "ALL_SERVERS", "OTHER_SERVER", "UNDECLARED", "PATH"] as const;
type Name = (typeof NAMES)[number];
const CONNECTORS = [
  { id: "c1", title: "for srv", server: SERVER, credentials: ["GRANTED"] },
  { id: "c2", title: "for every server", credentials: ["ALL_SERVERS"] },
  { id: "c3", title: "for another server", server: "other", credentials: ["OTHER_SERVER"] },
];
/** The spec of who may be asked: a connector for that server, or one without a server. */
const declaredFor = (server: string, name: string) =>
  CONNECTORS.some(
    (c) => (c.server === undefined || c.server === server) && c.credentials.includes(name),
  );
const canary = (server: string, name: string) => `brk-${name}-${server}-Zx9q`;
const canaries = (server: string) => NAMES.map((name) => canary(server, name));

const SLOTS = { stdio: ["command", "args", "cwd", "env"], http: ["url", "headers"] } as const;
type Slot = (typeof SLOTS)["stdio" | "http"][number];
const FORMS = [
  (n: string) => `\${${n}}`,
  (n: string) => `\${${n}:-fallback}`,
  (n: string) => `pre-\${${n}}-post`,
] as const;

const ROOT = "/plugins/it's a root";
const config = (
  kind: "stdio" | "http",
  refs: ReadonlyArray<readonly [Slot, Name, number]>,
): McpServerConfig => {
  const at = (slot: Slot) =>
    refs.filter(([s]) => s === slot).map(([, name, form]) => FORMS[form]!(name));
  if (kind === "http") {
    return {
      type: "http",
      url: ["https://mcp.example.com/${CLAUDE_PLUGIN_ROOT}", ...at("url")].join("/"),
      headers: Object.fromEntries(at("headers").map((v, i) => [`X-H${i}`, v])),
    };
  }
  return {
    command: at("command")[0] ?? "${CLAUDE_PLUGIN_ROOT}/server",
    args: ["--root", "${CLAUDE_PLUGIN_ROOT}", ...at("args")],
    ...(at("cwd").length > 0 ? { cwd: at("cwd")[0]! } : {}),
    env: {
      PLAIN: "x",
      NODE_OPTIONS: "--require=/evil.js",
      ...Object.fromEntries(at("env").map((v, i) => [`E${i}`, v])),
    },
  };
};

const plugin = (
  servers: Record<string, McpServerConfig>,
  hooks: LoadedPlugin["hooks"] = {},
): LoadedPlugin =>
  ({
    id: "p@space",
    name: "p",
    space: "space",
    root: ROOT,
    skills: [],
    commands: [],
    agents: [],
    hooks,
    mcpServers: servers,
    lspServers: {},
    monitors: [],
    rules: [],
    contributes: { connectors: CONNECTORS },
    manifest: { name: "p" },
    interface: {},
    problems: [],
    origin: { url: "https://example.com/space.git", commit: "c0ffee" },
  }) as unknown as LoadedPlugin;

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "secret-containment-plugins-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const resolveWith = async (plugins: ReadonlyArray<LoadedPlugin>, brokeredInEnv: boolean) => {
  const asked: Array<CredentialRequest> = [];
  const broker = Layer.succeed(CredentialBroker, {
    resolve: (request) =>
      Effect.sync(
        () => (
          asked.push(request),
          Option.some(Redacted.make(canary(request.server, request.name)))
        ),
      ),
  });
  const bundle = await Effect.runPromise(
    resolveBundle(plugins, { credentialsDir: path.join(tmp, "credentials"), brokeredInEnv }).pipe(
      Effect.provide(broker),
    ),
  );
  return { bundle, asked };
};

const holdsAny = (text: string, values: ReadonlyArray<string>) =>
  values.find((v) => text.includes(v));

/** Every property of one server as the bundle has it, against the config it came from. */
const checkServer = (
  where: string,
  configOf: McpServerConfig,
  server: PluginMcpServer,
  brokeredInEnv: boolean,
) => {
  const all = canaries(SERVER);
  const granted = NAMES.filter((n) => n !== "PATH" && declaredFor(SERVER, n)).map((n) =>
    canary(SERVER, n),
  );
  const outside = {
    command: "command" in server ? server.command : undefined,
    args: "args" in server ? server.args : undefined,
    url: "url" in server ? server.url : undefined,
    cwd: "cwd" in server ? server.cwd : undefined,
  };
  expect(
    holdsAny(JSON.stringify(outside), all),
    `${where}: a brokered value in command, args, url or cwd`,
  ).toBeUndefined();
  if (server.type !== "stdio") {
    for (const [header, value] of Object.entries(server.headers ?? {})) {
      const leaked = holdsAny(value, all);
      if (leaked !== undefined)
        expect(granted, `${where}: header ${header} carries an undeclared value`).toContain(leaked);
    }
    return;
  }
  expect(server.command, `${where}: starts through env -u`).toBe("/usr/bin/env");
  const policyAt = server.args.indexOf(SANDBOX_LAUNCHER) + 1;
  const policy = JSON.parse(server.args[policyAt]!) as LaunchPolicy;
  expect(
    [server.command, ...server.args.slice(0, policyAt + 1)],
    `${where}: the launcher argv, loader variables cleared`,
  ).toEqual(launcherPrefix(policy));
  expect(
    holdsAny(server.args[policyAt]!, all),
    `${where}: a value in the launch policy`,
  ).toBeUndefined();
  expect(
    policy.keep.every((name) => BASE_ENV_ALLOWLIST.includes(name)),
    `${where}: the policy passes through only allowlisted names`,
  ).toBe(true);
  for (const [name, value] of Object.entries(server.env ?? {})) {
    expect(
      name.startsWith(PLUGIN_ENV_PREFIX),
      `${where}: env ${name} would configure the launcher itself`,
    ).toBe(true);
    const leaked = holdsAny(value, all);
    if (leaked === undefined) continue;
    expect(
      brokeredInEnv,
      `${where}: ${name} carries a brokered value outside the credentials file`,
    ).toBe(true);
    expect(granted, `${where}: ${name} carries an undeclared value`).toContain(leaked);
  }
  const stdio = configOf as Extract<McpServerConfig, { command: string }>;
  const brokeredKeys = Object.entries(stdio.env ?? {}).filter(([, v]) =>
    NAMES.some((n) => n !== "PATH" && declaredFor(SERVER, n) && v.includes(`\${${n}`)),
  );
  if (brokeredInEnv || brokeredKeys.length === 0) {
    expect(
      policy.secrets,
      `${where}: a credentials file with nothing brokered for it`,
    ).toBeUndefined();
    return;
  }
  const file = JSON.parse(fs.readFileSync(policy.secrets!, "utf8")) as Record<string, string>;
  expect(
    Object.keys(file).sort(),
    `${where}: the credentials file holds exactly the brokered variables`,
  ).toEqual(brokeredKeys.map(([k]) => k).sort());
  for (const value of Object.values(file))
    expect(holdsAny(value, granted), `${where}: the file holds a declared value`).toBeDefined();
  if (POSIX)
    expect(
      fs.statSync(policy.secrets!).mode & 0o777,
      `${where}: the credentials file is 0600`,
    ).toBe(0o600);
};

describe.skipIf(!POSIX)(
  "resolveBundle: brokered values reach only declared names, and only the places made for them",
  () => {
    it("every server config of one or two references, every slot, name, form and delivery mode (exhaustive)", async () => {
      let runs = 0;
      for (const brokeredInEnv of [false, true]) {
        for (const kind of ["stdio", "http"] as const) {
          const refs = SLOTS[kind].flatMap((slot) =>
            NAMES.flatMap((name) => FORMS.map((_, form) => [slot, name, form] as const)),
          );
          for (const chosen of sequences(refs, 2)) {
            if (chosen.length === 2 && (chosen[0]![2] !== 0 || chosen[1]![2] !== 0)) continue;
            const configOf = config(kind, chosen);
            const where = `${kind} ${JSON.stringify(configOf)} ${brokeredInEnv ? "brokeredInEnv" : "credentials file"}`;
            const { bundle, asked } = await resolveWith(
              [
                plugin({
                  [SERVER]: configOf,
                  other: {
                    type: "http",
                    url: "https://other.example.com/${OTHER_SERVER}",
                    headers: { A: "${OTHER_SERVER}", B: "${GRANTED}" },
                  },
                }),
              ],
              brokeredInEnv,
            );
            for (const request of asked)
              expect(
                declaredFor(request.server, request.name),
                `${where}: asked the broker for ${request.server}:${request.name}`,
              ).toBe(true);
            checkServer(where, configOf, bundle.mcpServers[`p__${SERVER}`]!, brokeredInEnv);
            const other = bundle.mcpServers["p__other"]!;
            expect(
              holdsAny(JSON.stringify(other), [
                canary("other", "GRANTED"),
                canary(SERVER, "OTHER_SERVER"),
              ]),
              `${where}: another server got srv's credential`,
            ).toBeUndefined();
            runs++;
          }
        }
      }
      console.log(
        `[secret-containment] resolveBundle: ${runs} bundles, exhaustive to two references per server`,
      );
    });

    it("the launched child sees a brokered value only under its declared name, and no loader variable (real launcher)", async () => {
      for (const brokeredInEnv of [false, true]) {
        const configOf: McpServerConfig = {
          command: "/usr/bin/env",
          env: {
            TOKEN: "${GRANTED}",
            FALLBACK: "${UNDECLARED:-none}",
            NODE_OPTIONS: "--require=/evil.js",
          },
        };
        const { bundle } = await resolveWith([plugin({ [SERVER]: configOf })], brokeredInEnv);
        const server = bundle.mcpServers[`p__${SERVER}`] as Extract<
          PluginMcpServer,
          { type: "stdio" }
        >;
        const engineEnv = {
          ...process.env,
          ...server.env,
          NODE_OPTIONS: "--require=/evil.js",
          DYLD_INSERT_LIBRARIES: "/evil.dylib",
          ENGINE_SECRET: canary(SERVER, "UNDECLARED"),
        };
        const child = spawnSync(server.command, server.args, {
          env: engineEnv,
          encoding: "utf8",
          timeout: 30_000,
        });
        expect(child.status, child.stderr).toBe(0);
        const seen = Object.fromEntries(
          child.stdout
            .trim()
            .split("\n")
            .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
        );
        expect(seen.TOKEN, "the declared variable carries its brokered value").toBe(
          canary(SERVER, "GRANTED"),
        );
        expect(seen.FALLBACK, "an undeclared name is never asked for: its default").toBe("none");
        expect(seen.ENGINE_SECRET, "the engine's own env does not pass through").toBeUndefined();
        expect(
          Object.entries(seen).filter(
            ([name, value]) => name !== "TOKEN" && holdsAny(value, canaries(SERVER)),
          ),
          "a brokered value under another name",
        ).toEqual([]);
        for (const name of Object.keys(seen))
          expect(
            name.startsWith(PLUGIN_ENV_PREFIX),
            `${name} reached the child still prefixed`,
          ).toBe(false);
      }
    });
  },
);

describe.skipIf(!POSIX)(
  "command hooks: /bin/sh reads each one as the launcher argv, whatever the hook's text",
  () => {
    const COMMANDS = [
      "echo hi",
      "${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh --flag",
      `echo "it's" 'quoted' \`echo BROKE-OUT\` $(echo BROKE-OUT) $HOME`,
      "printf 'a\\nb'\nexit 0",
      "'; echo BROKE-OUT; '",
      "a\\'b \\\\ \"'\"",
    ];
    const ROOTS = ["/plugins/p", ROOT, "/plugins/$(echo BROKE-OUT)"];

    it("shell and exec forms over every command and plugin root (exhaustive, one sh run)", async () => {
      const expected: Array<ReadonlyArray<string>> = [];
      const strings: Array<string> = [];
      for (const root of ROOTS) {
        const hooks = {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                ...COMMANDS.map((command) => ({ type: "command", command })),
                { type: "command", command: "${CLAUDE_PLUGIN_ROOT}/bin/x", args: COMMANDS },
              ],
            },
          ],
        };
        const { bundle } = await resolveWith([{ ...plugin({}, hooks), root }], false);
        const prefix = launcherPrefix(bundle.hookPolicy);
        const withRoot = (s: string) => s.replaceAll("${CLAUDE_PLUGIN_ROOT}", root);
        expected.push(
          ...COMMANDS.map((command) => [...prefix, "/bin/sh", "-c", withRoot(command)]),
          [...prefix, withRoot("${CLAUDE_PLUGIN_ROOT}/bin/x"), ...COMMANDS.map(withRoot)],
        );
        strings.push(...bundle.hooks.map((hook) => hook.hook.command as string));
      }
      const script = [
        "__argv() { for a in \"$@\"; do printf '%s\\0' \"$a\"; done; printf '\\001\\000'; }",
        ...strings.map((s) => `__argv ${s}`),
      ].join("\n");
      const parsed = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" })
        .stdout.split("\u0001\u0000")
        .slice(0, -1)
        .map((argv) => argv.split("\u0000").slice(0, -1));
      expect(parsed.length, "every hook parsed").toBe(expected.length);
      parsed.forEach((argv, i) => expect(argv, `hook ${i}: ${strings[i]}`).toEqual(expected[i]));
      console.log(
        `[secret-containment] command hooks: ${parsed.length} hook strings re-parsed by /bin/sh`,
      );
    });
  },
);
