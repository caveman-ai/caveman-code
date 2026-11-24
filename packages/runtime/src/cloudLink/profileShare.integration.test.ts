// Skills and plugins shared by every computer a person uses, against the stand-in Cloud:
// two Macs, each with its own home and state, sync one profile both ways; a Cloud computer runs what both have.
// Writes over writes are refused and merged again, removals follow, what a sync replaces is kept, and an older
// Cloud (no shared writes) only merges what each Mac sends, writing nothing into any Mac.
import * as fs from "node:fs";
import * as path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { afterEach, expect, test } from "vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { layerSecretStore } from "../plugins/CredentialBroker.ts";
import * as ProjectSecretsLive from "../secrets/ProjectSecretsLive.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { tempRoot } from "../session-protocol/testHarness.ts";
import { CloudSyncState, macSync, type MacSync } from "./cloudSync.ts";
import { enroll } from "./identity.ts";
import { CloudComputer, CloudLinkState, linkDirOf } from "./index.ts";
import { applyProfile, writeProfileSkills, type Profile } from "./profile.ts";
import { readSyncFile, trashDir } from "./profileSync.ts";
import { startTestCloud } from "./testCloud.ts";

const scopes: Array<Scope.Closeable> = [];
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const scope of scopes.splice(0).reverse())
    await Effect.runPromise(Scope.close(scope, Exit.void));
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const runIn = <A, E>(context: Context.Context<any>, effect: Effect.Effect<A, E, any>) =>
  Effect.runPromise(Effect.provide(effect, context) as Effect.Effect<A, E, never>);

/** One Mac: its own home (as its runtime's process has it), state, settings and sync, enrolled with `cloud` as the same person. */
async function makeMac(
  cloud: Awaited<ReturnType<typeof startTestCloud>>,
  name: string,
  files: Record<string, string>,
) {
  const home = tempRoot(`share-${name}-home-`);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), text, { mode: rel.endsWith(".sh") ? 0o755 : 0o644 });
  }
  const saved = {
    HOME: process.env.HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CODEX_HOME: process.env.CODEX_HOME,
  };
  // macSync reads its home once, as it is made.
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  try {
    const scope = await Effect.runPromise(Scope.make());
    scopes.push(scope);
    const context = await Effect.runPromise(
      Layer.buildWithScope(
        Layer.mergeAll(layerSecretStore, ProjectSecretsLive.layer, ServerSettingsModule.layer).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(CloudLinkState, {}),
              Layer.succeed(CloudSyncState, { status: { state: "off", items: [] } }),
              Layer.succeed(CloudComputer, undefined),
            ),
          ),
          Layer.provideMerge(ServerSecretStore.layer),
          Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
          Layer.provideMerge(
            Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: `share-${name}-` })),
          ),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ) as Layer.Layer<any, unknown, never>,
        scope,
      ),
    );
    const stateDir = Context.get(context, ServerConfig.ServerConfig).stateDir;
    await enroll({
      dir: linkDirOf(stateDir),
      cloudUrl: cloud.url,
      bearer: cloud.state.personToken,
      name,
    });
    const side: MacSync = await runIn(context, macSync);
    const settings = Context.get(context, ServerSettingsModule.ServerSettingsService);
    return {
      home,
      stateDir,
      sync: () => runIn(context, side.pushProfile()),
      status: () => Context.get(context, CloudSyncState).status,
      plugins: () => runIn(context, settings.getSettings.pipe(Effect.map((s) => s.plugins))),
      setPlugins: (
        plugins: NonNullable<Parameters<typeof settings.updateSettings>[0]["plugins"]>,
      ) => runIn(context, settings.updateSettings({ plugins })),
      file: (rel: string) =>
        fs.existsSync(path.join(home, rel))
          ? fs.readFileSync(path.join(home, rel), "utf8")
          : undefined,
      write: (rel: string, text: string) => {
        fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
        fs.writeFileSync(path.join(home, rel), text);
      },
    };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const skillMd = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: ${name}.\n---\n${body}\n`;
const held = (cloud: Awaited<ReturnType<typeof startTestCloud>>) =>
  cloud.state.parity.profile?.profile as Profile | undefined;
const skillNames = (cloud: Awaited<ReturnType<typeof startTestCloud>>) =>
  (held(cloud)?.skills ?? []).map((s) => s.name);
const puts = (cloud: Awaited<ReturnType<typeof startTestCloud>>) =>
  cloud.state.parity.requests.filter((r) => r.method === "PUT" && r.path.endsWith("/profile"))
    .length;

test.skipIf(process.platform === "win32")(
  "a skill or plugin made on one Mac reaches the other and the Cloud computers; edits and removals follow; nothing is lost when both change at once",
  async () => {
    const cloud = await startTestCloud();
    cleanups.push(cloud.close);
    // Shared profiles (v3): a stale write is refused with 412, which Cloud does not do yet.
    cloud.state.parity.legacyProfiles = false;
    const a = await makeMac(cloud, "a", {
      ".claude/skills/review/SKILL.md": skillMd("review", "Review the diff."),
      ".claude/skills/review/scripts/check.sh": "#!/bin/sh\necho checked\n",
      ".agents/skills/notes/SKILL.md": skillMd("notes", "Take notes."),
    });
    const b = await makeMac(cloud, "b", {
      ".claude/skills/deploy/SKILL.md": skillMd("deploy", "Deploy it."),
    });
    await a.setPlugins({
      servers: [
        {
          name: "fs",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"],
          source: "manual",
          enabled: true,
        },
      ],
      installed: [{ id: "linear@caveman-curated", enabled: true }],
    });

    // A's first sync: Cloud holds A's profile, v3, in a lineage of its own.
    await a.sync();
    expect(held(cloud)).toMatchObject({
      version: 3,
      lineage: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(skillNames(cloud)).toEqual(["notes", "review"]);
    expect(a.status()).toMatchObject({ state: "ok", mode: "two_way" });

    // B's first sync adds both together: A's skills, server and plugin are written into B, and B's skill goes up.
    await b.sync();
    expect(skillNames(cloud)).toEqual(["deploy", "notes", "review"]);
    expect(b.file(".claude/skills/review/SKILL.md")).toBe(skillMd("review", "Review the diff."));
    expect(b.file(".agents/skills/notes/SKILL.md")).toBe(skillMd("notes", "Take notes."));
    // A helper that ran by itself on A runs by itself on B; the manifest that carried its bit is never written.
    expect(
      fs.statSync(path.join(b.home, ".claude/skills/review/scripts/check.sh")).mode & 0o111,
    ).not.toBe(0);
    expect(b.file(".claude/skills/review/.caveman-skill.json")).toBeUndefined();
    expect((await b.plugins()).servers.map((s) => s.name)).toEqual(["fs"]);
    expect((await b.plugins()).installed).toEqual([
      { id: "linear@caveman-curated", enabled: true },
    ]);
    expect(b.status()).toMatchObject({ state: "ok", mode: "two_way", received: 4 });
    // A takes B's skill on its next sync.
    await a.sync();
    expect(a.file(".claude/skills/deploy/SKILL.md")).toBe(skillMd("deploy", "Deploy it."));
    // In step, a sync writes nothing.
    const quiet = puts(cloud);
    await a.sync();
    await b.sync();
    expect(puts(cloud)).toBe(quiet);

    // An edit on A reaches B in place: B's own file that never syncs (a .env) stays, and what B had is in its trash.
    b.write(".claude/skills/review/.env", "TOKEN=b-only\n");
    a.write(
      ".claude/skills/review/SKILL.md",
      skillMd("review", "Review the diff, then the tests."),
    );
    await a.sync();
    await b.sync();
    expect(b.file(".claude/skills/review/SKILL.md")).toBe(
      skillMd("review", "Review the diff, then the tests."),
    );
    expect(b.file(".claude/skills/review/.env")).toBe("TOKEN=b-only\n");
    const trashed = fs.readdirSync(trashDir(b.stateDir));
    expect(
      trashed.some(
        (t) =>
          t.endsWith("-review") &&
          fs
            .readFileSync(path.join(trashDir(b.stateDir), t, "SKILL.md"), "utf8")
            .includes("Review the diff.\n"),
      ),
    ).toBe(true);

    // A removal on B reaches A, and A keeps it in its trash.
    fs.rmSync(path.join(b.home, ".agents/skills/notes"), { recursive: true });
    await b.sync();
    expect(skillNames(cloud)).toEqual(["deploy", "review"]);
    await a.sync();
    expect(a.file(".agents/skills/notes/SKILL.md")).toBeUndefined();
    expect(fs.readdirSync(trashDir(a.stateDir)).some((t) => t.endsWith("-notes"))).toBe(true);

    // Both change at once: each writes over what it read, the second is refused (412), reads again and merges.
    a.write(".claude/skills/from-a/SKILL.md", skillMd("from-a", "A's."));
    b.write(".claude/skills/from-b/SKILL.md", skillMd("from-b", "B's."));
    await Promise.all([a.sync(), b.sync()]);
    expect(skillNames(cloud)).toEqual(["deploy", "from-a", "from-b", "review"]);
    await Promise.all([a.sync(), b.sync()]);
    expect(a.file(".claude/skills/from-b/SKILL.md")).toBe(skillMd("from-b", "B's."));
    expect(b.file(".claude/skills/from-a/SKILL.md")).toBe(skillMd("from-a", "A's."));

    // Another computer's write lands between A's read and A's write: A's write is refused, and A reads, merges and writes again.
    a.write(".claude/skills/late/SKILL.md", skillMd("late", "A's late one."));
    cloud.state.parity.beforeProfilePut.push(() => {
      const now = cloud.state.parity.profile!;
      const p = now.profile as Profile;
      cloud.state.parity.profile = {
        ...now,
        profile: {
          ...p,
          skills: [
            ...p.skills,
            {
              name: "sneaky",
              source: "claude-home",
              files: [{ path: "SKILL.md", content: skillMd("sneaky", "From elsewhere.") }],
            },
          ],
        },
        digest: "c".repeat(64),
      };
    });
    const conflicts = cloud.state.parity.profileConflicts;
    await a.sync();
    expect(cloud.state.parity.profileConflicts).toBe(conflicts + 1);
    expect(skillNames(cloud)).toEqual(["deploy", "from-a", "from-b", "late", "review", "sneaky"]);
    expect(a.file(".claude/skills/sneaky/SKILL.md")).toBe(skillMd("sneaky", "From elsewhere."));

    // Two edits of one skill at once: Cloud's (the first to land) wins everywhere; the other is in its Mac's trash.
    a.write(".claude/skills/deploy/SKILL.md", skillMd("deploy", "Deploy it, A's way."));
    b.write(".claude/skills/deploy/SKILL.md", skillMd("deploy", "Deploy it, B's way."));
    await a.sync();
    await b.sync();
    expect(b.file(".claude/skills/deploy/SKILL.md")).toBe(skillMd("deploy", "Deploy it, A's way."));
    expect(b.status().items.find((i) => i.kind === "skill" && i.id === "deploy")?.reason).toMatch(
      /kept the other computer's/,
    );
    expect(
      fs
        .readdirSync(trashDir(b.stateDir))
        .some(
          (t) =>
            t.endsWith("-deploy") &&
            fs
              .readFileSync(path.join(trashDir(b.stateDir), t, "SKILL.md"), "utf8")
              .includes("B's way"),
        ),
    ).toBe(true);

    // A plugin turned off and a server removed on B follow to A.
    await b.setPlugins({
      installed: [{ id: "linear@caveman-curated", enabled: false }],
      servers: [],
    });
    await b.sync();
    await a.sync();
    expect((await a.plugins()).installed).toEqual([
      { id: "linear@caveman-curated", enabled: false },
    ]);
    expect((await a.plugins()).servers).toEqual([]);

    // A Cloud computer runs what both Macs have: its plugins from the shared profile, and every skill.
    const p = held(cloud)!;
    const applied = applyProfile({ profile: p, onPath: () => true });
    expect(applied.plugins.installed).toMatchObject([
      { id: "linear@caveman-curated", enabled: false, profile: true },
    ]);
    const skillsDir = path.join(tempRoot("share-computer-"), "profile-skills");
    writeProfileSkills(skillsDir, p.skills);
    expect(fs.readdirSync(path.join(skillsDir, "current")).sort()).toEqual([
      "deploy",
      "from-a",
      "from-b",
      "late",
      "review",
      "sneaky",
    ]);
    // What each Mac remembers is names and digests, never a file's text.
    expect(JSON.stringify(readSyncFile(a.stateDir))).not.toContain("Deploy it");
  },
  120_000,
);

test.skipIf(process.platform === "win32")(
  "safety: a linked folder, a wiped skills folder, a profile removed from Cloud and another lineage never take a Mac's skills",
  async () => {
    const cloud = await startTestCloud();
    cleanups.push(cloud.close);
    // Shared profiles (v3): a stale write is refused with 412, which Cloud does not do yet.
    cloud.state.parity.legacyProfiles = false;
    const many = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `.claude/skills/s${i}/SKILL.md`,
        skillMd(`s${i}`, `Skill ${i}.`),
      ]),
    );
    const a = await makeMac(cloud, "a", many);
    const b = await makeMac(cloud, "b", {});
    // B keeps "linked" in a folder of its own that it links in.
    const elsewhere = tempRoot("share-linked-");
    fs.writeFileSync(path.join(elsewhere, "SKILL.md"), skillMd("linked", "B's linked copy."));
    fs.mkdirSync(path.join(b.home, ".claude/skills"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(b.home, ".claude/skills/linked"));
    await a.sync();
    await b.sync();
    expect(fs.readdirSync(path.join(b.home, ".claude/skills")).sort()).toEqual(
      ["linked", ...Array.from({ length: 12 }, (_, i) => `s${i}`)].sort(),
    );

    // A changes its own "linked": B never writes through its link, and says why.
    a.write(".claude/skills/linked/SKILL.md", skillMd("linked", "A's copy."));
    await a.sync();
    await b.sync();
    expect(fs.readFileSync(path.join(elsewhere, "SKILL.md"), "utf8")).toBe(
      skillMd("linked", "B's linked copy."),
    );

    // A's skills folder is wiped: B keeps all twelve and says so; Cloud has them no more.
    for (let i = 0; i < 12; i++)
      fs.rmSync(path.join(a.home, `.claude/skills/s${i}`), { recursive: true });
    await a.sync();
    await b.sync();
    expect(
      Array.from({ length: 12 }, (_, i) => b.file(`.claude/skills/s${i}/SKILL.md`)).every(
        (t) => t !== undefined,
      ),
    ).toBe(true);
    expect(b.status().items.find((i) => i.id === "s0")?.reason).toMatch(
      /removed on another of your computers at once/,
    );

    // Removed from Cloud (and synced again): no common past, so nothing on B is taken for removed.
    cloud.state.parity.profile = undefined;
    await b.sync();
    expect(b.file(".claude/skills/s0/SKILL.md")).toBeDefined();
    expect(skillNames(cloud)).toContain("s0");

    // Another lineage (an older app, a profile made again elsewhere): both sides added together again, nothing removed.
    const other = held(cloud)!;
    cloud.state.parity.profile = {
      ...cloud.state.parity.profile!,
      profile: {
        ...other,
        lineage: "f".repeat(32),
        skills: other.skills.filter((s) => s.name !== "s1"),
      },
      digest: "e".repeat(64),
    };
    await b.sync();
    expect(b.file(".claude/skills/s1/SKILL.md")).toBeDefined();
    expect(skillNames(cloud)).toContain("s1");
  },
  120_000,
);

test.skipIf(process.platform === "win32")(
  "an older Cloud without shared writes: each Mac's skills are merged, removals still go, and nothing is written into a Mac",
  async () => {
    const cloud = await startTestCloud();
    cleanups.push(cloud.close);
    cloud.state.parity.legacyProfiles = true;
    const a = await makeMac(cloud, "a", {
      ".claude/skills/review/SKILL.md": skillMd("review", "Review."),
    });
    const b = await makeMac(cloud, "b", {
      ".claude/skills/deploy/SKILL.md": skillMd("deploy", "Deploy."),
    });
    await a.sync();
    await b.sync();
    // B's write merged A's in, instead of replacing it as an older app's did.
    expect(held(cloud)!.version).toBe(2);
    expect(skillNames(cloud)).toEqual(["deploy", "review"]);
    expect(b.status()).toMatchObject({ state: "ok", mode: "push_only" });
    expect(b.file(".claude/skills/review/SKILL.md")).toBeUndefined();
    // A's removal still reaches Cloud, and B's write after it does not bring it back.
    fs.rmSync(path.join(a.home, ".claude/skills/review"), { recursive: true });
    await a.sync();
    await b.sync();
    expect(skillNames(cloud)).toEqual(["deploy"]);
    // A write another Mac's lost (two writes at once on a Cloud that cannot refuse one) is put back by its Mac.
    const lost = held(cloud)!;
    cloud.state.parity.profile = {
      ...cloud.state.parity.profile!,
      profile: { ...lost, skills: [] },
      digest: "d".repeat(64),
    };
    await b.sync();
    expect(skillNames(cloud)).toEqual(["deploy"]);
  },
  120_000,
);

test.skipIf(process.platform === "win32")(
  "npx skills' layout takes changes in its real folder; a link with nothing behind it is never written through; a Cloud that refuses v3 while holding one never loops",
  async () => {
    const cloud = await startTestCloud();
    cleanups.push(cloud.close);
    // Shared profiles (v3) until the rollback below.
    cloud.state.parity.legacyProfiles = false;
    const a = await makeMac(cloud, "a", {
      ".agents/skills/x/SKILL.md": skillMd("x", "v1"),
      ".claude/skills/y/SKILL.md": skillMd("y", "Y"),
    });
    const b = await makeMac(cloud, "b", { ".agents/skills/x/SKILL.md": skillMd("x", "v1") });
    // B: Claude's x links to ~/.agents' (as `npx skills` lays them out), and its y links to a folder with no skill in it.
    fs.mkdirSync(path.join(b.home, ".claude/skills"), { recursive: true });
    fs.symlinkSync(path.join(b.home, ".agents/skills/x"), path.join(b.home, ".claude/skills/x"));
    const empty = tempRoot("share-empty-");
    fs.symlinkSync(empty, path.join(b.home, ".claude/skills/y"));
    await a.sync();
    await b.sync();
    expect(fs.readdirSync(empty)).toEqual([]);

    // A's edit lands in B's real folder; the link stays a link.
    a.write(".agents/skills/x/SKILL.md", skillMd("x", "v2"));
    await a.sync();
    await b.sync();
    expect(b.file(".agents/skills/x/SKILL.md")).toBe(skillMd("x", "v2"));
    expect(fs.lstatSync(path.join(b.home, ".claude/skills/x")).isSymbolicLink()).toBe(true);
    // A's removal takes the folder and the link that led to it.
    fs.rmSync(path.join(a.home, ".agents/skills/x"), { recursive: true });
    await a.sync();
    await b.sync();
    expect(fs.existsSync(path.join(b.home, ".agents/skills/x"))).toBe(false);
    expect(() => fs.lstatSync(path.join(b.home, ".claude/skills/x"))).toThrow();

    // Cloud holds a v3 profile and then refuses v3 (rolled back): a refusal, said once, never a loop of writes.
    cloud.state.parity.legacyProfiles = true;
    a.write(".claude/skills/z/SKILL.md", skillMd("z", "Z"));
    const before = puts(cloud);
    await expect(a.sync()).rejects.toThrow();
    expect(puts(cloud) - before).toBe(1);
    expect(a.status()).toMatchObject({ state: "error" });
  },
  120_000,
);
