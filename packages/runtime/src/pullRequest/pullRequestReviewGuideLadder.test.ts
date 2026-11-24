import { describe, expect, it } from "vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type PullRequestActor,
  type ServerProvider,
} from "@caveman-app/protocol";
import type { ReviewGuideGenerationResult } from "@caveman-app/engine-core/server/textGeneration";

import {
  changeFileKind,
  changeMap,
  checkGuide,
  chooseTier,
  codeLinesChanged,
  dependencyBumps,
  nextModelUp,
  parseChangeFiles,
  templateGuide,
} from "./pullRequestReviewGuideLadder.ts";
import { normalizeReviewGuide, parseReviewGuideChange } from "./pullRequestReviewGuideNormalize.ts";

const filePatch = (path: string, header: string, added: number, removed = 0) =>
  [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${removed} +1,${added} @@ ${header}`,
    ...Array.from({ length: removed }, (_, i) => `-old ${i}`),
    ...Array.from({ length: added }, (_, i) => `+new ${i}`),
    "",
  ].join("\n");

const CODE = filePatch("src/auth.ts", "export function geminiEnvSelectsAuth(env) {", 12, 3);
const TEST = filePatch("src/auth.test.ts", "describe(\"auth\", () => {", 20);
const LOCK = filePatch("pnpm-lock.yaml", "", 400, 380);
const SNAP = filePatch("src/__snapshots__/view.test.ts.snap", "", 5, 5);

describe("changeFileKind", () => {
  it("sorts code, tests and mechanical files like the web's Files tab", () => {
    expect(changeFileKind("src/auth.ts")).toBe("code");
    expect(changeFileKind("src/auth.test.ts")).toBe("test");
    expect(changeFileKind("go/pkg/x_test.go")).toBe("test");
    expect(changeFileKind("pnpm-lock.yaml")).toBe("mechanical");
    expect(changeFileKind("web/vendor/lib.js")).toBe("mechanical");
    expect(changeFileKind("src/api.generated.ts")).toBe("mechanical");
    expect(changeFileKind("src/__snapshots__/view.test.ts.snap")).toBe("mechanical");
  });
});

describe("parseChangeFiles and changeMap", () => {
  it("counts lines per file and names the symbols its hunks touch", () => {
    const files = parseChangeFiles(CODE + TEST + LOCK);
    expect(files.map((file) => [file.path, file.kind, file.added, file.removed])).toEqual([
      ["src/auth.ts", "code", 12, 3],
      ["src/auth.test.ts", "test", 20, 0],
      ["pnpm-lock.yaml", "mechanical", 400, 380],
    ]);
    expect(changeMap(files).split("\n")).toEqual([
      "code src/auth.ts +12 -3 · export function geminiEnvSelectsAuth(env) {",
      'test src/auth.test.ts +20 -0 · describe("auth", () => {',
      "mechanical pnpm-lock.yaml +400 -380",
    ]);
  });

  it("names a binary file from its diff header", () => {
    const files = parseChangeFiles(
      "diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n",
    );
    expect(files).toMatchObject([{ path: "logo.png", added: 0, removed: 0 }]);
  });

  it("reads file names git quotes or ends with a tab", () => {
    const files = parseChangeFiles(
      [
        "diff --git a/with space.ts b/with space.ts",
        "--- a/with space.ts\t",
        "+++ b/with space.ts\t",
        "@@ -1,0 +1 @@",
        "+new",
        'diff --git "a/tab\\tname.ts" "b/tab\\tname.ts"',
        '--- "a/tab\\tname.ts"',
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-old",
        "",
      ].join("\n"),
    );
    expect(files.map((file) => [file.path, file.added, file.removed])).toEqual([
      ["with space.ts", 1, 0],
      ["tab\tname.ts", 0, 1],
    ]);
  });
});

describe("dependencyBumps", () => {
  it("reads Dependabot's single bump title", () => {
    expect(dependencyBumps("chore(deps): bump vite from 5.1.0 to 5.2.0 in /web", "")).toEqual([
      { name: "vite", from: "5.1.0", to: "5.2.0" },
    ]);
  });

  it("reads Renovate's title and its body table for the old version", () => {
    const body = [
      "| Package | Change |",
      "|---|---|",
      "| [typescript](https://www.typescriptlang.org/) | [`5.4.0` -> `5.5.2`](https://renovatebot.com/diffs) |",
    ].join("\n");
    expect(dependencyBumps("Update dependency typescript to v5.5.2", body)).toEqual([
      { name: "typescript", from: "5.4.0", to: "5.5.2" },
    ]);
  });

  it("reads a grouped bump from Dependabot's body", () => {
    const body = [
      "Bumps the npm_and_yarn group with 2 updates in the / directory: [a](x) and [b](y).",
      "",
      "Updates `a` from 1.0.0 to 1.1.0",
      "- [Release notes](https://example.com)",
      "",
      "Updates `b` from 2.0.0 to 3.0.0",
    ].join("\n");
    expect(dependencyBumps("Bump the npm_and_yarn group with 2 updates", body)).toEqual([
      { name: "a", from: "1.0.0", to: "1.1.0" },
      { name: "b", from: "2.0.0", to: "3.0.0" },
    ]);
  });

  it("is null for a person's title", () => {
    expect(dependencyBumps("Merge gate blocks red CI", "Bumps nothing.")).toBeNull();
  });
});

const PERSON: PullRequestActor = { login: "julius", name: "Julius", avatarUrl: null };
const DEPENDABOT: PullRequestActor = { login: "dependabot", name: null, avatarUrl: null, isBot: true };

describe("chooseTier", () => {
  // The settings' defaults: 48 KB in one pass, a TL;DR up to 30 lines, opened by a person.
  const tier = (
    title: string,
    patch: string,
    settings: { budgetBytes?: number; shortLines?: number; author?: PullRequestActor | null } = {},
  ) =>
    chooseTier({
      title,
      body: "",
      files: parseChangeFiles(patch),
      budgetBytes: 48 * 1024,
      shortLines: 30,
      author: PERSON,
      ...settings,
    });

  it("templates a bot's bump and a mechanical-only change, short or not", () => {
    expect(tier("Bump vite from 5.1.0 to 5.2.0", CODE + LOCK, { author: DEPENDABOT })).toMatchObject({
      tier: "template",
    });
    // A host that does not say which accounts are bots still names the bot by its login.
    for (const login of ["dependabot[bot]", "app/dependabot", "renovate-bot", "renovate[bot]"]) {
      expect(
        tier("Update dependency vite to v5.2.0", CODE + LOCK, { author: { ...PERSON, login } }),
      ).toMatchObject({ tier: "template" });
    }
    expect(tier("Refresh snapshots", LOCK + SNAP)).toEqual({ tier: "template", bumps: null });
  });

  it("has a model read a person's change whose title only looks like a bot's bump", () => {
    const PUBLISH = filePatch("src/publish.ts", "export async function publish(packages) {", 30, 8);
    for (const title of [
      "Update the release script to publish packages",
      "Bump timeout from 30 to 60",
      "chore: bump version from 1.2.0 to 1.3.0",
    ]) {
      expect(tier(title, PUBLISH)).toMatchObject({ tier: "single-pass", depth: "tour" });
      expect(tier(title, PUBLISH, { author: null })).toMatchObject({ tier: "single-pass" });
    }
    // The tour a person presses for is a model's too.
    expect(tier("Update the release script to publish packages", CODE, { shortLines: 0 })).toMatchObject({
      tier: "single-pass",
      depth: "tour",
    });
  });

  it("writes code and tests that fit in a single pass, without the lockfile", () => {
    // 15 lines of code and 20 of tests: past the 30 a TL;DR takes.
    const choice = tier("Fix auth", CODE + TEST + LOCK);
    expect(choice).toMatchObject({ tier: "single-pass", depth: "tour" });
    if (choice.tier !== "single-pass") return;
    expect(choice.diff).toBe(CODE + TEST);
    expect(choice.diff).not.toContain("pnpm-lock.yaml");
  });

  it("reads the checkout when the filtered diff is over budget", () => {
    expect(tier("Fix auth", CODE + TEST, { budgetBytes: 100 })).toEqual({ tier: "checkout" });
  });

  it("writes a short change's TL;DR over its code and tests, lockfile lines not counted", () => {
    expect(codeLinesChanged(parseChangeFiles(CODE + TEST + LOCK))).toBe(35);
    // 15 lines of code beside 780 of lockfile is short.
    expect(tier("Fix auth", CODE + LOCK)).toEqual({ tier: "single-pass", diff: CODE, depth: "tldr" });
    expect(tier("Fix auth", CODE + TEST, { shortLines: 35 })).toMatchObject({ depth: "tldr" });
    expect(tier("Fix auth", CODE + TEST, { shortLines: 34 })).toMatchObject({ depth: "tour" });
    // Short is about lines, not bytes: a TL;DR is written even past the single-pass budget.
    expect(tier("Fix auth", CODE, { budgetBytes: 0 })).toMatchObject({ tier: "single-pass", depth: "tldr" });
  });

  it("never writes a TL;DR with the threshold at 0 or for a change with no lines", () => {
    expect(tier("Fix auth", CODE, { shortLines: 0 })).toMatchObject({ depth: "tour" });
    const binary = "diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n";
    expect(tier("New logo", binary)).toMatchObject({ depth: "tour" });
  });
});

describe("templateGuide", () => {
  it("writes a Dependabot bump in the model's shape, claiming only what it computed", () => {
    const files = parseChangeFiles(filePatch("package.json", "", 1, 1) + LOCK);
    const bumps = dependencyBumps("Bump vite from 5.1.0 to 6.0.0", "")!;
    const guide = templateGuide({ title: "Bump vite from 5.1.0 to 6.0.0", files, bumps });
    expect(guide.tldr).toBe("Bumps vite from 5.1.0 to 6.0.0. Opened by a dependency bot.");
    expect(guide.overview?.split("\n").map((line) => line.split(":")[0])).toEqual(["what", "why"]);
    expect(guide.beforeAfter?.rows).toEqual([
      { op: "-", depth: 0, text: "vite 5.1.0", stop: 1 },
      { op: "+", depth: 0, text: "vite 6.0.0", stop: 1 },
    ]);
    expect(guide.stops).toHaveLength(1);
    const [stop] = guide.stops;
    expect(stop?.summary).toMatch(/^checked: 2 files change, 1 mechanical/);
    expect(stop?.summary).toContain("no model read the diff");
    expect(stop?.attention).toEqual({
      kind: "risk",
      note: "Major version: vite 5.1.0 to 6.0.0. Read its release notes.",
    });
    expect(stop?.files.map((file) => file.path)).toEqual(["package.json", "pnpm-lock.yaml"]);
    // Every changed file is placed, so the normalizer adds no closing stop.
    const change = parseReviewGuideChange("package.json\0pnpm-lock.yaml\0", "");
    expect(normalizeReviewGuide(guide, change).stops).toHaveLength(1);
  });

  it("writes a lockfile-only change with no bump rows and no attention", () => {
    const files = parseChangeFiles(LOCK);
    const guide = templateGuide({ title: "Refresh lockfile", files, bumps: null });
    expect(guide.tldr).toBe("Updates 1 mechanical file; no code or tests change.");
    expect(guide.beforeAfter).toBeUndefined();
    expect(guide.stops).toMatchObject([
      { title: "Mechanical files only", attention: null, excerpts: [], files: [{ path: "pnpm-lock.yaml" }] },
    ]);
    expect(guide.stops[0]?.summary).toMatch(/^checked: /);
  });
});

describe("checkGuide", () => {
  const change = parseReviewGuideChange("src/auth.ts\0", "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,0 +1,12 @@\n");
  const stop = (summary: string, title = "Auth reads the env", start = 2) => ({
    title,
    summary,
    attention: null,
    excerpts: [{ path: "src/auth.ts", side: "new" as const, start, end: start + 3, caption: "" }],
    files: [],
    notes: [],
    questions: [],
  });
  const check = (generated: ReviewGuideGenerationResult) =>
    checkGuide(generated, normalizeReviewGuide(generated, change), change);

  it("passes a guide with before/after/why stops inside the change", () => {
    expect(check({ stops: [stop("before: a\nafter: b\nwhy: c")] })).toEqual([]);
  });

  it("misses no stops, excerpts outside the change, prose summaries and long titles", () => {
    expect(check({ stops: [] })).toContain("no stops");
    expect(check({ stops: [stop("before: a\nafter: b\nwhy: c", "Auth", 40)] })).toContain(
      "1 of 1 excerpts outside the change",
    );
    expect(check({ stops: [stop("It reads the env.")] })).toContain(
      "1 of 1 stops lack before/after/why",
    );
    expect(
      check({ stops: [stop("before: a\nafter: b\nwhy: c", "One two three four five six seven eight nine ten")] }),
    ).toContain("1 stop titles over 9 words");
  });

  it("passes a TL;DR on its TL;DR alone, with no stops to hold it to", () => {
    expect(check({ depth: "tldr", tldr: "Merge locks on red CI.", stops: [] })).toEqual([]);
    expect(check({ depth: "tldr", tldr: "  ", stops: [] })).toEqual(["no tldr"]);
  });
});

describe("nextModelUp", () => {
  const provider = (driver: string, models: ReadonlyArray<string>): ServerProvider =>
    ({
      instanceId: ProviderInstanceId.make(driver),
      driver: ProviderDriverKind.make(driver),
      models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    }) as unknown as ServerProvider;

  it("steps Haiku up to Sonnet and Codex low effort up to medium", () => {
    const claude = provider("claudeAgent", ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
    expect(
      nextModelUp({ instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-5-5" }, claude),
    ).toEqual({ instanceId: "claudeAgent", model: "claude-sonnet-5-5" });
    expect(
      nextModelUp({ instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" }, provider("codex", [])),
    ).toEqual({ instanceId: "codex", model: "gpt-6-luna", options: [{ id: "reasoningEffort", value: "medium" }] });
  });

  it("has no step up for Sonnet or a harness it does not know", () => {
    const claude = provider("claudeAgent", ["claude-sonnet-5-5"]);
    expect(nextModelUp({ instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-sonnet-5-5" }, claude)).toBeNull();
    expect(nextModelUp({ instanceId: ProviderInstanceId.make("grok"), model: "grok-build" }, provider("grok", []))).toBeNull();
  });
});
