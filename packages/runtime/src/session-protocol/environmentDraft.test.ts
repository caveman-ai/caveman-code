import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { parseComputerConfig } from "./computerConfig.ts";
import { aptPackages, draftEnvironment, nearestOffered, readMacSeed, serviceOfImage, servicesFrom, stripJsonComments, type MacSeed } from "./environmentDraft.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A git repo holding `files`, committed, with `ignored` written after a .gitignore for them. */
function fixture(files: Record<string, string>, ignored: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "draft-"));
  roots.push(root);
  const all = { ...files, ...(Object.keys(ignored).length > 0 ? { ".gitignore": Object.keys(ignored).join("\n") } : {}), ...ignored };
  for (const [rel, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  return root;
}
const noMac: MacSeed = { versions: {}, services: {}, env_names: [] };
const notes = (d: { evidence: Array<{ source: string; note: string }> }) => d.evidence.map((e) => `${e.source}: ${e.note}`);

describe("draftEnvironment", () => {
  test("a pnpm app: pins, its lockfile, compose Postgres, the URL it reads and its checks", async () => {
    const root = fixture({
      "package.json": JSON.stringify({ packageManager: "pnpm@9.12.0+sha512.abc", scripts: { typecheck: "tsc -b", test: "vitest", dev: "vite" }, dependencies: { pg: "^8" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      ".nvmrc": "v20.11.1\n",
      "docker-compose.yml": "services:\n  db:\n    image: postgres:16-alpine\n  web:\n    build: .\n",
      ".env.example": "DATABASE_URL=\nSTRIPE_SECRET_KEY=\nAPP_NAME=demo\n",
      "src/db.ts": "export const url = process.env.DATABASE_URL;\n",
    });
    const draft = await draftEnvironment(root, { seed: noMac });
    const config = parseComputerConfig(draft.config);
    expect(config.setup.run).toEqual(["mise use -g node@20.11.1", "mise use -g pnpm@9.12.0", "pnpm install --frozen-lockfile"]);
    expect(config.setup.check).toEqual(["pnpm typecheck", "pnpm test"]);
    expect(config.setup.inputs).toEqual([".nvmrc", "package.json", "pnpm-lock.yaml"]);
    expect(config.services).toEqual({ postgres: "16" });
    expect(config.env).toEqual({ DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/postgres" });
    // DATABASE_URL is the computer's own; APP_NAME has a default; the key is a value to supply.
    expect(draft.secret_names).toEqual(["STRIPE_SECRET_KEY"]);
    expect(notes(draft)).toEqual(
      expect.arrayContaining(["repo: Node 20.11.1 from .nvmrc", "repo: pnpm 9.12.0 from package.json packageManager", "repo: Postgres 16 from docker-compose.yml", "repo: Checks from package.json: pnpm typecheck · pnpm test"]),
    );
  });

  test("this Mac fills what the repo doesn't say, and its services count only when the repo uses them", async () => {
    const root = fixture(
      { "package.json": JSON.stringify({ scripts: { test: "jest" }, dependencies: { pg: "^8" } }), "package-lock.json": "{}" },
      { ".env.local": "DATABASE_URL=postgres://me:pw@localhost/app\nOPENAI_API_KEY=sk-test\nEMPTY=\n" },
    );
    const seed: MacSeed = { versions: { node: "22.11.0" }, services: { postgres: "16", redis: "7" }, env_names: ["DATABASE_URL", "OPENAI_API_KEY"] };
    const draft = await draftEnvironment(root, { seed });
    const config = parseComputerConfig(draft.config);
    expect(config.setup.run).toEqual(["mise use -g node@22.11.0", "npm ci"]);
    expect(config.setup.check).toEqual(["npm test"]);
    expect(config.services).toEqual({ postgres: "16" });
    expect(config.env.DATABASE_URL).toContain("127.0.0.1:5432");
    expect(draft.secret_names).toEqual(["OPENAI_API_KEY"]);
    expect(notes(draft)).toEqual(expect.arrayContaining(["mac: Node 22.11.0 from this Mac", "mac: Postgres 16 running on this Mac", "mac: 2 env names in this Mac's git-ignored .env files"]));
    // Never a value, never this Mac's path.
    expect(JSON.stringify(draft)).not.toContain("sk-test");
    expect(JSON.stringify(draft)).not.toContain(root);
  });

  test("package.json engines is a floor: CI's exact version and this Mac's real one win over it", async () => {
    const pkg = JSON.stringify({ engines: { node: ">=18" }, scripts: { test: "vitest" } });
    const workflow = "jobs:\n  test:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22.12.0\n";
    const nodeOf = async (files: Record<string, string>, seed: MacSeed) => parseComputerConfig((await draftEnvironment(fixture(files), { seed })).config).setup.run?.[0];
    expect(await nodeOf({ "package.json": pkg, "package-lock.json": "{}", ".github/workflows/ci.yml": workflow }, { ...noMac, versions: { node: "20.19.0" } })).toBe("mise use -g node@22.12.0");
    expect(await nodeOf({ "package.json": pkg, "package-lock.json": "{}" }, { ...noMac, versions: { node: "20.19.0" } })).toBe("mise use -g node@20.19.0");
    // Nothing else says: the range's floor.
    expect(await nodeOf({ "package.json": pkg, "package-lock.json": "{}" }, noMac)).toBe("mise use -g node@18");
  });

  test("CI: setup-* versions and service containers; uv brings its own Python", async () => {
    const root = fixture({
      "pyproject.toml": "[project]\nname = 'x'\ndependencies = ['redis>=5']\n",
      "uv.lock": "version = 1\n",
      ".github/workflows/ci.yml": [
        "jobs:",
        "  test:",
        "    services:",
        "      cache:",
        "        image: redis:7.2-alpine",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - uses: actions/setup-python@v5",
        "        with:",
        "          python-version: '3.12'",
        "      - run: uv run pytest",
      ].join("\n"),
      "AGENTS.md": "Run `uv run pytest -q` before you push. Never `uv run pytest --watch`.\n",
    });
    const draft = await draftEnvironment(root, { seed: noMac });
    const config = parseComputerConfig(draft.config);
    expect(config.setup.run).toEqual(["uv sync --frozen"]);
    expect(config.setup.check).toEqual(["uv run pytest -q"]);
    expect(config.services).toEqual({ redis: "7" });
    expect(notes(draft)).toEqual(expect.arrayContaining(["ci: Redis 7 from ci.yml", "repo: Checks from AGENTS.md: uv run pytest -q"]));
  });

  test("a devcontainer: JSONC, feature versions, a postCreateCommand that runs without root, its compose file", async () => {
    const root = fixture({
      ".devcontainer/devcontainer.json": `{
        // comments are fine
        "dockerComposeFile": "../compose.dev.yml",
        "features": { "ghcr.io/devcontainers/features/node:1": { "version": "20" }, },
        "postCreateCommand": { "deps": "pnpm install", "os": "sudo apt-get install -y libvips" },
        "forwardPorts": [3000],
      }`,
      "compose.dev.yml": "services:\n  db:\n    image: docker.io/library/postgres:15\n",
      "package.json": JSON.stringify({ scripts: { lint: "eslint ." } }),
      "pnpm-lock.yaml": "lockfileVersion: '6.0'\n",
    });
    const draft = await draftEnvironment(root, { seed: noMac });
    const config = parseComputerConfig(draft.config);
    expect(config.setup.run).toEqual(["mise use -g node@20", "mise use -g pnpm@8", "pnpm install --frozen-lockfile", "pnpm install"]);
    expect(config.setup.check).toEqual(["pnpm lint"]);
    expect(config.services).toEqual({ postgres: "15" });
    expect(notes(draft)).toEqual(expect.arrayContaining(["devcontainer: Node 20 from its node feature", "devcontainer: Forwards port 3000", "devcontainer: Its postCreateCommand: pnpm install"]));
  });

  test("a devcontainer's command keeps a comma before a bracket inside its string; only JSONC's own trailing commas go", async () => {
    const command = `echo '{"a": [1, ], "b": {"c": 2, }}' > seed.json`;
    const root = fixture({
      ".devcontainer/devcontainer.json": `{
        // JSONC, with trailing commas of its own
        "postCreateCommand": ${JSON.stringify(command)},
        "forwardPorts": [3000, /* web */ ],
      }`,
    });
    const draft = await draftEnvironment(root, { seed: noMac });
    expect(parseComputerConfig(draft.config).setup.run).toEqual([command]);
    expect(notes(draft)).toEqual(expect.arrayContaining(["devcontainer: Forwards port 3000"]));
  });

  test("a repo that pins with mise or asdf: mise install, without the database it pins as a tool", async () => {
    const root = fixture({ ".tool-versions": "golang 1.23.1\nnodejs 22.1.0\npostgres 16.2\n", "go.mod": "module x\n\ngo 1.23.1\n", "Makefile": "test:\n\tgo test ./...\nlint:\n\tgolangci-lint run\n" });
    const draft = await draftEnvironment(root, { seed: noMac });
    const config = parseComputerConfig(draft.config);
    expect(config.setup.run).toEqual(["mise trust --all", "mise install golang nodejs", "go mod download"]);
    expect(config.setup.check).toEqual(["make test", "make lint"]);
  });

  test("a service the install doesn't offer is left out; a version it doesn't offer moves to one it does", async () => {
    const root = fixture({ "docker-compose.yaml": "services:\n  a:\n    image: mysql:8\n  b:\n    image: postgres:13\n" });
    const draft = await draftEnvironment(root, { seed: noMac, offered: { postgres: ["15", "16", "17"], redis: ["7"] } });
    expect(parseComputerConfig(draft.config).services).toEqual({ postgres: "15" });
    expect(notes(draft)).toEqual(
      expect.arrayContaining(["repo: needs Docker: a (mysql:8); this install doesn't offer MySQL", "repo: Postgres 13 isn't offered; using 15 from docker-compose.yaml"]),
    );
  });

  test("compose services map onto the install's by image; the rest is named as a gap", async () => {
    // What the chart offers (lane C2): no OpenSearch, and Kafka's API from Apache Kafka (Redpanda doesn't run under gVisor).
    const offered = {
      postgres: ["15", "16", "17"],
      redis: ["7"],
      mysql: ["8.4"],
      mariadb: ["11.4"],
      mongodb: ["7", "8"],
      minio: ["latest"],
      kafka: ["4.3"],
      mailpit: ["1"],
    };
    const compose = [
      "services:",
      "  app:",
      "    build: .",
      "    environment:",
      "      DATABASE_URL: postgres://db:5432/app",
      "      - ignored",
      "  db:",
      "    image: postgis/postgis:16-3.4",
      "    environment:",
      "      POSTGRES_PASSWORD: secret-pw",
      "  cache:",
      "    image: valkey/valkey:8",
      "  docs:",
      "    image: mongo:7.0",
      "  files:",
      "    image: minio/minio:RELEASE.2024-06-13T22-53-53Z",
      "  search:",
      "    image: docker.elastic.co/elasticsearch/elasticsearch:8.13.0",
      "  zk:",
      "    image: confluentinc/cp-zookeeper:7.6.0",
      "  kafka:",
      "    image: redpandadata/redpanda:v24.2.7",
      "  mail:",
      "    image: mailhog/mailhog",
      "  aws:",
      "    image: localstack/localstack:3",
      "  worker:",
      "    image: node:22",
    ].join("\n");
    const root = fixture({
      "docker-compose.yml": compose.replace("      - ignored\n", ""),
      ".devcontainer/docker-compose.yml": "services:\n  sql:\n    image: mariadb:${MARIADB_VERSION:-10.11}\n",
      ".env.example":
        "REDIS_URL=redis://localhost:6379\nMONGODB_URI=\nS3_ENDPOINT=http://localhost:9000\nMINIO_ROOT_PASSWORD=\nELASTICSEARCH_URL=http://localhost:9200\nKAFKA_BROKERS=localhost:9092\nSMTP_HOST=localhost\nSMTP_PORT=1025\n",
      "package.json": JSON.stringify({ dependencies: { pg: "^8" } }),
      "package-lock.json": "{}",
    });
    const draft = await draftEnvironment(root, { seed: noMac, offered });
    const config = parseComputerConfig(draft.config);
    expect(config.services).toEqual({ postgres: "16", redis: "7", mongodb: "7", minio: "latest", kafka: "4.3", mailpit: "1", mariadb: "11.4" });
    // Only the names the repo reads, each the service's loopback address; DATABASE_URL is Postgres's, not MariaDB's or MongoDB's.
    expect(config.env).toEqual({
      DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/postgres",
      MONGODB_URI: "mongodb://127.0.0.1:27017",
      REDIS_URL: "redis://127.0.0.1:6379",
      S3_ENDPOINT: "http://127.0.0.1:9000",
      MINIO_ROOT_PASSWORD: "minioadmin",
      KAFKA_BROKERS: "127.0.0.1:9092",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: "1025",
    });
    expect(draft.secret_names).toEqual([]);
    expect(notes(draft)).toEqual(
      expect.arrayContaining([
        "repo: Postgres 16 from docker-compose.yml",
        "repo: postgis/postgis:16-3.4 runs as Postgres: the PostGIS extension may not be in the install's Postgres",
        "repo: MongoDB 7 from docker-compose.yml",
        "repo: Kafka 4.3 from docker-compose.yml",
        "repo: redpandadata/redpanda:v24.2.7 runs as Kafka: Kafka API from Apache Kafka 4.3",
        "repo: ZooKeeper (zk) isn't needed: the install's Kafka runs without it (KRaft)",
        "repo: needs Docker: aws (localstack/localstack:3)",
        "devcontainer: MariaDB 10.11 isn't offered; using 11.4 from .devcontainer/docker-compose.yml",
      ]),
    );
    // Search has no service on this install: a gap, and no [env] for it. The app's own services (built here, a
    // language image) are no gap; a value never leaves a compose file.
    expect(notes(draft).filter((n) => n.includes("needs Docker"))).toEqual([
      "repo: needs Docker: search (docker.elastic.co/elasticsearch/elasticsearch:8.13.0); this install doesn't offer OpenSearch",
      "repo: needs Docker: aws (localstack/localstack:3)",
    ]);
    expect(JSON.stringify(draft)).not.toContain("secret-pw");
    expect(JSON.stringify(draft)).not.toContain("db:5432");

    // An install that offers none of them: each is a gap, and no [env] points at a service that isn't there.
    const bare = await draftEnvironment(root, { seed: noMac, offered: { postgres: ["16"] } });
    expect(parseComputerConfig(bare.config).services).toEqual({ postgres: "16" });
    expect(parseComputerConfig(bare.config).env).toEqual({ DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/postgres" });
    expect(notes(bare)).toEqual(expect.arrayContaining(["repo: needs Docker: docs (mongo:7.0); this install doesn't offer MongoDB"]));
    // A blank or secret-looking example name the computer can't satisfy stays a value to supply.
    expect(bare.secret_names).toEqual(["MINIO_ROOT_PASSWORD", "MONGODB_URI", "REDIS_URL"]);
    // An install that offers OpenSearch gets Elasticsearch's images, with what that can't promise.
    const search = await draftEnvironment(root, { seed: noMac, offered: { ...offered, opensearch: ["2"] } });
    expect(parseComputerConfig(search.config).services.opensearch).toBe("2");
    expect(parseComputerConfig(search.config).env.ELASTICSEARCH_URL).toBe("http://127.0.0.1:9200");
    expect(notes(search)).toEqual(
      expect.arrayContaining([
        "repo: docker.elastic.co/elasticsearch/elasticsearch:8.13.0 runs as OpenSearch: OpenSearch answers Elasticsearch 7.10's API; Elasticsearch's own clients from 7.14 on refuse a server that isn't Elastic's",
      ]),
    );
  });

  test("apt-get in CI, Dockerfiles and a devcontainer becomes [system] packages, less what the image has", async () => {
    const root = fixture({
      "Gemfile": "source 'https://rubygems.org'\ngem 'pg'\n",
      ".github/workflows/ci.yml": [
        "jobs:",
        "  test:",
        "    steps:",
        "      - run: |",
        "          sudo apt-get update",
        "          sudo apt-get install -y --no-install-recommends \\",
        "            libpq-dev=15.* \\",
        "            libvips-dev ffmpeg build-essential # tools",
        "      - uses: awalsh128/cache-apt-pkgs-action@v1",
        "        with:",
        "          packages: graphviz, poppler-utils",
      ].join("\n"),
      "Dockerfile": "FROM ruby:3.3\nRUN apt-get update -qq && apt-get install -y libjemalloc2 curl ca-certificates libxml2-dev && rm -rf /var/lib/apt/lists/*\n",
      ".devcontainer/devcontainer.json": JSON.stringify({ build: { dockerfile: "Dockerfile" }, onCreateCommand: "sudo apt install -y protobuf-compiler" }),
      ".devcontainer/Dockerfile": "FROM mcr.microsoft.com/devcontainers/ruby:3.3\nRUN apt-get -y install imagemagick libmagickwand-dev cmake\n",
    });
    const draft = await draftEnvironment(root, { seed: noMac });
    const config = parseComputerConfig(draft.config);
    expect(config.system.packages).toEqual(["cmake", "ffmpeg", "graphviz", "libpq", "libxml2", "poppler", "protobuf"]);
    expect(draft.config).toContain("[system]\npackages = [");
    expect(notes(draft)).toEqual(
      expect.arrayContaining([
        "ci: System packages for apt-get in ci.yml: libpq (libpq-dev), ffmpeg, graphviz, poppler (poppler-utils)",
        "ci: Already on the computer image: libvips-dev, build-essential (it has a compiler) from ci.yml",
        "repo: System packages for apt-get in Dockerfile: libxml2 (libxml2-dev)",
        "repo: No conda-forge match for apt's libjemalloc2 from Dockerfile: add its conda-forge name to [system] if setup needs it",
        "devcontainer: System packages for apt-get in its onCreateCommand and .devcontainer/Dockerfile: protobuf (protobuf-compiler), cmake",
        "devcontainer: Already on the computer image: imagemagick, libmagickwand-dev from .devcontainer/Dockerfile",
      ]),
    );
    // apt's own plumbing is never named.
    expect(JSON.stringify(draft.evidence)).not.toMatch(/curl|ca-certificates/);
  });

  test("a draft without the code: no git grep, names from .env.example and compose only", async () => {
    const root = fixture({ "src/app.ts": "process.env.REDIS_URL;\n", "compose.yaml": "services:\n  r:\n    image: redis:7\n", "package.json": "{}" });
    expect(parseComputerConfig((await draftEnvironment(root, { seed: noMac })).config).env).toEqual({ REDIS_URL: "redis://127.0.0.1:6379" });
    expect(parseComputerConfig((await draftEnvironment(root, { readCode: false })).config).env).toEqual({});
  });

  test("an empty repo drafts an empty setup that still parses", async () => {
    const draft = await draftEnvironment(fixture({ "README.md": "hi" }), { seed: noMac });
    expect(parseComputerConfig(draft.config).setup).toEqual({});
    expect(draft.secret_names).toEqual([]);
  });

  test("a pin file that is a symlink out of the repo is never read", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    roots.push(outside);
    fs.writeFileSync(path.join(outside, "v"), "18.0.0\n");
    const root = fixture({ "package.json": "{}", "package-lock.json": "{}" });
    fs.symlinkSync(path.join(outside, "v"), path.join(root, ".nvmrc"));
    expect((await draftEnvironment(root, { seed: noMac })).config).not.toContain("node@18");
  });
});

describe("helpers", () => {
  test("images, versions, JSONC", () => {
    expect(serviceOfImage("postgres:16-alpine")).toEqual({ name: "postgres", version: "16" });
    expect(serviceOfImage("pgvector/pgvector:pg17")).toMatchObject({ name: "postgres", version: "17" });
    expect(serviceOfImage("ghcr.io/acme/redis:7")).toEqual({ name: "redis", version: "7" });
    expect(serviceOfImage("valkey/valkey:9-alpine")).toEqual({ name: "redis", version: "" });
    expect(serviceOfImage("node:22")).toBeUndefined();
    expect(serviceOfImage("mysql:8.0.36")).toEqual({ name: "mysql", version: "8.0" });
    expect(serviceOfImage("bitnami/mariadb:11.4")).toEqual({ name: "mariadb", version: "11.4" });
    expect(serviceOfImage("redpandadata/redpanda:v24.2.7")).toEqual({ name: "kafka", version: "", caveat: "Kafka API from Apache Kafka 4.3" });
    expect(serviceOfImage("apache/kafka:3.8.0")).toEqual({ name: "kafka", version: "3.8" });
    expect(serviceOfImage("bitnami/kafka:3.7")).toEqual({ name: "kafka", version: "3.7" });
    expect(serviceOfImage("confluentinc/cp-kafka:7.6.0")).toEqual({ name: "kafka", version: "" });
    expect(serviceOfImage("opensearchproject/opensearch:2.13.0")).toEqual({ name: "opensearch", version: "2.13" });
    expect(serviceOfImage("axllent/mailpit:v1.20")).toEqual({ name: "mailpit", version: "1.20" });
    expect(serviceOfImage("eqalpha/keydb")).toEqual({ name: "redis", version: "" });
    expect(serviceOfImage("postgres:${PG:-15}-alpine")).toEqual({ name: "postgres", version: "15" });
    expect(serviceOfImage("localstack/localstack")).toBeUndefined();
    expect(aptPackages("apt-get -qq install -y -o Dpkg::Options::=--force-confold libpq-dev:amd64 \"ffmpeg\" $EXTRA && echo done")).toEqual(["libpq-dev", "ffmpeg"]);
    expect(aptPackages("apt-get update; apt list --installed; apt-cache show x")).toEqual([]);
    expect(nearestOffered("", ["15", "16", "17"])).toBe("16");
    expect(nearestOffered("18", ["15", "16", "17"])).toBe("17");
    // A series names its newest; a minor between offered ones moves up.
    expect(nearestOffered("8", ["8.0", "8.4"])).toBe("8.4");
    expect(nearestOffered("8.0", ["8.0", "8.4"])).toBe("8.0");
    expect(nearestOffered("16.2", ["15", "16", "17"])).toBe("16");
    expect(nearestOffered("5.7", ["8.0", "8.4"])).toBe("8.0");
    expect(nearestOffered("10.11", ["10.6", "11.4"])).toBe("11.4");
    // The chart's keys (lane C2): mysql 8.4, mariadb 11.4, mongodb 7 and 8, minio latest, kafka 4.3, mailpit 1.
    expect(nearestOffered("8.0", ["8.4"])).toBe("8.4");
    expect(nearestOffered("8", ["8.4"])).toBe("8.4");
    expect(nearestOffered("10.11", ["11.4"])).toBe("11.4");
    expect(nearestOffered("7.0", ["7", "8"])).toBe("7");
    expect(nearestOffered("6.0", ["7", "8"])).toBe("7");
    expect(nearestOffered("", ["7", "8"])).toBe("7");
    expect(nearestOffered("", ["latest"])).toBe("latest");
    expect(nearestOffered("3.8", ["4.3"])).toBe("4.3");
    expect(nearestOffered("1.20", ["1"])).toBe("1");
    expect(JSON.parse(stripJsonComments('{"a": "http://x", /* c */ "b": [1,],}'))).toEqual({ a: "http://x", b: [1] });
    expect(JSON.parse(stripJsonComments('{"a": "x ,]", "b": "y, }", "c": [1, // c\n ], "d": "\\\\", }'))).toEqual({ a: "x ,]", b: "y, }", c: [1], d: "\\" });
  });

  test("the Mac seed: shell answers after the marker, lsof and docker services, .env names", async () => {
    const root = fixture({ "package.json": "{}", "pnpm-lock.yaml": "" }, { ".env.local": "A_KEY=1\nB=\n" });
    const calls: string[] = [];
    const exec = async (file: string, args: string[], options: { cwd?: string }) => {
      calls.push([file, ...args].join(" "));
      if (file === "/bin/zsh") return args[1]!.includes("node -v") ? "Welcome 2026.10.18\n@@caveman-version@@\nv22.11.0\n" : "noise 1.2.3\n@@caveman-version@@\n9.12.0\n";
      if (file === "lsof") return "p101\ncpostgres\nn127.0.0.1:5432\np202\ncredis-ser\nn*:6379\n";
      if (file === "ps") return args.includes("101") ? "/opt/homebrew/opt/postgresql@16/bin/postgres -D /x\n" : "/opt/homebrew/bin/redis-server *:6379\n";
      if (file === "/opt/homebrew/bin/redis-server") return "Redis server v=7.2.4 sha=0\n";
      if (file === "docker") return "";
      if (file === "git") return options.cwd === undefined ? ".env.local\n" : "";
      return "";
    };
    const seed = await readMacSeed(root, { shell: "/bin/zsh", exec });
    expect(seed).toEqual({ versions: { node: "22.11.0", pnpm: "9.12.0" }, services: { postgres: "16", redis: "7" }, env_names: ["A_KEY"] });
    expect(calls.filter((c) => c.startsWith("/bin/zsh"))).toHaveLength(2);
    expect(await servicesFrom("", "postgres:17|0.0.0.0:5432->5432/tcp\nredis:7|", exec)).toEqual({ postgres: "17" });
  });
});
