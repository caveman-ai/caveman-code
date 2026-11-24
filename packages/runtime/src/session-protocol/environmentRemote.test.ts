import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, test } from "vitest";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { parseComputerConfig } from "./computerConfig.ts";
import { cloneFailure, draftFromGitHub } from "./environmentRemote.ts";
import { git, tempRoot } from "./testHarness.ts";

const layer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "sp-remote-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A bare repo (as GitHub serves one: partial clone allowed) holding `files`, and its file:// URL. */
function remote(files: Record<string, string>, links: Record<string, string> = {}): { url: string; root: string } {
  const root = tempRoot("sp-remote-");
  roots.push(root);
  const work = path.join(root, "work");
  fs.mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), text);
  }
  for (const [rel, target] of Object.entries(links)) fs.symlinkSync(target, path.join(work, rel));
  if (Object.keys(files).length + Object.keys(links).length > 0) {
    git(work, "add", ".");
    git(work, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");
  }
  execFileSync("git", ["clone", "-q", "--bare", work, path.join(root, "repo.git")]);
  git(path.join(root, "repo.git"), "config", "uploadpack.allowFilter", "true");
  return { url: `file://${path.join(root, "repo.git")}`, root };
}

/** Runs draftFromGitHub with the real git driver; `seen` gets the checkout's files right after git checks them out. */
const missing: string[] = [];
const draft = (url: string, temp: string, seen?: string[], offered?: Record<string, string[]>) =>
  Effect.runPromise(
    Effect.flatMap(GitVcsDriver.GitVcsDriver, (driver) => {
      const recording: typeof driver = {
        ...driver,
        execute: (input) =>
          driver.execute(input).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (seen && input.operation === "environment.draft.checkout") {
                  const files = execFileSync("git", ["ls-files", "-t"], { cwd: input.cwd, encoding: "utf8" });
                  // H: checked out; S: skipped by the sparse patterns.
                  for (const line of files.split("\n").filter((l) => l.startsWith("H "))) seen.push(line.slice(2));
                  // Blobs never fetched: everything outside the patterns.
                  const objects = execFileSync("git", ["rev-list", "--objects", "--missing=print", "HEAD"], { cwd: input.cwd, encoding: "utf8" });
                  missing.push(...objects.split("\n").filter((l) => l.startsWith("?")));
                }
              }),
            ),
          ),
      };
      return draftFromGitHub({ repo: "acme/app", cloneUrl: url, git: recording, tempRoot: temp, ...(offered ? { offered } : {}) }).pipe(Effect.result);
    }).pipe(Effect.provide(layer)),
  );

describe("draftFromGitHub", () => {
  test("drafts from the manifests alone, then deletes the checkout", async () => {
    const outside = tempRoot("sp-remote-outside-");
    roots.push(outside);
    fs.writeFileSync(path.join(outside, "devcontainer.json"), JSON.stringify({ postCreateCommand: "echo LEAKED" }));
    const { url, root } = remote(
      {
        "package.json": JSON.stringify({ packageManager: "pnpm@9.12.0", scripts: { test: "vitest" }, dependencies: { pg: "^8" } }),
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
        ".nvmrc": "22.11.0\n",
        "compose.yaml": "services:\n  db:\n    image: postgres:17\n  s3:\n    image: localstack/localstack\n",
        ".env.example": "DATABASE_URL=\nSTRIPE_SECRET_KEY=\n",
        ".github/workflows/ci.yml": "jobs:\n  t:\n    steps:\n      - run: sudo apt-get install -y libpq-dev ffmpeg\n",
        "src/server.ts": "process.env.OPENAI_API_KEY;\n",
        "assets/big.bin": "x".repeat(256 * 1024),
        "docs/README.md": "hello\n",
      },
      // A link out of the repo: it checks out as a plain file, never followed.
      { ".devcontainer": outside },
    );
    const temp = path.join(root, "drafts");
    const seen: string[] = [];
    const result = await draft(url, temp, seen);
    expect(result._tag).toBe("Success");
    const drafted = result._tag === "Success" ? result.success : undefined!;
    const config = parseComputerConfig(drafted.config);
    expect(config.setup.run).toEqual(["mise use -g node@22.11.0", "mise use -g pnpm@9.12.0", "pnpm install --frozen-lockfile"]);
    expect(config.setup.check).toEqual(["pnpm test"]);
    expect(config.services).toEqual({ postgres: "17" });
    expect(config.env).toEqual({ DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/postgres" });
    expect(config.system.packages).toEqual(["ffmpeg", "libpq"]);
    expect(drafted.secret_names).toEqual(["STRIPE_SECRET_KEY"]);
    expect(drafted.evidence.map((e) => e.note)).toContain("needs Docker: s3 (localstack/localstack)");
    // Only the manifests were checked out: no code, no assets, no docs.
    // The link isn't a directory, so it isn't checked out at all.
    expect(seen.sort()).toEqual([".env.example", ".github/workflows/ci.yml", ".nvmrc", "compose.yaml", "package.json", "pnpm-lock.yaml"]);
    // The code, the asset, the docs and the link never left the remote: four blobs missing.
    expect(missing).toHaveLength(4);
    // No Mac seed and no code search: nothing from this Mac or the code, and nothing through the link.
    expect(JSON.stringify(drafted)).not.toMatch(/OPENAI_API_KEY|LEAKED|this Mac/);
    expect(fs.readdirSync(temp)).toEqual([]);
  });

  test("a repo that isn't there, or is private without access: not_found, without the URL, and nothing left behind", async () => {
    const root = tempRoot("sp-remote-");
    roots.push(root);
    const temp = path.join(root, "drafts");
    const result = await draft(`file://${path.join(root, "missing.git")}`, temp);
    expect(result._tag).toBe("Failure");
    const error = result._tag === "Failure" ? result.failure : undefined!;
    expect(error.reason).toBe("not_found");
    expect(error.message).toContain("acme/app");
    expect(error.message).not.toContain(root);
    expect(fs.readdirSync(temp)).toEqual([]);
  });

  test("an empty repo has nothing to draft; a URL that isn't one is refused before git runs", async () => {
    const { url, root } = remote({});
    const temp = path.join(root, "drafts");
    const empty = await draft(url, temp);
    expect(empty._tag === "Failure" && empty.failure.reason).toBe("invalid_state");
    expect(fs.readdirSync(temp)).toEqual([]);
    for (const bad of ["ext::sh -c touch% /tmp/pwned", "--upload-pack=touch /tmp/pwned", "/local/path"]) {
      const refused = await draft(bad, temp);
      expect(refused._tag === "Failure" && refused.failure.reason, bad).toBe("invalid_params");
    }
  });

  test("git's errors in words a person can act on, with credentials out", () => {
    expect(cloneFailure("acme/app", "remote: Repository not found.\nfatal: repository 'https://github.com/acme/app.git/' not found\n").reason).toBe("not_found");
    expect(cloneFailure("acme/app", "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n").reason).toBe("not_found");
    const auth = cloneFailure("acme/app", "remote: Invalid username or token.\nfatal: Authentication failed for 'https://x-access-token:ghs_secret@github.com/acme/app.git/'\n");
    expect(auth.reason).toBe("forbidden");
    expect(auth.message).not.toContain("ghs_secret");
    expect(cloneFailure("acme/app", "fatal: unable to access 'https://github.com/acme/app.git/': Could not resolve host: github.com\n").reason).toBe("unavailable");
    const other = cloneFailure("acme/app", "fatal: something odd at https://u:ghp_token@github.com/acme/app.git\n");
    expect(other.reason).toBe("internal");
    expect(other.message).toBe("Couldn't clone acme/app: fatal: something odd at https://github.com/acme/app.git");
  });
});
