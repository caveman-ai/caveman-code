// environment.draft: the first `.caveman/computer.toml` for a repo's Cloud setup, made here with no
// network and no model (design E1). It reads the repo (lockfiles, version pins, its own checks), its
// CI, a devcontainer and compose files, and what this Mac actually runs: the tool
// versions the login shell resolves in the repo, the services listening here, and the env var names
// in its git-ignored .env files. Names and versions only. A value never leaves a file read, and
// nothing outside the repo is named in the result. The Cloud build proves the draft; this only seeds it.
// Compose services map onto the install's own services by image, and apt-get lines onto conda-forge
// [system] packages (docs/ D7, D8); what maps onto nothing is named.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { isReservedEnvName } from "@caveman-app/session-protocol";
import { findGitBash } from "@caveman-app/shared/posixShell";
import { parse as parseYaml } from "yaml";

import { openNoFollowSync } from "../openNoFollow.ts";
import { MAX_SYSTEM_PACKAGES } from "./computerConfig.ts";

export type EvidenceSource = "repo" | "ci" | "devcontainer" | "mac";
export interface DraftEvidence {
  readonly source: EvidenceSource;
  readonly note: string;
}
export interface EnvironmentDraft {
  readonly config: string;
  readonly evidence: DraftEvidence[];
  /** Env var names the computer reads that a person supplies (Values); never ones its own services satisfy. */
  readonly secret_names: string[];
}

export const TOOLS = ["node", "pnpm", "yarn", "bun", "deno", "python", "go", "rust", "ruby", "java"] as const;
export type Tool = (typeof TOOLS)[number];

/** What this Mac knows that a clone doesn't (readMacSeed). */
export interface MacSeed {
  /** Versions the login shell resolves with cwd = the repo, so nvm, fnm, mise, asdf and direnv answer as the person sees them. */
  readonly versions: Readonly<Partial<Record<Tool, string>>>;
  /** Services listening here (postgres, redis, mysql) and their major version, "" when unknown. */
  readonly services: Readonly<Record<string, string>>;
  /** Names in the repo's git-ignored top-level .env* files. */
  readonly env_names: ReadonlyArray<string>;
}

export interface DraftOptions {
  readonly seed?: MacSeed;
  /** The install's service allowlist (Environment.services); default the chart's. */
  readonly offered?: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Whether to `git grep` the tracked code for the env names it reads (default yes); a manifests-only checkout has no code. */
  readonly readCode?: boolean;
}

export const DEFAULT_OFFERED: Readonly<Record<string, ReadonlyArray<string>>> = { postgres: ["15", "16", "17"], redis: ["7"] };

const PG = "postgres://postgres:postgres@127.0.0.1:5432/postgres";
/**
 * Each service's loopback address under the env names apps read it from. [env] gets a name only when the repo
 * reads it; a name two services share (DATABASE_URL) goes to the first in this order.
 */
export const SERVICE_ENV: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  postgres: { DATABASE_URL: PG, DIRECT_URL: PG, POSTGRES_URL: PG, POSTGRES_PRISMA_URL: PG, POSTGRES_URL_NON_POOLING: PG, PG_URL: PG },
  mysql: { DATABASE_URL: "mysql://root:mysql@127.0.0.1:3306/mysql", MYSQL_URL: "mysql://root:mysql@127.0.0.1:3306/mysql" },
  mariadb: { DATABASE_URL: "mysql://root:mariadb@127.0.0.1:3306/mysql", MARIADB_URL: "mysql://root:mariadb@127.0.0.1:3306/mysql", MYSQL_URL: "mysql://root:mariadb@127.0.0.1:3306/mysql" },
  mongodb: { MONGODB_URI: "mongodb://127.0.0.1:27017", MONGODB_URL: "mongodb://127.0.0.1:27017", MONGO_URL: "mongodb://127.0.0.1:27017", MONGO_URI: "mongodb://127.0.0.1:27017", DATABASE_URL: "mongodb://127.0.0.1:27017" },
  redis: { REDIS_URL: "redis://127.0.0.1:6379", VALKEY_URL: "redis://127.0.0.1:6379" },
  // MinIO's fixed local keys, never a cloud's: only MinIO's own names get them, not AWS_*.
  minio: {
    S3_ENDPOINT: "http://127.0.0.1:9000",
    S3_ENDPOINT_URL: "http://127.0.0.1:9000",
    AWS_ENDPOINT_URL: "http://127.0.0.1:9000",
    AWS_ENDPOINT_URL_S3: "http://127.0.0.1:9000",
    MINIO_URL: "http://127.0.0.1:9000",
    MINIO_ROOT_USER: "minioadmin",
    MINIO_ROOT_PASSWORD: "minioadmin",
    MINIO_ACCESS_KEY: "minioadmin",
    MINIO_SECRET_KEY: "minioadmin",
  },
  // No install offers OpenSearch today (it doesn't run under gVisor); kept for one that does.
  opensearch: { OPENSEARCH_URL: "http://127.0.0.1:9200", OPENSEARCH_NODE: "http://127.0.0.1:9200", ELASTICSEARCH_URL: "http://127.0.0.1:9200", ELASTICSEARCH_NODE: "http://127.0.0.1:9200", ELASTIC_URL: "http://127.0.0.1:9200" },
  kafka: { KAFKA_BROKERS: "127.0.0.1:9092", KAFKA_BROKER: "127.0.0.1:9092", KAFKA_BOOTSTRAP_SERVERS: "127.0.0.1:9092", KAFKA_URL: "127.0.0.1:9092", REDPANDA_BROKERS: "127.0.0.1:9092" },
  mailpit: {
    SMTP_URL: "smtp://127.0.0.1:1025",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: "1025",
    MAIL_HOST: "127.0.0.1",
    MAIL_PORT: "1025",
    EMAIL_HOST: "127.0.0.1",
    EMAIL_PORT: "1025",
    MAILPIT_URL: "http://127.0.0.1:8025",
  },
};

const LABEL: Record<Tool, string> = { node: "Node", pnpm: "pnpm", yarn: "Yarn", bun: "Bun", deno: "Deno", python: "Python", go: "Go", rust: "Rust", ruby: "Ruby", java: "Java" };
const SERVICE_LABEL: Record<string, string> = {
  postgres: "Postgres",
  redis: "Redis",
  mysql: "MySQL",
  mariadb: "MariaDB",
  mongodb: "MongoDB",
  minio: "MinIO",
  opensearch: "OpenSearch",
  kafka: "Kafka",
  mailpit: "Mailpit",
};
const MAX_FILE = 1024 * 1024;

/** A repo file's text; a symlink, a non-file or a big file reads as absent, so nothing outside the repo is ever read. */
function readRepoFile(root: string, rel: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openNoFollowSync(path.join(root, rel), fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE) return undefined;
    return fs.readFileSync(fd, "utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
const listDir = (root: string, rel: string): string[] => {
  try {
    return fs.readdirSync(path.join(root, rel)).sort();
  } catch {
    return [];
  }
};
const json = (text: string | undefined): Record<string, unknown> | undefined => {
  if (text === undefined) return undefined;
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};
const yamlDoc = (text: string | undefined): Record<string, unknown> | undefined => {
  if (text === undefined) return undefined;
  try {
    const v = parseYaml(text) as unknown;
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};
const record = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : undefined);

/** JSONC (devcontainer.json): comments out, strings kept, trailing commas dropped. */
export function stripJsonComments(text: string): string {
  let out = "";
  /** Where in `out` the last comma outside a string sits, until anything but blanks and comments follows it. */
  let comma = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
      comma = -1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else {
      if ((c === "}" || c === "]") && comma >= 0) out = out.slice(0, comma) + out.slice(comma + 1);
      if (c === ",") comma = out.length;
      else if (!/\s/.test(c)) comma = -1;
      out += c;
    }
  }
  return out;
}

/** A version a mise line can name: "v22.11.0" → "22.11.0", "lts/*" → "lts"; undefined for a range or an expression. */
export function cleanVersion(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().replace(/^v(?=\d)/, "");
  if (v === "") return undefined;
  if (/^lts(\/.*)?$/i.test(v)) return "lts";
  if (/^(stable|latest|nightly|beta)$/.test(v)) return v;
  return /^\d+(\.\d+){0,2}$/.test(v) ? v : undefined;
}

/** "^20.1", ">=18", "20.x", "~3.11" → its major (and minor when given exactly enough); undefined for anything looser. */
const rangeFloor = (raw: string | undefined): string | undefined => {
  const m = raw === undefined ? null : /^\s*(?:\^|~|>=|=)?\s*v?(\d+)(?:\.(\d+|x))?/.exec(raw);
  return m ? m[1] : undefined;
};

const versionFrom = (text: string | undefined): string | undefined => /(\d+\.\d+(?:\.\d+)?)/.exec(text ?? "")?.[1];
const major = (v: string) => v.split(".")[0]!;

// ---------------------------------------------------------------- the draft

interface Pick {
  version: string;
  source: EvidenceSource;
  from: string;
}

/** Drafts computer.toml for the checkout at `root` (its top level). Reads only files inside it, plus `git grep` there. */
export async function draftEnvironment(root: string, options: DraftOptions = {}): Promise<EnvironmentDraft> {
  const evidence: DraftEvidence[] = [];
  const seed = options.seed;
  const offered = options.offered ?? DEFAULT_OFFERED;
  const run: string[] = [];
  const inputs = new Set<string>();
  const has = (rel: string) => readRepoFile(root, rel) !== undefined;
  const add = (rel: string) => {
    if (has(rel)) inputs.add(rel);
  };

  // Versions, best first: the repo's own pins, then CI, then a devcontainer, then this Mac, then package.json engines.
  const picks = new Map<Tool, Pick>();
  const offer = (tool: Tool, version: string | undefined, source: EvidenceSource, from: string) => {
    if (version !== undefined && !picks.has(tool)) picks.set(tool, { version, source, from });
  };

  // ---- the repo
  const pkg = json(readRepoFile(root, "package.json"));
  const { pm, pmField, lock } = packageManager(root, pkg);
  const miseFiles = ["mise.toml", ".mise.toml", ".tool-versions", ".config/mise.toml", "mise/config.toml"].filter(has);
  const pinnedByMise = new Set<string>();
  const rawPins = new Map<string, string>();
  for (const file of miseFiles) {
    const text = readRepoFile(root, file)!;
    const names = file.endsWith(".tool-versions")
      ? [...text.matchAll(/^\s*([a-z][\w-]*)\s+\S/gm)].map((m) => m[1]!)
      : [...(/^\s*\[tools\]\s*$([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/m.exec(text)?.[1] ?? "").matchAll(/^\s*"?([a-z][\w:/-]*)"?\s*=/gm)].map((m) => m[1]!.replace(/^.*[:/]/, ""));
    // asdf's names for mise's.
    for (const name of names) {
      rawPins.set(name === "nodejs" ? "node" : name === "golang" ? "go" : name === "postgresql" ? "postgres" : name, name);
      pinnedByMise.add(name === "nodejs" ? "node" : name === "golang" ? "go" : name === "postgresql" ? "postgres" : name);
    }
    inputs.add(file);
  }
  // A database pinned as a tool would build from source; it runs as a service instead.
  const pinnedServices: string[] = [...pinnedByMise].filter((t) => t === "postgres" || t === "redis" || t === "mysql");
  const miseInstall = pinnedServices.length === 0 ? "mise install" : `mise install ${[...pinnedByMise].filter((t) => !pinnedServices.includes(t)).map((t) => rawPins.get(t) ?? t).join(" ")}`;
  if (miseFiles.length > 0) evidence.push({ source: "repo", note: `Tool versions pinned in ${miseFiles.join(", ")}: ${miseInstall}` });
  if (pinnedServices.length > 0) evidence.push({ source: "repo", note: `${joinAnd(pinnedServices.map((n) => SERVICE_LABEL[n] ?? n))} from ${miseFiles.join(", ")} would build from source, so it's left to [services]` });

  const pinFile = (tool: Tool, rel: string, parse: (text: string) => string | undefined = (t) => cleanVersion(t.split("\n")[0])) => {
    const text = readRepoFile(root, rel);
    if (text === undefined) return;
    const v = parse(text);
    if (v !== undefined) {
      offer(tool, v, "repo", rel);
      inputs.add(rel);
    }
  };
  if (pkg) {
    pinFile("node", ".nvmrc");
    pinFile("node", ".node-version");
    if (pmField && pmField[1] !== "npm") offer(pmField[1] as Tool, cleanVersion(pmField[2]), "repo", "package.json packageManager");
  }
  pinFile("bun", ".bun-version");
  pinFile("python", ".python-version");
  pinFile("ruby", ".ruby-version");
  pinFile("java", ".java-version", (t) => rangeFloor(t.split("\n")[0]));
  pinFile("java", ".sdkmanrc", (t) => /^java=(\d+)/m.exec(t)?.[1]);
  pinFile("rust", "rust-toolchain.toml", (t) => cleanVersion(/channel\s*=\s*["']([^"']+)["']/.exec(t)?.[1]));
  pinFile("rust", "rust-toolchain");
  pinFile("go", "go.mod", (t) => cleanVersion(/^toolchain\s+go(\S+)/m.exec(t)?.[1] ?? /^go\s+(\S+)/m.exec(t)?.[1]));
  const gemfile = readRepoFile(root, "Gemfile");
  if (gemfile !== undefined) offer("ruby", cleanVersion(/^\s*ruby\s+["']([\d.]+)["']/m.exec(gemfile)?.[1]), "repo", "Gemfile");
  const pyproject = readRepoFile(root, "pyproject.toml");
  const uvLock = has("uv.lock");

  // ---- CI
  const workflows = listDir(root, ".github/workflows").filter((f) => /\.ya?ml$/.test(f));
  const ciServices = new Map<string, FoundService>();
  // Services nothing on the install stands for, and apt packages, with where they were seen.
  const gaps: DraftEvidence[] = [];
  const gap = (source: EvidenceSource, service: string, image: string) => {
    const note = `needs Docker: ${service} (${image})`;
    if (!gaps.some((g) => g.note === note)) gaps.push({ source, note });
  };
  const apt = new Map<string, { source: EvidenceSource; from: string }>();
  const aptFrom = (text: string | undefined, source: EvidenceSource, from: string) => {
    for (const name of aptPackages(text ?? "")) if (!apt.has(name)) apt.set(name, { source, from });
  };
  for (const file of workflows) {
    const doc = yamlDoc(readRepoFile(root, `.github/workflows/${file}`));
    for (const job of Object.values(record(doc?.jobs))) {
      for (const [key, service] of Object.entries(record(record(job).services))) {
        const image = str(record(service).image) ?? str(service);
        const found = image ? serviceOfImage(image) : undefined;
        if (found && !ciServices.has(found.name)) ciServices.set(found.name, { ...found, source: "ci", from: file, key, image: image! });
        else if (!found && image && !image.includes("${{")) gap("ci", key, image);
      }
      const steps = Array.isArray(record(job).steps) ? (record(job).steps as unknown[]) : [];
      for (const step of steps) {
        const uses = str(record(step).uses) ?? "";
        const w = record(record(step).with);
        aptFrom(str(record(step).run), "ci", file);
        if (uses.startsWith("awalsh128/cache-apt-pkgs-action")) aptFrom(`apt-get install ${(str(w.packages) ?? "").replace(/,/g, " ")}`, "ci", file);
        const fromFile = (key: string, tool: Tool) => {
          const rel = str(w[key]);
          if (rel && !rel.includes("${{") && !rel.startsWith("/") && !rel.includes("..")) offer(tool, cleanVersion(readRepoFile(root, rel)?.split("\n")[0]), "ci", `${file} (${rel})`);
        };
        const at = (key: string, tool: Tool) => offer(tool, cleanVersion(str(w[key])), "ci", file);
        if (uses.startsWith("actions/setup-node")) {
          at("node-version", "node");
          fromFile("node-version-file", "node");
        } else if (uses.startsWith("pnpm/action-setup")) at("version", "pnpm");
        else if (uses.startsWith("actions/setup-python")) at("python-version", "python");
        else if (uses.startsWith("actions/setup-go")) at("go-version", "go");
        else if (uses.startsWith("actions/setup-java")) offer("java", rangeFloor(str(w["java-version"])), "ci", file);
        else if (uses.startsWith("ruby/setup-ruby")) at("ruby-version", "ruby");
        else if (uses.startsWith("oven-sh/setup-bun")) at("bun-version", "bun");
        else if (uses.startsWith("denoland/setup-deno")) at("deno-version", "deno");
        else if (uses.startsWith("dtolnay/rust-toolchain@")) offer("rust", cleanVersion(str(w.toolchain) ?? uses.split("@")[1]), "ci", file);
      }
    }
  }

  // ---- devcontainer
  const devcontainerPath = [".devcontainer/devcontainer.json", ".devcontainer.json", ...listDir(root, ".devcontainer").map((d) => `.devcontainer/${d}/devcontainer.json`)].find(has);
  const devcontainer = devcontainerPath ? json(stripJsonComments(readRepoFile(root, devcontainerPath)!)) : undefined;
  const isCompose = (f: string) => /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(f);
  const composeFiles = new Set([...listDir(root, ".").filter(isCompose), ...listDir(root, ".devcontainer").filter(isCompose).map((f) => `.devcontainer/${f}`)]);
  const isDockerfile = (f: string) => /^(Dockerfile|Containerfile)(\.[\w.-]+)?$|\.Dockerfile$/i.test(f);
  const dockerfiles = new Set([
    ...listDir(root, ".").filter(isDockerfile),
    ...[".devcontainer", "docker", ".docker"].flatMap((dir) => listDir(root, dir).filter(isDockerfile).map((f) => `${dir}/${f}`)),
  ]);
  const postCreate: string[] = [];
  if (devcontainer) {
    const dir = path.posix.dirname(devcontainerPath!);
    const dockerfile = str(record(devcontainer.build).dockerfile) ?? str(devcontainer.dockerFile);
    const dockerfileRel = dockerfile === undefined ? undefined : path.posix.normalize(path.posix.join(dir, dockerfile));
    if (dockerfileRel !== undefined && !dockerfileRel.startsWith("..")) dockerfiles.add(dockerfileRel);
    // Its other lifecycle commands may install with apt too; only postCreateCommand runs in setup.
    for (const key of ["onCreateCommand", "updateContentCommand", "postCreateCommand", "postStartCommand"]) {
      const c = devcontainer[key];
      const texts = typeof c === "string" ? [c] : Array.isArray(c) ? [c.map(String).join(" ")] : Object.values(record(c)).map((x) => (Array.isArray(x) ? x.map(String).join(" ") : String(x)));
      for (const text of texts) aptFrom(text, "devcontainer", `its ${key}`);
    }
    const image = str(devcontainer.image) ?? "";
    const imageTool = /devcontainers\/(typescript-node|javascript-node|python|go|rust|java|ruby)(?::[\d-]*?(\d+(?:\.\d+)?)(?:-|$))?/.exec(image);
    if (imageTool?.[2]) offer(imageTool[1]!.endsWith("node") ? "node" : (imageTool[1] as Tool), imageTool[2], "devcontainer", "its image");
    for (const [ref, opts] of Object.entries(record(devcontainer.features))) {
      const name = /\/([\w-]+)(?::[\w.-]+)?$/.exec(ref)?.[1];
      const tool = name === "rust" ? "rust" : (TOOLS as readonly string[]).includes(name ?? "") ? (name as Tool) : undefined;
      if (tool) offer(tool, cleanVersion(str(record(opts).version)), "devcontainer", `its ${name} feature`);
    }
    const pc = devcontainer.postCreateCommand;
    const commands = typeof pc === "string" ? [pc] : Array.isArray(pc) ? [pc.map(String).join(" ")] : Object.values(record(pc)).map((c) => (Array.isArray(c) ? c.map(String).join(" ") : String(c)));
    // A command that needs root or a package manager of the OS can't run as the tools uid.
    for (const c of commands) if (c.trim() && !/\b(sudo|apt(-get)?|apk|yum|dnf|brew)\b/.test(c)) postCreate.push(c.trim());
    const ports = Array.isArray(devcontainer.forwardPorts) ? devcontainer.forwardPorts.map(String) : [];
    if (ports.length > 0) evidence.push({ source: "devcontainer", note: `Forwards port ${ports.join(", ")}` });
    const compose = devcontainer.dockerComposeFile;
    for (const f of typeof compose === "string" ? [compose] : Array.isArray(compose) ? compose.map(String) : []) {
      const rel = path.posix.normalize(path.posix.join(dir, f));
      if (!rel.startsWith("..")) composeFiles.add(rel);
    }
  }

  // ---- compose services: the install's own services by image; the app's services say which env names it reads
  const composeServices = new Map<string, FoundService>();
  const composeNames = new Set<string>();
  // The devcontainer's own service is the workspace: the computer is that.
  const workspaceService = str(devcontainer?.service);
  for (const file of [...composeFiles].sort()) {
    const source: EvidenceSource = file.startsWith(".devcontainer/") || (devcontainerPath !== undefined && !isCompose(file)) ? "devcontainer" : "repo";
    for (const [key, service] of Object.entries(record(yamlDoc(readRepoFile(root, file))?.services))) {
      const image = str(record(service).image);
      const found = image ? serviceOfImage(image) : undefined;
      if (found) {
        if (!composeServices.has(found.name)) composeServices.set(found.name, { ...found, source, from: file, key, image: image! });
        continue;
      }
      for (const name of composeEnvNames(record(service).environment)) composeNames.add(name);
      // Built here, or a language image: the app itself, which runs on the computer without Docker.
      const parts = image === undefined ? undefined : imageParts(image);
      if (image === undefined || key === workspaceService || (parts !== undefined && APP_IMAGE.test(parts.repo))) continue;
      if (parts !== undefined && ZOOKEEPER_IMAGE.test(parts.repo)) {
        if (!gaps.some((g) => g.note.startsWith("ZooKeeper"))) gaps.push({ source, note: `ZooKeeper (${key}) isn't needed: the install's Kafka runs without it (KRaft)` });
        continue;
      }
      gap(source, key, image);
    }
  }

  // ---- Dockerfiles: the apt packages their RUN lines install
  for (const file of [...dockerfiles].sort()) aptFrom(readRepoFile(root, file), file.startsWith(".devcontainer/") ? "devcontainer" : "repo", file);

  // ---- this Mac (last: the repo, CI and a devcontainer say what the project means; the Mac fills the gaps)
  if (seed) for (const tool of TOOLS) offer(tool, cleanVersion(seed.versions[tool]), "mac", "this Mac");
  // package.json engines is a range: its floor (">=18" is Node 18) only when nothing names a version in use.
  const engine = rangeFloor(str(record(pkg?.engines).node));
  if (engine !== undefined) offer("node", engine, "repo", "package.json engines");

  // ---- install
  if (miseFiles.length > 0) run.push("mise trust --all", miseInstall);
  const needs = new Set<Tool>();
  if (pkg) needs.add("node");
  if (pm === "pnpm" || pm === "yarn" || pm === "bun") needs.add(pm);
  if (has("deno.json") || has("deno.jsonc")) needs.add("deno");
  if (has("go.mod")) needs.add("go");
  if (has("Cargo.toml")) needs.add("rust");
  if (gemfile !== undefined) needs.add("ruby");
  if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts")) needs.add("java");
  // uv brings the Python a project asks for; the image has 3.13 for the rest.
  if (!uvLock && (pyproject !== undefined || has("requirements.txt") || has("Pipfile"))) needs.add("python");
  if (pm === "pnpm" && !picks.has("pnpm")) {
    const lockVersion = /lockfileVersion:\s*'?(\d+)/.exec(readRepoFile(root, "pnpm-lock.yaml") ?? "")?.[1];
    const pnpmMajor = lockVersion === undefined ? undefined : Number(lockVersion) >= 9 ? "9" : Number(lockVersion) >= 6 ? "8" : "7";
    offer("pnpm", pnpmMajor, "repo", "pnpm-lock.yaml");
  }
  const misePicks: Array<[Tool, Pick]> = [];
  for (const tool of TOOLS) {
    const pick = picks.get(tool);
    if (!needs.has(tool) || pinnedByMise.has(tool)) continue;
    // The image has Node and Python: name a version only when something does.
    if (pick === undefined) {
      if (tool !== "node" && tool !== "python") run.push(`mise use -g ${tool}@${tool === "rust" ? "stable" : "latest"}`);
      continue;
    }
    run.push(`mise use -g ${tool}@${pick.version}`);
    misePicks.push([tool, pick]);
  }
  for (const group of groupBy(misePicks, ([, p]) => (p.source === "mac" ? "this Mac" : p.from))) {
    const tools = group.items.map(([t, p]) => `${LABEL[t]} ${p.version}`);
    evidence.push({ source: group.items[0]![1].source, note: `${joinAnd(tools)} from ${group.key}` });
  }

  const installs: Array<[string, string]> = [];
  if (pm === "pnpm") installs.push([lock ? "pnpm install --frozen-lockfile" : "pnpm install", lock ? "pnpm-lock.yaml" : "package.json"]);
  else if (pm === "yarn") {
    const berry = has(".yarnrc.yml") || Number(major(pmField?.[2] ?? "1")) >= 2;
    installs.push([lock ? (berry ? "yarn install --immutable" : "yarn install --frozen-lockfile") : "yarn install", lock ? "yarn.lock" : "package.json"]);
  } else if (pm === "bun") installs.push([lock ? "bun install --frozen-lockfile" : "bun install", lock ? (has("bun.lock") ? "bun.lock" : "bun.lockb") : "package.json"]);
  else if (pm === "npm") installs.push([lock ? "npm ci" : "npm install", lock ? (has("package-lock.json") ? "package-lock.json" : "npm-shrinkwrap.json") : "package.json"]);
  if (uvLock) installs.push(["uv sync --frozen", "uv.lock"]);
  else if (has("poetry.lock")) installs.push(["uv tool install poetry && poetry install --no-interaction", "poetry.lock"]);
  else if (has("Pipfile.lock")) installs.push(["uv tool install pipenv && pipenv sync", "Pipfile.lock"]);
  else if (has("requirements.txt")) installs.push(["uv venv && uv pip install -r requirements.txt", "requirements.txt"]);
  else if (pyproject !== undefined && /^\[project\]/m.test(pyproject)) installs.push(["uv sync", "pyproject.toml"]);
  if (has("go.mod")) installs.push(["go mod download", "go.mod"]);
  if (has("Cargo.toml")) installs.push(["cargo fetch", has("Cargo.lock") ? "Cargo.lock" : "Cargo.toml"]);
  if (gemfile !== undefined) installs.push(["bundle install", has("Gemfile.lock") ? "Gemfile.lock" : "Gemfile"]);
  if (has("deno.json") || has("deno.jsonc")) installs.push(["deno install", has("deno.lock") ? "deno.lock" : has("deno.json") ? "deno.json" : "deno.jsonc"]);
  if (has("pom.xml")) installs.push([has("mvnw") ? "./mvnw -q -DskipTests dependency:go-offline" : "mvn -q -DskipTests dependency:go-offline", "pom.xml"]);
  else if (has("build.gradle") || has("build.gradle.kts")) installs.push([has("gradlew") ? "./gradlew --no-daemon dependencies" : "gradle --no-daemon dependencies", has("build.gradle") ? "build.gradle" : "build.gradle.kts"]);
  for (const [command, file] of installs) {
    run.push(command);
    evidence.push({ source: "repo", note: `${file}: ${command}` });
    inputs.add(file);
  }
  for (const manifest of ["package.json", "pyproject.toml", "Cargo.toml", "Gemfile", "go.sum"]) add(manifest);
  for (const c of postCreate) {
    if (!run.includes(c)) {
      run.push(c);
      evidence.push({ source: "devcontainer", note: `Its postCreateCommand: ${c}` });
    }
  }

  // ---- env names (names only) and services
  const exampleNames = new Set<string>();
  const exampleAll = new Set<string>();
  // An example's name with a value is a default someone wrote down; one left blank, or a secret's, is a value to supply.
  for (const f of listDir(root, ".").filter((f) => /^\.env\.(example|sample|template|dist)$/.test(f))) {
    for (const { name, empty } of envFileEntries(readRepoFile(root, f) ?? "")) {
      exampleAll.add(name);
      if (empty || SECRETISH.test(name)) exampleNames.add(name);
    }
  }
  const codeNames = options.readCode === false ? new Set<string>() : await codeEnvReads(root);
  const macNames = new Set(seed?.env_names ?? []);
  const allNames = new Set([...macNames, ...exampleNames, ...codeNames]);
  // Every name the repo shows it reads, defaults and compose's included: a service's address goes only to these.
  const readNames = new Set([...allNames, ...exampleAll, ...composeNames]);
  const deps = dependencyText(root);
  const usesService = (name: string) =>
    name === "postgres"
      ? /\b(pg|postgres|postgresql|psycopg2?|psycopg|asyncpg|pgx|lib\/pq|tokio-postgres|sqlx|activerecord-postgresql-adapter)\b|"pg"|provider\s*=\s*"postgresql"/.test(deps) || [...allNames].some((n) => /^(PG[A-Z]+|POSTGRES_\w+)$/.test(n))
      : name === "redis"
        ? /\b(redis|ioredis|bullmq|go-redis|sidekiq|celery)\b/.test(deps) || allNames.has("REDIS_URL")
        : name === "mysql" || name === "mariadb"
          ? /\b(mysql2?|pymysql|go-sql-driver\/mysql)\b/.test(deps)
          : false;

  const services = new Map<string, { version: string; source: EvidenceSource; from: string; key?: string; image?: string; caveat?: string }>();
  for (const [name, s] of ciServices) services.set(name, s);
  for (const [name, s] of composeServices) if (!services.has(name)) services.set(name, s);
  // This Mac runs Postgres for many projects: it counts only when the repo shows it uses one.
  for (const [name, version] of Object.entries(seed?.services ?? {})) {
    if (!services.has(name) && usesService(name)) services.set(name, { version, source: "mac", from: "this Mac" });
  }
  const serviceLines: Array<[string, string]> = [];
  for (const [name, s] of [...services].sort(([a], [b]) => a.localeCompare(b))) {
    const label = SERVICE_LABEL[name] ?? name;
    const allowed = offered[name];
    if (allowed === undefined || allowed.length === 0) {
      // From a compose file or CI: a gap like any other image, saying why.
      evidence.push({
        source: s.source,
        note: s.image === undefined ? `${label} isn't offered on this install, so it's left out` : `needs Docker: ${s.key} (${s.image}); this install doesn't offer ${label}`,
      });
      continue;
    }
    const version = nearestOffered(s.version, allowed);
    serviceLines.push([name, version]);
    const said = s.version && !sameSeries(s.version, version) ? `${s.version} isn't offered; using ${version}` : version;
    evidence.push({ source: s.source, note: s.source === "mac" ? `${label} ${said} running on this Mac` : `${label} ${said} from ${s.from}` });
    if (s.caveat !== undefined) evidence.push({ source: s.source, note: `${s.image} runs as ${label}: ${s.caveat}` });
  }
  // A name two services answer to (DATABASE_URL) goes to the first in SERVICE_ENV: Postgres, then MySQL, MariaDB, MongoDB.
  const env: Array<[string, string]> = [];
  for (const name of Object.keys(SERVICE_ENV).filter((n) => serviceLines.some(([line]) => line === n))) {
    for (const [envName, value] of Object.entries(SERVICE_ENV[name]!)) {
      if (readNames.has(envName) && !env.some(([n]) => n === envName)) env.push([envName, value]);
    }
  }

  const satisfied = new Set(env.map(([n]) => n));
  // A value someone can add comes from a file they have; a name only the code reads is usually optional (a fallback, a test knob).
  const secretNames = [...new Set([...macNames, ...exampleNames])]
    .filter((n) => !satisfied.has(n) && !isReservedEnvName(n, "process") && !NOT_SECRETS.test(n))
    .sort();
  if (macNames.size > 0) evidence.push({ source: "mac", note: `${plural(macNames.size, "env name")} in this Mac's git-ignored .env files` });
  if (exampleNames.size > 0) evidence.push({ source: "repo", note: `${plural(exampleNames.size, "env name")} in .env.example` });
  const unlisted = [...codeNames].filter((n) => SECRETISH.test(n) && !allNamesListed(n, macNames, exampleNames)).length;
  if (unlisted > 0) evidence.push({ source: "repo", note: `The code reads ${plural(unlisted, "more secret-looking name")} no .env file sets` });

  // ---- services nothing on the install stands for
  evidence.push(...gaps);

  // ---- system packages: apt's names as conda-forge's, less what the computer image already has
  const system = systemPackages(apt);
  evidence.push(...system.evidence);

  // ---- checks: the repo's own, a fast subset
  const checks = repoChecks(root, pkg, pm);
  if (checks.commands.length > 0) evidence.push({ source: "repo", note: `Checks from ${checks.from}: ${checks.commands.join(" · ")}` });

  return {
    config: renderToml({ run, check: checks.commands, inputs: [...inputs].sort(), system: system.packages, services: serviceLines, env }),
    evidence,
    secret_names: secretNames,
  };
}

interface FoundService {
  readonly version: string;
  readonly caveat?: string;
  readonly source: EvidenceSource;
  readonly from: string;
  /** The service's name in the compose file or the workflow. */
  readonly key: string;
  readonly image: string;
}

/**
 * [system] packages for the apt packages the repo installs (first seen where), and the evidence: what maps, what
 * the computer image already has, and what has no conda-forge match. apt's own plumbing is left out silently.
 */
function systemPackages(apt: ReadonlyMap<string, { source: EvidenceSource; from: string }>): { packages: string[]; evidence: DraftEvidence[] } {
  const mapped: Array<[string, string, EvidenceSource, string]> = [];
  const onImage: Array<[string, EvidenceSource, string]> = [];
  const unmapped: Array<[string, EvidenceSource, string]> = [];
  for (const [name, { source, from }] of apt) {
    if (APT_PLUMBING.has(name)) continue;
    const conda = Object.hasOwn(APT_TO_CONDA, name) ? APT_TO_CONDA[name] : undefined;
    if (ON_IMAGE_APT.has(name) || (conda !== undefined && ON_IMAGE_CONDA.has(conda))) onImage.push([name, source, from]);
    else if (conda !== undefined) mapped.push([name, conda, source, from]);
    else unmapped.push([name, source, from]);
  }
  const packages = [...new Set(mapped.map(([, conda]) => conda))].sort().slice(0, MAX_SYSTEM_PACKAGES);
  const evidence: DraftEvidence[] = [];
  const where = (items: Array<{ from: string }>) => joinAnd([...new Set(items.map((i) => i.from))]);
  for (const group of groupBy(mapped, ([, , source]) => source)) {
    const names = [...new Set(group.items.map(([apt, conda]) => (apt === conda ? conda : `${conda} (${apt})`)))];
    evidence.push({ source: group.items[0]![2], note: `System packages for apt-get in ${where(group.items.map(([, , , from]) => ({ from })))}: ${names.join(", ")}` });
  }
  for (const group of groupBy(onImage, ([, source]) => source)) {
    const names = group.items.map(([apt]) => (apt === "build-essential" ? "build-essential (it has a compiler)" : apt));
    evidence.push({ source: group.items[0]![1], note: `Already on the computer image: ${names.join(", ")} from ${where(group.items.map(([, , from]) => ({ from })))}` });
  }
  for (const group of groupBy(unmapped, ([, source]) => source)) {
    evidence.push({
      source: group.items[0]![1],
      note: `No conda-forge match for apt's ${group.items.map(([apt]) => apt).join(", ")} from ${where(group.items.map(([, , from]) => ({ from })))}: add its conda-forge name to [system] if setup needs it`,
    });
  }
  if (new Set(mapped.map(([, conda]) => conda)).size > MAX_SYSTEM_PACKAGES) evidence.push({ source: mapped[0]![2], note: `Only the first ${MAX_SYSTEM_PACKAGES} system packages fit in [system]` });
  return { packages, evidence };
}

/** The repo's JavaScript package manager: package.json's packageManager, else its lockfile, else npm when there is a package.json. */
function packageManager(root: string, pkg: Record<string, unknown> | undefined) {
  const has = (rel: string) => readRepoFile(root, rel) !== undefined;
  const pmField = /^(pnpm|yarn|npm|bun)@([^+\s]+)/.exec(str(pkg?.packageManager) ?? "");
  const lock = has("pnpm-lock.yaml") ? "pnpm" : has("bun.lock") || has("bun.lockb") ? "bun" : has("yarn.lock") ? "yarn" : has("package-lock.json") || has("npm-shrinkwrap.json") ? "npm" : undefined;
  const pm = (pmField?.[1] as "pnpm" | "yarn" | "npm" | "bun" | undefined) ?? lock ?? (pkg ? "npm" : undefined);
  return { pm, pmField, lock };
}

const SECRETISH = /KEY|TOKEN|SECRET|PASS|PWD|PRIVATE|CREDENTIAL|AUTH|DSN|SALT|SIGNING|(?:DATABASE|DB|REDIS|MONGO)_?UR[LI]/i;
const allNamesListed = (n: string, ...sets: ReadonlyArray<ReadonlySet<string>>) => sets.some((set) => set.has(n));
const NOT_SECRETS = /^(NODE_ENV|CI|PORT|HOSTNAME|DEBUG|LOG_LEVEL|TZ|LANG|NEXT_RUNTIME|VERCEL\w*|npm_\w+)$/;

/**
 * The install's service an image stands for, by its repository (the last two path parts). `versioned` false: the
 * image counts its versions its own way (Valkey, MinIO's dates, Kafka's), so any offered version serves it.
 * `caveat`: what the offered service may not do that the image did.
 */
const IMAGE_SERVICES: ReadonlyArray<{ readonly match: RegExp; readonly name: string; readonly versioned?: false; readonly caveat?: string }> = [
  { match: /(^|\/)(postgres|postgresql)$/, name: "postgres" },
  { match: /(^|\/)postgis$/, name: "postgres", caveat: "the PostGIS extension may not be in the install's Postgres" },
  { match: /(^|\/)pgvector$/, name: "postgres", caveat: "the pgvector extension may not be in the install's Postgres" },
  { match: /(^|\/)(redis|redis-stack|redis-stack-server)$/, name: "redis" },
  { match: /(^|\/)(valkey|keydb)$/, name: "redis", versioned: false },
  { match: /(^|\/)(mysql|mysql-server)$/, name: "mysql" },
  { match: /(^|\/)mariadb$/, name: "mariadb" },
  { match: /(^|\/)(mongo|mongodb|mongodb-community-server)$/, name: "mongodb" },
  { match: /(^|\/)minio$/, name: "minio", versioned: false },
  // No install offers OpenSearch today (it doesn't run under gVisor), so these are gaps unless one does.
  { match: /(^|\/)opensearch$/, name: "opensearch" },
  {
    match: /(^|\/)elasticsearch$/,
    name: "opensearch",
    versioned: false,
    caveat: "OpenSearch answers Elasticsearch 7.10's API; Elasticsearch's own clients from 7.14 on refuse a server that isn't Elastic's",
  },
  { match: /(^|\/)redpanda$/, name: "kafka", versioned: false, caveat: "Kafka API from Apache Kafka 4.3" },
  // Confluent's tags count Confluent Platform releases, not Kafka's.
  { match: /(^|\/)cp-kafka$/, name: "kafka", versioned: false },
  { match: /(^|\/)kafka$/, name: "kafka" },
  { match: /(^|\/)mailpit$/, name: "mailpit" },
  { match: /(^|\/)mailhog$/, name: "mailpit", versioned: false },
];

/** An image's repository (its last two path parts, lowercased) and tag; `${VAR:-default}` reads as its default. */
function imageParts(image: string): { repo: string; tag: string } | undefined {
  const plain = image.trim().replace(/\$\{[A-Za-z_]\w*:?-([^}]*)\}/g, "$1");
  const m = /^(?:[\w.-]+(?::\d+)?\/)*?([\w.-]+\/)?([\w.-]+)(?::([\w.-]+))?(?:@sha256:\w+)?$/.exec(plain);
  return m ? { repo: `${m[1] ?? ""}${m[2]}`.toLowerCase(), tag: m[3] ?? "" } : undefined;
}

/** postgres:16-alpine → postgres 16; mysql:8.0.36 → mysql 8.0; redis → redis ""; confluentinc/cp-kafka → kafka ""; anything else undefined. */
export function serviceOfImage(image: string): { name: string; version: string; caveat?: string } | undefined {
  const parts = imageParts(image);
  const found = parts && IMAGE_SERVICES.find((s) => s.match.test(parts.repo));
  if (!parts || !found) return undefined;
  // Postgres counts majors; pgvector and PostGIS tags name it as pg17 or 16-3.4.
  const version =
    found.versioned === false
      ? ""
      : found.name === "postgres"
        ? (/(?:^|-)pg(\d+)/.exec(parts.tag)?.[1] ?? /^(\d+)/.exec(parts.tag)?.[1] ?? "")
        : (/^v?(\d+(?:\.\d+)?)/.exec(parts.tag)?.[1] ?? "");
  return found.caveat === undefined ? { name: found.name, version } : { name: found.name, version, caveat: found.caveat };
}

/** Images of a language or a base OS: in compose they run the app itself, which the computer runs without Docker. */
const APP_IMAGE =
  /(^|\/)(node|python|golang|rust|ruby|php|openjdk|eclipse-temurin|amazoncorretto|bun|deno|elixir|dart|gradle|maven|ubuntu|debian|alpine|buildpack-deps|base|universal|typescript-node|javascript-node|java|go|dotnet|cpp)$/;
/** ZooKeeper only serves Kafka, and the install's Kafka (KRaft) needs none. */
const ZOOKEEPER_IMAGE = /(^|\/)(zookeeper|cp-zookeeper)$/;

const versionParts = (v: string) => v.split(".").map(Number);
/** Whether two versions agree on the parts both name: "8" and "8.4", "16" and "16". */
const sameSeries = (a: string, b: string) => {
  const [x, y] = [versionParts(a), versionParts(b)];
  return x.slice(0, Math.min(x.length, y.length)).every((n, i) => n === y[i]);
};
const compareVersions = (a: string, b: string) => {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/**
 * The offered version for one asked for: the same; else the newest of the same series ("8" → "8.4", "16.2" → "16");
 * else the nearest above it; else the newest. Unknown → the middle of the list (postgres 16).
 */
export function nearestOffered(asked: string, allowed: ReadonlyArray<string>): string {
  const sorted = [...allowed].sort(compareVersions);
  if (asked === "") return sorted[Math.floor((sorted.length - 1) / 2)]!;
  if (sorted.includes(asked)) return asked;
  const series = sorted.filter((v) => sameSeries(v, asked));
  if (series.length > 0) return series[series.length - 1]!;
  return sorted.find((v) => compareVersions(v, asked) > 0) ?? sorted[sorted.length - 1]!;
}

/** The env names a compose service's `environment` sets, as a map or as a list of NAME=value. */
function composeEnvNames(environment: unknown): string[] {
  const names = Array.isArray(environment) ? environment.map((e) => String(e).split("=")[0]!.trim()) : Object.keys(record(environment));
  return names.filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
}

// ---------------------------------------------------------------- system packages (D8)

/**
 * apt package → its conda-forge name, for what CI, a Dockerfile or a devcontainer installs with apt-get.
 * Computers have no root, so [system] installs these with micromamba instead.
 */
export const APT_TO_CONDA: Readonly<Record<string, string>> = {
  "libpq-dev": "libpq",
  libpq5: "libpq",
  "libvips-dev": "libvips",
  libvips42: "libvips",
  libvips: "libvips",
  "libvips-tools": "libvips",
  ffmpeg: "ffmpeg",
  imagemagick: "imagemagick",
  "libmagickwand-dev": "imagemagick",
  "libmagickcore-dev": "imagemagick",
  "pkg-config": "pkg-config",
  pkgconf: "pkg-config",
  "libssl-dev": "openssl",
  openssl: "openssl",
  "libxml2-dev": "libxml2",
  "libxslt1-dev": "libxslt",
  "libxslt-dev": "libxslt",
  "libsqlite3-dev": "sqlite",
  sqlite3: "sqlite",
  "libpng-dev": "libpng",
  "libjpeg-dev": "libjpeg-turbo",
  "libjpeg62-turbo-dev": "libjpeg-turbo",
  "libjpeg-turbo8-dev": "libjpeg-turbo",
  "poppler-utils": "poppler",
  "libpoppler-cpp-dev": "poppler",
  ghostscript: "ghostscript",
  graphviz: "graphviz",
  "libgraphviz-dev": "graphviz",
  "protobuf-compiler": "protobuf",
  "libprotobuf-dev": "libprotobuf",
  cmake: "cmake",
  "ninja-build": "ninja",
  clang: "clang",
  gfortran: "gfortran",
  swig: "swig",
  gettext: "gettext",
  "libffi-dev": "libffi",
  "zlib1g-dev": "zlib",
  "libyaml-dev": "yaml",
  "libreadline-dev": "readline",
  "libcurl4-openssl-dev": "libcurl",
  "libcurl4-gnutls-dev": "libcurl",
  "libgdal-dev": "gdal",
  "gdal-bin": "gdal",
  "libgeos-dev": "geos",
  "libproj-dev": "proj",
  "proj-bin": "proj",
  "tesseract-ocr": "tesseract",
  "libtesseract-dev": "tesseract",
  libmagic1: "libmagic",
  "libmagic-dev": "libmagic",
  "libcairo2-dev": "cairo",
  "libpango1.0-dev": "pango",
  "libgif-dev": "giflib",
  "librsvg2-dev": "librsvg",
  "librsvg2-bin": "librsvg",
  "libwebp-dev": "libwebp",
  "libtiff-dev": "libtiff",
  "libtiff5-dev": "libtiff",
  "libfreetype6-dev": "freetype",
  "libfreetype-dev": "freetype",
  "libharfbuzz-dev": "harfbuzz",
  "libglib2.0-0": "glib",
  "libglib2.0-dev": "glib",
  "libzmq3-dev": "zeromq",
  "libsnappy-dev": "snappy",
  "liblz4-dev": "lz4-c",
  "libzstd-dev": "zstd",
  "libbz2-dev": "bzip2",
  "liblzma-dev": "xz",
  "xz-utils": "xz",
  "libgmp-dev": "gmp",
  "libsodium-dev": "libsodium",
  "libboost-all-dev": "boost",
  "unixodbc-dev": "unixodbc",
  "libldap2-dev": "openldap",
  "libsasl2-dev": "cyrus-sasl",
  "libkrb5-dev": "krb5",
  "libhdf5-dev": "hdf5",
  "libopenblas-dev": "openblas",
  "liblapack-dev": "liblapack",
  jq: "jq",
  pandoc: "pandoc",
  sox: "sox",
  qpdf: "qpdf",
  ripgrep: "ripgrep",
  "libimage-exiftool-perl": "exiftool",
  unzip: "unzip",
  zip: "zip",
  rsync: "rsync",
};
/** What the computer image already has (Wolfi with build-base, git-lfs, postgresql-client, sqlite, vips and imagemagick), by conda-forge name. */
const ON_IMAGE_CONDA = new Set(["libvips", "imagemagick", "sqlite"]);
/** apt packages the image covers another way: a compiler, git, the Postgres client, and the toolchains mise and uv bring. */
const ON_IMAGE_APT = new Set(["build-essential", "gcc", "g++", "make", "libc6-dev", "git", "git-lfs", "postgresql-client", "python3", "python3-pip", "python3-venv", "python3-dev", "python-is-python3", "nodejs", "npm"]);
/** apt's own plumbing: what a script installs to add a repository or run apt, never what the repo needs. */
const APT_PLUMBING = new Set(["ca-certificates", "curl", "wget", "gnupg", "gnupg2", "dirmngr", "lsb-release", "software-properties-common", "apt-transport-https", "apt-utils", "sudo", "locales", "tzdata"]);

/** Package names from the `apt-get install` and `apt install` commands in shell text, continuations joined. */
export function aptPackages(text: string): string[] {
  const out: string[] = [];
  for (const m of text.replace(/\\\r?\n/g, " ").matchAll(/\bapt(?:-get)?((?:\s+-\S+)*)\s+install\b([^\n;&|<>)#]*)/g)) {
    const tokens = m[2]!.trim().split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!.replace(/^["']|["']$/g, "");
      // -o Dpkg::Options and -t a-release take a value; a variable or a glob names no package here.
      if (token === "-o" || token === "-t" || token === "--target-release") i++;
      // libpq-dev=15.* pins a version, libpq-dev:amd64 an architecture: the name is before them.
      const name = token.replace(/[:=].*$/, "").toLowerCase();
      if (token.startsWith("-") || /[$`*?{}]/.test(name)) continue;
      if (/^[a-z0-9][a-z0-9.+-]+$/.test(name) && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

/** Each name an env file assigns, and whether it is left blank. Values are never kept. */
export function envFileEntries(text: string): Array<{ name: string; empty: boolean }> {
  const out = new Map<string, boolean>();
  for (const m of text.matchAll(/^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*([^\s#"']|["'][^"'\s])?/gm)) out.set(m[1]!, m[2] === undefined);
  return [...out].map(([name, empty]) => ({ name, empty }));
}

/** Names assigned a value in an env file. */
export const envFileNames = (text: string): string[] => envFileEntries(text).filter((e) => !e.empty).map((e) => e.name);

/** Env var names the repo's tracked code reads, from `git grep` (3 s at most; none when git can't). */
function codeEnvReads(root: string): Promise<Set<string>> {
  const pattern = String.raw`(process\.env\.[A-Z_][A-Z0-9_]*|process\.env\[["'][A-Z_][A-Z0-9_]*|import\.meta\.env\.[A-Z_][A-Z0-9_]*|os\.environ(\.get)?\(?\[?["'][A-Z_][A-Z0-9_]*|os\.getenv\(["'][A-Z_][A-Z0-9_]*|os\.Getenv\("[A-Z_][A-Z0-9_]*|env::var\("[A-Z_][A-Z0-9_]*|ENV\[["'][A-Z_][A-Z0-9_]*|env\("[A-Z_][A-Z0-9_]*)`;
  return new Promise((resolve) =>
    execFile("git", ["-C", root, "grep", "-I", "-h", "-o", "-E", pattern, "--", ":!*.md", ":!*.lock", ":!*lock.json", ":!*.min.js", ":!*test*", ":!*spec*", ":!*fixture*", ":!*mock*"], { timeout: 3000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (_error, stdout) => {
      const names = new Set<string>();
      for (const line of String(stdout ?? "").split("\n")) {
        const m = /([A-Z_][A-Z0-9_]*)$/.exec(line.trim());
        if (m && m[1]!.length > 1) names.add(m[1]!);
      }
      resolve(names);
    }),
  );
}

/** The manifests' text, for telling whether the repo uses Postgres or Redis. */
function dependencyText(root: string): string {
  const pkg = json(readRepoFile(root, "package.json"));
  const names = pkg ? Object.keys({ ...record(pkg.dependencies), ...record(pkg.devDependencies) }).join(" ") : "";
  const files = ["pyproject.toml", "requirements.txt", "Pipfile", "go.mod", "Gemfile", "Cargo.toml", "prisma/schema.prisma", "schema.prisma"].map((f) => readRepoFile(root, f) ?? "");
  return [names, ...files].join("\n");
}

function repoChecks(root: string, pkg: Record<string, unknown> | undefined, pm: string | undefined): { commands: string[]; from: string } {
  const scripts = record(pkg?.scripts);
  const runScript = (s: string) => (pm === "pnpm" ? `pnpm ${s}` : pm === "yarn" ? `yarn ${s}` : pm === "bun" ? `bun run ${s}` : s === "test" ? "npm test" : `npm run ${s}`);
  const usable = (s: string) => {
    const body = str(scripts[s]);
    return body !== undefined && !/--watch\b|no test specified|playwright|cypress/.test(body);
  };
  const typecheck = ["typecheck", "type-check", "check-types", "types", "tsc"].find(usable);
  const fromScripts = [typecheck, usable("test") ? "test" : undefined].filter((s) => s !== undefined);
  if (fromScripts.length < 2 && usable("lint")) fromScripts.push("lint");
  if (fromScripts.length > 0) return { commands: fromScripts.map(runScript), from: "package.json" };

  const makefile = readRepoFile(root, "Makefile") ?? readRepoFile(root, "makefile");
  if (makefile !== undefined) {
    const targets = new Set([...makefile.matchAll(/^([A-Za-z][\w-]*)\s*:(?!=)/gm)].map((m) => m[1]!));
    const picked = ["check", "typecheck", "test", "lint"].filter((t) => targets.has(t)).slice(0, 2);
    if (picked.length > 0) return { commands: picked.map((t) => `make ${t}`), from: "the Makefile" };
  }
  for (const doc of ["AGENTS.md", "CLAUDE.md"]) {
    const text = readRepoFile(root, doc);
    if (text === undefined) continue;
    const found = [...text.matchAll(/`((?:pnpm|npm (?:run |test)|yarn|bun (?:run |test)|make|go (?:test|vet|build)|cargo (?:test|check|clippy)|uv run|pytest|just|bundle exec)[^`\n]{0,80})`/g)]
      .map((m) => m[1]!.trim())
      .filter((c) => /test|check|lint|vet|clippy|typecheck/.test(c) && !/watch|\bdev\b|e2e|--fix|deploy|release/.test(c));
    const picked = [...new Set(found)].slice(0, 2);
    if (picked.length > 0) return { commands: picked, from: doc };
  }
  if (readRepoFile(root, "go.mod") !== undefined) return { commands: ["go build ./..."], from: "go.mod" };
  if (readRepoFile(root, "Cargo.toml") !== undefined) return { commands: ["cargo check"], from: "Cargo.toml" };
  return { commands: [], from: "" };
}

const toml = (s: string) => JSON.stringify(s);
const tomlArray = (items: ReadonlyArray<string>) => (items.length <= 1 || items.join(", ").length < 60 ? `[${items.map(toml).join(", ")}]` : `[\n${items.map((i) => `  ${toml(i)},`).join("\n")}\n]`);

function renderToml(c: { run: string[]; check: string[]; inputs: string[]; system: string[]; services: Array<[string, string]>; env: Array<[string, string]> }): string {
  const lines = ["# Drafted by Caveman; edit freely.", "[setup]"];
  if (c.run.length > 0) lines.push(`run = ${tomlArray(c.run)}`);
  if (c.check.length > 0) lines.push(`check = ${tomlArray(c.check)}`);
  if (c.inputs.length > 0) lines.push(`inputs = ${tomlArray(c.inputs)}`);
  if (c.system.length > 0) lines.push("", "[system]", `packages = ${tomlArray(c.system)}`);
  if (c.services.length > 0) lines.push("", "[services]", ...c.services.map(([n, v]) => `${n} = ${toml(v)}`));
  if (c.env.length > 0) lines.push("", "[env]", ...c.env.map(([n, v]) => `${n} = ${toml(v)}`));
  return `${lines.join("\n")}\n`;
}

function groupBy<T>(items: T[], key: (t: T) => string): Array<{ key: string; items: T[] }> {
  const out: Array<{ key: string; items: T[] }> = [];
  for (const item of items) {
    const k = key(item);
    const group = out.find((g) => g.key === k);
    if (group) group.items.push(item);
    else out.push({ key: k, items: [item] });
  }
  return out;
}
const joinAnd = (parts: string[]) => (parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---------------------------------------------------------------- the Mac seed

const VERSION_COMMANDS: Record<Tool, string> = {
  node: "node -v",
  pnpm: "pnpm -v",
  yarn: "yarn -v",
  bun: "bun -v",
  deno: "deno -V",
  python: "python3 -V",
  go: "go version",
  rust: "rustc -V",
  ruby: "ruby -v",
  java: "java -version 2>&1",
};

const MARK = "@@caveman-version@@";

type Exec = (file: string, args: string[], options: { cwd?: string; timeout: number }) => Promise<string>;
const exec: Exec = (file, args, options) =>
  new Promise((resolve) => {
    const child = execFile(file, args, { ...options, maxBuffer: 1024 * 1024, killSignal: "SIGKILL", windowsHide: true }, (error, stdout, stderr) =>
      resolve(error && !stdout ? "" : `${stdout ?? ""}${stderr ?? ""}`),
    );
    child.stdin?.end();
  });

/** The tools a repo at `root` uses, for which readMacSeed asks this Mac's shell. */
export function toolsOf(root: string): Tool[] {
  const has = (rel: string) => readRepoFile(root, rel) !== undefined;
  const out: Tool[] = [];
  const pkg = json(readRepoFile(root, "package.json"));
  const { pm } = packageManager(root, pkg);
  if (pkg) out.push("node");
  if (pm === "pnpm" || pm === "yarn" || pm === "bun") out.push(pm);
  if (has("deno.json") || has("deno.jsonc")) out.push("deno");
  if (has("pyproject.toml") || has("requirements.txt") || has("Pipfile")) out.push("python");
  if (has("go.mod")) out.push("go");
  if (has("Cargo.toml")) out.push("rust");
  if (has("Gemfile")) out.push("ruby");
  if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts")) out.push("java");
  return out;
}

/**
 * What this Mac runs for the repo at `root`: each tool's version in the person's login shell with cwd = root
 * (2 s each, all at once), the services listening here (lsof, then the server's own --version, and Docker's
 * published ports), and the names in the repo's git-ignored top-level .env files. Paths and values stay here.
 */
export async function readMacSeed(root: string, options: { shell?: string; exec?: Exec } = {}): Promise<MacSeed> {
  const run = options.exec ?? exec;
  // Windows has no login shell of the person's that speaks POSIX: Git Bash when installed, else no versions
  // (lsof is missing there too, so services come from Docker alone).
  const shell = options.shell ?? (process.platform === "win32" ? findGitBash() : (process.env.SHELL ?? "/bin/zsh"));
  const tools = shell === undefined ? [] : toolsOf(root);
  // The marker splits what the shell's startup files print from the command's own answer.
  const answers = await Promise.all(tools.map((tool) => run(shell!, ["-ilc", `printf '\\n${MARK}\\n'; ${VERSION_COMMANDS[tool]}`], { cwd: root, timeout: 2000 })));
  const versions: Partial<Record<Tool, string>> = {};
  tools.forEach((tool, i) => {
    const text = answers[i]!.split(MARK)[1] ?? "";
    const v = tool === "go" ? /go(\d+\.\d+(?:\.\d+)?)/.exec(text)?.[1] : tool === "java" ? /version "(\d+(?:\.\d+)*)/.exec(text)?.[1] : versionFrom(text);
    // Yarn 1 under a Berry project, a pnpm shim without pnpm: an answer that isn't a version is no answer.
    if (v !== undefined) versions[tool] = v;
  });
  const [listening, docker] = await Promise.all([run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], { timeout: 2000 }), run("docker", ["ps", "--format", "{{.Image}}|{{.Ports}}"], { timeout: 2000 })]);
  const services = await servicesFrom(listening, docker, run);
  const env_names = await ignoredEnvNames(root, run);
  return { versions, services, env_names };
}

/** Services from `lsof -Fpcn` and `docker ps`; a native server's version from its own binary (its path never leaves). */
export async function servicesFrom(lsof: string, docker: string, run: Exec): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const line of docker.split("\n")) {
    const [image, ports] = line.split("|");
    const found = image ? serviceOfImage(image) : undefined;
    if (found && ports && /->\d+\/tcp/.test(ports) && out[found.name] === undefined) out[found.name] = found.version;
  }
  const procs: Array<{ pid: string; command: string }> = [];
  let pid = "";
  for (const line of lsof.split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1);
    else if (line.startsWith("c")) procs.push({ pid, command: line.slice(1) });
  }
  for (const { pid, command } of procs) {
    const name = /^postgres/.test(command) ? "postgres" : /^redis-ser/.test(command) ? "redis" : /^mysqld/.test(command) ? "mysql" : /^mariadbd/.test(command) ? "mariadb" : undefined;
    if (!name || out[name] !== undefined) continue;
    const exe = (await run("ps", ["-o", "command=", "-p", pid], { timeout: 2000 })).trim().split(/\s+/)[0] ?? "";
    const fromPath = /postgresql@(\d+)|\/Versions\/(\d+)\/|\/postgresql\/(\d+)\/|redis@(\d+)|mysql@(\d+)/.exec(exe);
    const v = fromPath?.slice(1).find((x) => x !== undefined) ?? (exe.startsWith("/") ? versionFrom(await run(exe, ["--version"], { timeout: 2000 })) : undefined);
    out[name] = v === undefined ? "" : major(v);
  }
  return out;
}

async function ignoredEnvNames(root: string, run: Exec): Promise<string[]> {
  const files = listDir(root, ".").filter((f) => f.startsWith(".env") && !/\.(example|sample|template|dist)$/.test(f) && readRepoFile(root, f) !== undefined);
  if (files.length === 0) return [];
  const ignored = new Set((await run("git", ["-C", root, "check-ignore", "--", ...files], { timeout: 2000 })).split("\n").map((l) => l.trim()));
  const names = new Set<string>();
  for (const f of files) if (ignored.has(f)) for (const n of envFileNames(readRepoFile(root, f) ?? "")) names.add(n);
  return [...names].sort();
}
