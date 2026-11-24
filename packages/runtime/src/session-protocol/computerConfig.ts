// `.caveman/computer.toml` (docs/computer-config.md), and the subset of TOML
// the `.caveman` files use (tables, strings, arrays of strings, true and
// false), with every unknown key an error that names its line.

export const CONFIG_PATH = ".caveman/computer.toml";
export const SNAPSHOT_MARKER_PATH = ".caveman/snapshot.json";

export interface ComputerConfig {
  /**
   * `check`: the repo's own fast checks, run after setup and again on a computer restored from the snapshot (Cloud).
   * `inputs`: absent means the default lockfiles and pins (lifecycle.ts DEFAULT_SETUP_INPUTS); `[]` means none. The two stay distinct.
   */
  readonly setup: { readonly run?: string[]; readonly check?: string[]; readonly cache?: string[]; readonly inputs?: string[] };
  readonly run: { readonly command?: string; readonly ports?: string[] };
  readonly archive: { readonly run?: string[] };
  readonly env: Record<string, string>;
  /** name = version, e.g. postgres = "16": sidecars on a Cloud computer, from the install's allowlist. This Mac runs none; everywhere each name gets the workspace a port (portNames). */
  readonly services: Record<string, string>;
  readonly computer: { readonly size?: string };
  readonly idle: { readonly sleep_after?: string };
  /** Cloud and VPC only: the hosts the computer may reach through the install's egress proxy. This Mac ignores it. */
  readonly network: { readonly allow?: string[] };
  /** Cloud and VPC only: conda-forge packages installed without root before [setup].run, kept in the snapshot. This Mac ignores them. */
  readonly system: { readonly packages?: string[] };
  /**
   * A Cloud computer only, every boot (bootSteps.ts): `run` after the built-in fetch and install. `wait`: a chat's
   * first message waits for them. Not part of the snapshot's identity (setupIdentity). This Mac ignores the table.
   */
  readonly on_wake: { readonly run?: string[]; readonly wait?: boolean };
  /**
   * A Cloud computer only, every boot (bootSteps.ts): services and dev servers, which may keep running. `wait`: a
   * chat's first message waits until each has exited 0 or has been up for 2 s. Not part of the snapshot's identity.
   */
  readonly start: { readonly run?: string[]; readonly wait?: boolean };
}

/** At most this many [system] packages: each one is part of the snapshot and its identity. */
export const MAX_SYSTEM_PACKAGES = 64;
/** A conda-forge package name: lowercase, never a flag. */
const CONDA_NAME = /^[a-z0-9][a-z0-9._+-]{0,99}$/;

export class ComputerConfigError extends Error {}

export type TomlKind = "string" | "strings" | "boolean";
type Kind = TomlKind;
/** What a key of each kind must be, as an error says it. */
const KIND_SAYS: Record<Kind, string> = { string: "a string", strings: "an array of strings", boolean: "true or false" };
// "env" and "services" are open tables of strings: any key, a string value.
const KEYS: Record<string, Record<string, Kind> | "open"> = {
  setup: { run: "strings", check: "strings", cache: "strings", inputs: "strings" },
  run: { command: "string", ports: "strings" },
  archive: { run: "strings" },
  env: "open",
  services: "open",
  computer: { size: "string" },
  idle: { sleep_after: "string" },
  network: { allow: "strings" },
  system: { packages: "strings" },
  on_wake: { run: "strings", wait: "boolean" },
  start: { run: "strings", wait: "boolean" },
};

/** Reads one string literal at `text[i]`; returns the value and the index after it. */
function readString(text: string, i: number, line: number, file: string): [string, number] {
  const quote = text[i];
  if (quote === "'") {
    const end = text.indexOf("'", i + 1);
    if (end < 0) throw new ComputerConfigError(`${file}:${line}: unterminated string`);
    return [text.slice(i + 1, end), end + 1];
  }
  let out = "";
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j]!;
    if (c === '"') return [out, j + 1];
    if (c === "\n") break;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = text[++j];
    const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", b: "\b", f: "\f" };
    if (e !== undefined && simple[e] !== undefined) out += simple[e];
    else if (e === "u" || e === "U") {
      const len = e === "u" ? 4 : 8;
      out += String.fromCodePoint(Number.parseInt(text.slice(j + 1, j + 1 + len), 16));
      j += len;
    } else throw new ComputerConfigError(`${file}:${line}: bad escape \\${e ?? ""}`);
  }
  throw new ComputerConfigError(`${file}:${line}: unterminated string`);
}

/** One table of a parsed file: the line of its header and its values. */
export interface TomlTable {
  readonly line: number;
  readonly values: Record<string, string | string[] | boolean>;
  /** The line each key was set on. */
  readonly lines: Record<string, number>;
}

/**
 * Parses a `.caveman` TOML file into its tables, in file order. `keysOf`
 * names a table's keys and their kinds ("open": any key, a string value);
 * undefined makes the table unknown, an error. `example` is the table a key
 * outside any table is pointed to.
 */
export function parseTomlTables(
  text: string,
  file: string,
  keysOf: (table: string) => Record<string, TomlKind> | "open" | undefined,
  example: string,
): Map<string, TomlTable> {
  const tables = new Map<string, TomlTable>();
  let values: Record<string, string | string[] | boolean> | undefined;
  let lines: Record<string, number> | undefined;
  let table: string | undefined;
  let i = 0;
  let line = 1;
  const skipBlank = (multiline: boolean) => {
    while (i < text.length) {
      const c = text[i]!;
      if (c === " " || c === "\t" || c === "\r") i++;
      else if (c === "#") while (i < text.length && text[i] !== "\n") i++;
      else if (c === "\n" && multiline) {
        i++;
        line++;
      } else break;
    }
  };
  const fail = (message: string): never => {
    throw new ComputerConfigError(`${file}:${line}: ${message}`);
  };
  while (true) {
    skipBlank(true);
    if (i >= text.length) break;
    if (text[i] === "[") {
      const end = text.indexOf("]", i);
      if (end < 0 || text.slice(i, end).includes("\n")) fail("unterminated table header");
      const name = text.slice(i + 1, end).trim();
      if (keysOf(name) === undefined) fail(`unknown table [${name}]`);
      if (tables.has(name)) fail(`table [${name}] defined twice`);
      values = {};
      lines = {};
      tables.set(name, { line, values, lines });
      table = name;
      i = end + 1;
    } else {
      const match = /^([A-Za-z0-9_-]+)[ \t]*=[ \t]*/.exec(text.slice(i));
      if (match === null) fail("expected key = value");
      const key = match![1]!;
      const keyLine = line;
      i += match![0].length;
      if (table === undefined) fail(`unknown key "${key}" (keys belong in a table such as [${example}])`);
      const spec = keysOf(table!)!;
      if (key === "__proto__") fail(`unknown key "${table}.${key}"`);
      const kind: Kind | undefined = spec === "open" ? "string" : Object.hasOwn(spec, key) ? spec[key] : undefined;
      if (kind === undefined) fail(`unknown key "${table}.${key}"`);
      if (Object.hasOwn(values!, key)) fail(`key "${table}.${key}" set twice`);
      let value: string | string[] | boolean;
      const bare = /^(true|false)(?![A-Za-z0-9_-])/.exec(text.slice(i, i + 6));
      if (bare !== null) {
        value = bare[1] === "true";
        i += bare[1]!.length;
      } else if (text[i] === '"' || text[i] === "'") {
        [value, i] = readString(text, i, line, file);
      } else if (text[i] === "[") {
        i++;
        const items: string[] = [];
        while (true) {
          skipBlank(true);
          if (text[i] === "]") {
            i++;
            break;
          }
          if (text[i] !== '"' && text[i] !== "'") fail(`"${table}.${key}" must be an array of strings`);
          const [item, next] = readString(text, i, line, file);
          items.push(item);
          i = next;
          skipBlank(true);
          if (text[i] === ",") i++;
          else if (text[i] !== "]") fail(`expected , or ] in "${table}.${key}"`);
        }
        value = items;
      } else {
        line = keyLine;
        return fail(`"${table}.${key}" must be ${KIND_SAYS[kind!]}`);
      }
      if (kind !== (typeof value === "string" ? "string" : typeof value === "boolean" ? "boolean" : "strings")) {
        line = keyLine;
        fail(`"${table}.${key}" must be ${KIND_SAYS[kind!]}`);
      }
      values![key] = value;
      lines![key] = keyLine;
    }
    skipBlank(false);
    if (i < text.length && text[i] !== "\n") fail("unexpected text after value");
  }
  return tables;
}

/** Parses computer.toml. Empty text is the empty config. */
export function parseComputerConfig(text: string): ComputerConfig {
  const config = { setup: {}, run: {}, archive: {}, env: {}, services: {}, computer: {}, idle: {}, network: {}, system: {}, on_wake: {}, start: {} } as Record<string, Record<string, unknown>>;
  const tables = parseTomlTables(text, CONFIG_PATH, (name) => (Object.hasOwn(KEYS, name) ? KEYS[name] : undefined), "setup");
  for (const [name, table] of tables) config[name] = table.values;
  const system = tables.get("system");
  const packages = system?.values.packages as string[] | undefined;
  if (packages !== undefined) {
    const at = `${CONFIG_PATH}:${system!.lines.packages}`;
    if (packages.length > MAX_SYSTEM_PACKAGES) throw new ComputerConfigError(`${at}: [system] packages lists ${packages.length}; at most ${MAX_SYSTEM_PACKAGES}`);
    const bad = packages.find((name) => !CONDA_NAME.test(name));
    if (bad !== undefined) throw new ComputerConfigError(`${at}: [system] package ${JSON.stringify(bad)} is not a conda-forge name, such as "libvips"`);
  }
  const size = config.computer!.size as string | undefined;
  if (size !== undefined && !/^[1-9][0-9]?x[1-9][0-9]{0,3}$/.test(size)) {
    throw new ComputerConfigError(`${CONFIG_PATH}: [computer] size "${size}" is not <vCPU>x<GiB>, such as 4x16`);
  }
  return config as unknown as ComputerConfig;
}

/**
 * A workspace's short name on what it shares with the others on its computer: its database, its Compose project,
 * its browser session, its temp folder. `ws_` and the first 8 letters and digits of its id, lowercase.
 */
export const workspaceTag = (id: string) => `ws_${id.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8)}`;

/** The names a workspace gets a port for: [run].ports, then each [services] name not among them (a stack it runs itself). */
export const portNames = (config: ComputerConfig | null): string[] => {
  const run = config?.run.ports ?? [];
  return [...run, ...Object.keys(config?.services ?? {}).filter((name) => !run.includes(name))];
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** A service URL's family (postgres, redis) and where it points; undefined for any other value. */
const serviceAddress = (value: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  // postgresql+asyncpg:// and the like name a driver, not another service.
  const family = /^postgres(ql)?(\+[a-z0-9]+)?:$/.test(url.protocol) ? "postgres" : url.protocol === "redis:" ? "redis" : undefined;
  if (family === undefined || url.hostname === "") return undefined;
  const loopback = LOOPBACK.has(url.hostname.toLowerCase());
  return { family, host: loopback ? "127.0.0.1" : url.hostname.toLowerCase(), port: url.port || (family === "postgres" ? "5432" : "6379"), loopback, url };
};
/** `host:port` of a service URL (every loopback name is 127.0.0.1); undefined when it is not one. */
export const serviceAt = (value: string) => {
  const address = serviceAddress(value);
  return address && `${address.host}:${address.port}`;
};
/** Whether a service URL points at this computer itself. */
export const onLoopback = (value: string) => serviceAddress(value)?.loopback === true;
/** `value` when it is no URL at the service `shared` names (same family, host and port); else that URL at `own`'s database or index, its own user and options kept. */
const atOwn = (value: string, shared: string, own: string) => {
  const address = serviceAddress(value);
  const service = serviceAddress(shared);
  if (address === undefined || service === undefined || address.family !== service.family || address.host !== service.host || address.port !== service.port) return value;
  address.url.pathname = new URL(own).pathname;
  return address.url.toString();
};

/**
 * What makes a workspace's processes its own on a computer that holds many (workspaceIsolation.ts works it out, and
 * every child of the workspace gets its environment through there).
 */
export interface WorkspaceIsolation {
  readonly id: string;
  readonly ports: Readonly<Record<string, number>>;
  /** Its temp folder and its browser profile, both there when a child starts. */
  readonly tmpDir?: string;
  readonly browserProfile?: string;
  /**
   * Each declared service this computer runs, by name: the address every workspace shares, and this one's own URL
   * there (its database, its index). No `own`: it could not have one.
   */
  readonly services?: Readonly<Record<string, { readonly shared: string; readonly own?: string }>>;
}

/**
 * Environment for setup, run, archive, terminals and tool processes: [env], then what the runtime sets for the
 * workspace, which wins. An [env] URL at a declared service's shared address goes to the workspace's own database or
 * index, so a repository that writes DATABASE_URL at the shared one is kept apart without changing its file.
 */
export function workspaceEnv(config: ComputerConfig | null, isolation: WorkspaceIsolation): Record<string, string> {
  const services = Object.entries(isolation.services ?? {});
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(config?.env ?? {})) env[name] = services.reduce((v, [, service]) => (service.own === undefined ? v : atOwn(v, service.shared, service.own)), value);
  const tag = workspaceTag(isolation.id);
  env.CAVEMAN_WORKSPACE_ID = isolation.id;
  env.COMPOSE_PROJECT_NAME = tag;
  env.AGENT_BROWSER_SESSION = tag;
  const named = portNames(config);
  // CAVEMAN_PORT and PORT are the first [run] port, never a service's. Without [run].ports, whatever else the workspace holds (its preview's).
  const run = config?.run.ports ?? Object.keys(isolation.ports).filter((name) => !named.includes(name));
  let first: string | undefined;
  for (const name of new Set([...run, ...named])) {
    const port = isolation.ports[name];
    if (port === undefined) continue;
    env[`CAVEMAN_PORT_${name.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`] = String(port);
    if (run.includes(name)) first ??= String(port);
  }
  if (first !== undefined) env.CAVEMAN_PORT = env.PORT = first;
  if (isolation.tmpDir !== undefined) env.TMPDIR = isolation.tmpDir;
  if (isolation.browserProfile !== undefined) env.CAVEMAN_BROWSER_PROFILE = env.AGENT_BROWSER_PROFILE = isolation.browserProfile;
  // One it could not have is set empty, so the shared address the computer's own environment may name never stands in for it.
  for (const [name, service] of services) env[`CAVEMAN_SERVICE_${name.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}_URL`] = service.own ?? "";
  return env;
}

/**
 * Environment for a command that runs for a clone itself and no workspace: a Cloud computer's on_wake and start
 * commands, and setup run again at the clone root (bootSteps.ts). What a snapshot build's setup gets: [env] as
 * written, so a service URL stays at the address every workspace shares, and [run].ports numbered from 3000 in
 * order. Nothing that names a workspace, so a `docker compose` stack started there is no chat's own.
 */
export function sharedEnv(config: ComputerConfig | null): Record<string, string> {
  const ports = Object.fromEntries((config?.run.ports ?? []).map((name, i) => [name, 3000 + i]));
  const { CAVEMAN_WORKSPACE_ID: _id, COMPOSE_PROJECT_NAME: _project, AGENT_BROWSER_SESSION: _session, ...env } = workspaceEnv(config, { id: "", ports });
  return env;
}
