// A chat folder that holds a worktree per source: one checkpoint covers every source, with real git.
// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CheckpointRef } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, describe, expect, test } from "vitest";

import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import { parseTurnDiffFilesFromNumstat } from "./Diffs.ts";
import {
  prefixNumstat,
  prefixPatch,
  readSourceRoot,
  removeSourceRoot,
  sourcesManifestPath,
  splitSourcePath,
  writeSourceRoot,
} from "./SourceRoots.ts";

const vcsProcess = VcsProcess.layer.pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const layer = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(vcsProcess))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "caveman-source-roots-" }),
  ),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const run = <A, E>(effect: Effect.Effect<A, E, CheckpointStore.CheckpointStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped) as Effect.Effect<A, E>);
const store = <A, E>(
  use: (store: CheckpointStore.CheckpointStore["Service"]) => Effect.Effect<A, E>,
) => run(Effect.flatMap(CheckpointStore.CheckpointStore, use));

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const roots: Array<string> = [];
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** A chat folder with a worktree of two repositories, `api` and `web`, each holding one committed file. */
function chatFolder() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "caveman-source-roots-")));
  roots.push(base);
  const chat = path.join(base, "chat");
  fs.mkdirSync(chat);
  for (const name of ["api", "web"]) {
    const repo = path.join(base, `${name}-repo`);
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    fs.writeFileSync(path.join(repo, "readme.md"), `${name}\n`);
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "init");
    git(repo, "worktree", "add", "-q", "-b", "caveman/chat", path.join(chat, name));
  }
  writeSourceRoot(chat, ["api", "web"]);
  return { base, chat, api: path.join(chat, "api"), web: path.join(chat, "web") };
}
const ref = (name: string) =>
  CheckpointRef.make(`refs/t3/orchestration-v2/checkpoints/test/ordinal/${name}`);

describe("a chat folder's manifest", () => {
  test("names its sources, the primary first, and only folders right inside it", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-source-manifest-"));
    roots.push(base);
    const chat = path.join(base, "chat");
    fs.mkdirSync(chat);
    expect(readSourceRoot(chat)).toBeUndefined();
    writeSourceRoot(chat, ["api", "web"]);
    expect(readSourceRoot(chat)).toEqual(["api", "web"]);
    expect(sourcesManifestPath(chat)).toBe(`${chat}.sources.json`);
    expect(fs.readdirSync(chat)).toEqual([]);
    // A manifest someone else wrote can never point outside the folder.
    fs.writeFileSync(
      sourcesManifestPath(chat),
      JSON.stringify({ sources: ["../elsewhere", "a/b", "..", "ok", 3] }),
    );
    expect(readSourceRoot(chat)).toEqual(["ok"]);
    removeSourceRoot(chat);
    expect(readSourceRoot(chat)).toBeUndefined();
  });

  test("a path from the chat's folder names its source", () => {
    expect(splitSourcePath(["api", "web"], "api/src/a.ts")).toEqual({
      name: "api",
      path: "src/a.ts",
    });
    expect(splitSourcePath(["api", "web"], "./web/b.ts")).toEqual({ name: "web", path: "b.ts" });
    expect(splitSourcePath(["api", "web"], "other/b.ts")).toBeUndefined();
    expect(splitSourcePath(["api", "web"], "api")).toEqual({ name: "api", path: "" });
  });
});

describe("git's output of one source, read from the chat's folder", () => {
  test("numstat, with a rename", () => {
    expect(prefixNumstat("1\t0\tsrc/a.ts\0-\t-\tlogo.png\0", "api")).toBe(
      "1\t0\tapi/src/a.ts\0-\t-\tapi/logo.png\0",
    );
    const renamed = prefixNumstat("2\t1\t\0old name.ts\0new name.ts\0", "web");
    expect(parseTurnDiffFilesFromNumstat(renamed)).toEqual([
      { path: "web/new name.ts", previousPath: "web/old name.ts", additions: 2, deletions: 1 },
    ]);
    expect(prefixNumstat("", "api")).toBe("");
  });

  test("a patch's headers, and never a line of a hunk", () => {
    const patch = [
      "diff --git a/src/a b.ts b/src/a b.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a b.ts",
      "+++ b/src/a b.ts",
      "@@ -1,3 +1,3 @@",
      " keep",
      "--- a/not a header",
      "+++ b/not a header either",
      " keep",
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
      "new file mode 100644",
      "--- /dev/null",
      '+++ "b/caf\\303\\251.ts"',
      "@@ -0,0 +1 @@",
      "+diff --git a/x b/x",
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
      "",
    ].join("\n");
    expect(prefixPatch(patch, "api").split("\n")).toEqual([
      "diff --git a/api/src/a b.ts b/api/src/a b.ts",
      "index 1111111..2222222 100644",
      "--- a/api/src/a b.ts",
      "+++ b/api/src/a b.ts",
      "@@ -1,3 +1,3 @@",
      " keep",
      "--- a/not a header",
      "+++ b/not a header either",
      " keep",
      "diff --git a/api/old.ts b/api/new.ts",
      "similarity index 90%",
      "rename from api/old.ts",
      "rename to api/new.ts",
      'diff --git "a/api/caf\\303\\251.ts" "b/api/caf\\303\\251.ts"',
      "new file mode 100644",
      "--- /dev/null",
      '+++ "b/api/caf\\303\\251.ts"',
      "@@ -0,0 +1 @@",
      "+diff --git a/x b/x",
      "diff --git a/api/logo.png b/api/logo.png",
      "Binary files a/api/logo.png and b/api/logo.png differ",
      "",
    ]);
  });
});

describe("a checkpoint of a chat folder", () => {
  test("covers every source, diffs as one, and restores them together", async () => {
    const { chat, api, web } = chatFolder();
    expect(await store((s) => s.isGitRepository(chat))).toBe(true);
    await store((s) => s.captureCheckpoint({ cwd: chat, checkpointRef: ref("0") }));
    expect(await store((s) => s.hasCheckpointRef({ cwd: chat, checkpointRef: ref("0") }))).toBe(
      true,
    );
    // The same ref name in each source's own repository.
    for (const source of [api, web])
      expect(git(source, "rev-parse", "--verify", "--quiet", ref("0"))).toMatch(/^[0-9a-f]{40}$/);

    fs.writeFileSync(path.join(api, "readme.md"), "api\nchanged\n");
    fs.writeFileSync(path.join(web, "new.txt"), "made\n");
    await store((s) => s.captureCheckpoint({ cwd: chat, checkpointRef: ref("1") }));

    const numstat = await store((s) =>
      s.diffCheckpoints({
        cwd: chat,
        fromCheckpointRef: ref("0"),
        toCheckpointRef: ref("1"),
        ignoreWhitespace: false,
        format: "numstat",
      }),
    );
    expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
      { path: "api/readme.md", additions: 1, deletions: 0 },
      { path: "web/new.txt", additions: 1, deletions: 0 },
    ]);
    const patch = await store((s) =>
      s.diffCheckpoints({
        cwd: chat,
        fromCheckpointRef: ref("0"),
        toCheckpointRef: ref("1"),
        ignoreWhitespace: false,
      }),
    );
    expect(patch).toContain("diff --git a/api/readme.md b/api/readme.md");
    expect(patch).toContain("+++ b/web/new.txt");
    // Only the paths asked for, each in its own source.
    const one = await store((s) =>
      s.diffCheckpoints({
        cwd: chat,
        fromCheckpointRef: ref("0"),
        toCheckpointRef: ref("1"),
        ignoreWhitespace: false,
        format: "numstat",
        filePaths: ["web/new.txt"],
      }),
    );
    expect(parseTurnDiffFilesFromNumstat(one).map((file) => file.path)).toEqual(["web/new.txt"]);
    // HEAD moved in neither source, so every changed path is the turn's.
    expect(
      await store((s) =>
        s.listAuthoredPaths({ cwd: chat, fromCheckpointRef: ref("0"), toCheckpointRef: ref("1") }),
      ),
    ).toBeNull();

    expect(
      await store((s) => s.restoreCheckpoint({ cwd: chat, checkpointRef: ref("0"), dryRun: true })),
    ).toBe(true);
    expect(fs.existsSync(path.join(web, "new.txt"))).toBe(true);
    expect(await store((s) => s.restoreCheckpoint({ cwd: chat, checkpointRef: ref("0") }))).toBe(
      true,
    );
    expect(fs.readFileSync(path.join(api, "readme.md"), "utf8")).toBe("api\n");
    expect(fs.existsSync(path.join(web, "new.txt"))).toBe(false);
    // No ref of the restore's own is left behind.
    for (const source of [api, web])
      expect(git(source, "for-each-ref", "refs/caveman/restore-undo")).toBe("");

    await store((s) => s.deleteCheckpointRefs({ cwd: chat, checkpointRefs: [ref("0"), ref("1")] }));
    expect(await store((s) => s.hasCheckpointRef({ cwd: chat, checkpointRef: ref("0") }))).toBe(
      false,
    );
    for (const source of [api, web]) expect(git(source, "for-each-ref", "refs/t3")).toBe("");
  });

  test("is taken in every source or in none", async () => {
    const { chat, api, web } = chatFolder();
    // The primary's repository cannot take the ref (a ref of that name's parent is in its way): the others' is taken back.
    git(api, "update-ref", "refs/t3/orchestration-v2/checkpoints/test/ordinal", "HEAD");
    const failed = await store((s) =>
      s.captureCheckpoint({ cwd: chat, checkpointRef: ref("0") }).pipe(
        Effect.as(false),
        Effect.orElseSucceed(() => true),
      ),
    );
    expect(failed).toBe(true);
    expect(await store((s) => s.hasCheckpointRef({ cwd: chat, checkpointRef: ref("0") }))).toBe(
      false,
    );
    expect(git(web, "for-each-ref", "refs/t3")).toBe("");
  });

  test("is restored in every source or in none", async () => {
    const { chat, api, web } = chatFolder();
    await store((s) => s.captureCheckpoint({ cwd: chat, checkpointRef: ref("0") }));
    fs.writeFileSync(path.join(api, "readme.md"), "api\nlater\n");
    fs.writeFileSync(path.join(web, "readme.md"), "web\nlater\n");
    fs.writeFileSync(path.join(api, "untracked.txt"), "made since\n");
    // web's restore fails once api's has gone back (its checks pass; the restore itself does not).
    const outcome = await store((s) =>
      CheckpointStore.overSources({
        ...s,
        restoreCheckpoint: (input) =>
          input.cwd === web && input.dryRun !== true && input.checkpointRef === ref("0")
            ? Effect.succeed(false)
            : s.restoreCheckpoint(input),
      })
        .restoreCheckpoint({ cwd: chat, checkpointRef: ref("0") })
        .pipe(Effect.orElseSucceed(() => "failed" as const)),
    );
    expect(outcome).toBe("failed");
    // Neither source went back: api is as it was before the restore began, the file made since included.
    expect(fs.readFileSync(path.join(api, "readme.md"), "utf8")).toBe("api\nlater\n");
    expect(fs.readFileSync(path.join(api, "untracked.txt"), "utf8")).toBe("made since\n");
    expect(fs.readFileSync(path.join(web, "readme.md"), "utf8")).toBe("web\nlater\n");
    for (const source of [api, web])
      expect(git(source, "for-each-ref", "refs/caveman/restore-undo")).toBe("");
  });

  test("a restore one source's checks refuse changes nothing", async () => {
    const { chat, api, web } = chatFolder();
    await store((s) => s.captureCheckpoint({ cwd: chat, checkpointRef: ref("0") }));
    fs.writeFileSync(path.join(api, "readme.md"), "api\nlater\n");
    const outcome = await store((s) =>
      CheckpointStore.overSources({
        ...s,
        restoreCheckpoint: (input) =>
          input.cwd === web && input.dryRun === true
            ? Effect.succeed(false)
            : s.restoreCheckpoint(input),
      }).restoreCheckpoint({ cwd: chat, checkpointRef: ref("0") }),
    );
    expect(outcome).toBe(false);
    expect(fs.readFileSync(path.join(api, "readme.md"), "utf8")).toBe("api\nlater\n");
  });

  test("a source added later is left as it is by a restore to an earlier checkpoint", async () => {
    const { base, chat, api } = chatFolder();
    await store((s) => s.captureCheckpoint({ cwd: chat, checkpointRef: ref("0") }));
    const docs = path.join(base, "docs-repo");
    fs.mkdirSync(docs);
    git(docs, "init", "-q", "-b", "main");
    git(docs, "config", "user.email", "test@example.com");
    git(docs, "config", "user.name", "Test");
    fs.writeFileSync(path.join(docs, "guide.md"), "guide\n");
    git(docs, "add", ".");
    git(docs, "commit", "-qm", "init");
    git(docs, "worktree", "add", "-q", "-b", "caveman/chat", path.join(chat, "docs"));
    writeSourceRoot(chat, ["api", "web", "docs"]);
    fs.writeFileSync(path.join(chat, "docs", "guide.md"), "guide\nedited\n");
    fs.writeFileSync(path.join(api, "readme.md"), "api\nedited\n");
    expect(await store((s) => s.restoreCheckpoint({ cwd: chat, checkpointRef: ref("0") }))).toBe(
      true,
    );
    expect(fs.readFileSync(path.join(api, "readme.md"), "utf8")).toBe("api\n");
    expect(fs.readFileSync(path.join(chat, "docs", "guide.md"), "utf8")).toBe("guide\nedited\n");
  });

  test("a folder that is one worktree is checkpointed as before", async () => {
    const { api } = chatFolder();
    await store((s) => s.captureCheckpoint({ cwd: api, checkpointRef: ref("solo") }));
    fs.writeFileSync(path.join(api, "readme.md"), "api\nsolo\n");
    await store((s) => s.captureCheckpoint({ cwd: api, checkpointRef: ref("solo-2") }));
    const numstat = await store((s) =>
      s.diffCheckpoints({
        cwd: api,
        fromCheckpointRef: ref("solo"),
        toCheckpointRef: ref("solo-2"),
        ignoreWhitespace: false,
        format: "numstat",
      }),
    );
    expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
      { path: "readme.md", additions: 1, deletions: 0 },
    ]);
  });
});
