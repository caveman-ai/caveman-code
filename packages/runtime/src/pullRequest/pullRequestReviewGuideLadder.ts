/**
 * The guide writer's cost ladder (docs/, phase 1).
 *
 * Everything a script can know is computed here, not asked of a model: which files are mechanical,
 * what a dependency bump bumps, which symbols a hunk touches. A guide is then written by the
 * cheapest tier that fits, and checked by code after the normalizer:
 *
 * - tier 0, template: a dependency-bump bot or mechanical files only; no model.
 * - tier 1, single pass: the filtered diff fits the budget; one call with no tools. A short change
 *   gets a TL;DR the same way, with no tour.
 * - tier 2, checkout: today's investigating run, with the change map at the top of the prompt.
 *
 * Every threshold is a server setting (`reviewGuideShortLines`, `reviewGuideSinglePassKb`).
 *
 * @module pullRequest/pullRequestReviewGuideLadder
 */
import type {
  ModelSelection,
  PullRequestActor,
  PullRequestReviewGuideStop,
  ServerProvider,
} from "@caveman-app/protocol";
import type { ReviewGuideGenerationResult } from "@caveman-app/engine-core/server/textGeneration";
import { getModelSelectionStringOptionValue } from "@caveman-app/shared/model";

import { clampExcerpt, headerPath, type ReviewGuideChange } from "./pullRequestReviewGuideNormalize.ts";

export type ReviewGuideTier = "template" | "single-pass" | "checkout";

/** What a reader sees after the model's name: "Claude Haiku 5.5 · single pass". */
export const REVIEW_GUIDE_TIER_LABEL: Record<ReviewGuideTier, string> = {
  template: "template",
  "single-pass": "single pass",
  checkout: "read the checkout",
};

/**
 * A writer that cannot read a checkout (Cursor, Grok, Muse, Pi, OpenCode, Antigravity) writes a
 * larger change in one pass instead, up to ~48k tokens; past that only a writer that reads the
 * checkout (Claude, Codex, the Caveman engine) can.
 */
export const WIDE_SINGLE_PASS_DIFF_BYTES = 192 * 1024;

// Mirrors the web's fileKind (apps/web/src/routes/review/model.ts); snapshots count as mechanical here.
const TEST =
  /(^|\/)(__tests__|tests?|spec|e2e|fixtures?|testdata)\/|[._-](test|spec)\.[a-z0-9]+$|_test\.go$/i;
const MECHANICAL =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|uv\.lock|poetry\.lock|Gemfile\.lock|composer\.lock)$|\.generated\.|\.gen\.|(^|\/)(dist|build|vendor|generated|__snapshots__)\/|\.min\.(js|css)$|\.pb\.go$|schema\/[^/]+\.json$|\.snap$/i;

export type ChangeFileKind = "code" | "test" | "mechanical";

export function changeFileKind(path: string): ChangeFileKind {
  if (MECHANICAL.test(path)) return "mechanical";
  if (TEST.test(path)) return "test";
  return "code";
}

export interface ChangeFile {
  readonly path: string;
  readonly kind: ChangeFileKind;
  readonly added: number;
  readonly removed: number;
  /** What the hunk headers name (`@@ … @@ function foo`), deduplicated, at most four. */
  readonly symbols: ReadonlyArray<string>;
  /** This file's part of the diff, headers included. */
  readonly patch: string;
}

const HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?(.*)$/;

/** Splits a `git diff` (fixed a/ b/ prefixes, any context) into its files. */
export function parseChangeFiles(patch: string): ReadonlyArray<ChangeFile> {
  const files: Array<ChangeFile> = [];
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith("diff --git ")) continue;
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let added = 0;
    let removed = 0;
    let inHunks = false;
    const symbols = new Set<string>();
    for (const line of chunk.split("\n")) {
      if (!inHunks && line.startsWith("--- ")) {
        oldPath = headerPath(line, "a/");
      } else if (!inHunks && line.startsWith("+++ ")) {
        newPath = headerPath(line, "b/");
      } else if (line.startsWith("@@")) {
        inHunks = true;
        const symbol = HUNK.exec(line)?.[1]?.trim();
        if (symbol) symbols.add(symbol.length > 60 ? `${symbol.slice(0, 59)}…` : symbol);
      } else if (inHunks && line.startsWith("+")) {
        added += 1;
      } else if (inHunks && line.startsWith("-")) {
        removed += 1;
      }
    }
    // A binary or mode-only change has no ---/+++ lines: the header names it.
    const header = /^diff --git a\/(.*) b\/(.*)$/m.exec(chunk);
    const path = newPath ?? oldPath ?? header?.[2] ?? null;
    if (path === null) continue;
    files.push({
      path,
      kind: changeFileKind(path),
      added,
      removed,
      symbols: [...symbols].slice(0, 4),
      patch: chunk.endsWith("\n") ? chunk : `${chunk}\n`,
    });
  }
  return files;
}

/** One line per file: kind, path, +/-, and the symbols its hunks touch. 0 tokens to compute. */
export function changeMap(files: ReadonlyArray<ChangeFile>): string {
  return files
    .map(
      (file) =>
        `${file.kind} ${file.path} +${file.added} -${file.removed}${file.symbols.length > 0 ? ` · ${file.symbols.join("; ")}` : ""}`,
    )
    .join("\n");
}

/**
 * Code and tests, in diff order. Mechanical files are named only in the change map. The writer cuts
 * this into chunks the model cites by id (engine-core reviewGuideChunks.ts), so no line numbers.
 */
export const filteredDiff = (files: ReadonlyArray<ChangeFile>): string =>
  files
    .filter((file) => file.kind !== "mechanical")
    .map((file) => file.patch)
    .join("");

export interface DependencyBump {
  readonly name: string;
  readonly from: string | null;
  readonly to: string;
}

const clean = (version: string) => version.replace(/^[`'"]+|[`'".,]+$/g, "");

/**
 * The bumps a dependency bot's pull request makes, read from its title and body; null when the
 * title is not one a bot writes. A grouped bump whose body names nothing gives an empty list.
 */
export function dependencyBumps(title: string, body: string): ReadonlyArray<DependencyBump> | null {
  // Dependabot: "Bump vite from 5.1.0 to 5.2.0", "chore(deps): bump x from a to b in /web".
  const single = /\bbump (\S+) from (\S+) to (\S+)/i.exec(title);
  if (single) return [{ name: single[1]!, from: clean(single[2]!), to: clean(single[3]!) }];
  // Renovate: "Update dependency vite to v5.2.0", "chore(deps): update dependency x to v2".
  const renovate = /\bupdate dependency (\S+) to v?(\S+)/i.exec(title);
  if (renovate) {
    const name = renovate[1]!;
    const row = bodyBumps(body).find((bump) => bump.name === name);
    return [{ name, from: row?.from ?? null, to: clean(renovate[2]!) }];
  }
  // Grouped: "Bump the npm group with 3 updates", "Update all non-major dependencies", "Update react monorepo".
  if (
    /\bbump the \S+ group\b|\bbump .+ (and|with) \d+ (others?|updates?)\b|\bupdate (all )?(non-major |major |minor |patch )?dependencies\b|\bupdate .+ (monorepo|packages)\b/i.test(
      title,
    )
  ) {
    return bodyBumps(body);
  }
  return null;
}

/** "Updates `x` from 1 to 2" (Dependabot) and `| x | … | \`1\` -> \`2\` |` table rows (Renovate). */
function bodyBumps(body: string): ReadonlyArray<DependencyBump> {
  const bumps = new Map<string, DependencyBump>();
  for (const match of body.matchAll(/^\s*(?:Updates|Bumps) [`[]?([^`\]\s]+)[`\]]?(?:\([^)]*\))? from (\S+) to (\S+)/gim)) {
    bumps.set(match[1]!, { name: match[1]!, from: clean(match[2]!), to: clean(match[3]!) });
  }
  for (const line of body.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const versions = /`v?([^`]+)`\s*(?:->|→)\s*`v?([^`]+)`/.exec(line);
    const name = /^\s*\|\s*\[?([^\]|]+?)\]?(?:\([^)]*\))?\s*\|/.exec(line)?.[1]?.trim();
    if (versions && name && !bumps.has(name)) {
      bumps.set(name, { name, from: versions[1]!, to: versions[2]! });
    }
  }
  return [...bumps.values()];
}

/**
 * Whether a bot opened the change: the host says so, or, on a host that does not say, the login is
 * one Dependabot or Renovate signs with.
 */
const isBotAuthor = (author: PullRequestActor | null | undefined): boolean =>
  author != null &&
  (author.isBot === true || /^(app\/)?(dependabot|renovate)|\[bot\]$/i.test(author.login));

/** How deep a guide goes: a short change's TL;DR, or the tour. */
export type ReviewGuideDepth = "tldr" | "tour";

export type TierChoice =
  | { readonly tier: "template"; readonly bumps: ReadonlyArray<DependencyBump> | null }
  | { readonly tier: "single-pass"; readonly diff: string; readonly depth: ReviewGuideDepth }
  | { readonly tier: "checkout" };

/** Lines of code and tests the change adds and removes; mechanical files do not count. */
export const codeLinesChanged = (files: ReadonlyArray<ChangeFile>): number =>
  files.reduce((lines, file) => (file.kind === "mechanical" ? lines : lines + file.added + file.removed), 0);

/**
 * The cheapest tier that fits the change. A template still wins first; then a change of at most
 * `shortLines` lines of code and tests (0 for never) gets its TL;DR in one call, when its diff
 * fits the widest pass; then the single pass within `budgetBytes`; then the checkout.
 */
export function chooseTier(input: {
  readonly title: string;
  readonly body: string;
  /** Who opened the change. A bump's title shape names a bump only when a bot wrote it. */
  readonly author: PullRequestActor | null | undefined;
  readonly files: ReadonlyArray<ChangeFile>;
  readonly budgetBytes: number;
  readonly shortLines: number;
}): TierChoice {
  const bumps = isBotAuthor(input.author) ? dependencyBumps(input.title, input.body) : null;
  if (bumps !== null || (input.files.length > 0 && input.files.every((file) => file.kind === "mechanical"))) {
    return { tier: "template", bumps };
  }
  const diff = filteredDiff(input.files);
  const bytes = Buffer.byteLength(diff);
  const lines = codeLinesChanged(input.files);
  if (diff !== "" && lines > 0 && lines <= input.shortLines && bytes <= WIDE_SINGLE_PASS_DIFF_BYTES) {
    return { tier: "single-pass", diff, depth: "tldr" };
  }
  return diff !== "" && bytes <= input.budgetBytes
    ? { tier: "single-pass", diff, depth: "tour" }
    : { tier: "checkout" };
}

const major = (version: string | null) => /^v?(\d+)/.exec(version ?? "")?.[1];

const listNames = (names: ReadonlyArray<string>) =>
  names.length <= 3
    ? names.join(names.length === 2 ? " and " : ", ")
    : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;

/**
 * A guide written by code alone, in the same shape a model writes. It says only what was computed:
 * the bumps the title and body name and the files the diff changes. It never claims a check it
 * did not run.
 */
export function templateGuide(input: {
  readonly title: string;
  readonly files: ReadonlyArray<ChangeFile>;
  readonly bumps: ReadonlyArray<DependencyBump> | null;
}): ReviewGuideGenerationResult {
  const { files, bumps } = input;
  const mechanical = files.filter((file) => file.kind === "mechanical").length;
  const fileFacts = `${files.length} file${files.length === 1 ? "" : "s"} change, ${mechanical} mechanical (lockfiles, generated, vendored, snapshots)`;
  const majors = (bumps ?? []).filter((bump) => {
    const from = major(bump.from);
    const to = major(bump.to);
    return from !== undefined && to !== undefined && from !== to;
  });
  if (bumps !== null) {
    const what =
      bumps.length === 1
        ? `Bumps ${bumps[0]!.name}${bumps[0]!.from ? ` from ${bumps[0]!.from}` : ""} to ${bumps[0]!.to}.`
        : bumps.length > 1
          ? `Bumps ${bumps.length} dependencies: ${listNames(bumps.map((bump) => bump.name))}.`
          : "Bumps a group of dependencies.";
    const rows = bumps.slice(0, 6).flatMap((bump) => [
      ...(bump.from ? [{ op: "-" as const, depth: 0, text: `${bump.name} ${bump.from}`, stop: 1 }] : []),
      { op: "+" as const, depth: 0, text: `${bump.name} ${bump.to}`, stop: 1 },
    ]);
    const stop: PullRequestReviewGuideStop = {
      title: bumps.length === 1 ? `Bump ${bumps[0]!.name}` : "Bump dependencies",
      summary: `checked: ${fileFacts}. Versions read from the title and description; no model read the diff.`,
      attention:
        majors.length > 0
          ? {
              kind: "risk",
              note: `Major version: ${listNames(majors.map((bump) => `${bump.name} ${bump.from} to ${bump.to}`))}. Read its release notes.`,
            }
          : null,
      excerpts: [],
      files: files.map((file) => ({ path: file.path, note: `${file.kind}, +${file.added} -${file.removed}` })),
      notes: [],
      questions: [],
    };
    return {
      tldr: `${what} Opened by a dependency bot.`,
      overview: `what: ${what}\nwhy: a dependency update; release notes, if any, are in the description.`,
      ...(rows.length > 0 ? { beforeAfter: { title: "Dependency versions", rows } } : {}),
      stops: [stop],
    };
  }
  const what = `Updates ${files.length} mechanical file${files.length === 1 ? "" : "s"}; no code or tests change.`;
  return {
    tldr: what,
    overview: `what: ${what}\nwhy: not stated by the change itself; see the description.`,
    stops: [
      {
        title: "Mechanical files only",
        summary: `checked: ${fileFacts}. Kinds read from the paths; no model read the diff.`,
        attention: null,
        excerpts: [],
        files: files.map((file) => ({ path: file.path, note: `+${file.added} -${file.removed}` })),
        notes: [],
        questions: [],
      },
    ],
  };
}

const isSkim = (stop: PullRequestReviewGuideStop) =>
  stop.title === "Other files" || /^\s*checked:/im.test(stop.summary);

/**
 * The fixed check after the normalizer. Empty when the guide passes; otherwise what it missed.
 * `generated` is the model's guide before normalizing, `guide` after.
 */
export function checkGuide(
  generated: ReviewGuideGenerationResult,
  guide: ReviewGuideGenerationResult,
  change: ReviewGuideChange,
): ReadonlyArray<string> {
  // A TL;DR has no stops to check: it passes when it says something.
  if (guide.depth === "tldr") return guide.tldr ? [] : ["no tldr"];
  const misses: Array<string> = [];
  if (!generated.stops.some((stop) => stop.title.trim() !== "")) misses.push("no stops");
  const excerpts = generated.stops.flatMap((stop) => stop.excerpts);
  const dropped = excerpts.filter(
    (excerpt) => !change.files.includes(excerpt.path) || clampExcerpt(excerpt, change) === null,
  ).length;
  if (excerpts.length > 0 && dropped / excerpts.length > 0.4) {
    misses.push(`${dropped} of ${excerpts.length} excerpts outside the change`);
  }
  const told = guide.stops.filter((stop) => !isSkim(stop));
  const shaped = told.filter((stop) =>
    ["before", "after", "why"].every((key) => new RegExp(`^\\s*${key}:`, "im").test(stop.summary)),
  ).length;
  if (told.length > 0 && shaped * 2 <= told.length) {
    misses.push(`${told.length - shaped} of ${told.length} stops lack before/after/why`);
  }
  const long = guide.stops.filter((stop) => stop.title.trim().split(/\s+/).length > 9).length;
  if (long > 0) misses.push(`${long} stop titles over 9 words`);
  return misses;
}

/**
 * The same harness's next model up, for a checkout run that missed the check: Haiku to Sonnet,
 * Codex low effort to medium. Null where the harness has no step up known here.
 */
export function nextModelUp(
  selection: ModelSelection,
  provider: ServerProvider | undefined,
): ModelSelection | null {
  if (provider?.driver === "claudeAgent" && /haiku/i.test(selection.model)) {
    const sonnet = provider.models.find((model) => /sonnet/i.test(model.slug) && !model.isLegacy);
    return sonnet ? { instanceId: selection.instanceId, model: sonnet.slug } : null;
  }
  if (provider?.driver === "codex") {
    const effort = getModelSelectionStringOptionValue(selection, "reasoningEffort") ?? "low";
    if (effort !== "low" && effort !== "minimal") return null;
    return {
      ...selection,
      options: [
        ...(selection.options ?? []).filter((option) => option.id !== "reasoningEffort"),
        { id: "reasoningEffort", value: "medium" },
      ],
    };
  }
  return null;
}
