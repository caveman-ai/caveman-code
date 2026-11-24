// One branch from many builders (SPEC §8.5, finding P5). When a lead's builders have finished, each builder's
// branch is tried against the lead's with `git merge-tree`, in a fixed order: the ones that merge cleanly become
// merge commits on top of the lead's head, made in the object store alone, and the lead's branch then moves to the
// last of them in one fast-forward. Nothing is rewritten and nothing is forced: the lead's own commits stay as they
// are under the merges. A branch that conflicts is left out of this pass, with the files named, for its author.
//
// A pass that stops anywhere leaves either nothing (unreferenced objects) or a finished fast-forward, and a branch
// whose head is already in the lead's is "merged" without a second merge, so it can run again after a crash.
import * as Effect from "effect/Effect";

/** git in the lead's worktree. */
export type IntegrationGit = (
  args: ReadonlyArray<string>,
  options?: {
    readonly allowNonZeroExit?: boolean;
    readonly env?: NodeJS.ProcessEnv;
    readonly movesWorkingTree?: boolean;
  },
) => Effect.Effect<
  { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
  { readonly message: string }
>;

export interface Candidate {
  /** The builder's delegation (its row's key). */
  readonly key: string;
  readonly title: string;
  readonly branch: string;
  /** What names its head in the lead's repository: its branch (the same .git), or the ref it was fetched into. */
  readonly ref: string;
}

export type Outcome =
  /** Its head is in the lead's branch: merged now, or there already. */
  | { readonly key: string; readonly kind: "merged"; readonly sha: string }
  | {
      readonly key: string;
      readonly kind: "conflict";
      readonly sha: string;
      readonly files: ReadonlyArray<string>;
    }
  /** Its branch names no commit here. */
  | { readonly key: string; readonly kind: "missing" };

export interface Merged {
  readonly outcomes: ReadonlyArray<Outcome>;
  /** The lead's head after the pass. */
  readonly head: string;
  /**
   * Set when the clean merges could not be moved onto the lead's branch (its uncommitted changes are in the way, or it
   * moved meanwhile): nothing was merged, and `outcomes` says only what would have been.
   */
  readonly held?: string;
}

/** The merges are the app's, not a person's: a Cloud computer's git has no identity of its own. */
const IDENTITY = {
  GIT_AUTHOR_NAME: "Caveman Code",
  GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
  GIT_COMMITTER_NAME: "Caveman Code",
  GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
};

const said = (r: { readonly stdout: string; readonly stderr: string }) =>
  (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-3).join(" ").slice(0, 400);

/**
 * Merges every candidate that merges cleanly into the lead's branch, in the order given, and says what became of
 * each. The lead's worktree moves once, at the end, by fast-forward.
 */
export const mergeBranches = (
  git: IntegrationGit,
  candidates: ReadonlyArray<Candidate>,
  /** `tryOnly`: say what would merge and what conflicts, and move nothing (the lead's branch stays where it is). */
  options: { readonly tryOnly?: boolean } = {},
): Effect.Effect<Merged, { readonly message: string }> =>
  Effect.gen(function* () {
    const start = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
    let tip = start;
    const outcomes: Array<Outcome> = [];
    for (const candidate of candidates) {
      const found = yield* git(
        ["rev-parse", "--verify", "--quiet", "--end-of-options", `${candidate.ref}^{commit}`],
        { allowNonZeroExit: true },
      );
      const sha = found.stdout.trim();
      if (found.exitCode !== 0 || sha === "") {
        outcomes.push({ key: candidate.key, kind: "missing" });
        continue;
      }
      // In already (an earlier pass, or the builder never left the lead's commit): never merged twice.
      if (
        (yield* git(["merge-base", "--is-ancestor", sha, tip], { allowNonZeroExit: true }))
          .exitCode === 0
      ) {
        outcomes.push({ key: candidate.key, kind: "merged", sha });
        continue;
      }
      // Exit 0: the tree of a clean merge. Exit 1: conflicts, the files after the tree. Anything else is git failing.
      const tried = yield* git(
        ["merge-tree", "--write-tree", "--name-only", "--no-messages", tip, sha],
        { allowNonZeroExit: true },
      );
      const [tree = "", ...files] = tried.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      if (tried.exitCode === 1) {
        outcomes.push({ key: candidate.key, kind: "conflict", sha, files });
        continue;
      }
      if (tried.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(tree))
        return yield* Effect.fail({
          message: `git merge-tree could not try ${candidate.branch}: ${said(tried)}`,
        });
      const commit = (yield* git(
        [
          "commit-tree",
          tree,
          "-p",
          tip,
          "-p",
          sha,
          "-m",
          `Merge ${candidate.title} (${candidate.branch})`,
        ],
        { env: IDENTITY },
      )).stdout.trim();
      tip = commit;
      outcomes.push({ key: candidate.key, kind: "merged", sha });
    }
    if (tip === start || options.tryOnly === true) return { outcomes, head: start };
    // The one step that touches the lead's branch and files: git refuses it whole when the lead's uncommitted
    // changes would be overwritten or its branch moved since `start`, and then nothing here has happened.
    const moved = yield* git(["merge", "--ff-only", "--quiet", tip], {
      allowNonZeroExit: true,
      movesWorkingTree: true,
    });
    if (moved.exitCode !== 0) return { outcomes, head: start, held: said(moved) };
    return { outcomes, head: tip };
  });

/** One source of a lead that works in several: git in the lead's worktree of it, and the builders' branches there. */
export interface SourceCandidates {
  /** The source's folder in the lead's chat folder: a conflicting file is named under it. */
  readonly name: string;
  readonly git: IntegrationGit;
  readonly candidates: ReadonlyArray<Candidate>;
}

/**
 * The same step for a lead that works in several sources, whose builders each hold a branch of the same name in
 * every source. A builder's work goes in whole or not at all: its branches are first tried in every source without
 * moving anything, a builder that conflicts in any one is out of all of them this pass (again until no try
 * conflicts, since leaving one out changes what the next is tried against), and only then does each source's
 * branch move, each by its own fast-forward. A builder with no branch in a source changed nothing there.
 *
 * A source whose branch git would not move (`held`, naming it) leaves the sources before it moved; the pass is
 * tried again by itself, and a branch already in counts as merged, so it finishes where it stopped.
 */
export const mergeAcrossSources = (
  sources: ReadonlyArray<SourceCandidates>,
): Effect.Effect<Merged, { readonly message: string }> =>
  Effect.gen(function* () {
    const conflicts = new Map<string, { sha: string; files: Array<string> }>();
    const among = (source: SourceCandidates) =>
      source.candidates.filter((candidate) => !conflicts.has(candidate.key));
    for (let found = true; found;) {
      found = false;
      for (const source of sources) {
        const tried = yield* mergeBranches(source.git, among(source), { tryOnly: true });
        for (const outcome of tried.outcomes) {
          if (outcome.kind !== "conflict") continue;
          found = true;
          conflicts.set(outcome.key, {
            sha: outcome.sha,
            files: outcome.files.map((file) => `${source.name}/${file}`),
          });
        }
      }
    }
    const merged = new Map<string, string>();
    const heads: Array<string> = [];
    let held: string | undefined;
    for (const source of sources) {
      const done = yield* mergeBranches(source.git, among(source));
      heads.push(done.head);
      if (done.held !== undefined) {
        held = `${source.name}: ${done.held}`;
        break;
      }
      for (const outcome of done.outcomes) {
        if (outcome.kind === "merged" && !merged.has(outcome.key))
          merged.set(outcome.key, outcome.sha);
        // Between the try and the move its branch changed: out, as any conflict is.
        else if (outcome.kind === "conflict")
          conflicts.set(outcome.key, {
            sha: outcome.sha,
            files: outcome.files.map((file) => `${source.name}/${file}`),
          });
      }
    }
    const keys = [
      ...new Set(sources.flatMap((source) => source.candidates.map((candidate) => candidate.key))),
    ];
    const outcomes = keys.map((key): Outcome => {
      const conflict = conflicts.get(key);
      if (conflict !== undefined)
        return { key, kind: "conflict", sha: conflict.sha, files: conflict.files };
      const sha = merged.get(key);
      return sha === undefined ? { key, kind: "missing" } : { key, kind: "merged", sha };
    });
    return { outcomes, head: heads.join("+"), ...(held === undefined ? {} : { held }) };
  });

/** How many times a builder whose branch conflicts is sent back to bring it up to date before its work is left out. */
export const MAX_CONFLICT_ROUNDS = 2;

const fileList = (files: ReadonlyArray<string>) =>
  files.length === 0
    ? "the same lines"
    : files.length <= 8
      ? files.join(", ")
      : `${files.slice(0, 8).join(", ")} and ${files.length - 8} more`;

/** What a builder reads when its branch does not merge: which files, and how to finish without a force-push. */
export const conflictText = (input: {
  readonly branch: string;
  readonly leadBranch: string;
  readonly files: ReadonlyArray<string>;
  readonly round: number;
  /** The lead works in several repositories: the folders of each in the builder's own. */ readonly sources?: ReadonlyArray<string>;
}) =>
  `[Caveman Code] Your branch ${input.branch} does not merge into the lead's branch ${input.leadBranch}: both changed ${fileList(input.files)}. The other builders' work is in ${input.leadBranch} now. Bring yours up to date: run \`git merge ${input.leadBranch}\` in ${input.sources === undefined ? "your worktree" : `each repository's folder (${input.sources.join(", ")})`}, resolve the conflicts keeping both sides' intent, commit, and say what you did. Merge, do not rebase: your branch is shared and nothing is force-pushed. ${input.round >= MAX_CONFLICT_ROUNDS ? `This is the last try: if it still conflicts, your work is left out of the pull request${input.sources === undefined ? "" : "s"}.` : ""}`.trim();

export interface BuilderResult {
  readonly title: string;
  readonly branch: string;
  /** What it said of its work when it finished, in its own words. */
  readonly note: string;
  readonly state: "merged" | "left_out";
  /** Left out: why, in one clause. */
  readonly why?: string;
}

/** A builder's last answer as one short paragraph. */
export const shortNote = (text: string, max = 400) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/** Why a conflicting builder's work is not in, after its rounds. */
export const leftOutForConflict = (files: ReadonlyArray<string>, rounds: number) =>
  `it still conflicts with the rest in ${fileList(files)} after ${rounds === 1 ? "one try" : `${rounds} tries`} at bringing it up to date`;

/** The pull request's description: a note from each builder whose work is in, and plainly whose is not. */
export function describeResult(results: ReadonlyArray<BuilderResult>): string {
  const inside = results.filter((r) => r.state === "merged");
  const out = results.filter((r) => r.state === "left_out");
  const count = (n: number) => `${n} agent${n === 1 ? "" : "s"}`;
  const lines = [
    `${count(results.length)} worked on this. The work of ${inside.length === results.length ? "all of them" : count(inside.length)} is in this branch${out.length === 0 ? "" : `; ${count(out.length)} ${out.length === 1 ? "is" : "are"} left out, below`}.`,
    "",
  ];
  if (inside.length > 0)
    lines.push(
      "## What each agent did",
      "",
      ...inside.map((r) => `- **${r.title}** (\`${r.branch}\`): ${r.note || "It left no note."}`),
      "",
    );
  if (out.length > 0)
    lines.push(
      "## Left out",
      "",
      ...out.map(
        (r) =>
          `- **${r.title}** (\`${r.branch}\`): ${r.why ?? "its work is not in"}. Its work is on its own branch.`,
      ),
      "",
    );
  return lines.join("\n").trimEnd();
}

/** What the lead reads once, when its builders' work has come together. */
export function leadSummary(input: {
  readonly branch: string;
  readonly results: ReadonlyArray<BuilderResult>;
  readonly pullRequest?: string;
  readonly pullRequestProblem?: string;
  /** The lead works in several repositories: `pullRequest` names one pull request in each it changed. */ readonly several?: boolean;
}): string {
  const inside = input.results.filter((r) => r.state === "merged");
  const out = input.results.filter((r) => r.state === "left_out");
  const parts = [
    `[Caveman Code] Your builders have finished. ${inside.length} of ${input.results.length} ${input.results.length === 1 ? "branch is" : "branches are"} merged into ${input.branch}${inside.length === 0 ? "" : `: ${inside.map((r) => r.title).join(", ")}`}.`,
  ];
  if (out.length > 0)
    parts.push(`Not in: ${out.map((r) => `${r.title} (${r.why ?? "left out"})`).join("; ")}.`);
  if (input.pullRequest !== undefined && input.several === true)
    parts.push(
      `One pull request in each repository carries it, each naming the others, with a note from each builder: ${input.pullRequest}`,
    );
  else if (input.pullRequest !== undefined)
    parts.push(
      `One pull request carries it all, with a note from each builder: ${input.pullRequest}`,
    );
  else if (input.pullRequestProblem !== undefined)
    parts.push(`No pull request was opened: ${input.pullRequestProblem}`);
  return parts.join(" ");
}
