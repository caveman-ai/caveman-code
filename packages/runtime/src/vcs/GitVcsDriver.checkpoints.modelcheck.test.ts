// Model check: a checkpoint restore round-trips. For every pair of states two sibling paths can be in when the
// checkpoint is captured, every pair they can be in when it is restored, staged or not, with and without a committed
// version, in a directory that stays visible or one an ignore rule added after the capture hides as a whole: the
// restore leaves the files under the workspace byte-identical to the checkpoint (contents, exec bit, symlink targets,
// files vs directories), the ignored files it does not hold untouched, and never touches anything outside the
// workspace (not even through a symlink), the index outside it, HEAD or other refs. The unstaged visible cases run
// once more in a workspace below a folder an ignore rule added after the capture hides as a whole. Where git restore
// would delete an ignored file (a directory where the checkpoint holds a file or symlink, or a file or symlink where it
// holds a directory) or write the checkpoint's copy over one the person changed since (its contents, kind or execute
// bit), the restore refuses, naming exactly those, and changes nothing; once the person moves them, the restore goes
// ahead. Where the workspace's own .gitignore changed since the checkpoint, every pair of rule sets, the change
// written, staged or committed: the restore refuses to write over a file the checkpoint holds that git now ignores and
// the person changed; once that is moved, it keeps every file git ignored before it, and removes exactly what neither
// those rules nor the ones it brings back ignore. Real GitVcsDriver checkpoints through
// CheckpointStore. Every case is its own directory in one workspace, so one capture and two restores (the refused one,
// then the one after the person moved what it named) cover them all; git restores each path on its own, and the
// empty-workspace branches of restoreCheckpoint get their own repositories.
// The skill that maintains this check: .claude/skills/checkpoint-rollback/SKILL.md.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CheckpointRef, VcsUnsupportedOperationError } from "@caveman-app/protocol";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { snapshotTree, trackExecBit } from "../testUtils/fileTree.ts";

trackExecBit();

/**
 * What one path can be. p's link points out of the workspace (at a directory holding a file), q's at its sibling p;
 * `dir+ignored` also holds an ignored file. A checkpoint's own contents are captured too, so the content change
 * (file:two) and the ignored file only need to appear after the capture.
 */
const STATES = ["absent", "file:one", "exec:one", "link", "dir"] as const;
const NOW_STATES = [...STATES, "file:two", "dir+ignored"] as const;
type State = (typeof NOW_STATES)[number];

interface Case {
  readonly name: string;
  readonly captured: readonly [State, State];
  readonly now: readonly [State, State];
  readonly staged: boolean;
  /** Ignored as a whole after the capture (and after the staging), by `HIDDEN_RULE`; its name starts with h. */
  readonly hidden: boolean;
}
const CASES: ReadonlyArray<Case> = (() => {
  const cases: Array<Case> = [];
  for (const p of STATES)
    for (const q of STATES)
      for (const p2 of NOW_STATES)
        for (const q2 of NOW_STATES)
          for (const staged of [false, true])
            for (const hidden of [false, true])
              cases.push({
                name: `${hidden ? "h" : "c"}${cases.length}`,
                captured: [p, q],
                now: [p2, q2],
                staged,
                hidden,
              });
  return cases;
})();
const HIDDEN_RULE = "/ws/h*/\n";

/**
 * The repository a round's cases run in: p and q never committed, committed, or never committed in a workspace below a
 * folder `ABOVE_RULE` (added after the capture) hides as a whole. Nothing under that folder is in the index, so status
 * names only the folder; a staged case would put it there, and HIDDEN_RULE would add nothing, so that round has neither.
 */
type RoundKind = "untracked" | "committed" | "above";
const ABOVE_RULE = "/above/\n";
const workspaceOf = (kind: RoundKind) => (kind === "above" ? "above/ws" : "ws");
const casesOf = (kind: RoundKind) =>
  kind === "above" ? CASES.filter((c) => !c.staged && !c.hidden) : CASES;

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
const isIgnored = (rel: string) => rel.endsWith(".log");

/** Puts `name` in `state`; p's link points at `outside`, a directory outside the workspace. */
function put(dir: string, name: "p" | "q", state: State, outside: string) {
  const at = path.join(dir, name);
  fs.rmSync(at, { recursive: true, force: true });
  switch (state) {
    case "absent":
      return;
    case "file:one":
    case "file:two":
    case "exec:one":
      fs.writeFileSync(at, `${state.split(":")[1]}\n`);
      fs.chmodSync(at, state.startsWith("exec") ? 0o755 : 0o644);
      return;
    case "link":
      fs.symlinkSync(name === "p" ? path.relative(dir, outside) : "p", at);
      return;
    case "dir":
    case "dir+ignored":
      fs.mkdirSync(at);
      fs.writeFileSync(path.join(at, "x"), "inside\n");
      if (state === "dir+ignored")
        fs.writeFileSync(path.join(at, "mine.log"), "the person's ignored file\n");
      return;
  }
}

const byCase = (tree: Record<string, string>) => {
  const cases = new Map<string, Record<string, string>>();
  for (const [entry, value] of Object.entries(tree)) {
    const [name, ...rest] = entry.split("/");
    const files = cases.get(name!) ?? {};
    files[rest.join("/")] = value;
    cases.set(name!, files);
  }
  return cases;
};

interface Untouchable {
  readonly outside: string;
  readonly indexOutside: string;
  readonly refs: string;
  readonly head: string;
}
const untouchable = (repo: string, workspace = "ws"): Untouchable => ({
  outside: JSON.stringify(snapshotTree(repo, (rel) => !rel.startsWith(`${workspace}/`))),
  indexOutside: git(repo, "ls-files", "--stage", "--", ".", `:(exclude)${workspace}`),
  refs: git(repo, "for-each-ref", "--format=%(refname) %(objectname)"),
  head: fs.readFileSync(path.join(repo, ".git", "HEAD"), "utf8"),
});

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "mc-checkpoint-restore-" });
const layerCheckpointStore = CheckpointStore.layer.pipe(
  Layer.provide(
    VcsDriverRegistry.layer.pipe(
      Layer.provide(VcsProcess.layer),
      Layer.provide(layerConfig),
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  ),
);
const checkpointRef = CheckpointRef.make(
  "refs/t3/orchestration-v2/checkpoints/model-check/ordinal/0",
);

/**
 * restoreCheckpoint's refusal naming what it would delete and what it would write over (the first 20 of each; it
 * counts the rest).
 */
const REFUSAL = (deleted: ReadonlyArray<string>, writtenOver: ReadonlyArray<string>) => {
  const named = (paths: ReadonlyArray<string>) =>
    `${paths.slice(0, 20).join(", ")}${paths.length > 20 ? ` and ${paths.length - 20} more` : ""}`;
  const clauses = [
    ...(deleted.length > 0
      ? [`delete ignored files this checkpoint never saved: ${named(deleted)}`]
      : []),
    ...(writtenOver.length > 0
      ? [`write over ignored files changed since this checkpoint saved them: ${named(writtenOver)}`]
      : []),
  ];
  return `Restoring would ${clauses.join(". It would also ")}. Move them elsewhere, then restore again.`;
};

/** A refused restore's explanation, or what it did instead. */
const refusalOf = (exit: Exit.Exit<boolean, unknown>): string => {
  if (Exit.isSuccess(exit)) return `went ahead (${exit.value})`;
  const error = Cause.findErrorOption(exit.cause);
  return Option.isSome(error) && error.value instanceof VcsUnsupportedOperationError
    ? error.value.detail
    : Cause.pretty(exit.cause);
};

const BLOB_STATES: ReadonlyArray<State> = ["file:one", "exec:one", "link"];
const NON_DIRECTORY_STATES: ReadonlyArray<State> = ["file:one", "exec:one", "link", "file:two"];

/**
 * The ignored files restoring this case would delete or write over: git restore removes a directory to write a file or
 * symlink the checkpoint holds (and everything in it goes), and a file or symlink to make a directory it holds; and
 * writes the checkpoint's file or symlink over another (a state other than the captured one: other contents, execute
 * bit, kind). Each state's symlink always points at the same target. `ignored` is the case's files git ignored just
 * before the restore.
 */
const atRisk = (c: Case, ignored: Record<string, string>) => {
  const deleted: Array<string> = [];
  const writtenOver: Array<string> = [];
  (["p", "q"] as const).forEach((name, side) => {
    if (BLOB_STATES.includes(c.captured[side]!) && c.now[side]!.startsWith("dir"))
      deleted.push(...Object.keys(ignored).filter((file) => file.startsWith(`${name}/`)));
    else if (
      c.captured[side] === "dir" &&
      NON_DIRECTORY_STATES.includes(c.now[side]!) &&
      name in ignored
    )
      deleted.push(name);
    else if (
      BLOB_STATES.includes(c.captured[side]!) &&
      c.now[side] !== c.captured[side] &&
      name in ignored
    )
      writtenOver.push(name);
  });
  return {
    deleted: deleted.map((file) => `${c.name}/${file}`),
    writtenOver: writtenOver.map((file) => `${c.name}/${file}`),
  };
};

/** Whether a named path (a directory with a trailing slash) is, or holds, `file`. */
const covers = (named: string, file: string) =>
  named.endsWith("/") ? file.startsWith(named) : file === named;

interface Round {
  readonly kind: RoundKind;
  readonly cases: ReadonlyArray<Case>;
  readonly captured: Map<string, Record<string, string>>;
  /** Every file under the workspace after the second restore, ignored ones too. */
  readonly files: Map<string, Record<string, string>>;
  /** The files git ignored just before the first restore. */
  readonly ignoredBefore: Map<string, Record<string, string>>;
  readonly before: Untouchable;
  readonly after: Untouchable;
  /** What GitVcsDriver's ignoredInTheWay listed in the first restore's way (moved away next), both lists. */
  readonly named: ReadonlyArray<string>;
  /** Of those, the ignored files it would write over. */
  readonly writtenOver: ReadonlyArray<string>;
  /** The first restore's answer: its refusal's explanation, or what it did. */
  readonly refused: string;
  /** Every file under the workspace (ignored ones too) and its index, around the refused restore. */
  readonly workspaceBeforeRefusal: string;
  readonly workspaceAfterRefusal: string;
  /** The second restore's answer (true: the checkpoint was found), or the failure. */
  readonly restored: boolean | string;
}

/**
 * One workspace holding every case of the round: commit (or not), capture, change, stage some, hide some, restore
 * (refused), move what it named out of the workspace, restore again.
 */
const round = (root: string, kind: RoundKind) =>
  Effect.gen(function* () {
    const store = yield* CheckpointStore.CheckpointStore;
    const ignoredInTheWay = yield* GitVcsDriver.makeIgnoredInTheWay;
    const cases = casesOf(kind);
    const repo = path.join(root, kind);
    const workspaceRel = workspaceOf(kind);
    const cwd = path.join(repo, workspaceRel);
    const outside = path.join(repo, "outside-dir");
    fs.mkdirSync(outside, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, ".gitignore"), "*.log\n");
    fs.writeFileSync(path.join(outside, "kept.txt"), "outside the workspace\n");
    for (const c of cases) {
      fs.mkdirSync(path.join(cwd, c.name), { recursive: true });
      if (kind === "committed") {
        fs.writeFileSync(path.join(cwd, c.name, "p"), "committed\n");
        fs.writeFileSync(path.join(cwd, c.name, "q"), "committed\n");
      }
    }
    fs.writeFileSync(path.join(kind === "above" ? repo : cwd, "anchor.txt"), "anchor\n");
    git(repo, "add", ".");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");

    for (const c of cases) {
      const dir = path.join(cwd, c.name);
      put(dir, "p", c.captured[0], outside);
      put(dir, "q", c.captured[1], outside);
      fs.writeFileSync(path.join(dir, "z.log"), "ignored, at capture\n");
    }
    yield* store.captureCheckpoint({ cwd, checkpointRef });
    const captured = byCase(snapshotTree(cwd, (rel) => !isIgnored(rel)));

    for (const c of cases) {
      const dir = path.join(cwd, c.name);
      put(dir, "p", c.now[0], outside);
      put(dir, "q", c.now[1], outside);
      fs.writeFileSync(path.join(dir, "z.log"), "ignored, written after the capture\n");
    }
    fs.writeFileSync(path.join(outside, "kept.txt"), "outside, edited after the capture\n");
    fs.writeFileSync(path.join(repo, "staged-outside.txt"), "staged outside the workspace\n");
    git(repo, "add", "staged-outside.txt");
    const staged = cases.filter((c) => c.staged).map((c) => `${workspaceRel}/${c.name}`);
    // With no pathspec at all, add -A would stage the whole repository.
    if (staged.length > 0)
      execFileSync("git", ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        cwd: repo,
        input: staged.join("\0"),
      });
    fs.appendFileSync(
      path.join(repo, ".git", "info", "exclude"),
      kind === "above" ? ABOVE_RULE : HIDDEN_RULE,
    );
    const before = untouchable(repo, workspaceRel);
    const workspace = () =>
      JSON.stringify({
        files: snapshotTree(cwd),
        index: git(repo, "ls-files", "--stage", "--", workspaceRel),
      });
    const workspaceBeforeRefusal = workspace();
    const ignored = new Set(
      git(cwd, "ls-files", "-z", "-o", "-i", "--exclude-standard", "--", ".").split("\0"),
    );
    const ignoredBefore = byCase(snapshotTree(cwd, (rel) => ignored.has(rel)));

    const way = yield* ignoredInTheWay(cwd, git(repo, "rev-parse", checkpointRef).trim());
    const named = [...way.inTheWay, ...way.writtenOver];
    const refused = refusalOf(
      yield* Effect.exit(store.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false })),
    );
    const workspaceAfterRefusal = workspace();
    for (const entry of named) fs.rmSync(path.join(cwd, entry), { recursive: true, force: true });

    const restored = yield* Effect.exit(
      store.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false }),
    );
    return {
      kind,
      cases,
      captured,
      files: byCase(snapshotTree(cwd)),
      ignoredBefore,
      before,
      after: untouchable(repo, workspaceRel),
      named,
      writtenOver: way.writtenOver,
      refused,
      workspaceBeforeRefusal,
      workspaceAfterRefusal,
      restored: Exit.isSuccess(restored) ? restored.value : Cause.pretty(restored.cause),
    } satisfies Round;
  });

/**
 * What a case directory's own .gitignore (restored with the checkpoint) can hold. `neg` takes k.sec back from the
 * repository's `*.sec`, which lives outside the workspace and so never changes.
 */
const RULES = { env: "*.env", out: "out/", neg: "!k.sec" } as const;
type Rule = keyof typeof RULES;
const RULE_SETS: ReadonlyArray<ReadonlyArray<Rule>> = [
  [],
  ["env"],
  ["out"],
  ["neg"],
  ["env", "out"],
  ["env", "neg"],
  ["out", "neg"],
  ["env", "out", "neg"],
];
/** How the .gitignore's change after the capture is recorded. */
const RECORDED = ["written", "staged", "committed"] as const;
/** The files of a rules case at restore, and, when it has files at the capture, then too (other contents). */
const RULES_FILES = [
  "s.env",
  "k.sec",
  "out/o",
  "out/s.env",
  "n/s.env",
  "n/v",
  "v",
  "z.log",
] as const;

interface RulesCase {
  readonly name: string;
  /** The case's .gitignore at the capture, committed (none when empty). */
  readonly captured: ReadonlyArray<Rule>;
  /** Its .gitignore at the restore. */
  readonly now: ReadonlyArray<Rule>;
  readonly recorded: (typeof RECORDED)[number];
  readonly filesAtCapture: boolean;
}
const RULES_CASES: ReadonlyArray<RulesCase> = (() => {
  const cases: Array<RulesCase> = [];
  for (const captured of RULE_SETS)
    for (const now of RULE_SETS)
      for (const recorded of RECORDED)
        for (const filesAtCapture of [false, true])
          cases.push({ name: `r${cases.length}`, captured, now, recorded, filesAtCapture });
  return cases;
})();
const gitignoreOf = (rules: ReadonlyArray<Rule>) =>
  rules.map((rule) => `${RULES[rule]}\n`).join("");

/** Whether git ignores `file` (relative to its case) under the repository's rules (`*.log`, `*.sec`) and `rules`. */
const ignoredUnder = (rules: ReadonlyArray<Rule>, file: string) =>
  file.endsWith(".log") ||
  (file === "k.sec" && !rules.includes("neg")) ||
  (file.endsWith(".env") && rules.includes("env")) ||
  (file.startsWith("out/") && rules.includes("out"));

/**
 * One workspace holding every rules case: commit each case's .gitignore, write its files (or not), capture, change
 * the .gitignore (and record it), write the files again, restore (refused where the person changed a file the
 * checkpoint holds and git now ignores), move what it named, restore again.
 */
const rulesRound = (root: string) =>
  Effect.gen(function* () {
    const store = yield* CheckpointStore.CheckpointStore;
    const ignoredInTheWay = yield* GitVcsDriver.makeIgnoredInTheWay;
    const repo = path.join(root, "rules");
    const cwd = path.join(repo, "ws");
    fs.mkdirSync(cwd, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, ".gitignore"), "*.log\n*.sec\n");
    fs.writeFileSync(path.join(cwd, "anchor.txt"), "anchor\n");
    const write = (c: RulesCase, file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(cwd, c.name, file)), { recursive: true });
      fs.writeFileSync(path.join(cwd, c.name, file), text);
    };
    for (const c of RULES_CASES)
      if (c.captured.length > 0) write(c, ".gitignore", gitignoreOf(c.captured));
    git(repo, "add", ".");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    for (const c of RULES_CASES)
      if (c.filesAtCapture) for (const file of RULES_FILES) write(c, file, "then\n");
    const gitIgnored = () =>
      new Set(git(cwd, "ls-files", "-z", "-o", "-i", "--exclude-standard", "--", ".").split("\0"));
    const ignoredAtCapture = gitIgnored();
    yield* store.captureCheckpoint({ cwd, checkpointRef });

    for (const c of RULES_CASES) {
      for (const file of RULES_FILES) write(c, file, "now\n");
      if (c.now.length > 0) write(c, ".gitignore", gitignoreOf(c.now));
      else fs.rmSync(path.join(cwd, c.name, ".gitignore"), { force: true });
    }
    const recordedAs = (how: RulesCase["recorded"]) =>
      RULES_CASES.filter((c) => (how === "staged" ? c.recorded !== "written" : c.recorded === how))
        .filter((c) => c.captured.length > 0 || c.now.length > 0)
        .map((c) => `ws/${c.name}/.gitignore`)
        .join("\0");
    execFileSync("git", ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], {
      cwd: repo,
      input: recordedAs("staged"),
    });
    execFileSync(
      "git",
      [
        ...["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "rules"],
        ...["--pathspec-from-file=-", "--pathspec-file-nul"],
      ],
      { cwd: repo, input: recordedAs("committed") },
    );
    const ignoredBefore = gitIgnored();
    const filesBefore = byCase(snapshotTree(cwd));
    const before = untouchable(repo);
    const workspace = () =>
      JSON.stringify({
        files: snapshotTree(cwd),
        index: git(repo, "ls-files", "--stage", "--", "ws"),
      });
    const workspaceBeforeRefusal = workspace();
    const way = yield* ignoredInTheWay(cwd, git(repo, "rev-parse", checkpointRef).trim());
    const named = [...way.inTheWay, ...way.writtenOver];
    const refused = refusalOf(
      yield* Effect.exit(store.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false })),
    );
    const workspaceAfterRefusal = workspace();
    for (const entry of named) fs.rmSync(path.join(cwd, entry), { recursive: true, force: true });
    const restored = yield* Effect.exit(
      store.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false }),
    );
    return {
      ignoredAtCapture,
      ignoredBefore,
      filesBefore,
      named,
      writtenOver: way.writtenOver,
      refused,
      workspaceBeforeRefusal,
      workspaceAfterRefusal,
      files: byCase(snapshotTree(cwd)),
      before,
      after: untouchable(repo),
      restored: Exit.isSuccess(restored) ? restored.value : Cause.pretty(restored.cause),
    };
  });

/**
 * An empty workspace at capture. With nothing tracked there at restore, restoreCheckpoint skips git restore (its
 * pathspec would match nothing); with a staged file, git restore removes the workspace's last tracked file and the
 * directory with it, which restoreCheckpoint makes again.
 */
const emptyRound = (root: string, staged: boolean) =>
  Effect.gen(function* () {
    const store = yield* CheckpointStore.CheckpointStore;
    const repo = path.join(root, staged ? "empty-staged" : "empty");
    const cwd = path.join(repo, "ws");
    fs.mkdirSync(cwd, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, ".gitignore"), "*.log\n");
    fs.writeFileSync(path.join(repo, "outside.txt"), "outside\n");
    git(repo, "add", ".");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    if (!staged) fs.writeFileSync(path.join(cwd, "z.log"), "ignored\n");
    yield* store.captureCheckpoint({ cwd, checkpointRef });
    fs.mkdirSync(path.join(cwd, "made", "deep"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "made", "deep", "file.txt"), "made after\n");
    if (staged) git(repo, "add", "ws/made");
    else fs.symlinkSync("made", path.join(cwd, "link"));
    const before = untouchable(repo);
    const restored = yield* Effect.exit(
      store.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false }),
    );
    return {
      staged,
      restored: Exit.isSuccess(restored) ? restored.value : Cause.pretty(restored.cause),
      tree: fs.existsSync(cwd) ? snapshotTree(cwd) : "<no workspace directory>",
      before,
      after: untouchable(repo),
    };
  });

let root: string;
let rounds: ReadonlyArray<Round> = [];
let empties: ReadonlyArray<Effect.Success<ReturnType<typeof emptyRound>>> = [];
let rules: Effect.Success<ReturnType<typeof rulesRound>>;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mc-checkpoint-restore-"));
  const started = Date.now();
  [rounds, empties, rules] = await Effect.runPromise(
    Effect.all([
      Effect.all([round(root, "untracked"), round(root, "committed"), round(root, "above")]),
      Effect.all([emptyRound(root, false), emptyRound(root, true)]),
      rulesRound(root),
    ]).pipe(
      Effect.provide(
        Layer.mergeAll(layerCheckpointStore, VcsProcess.layer).pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );
  process.stdout.write(
    `checkpoint restore model check: ${STATES.length}^2 captured x ${NOW_STATES.length}^2 current x 2 staged x 2 hidden = ${CASES.length} cases per round, 2 rounds (uncommitted, committed) + their ${casesOf("above").length} unstaged visible cases below an ignored folder + ${RULE_SETS.length}^2 .gitignore rules x ${RECORDED.length} recorded x 2 files at capture = ${RULES_CASES.length} rules cases + 2 empty workspaces = ${rounds.reduce((sum, r) => sum + r.cases.length, 0) + RULES_CASES.length + 2} round trips, exhaustive within the bound, ${((Date.now() - started) / 1000).toFixed(1)} s\n`,
  );
  // Room for a heavily loaded machine, where the rollback check has taken over 300 s.
}, 600_000);

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const ROUND_LABELS: Record<RoundKind, string> = {
  untracked: "p and q never committed",
  committed: "p and q committed",
  above: "p and q never committed, a folder above the workspace ignored since",
};

const describeCase = (r: Round, c: Case) =>
  `case ${c.name} (${ROUND_LABELS[r.kind]}): at capture p=${c.captured[0]} q=${c.captured[1]}; at restore p=${c.now[0]} q=${c.now[1]}${c.staged ? ", staged" : ""}${c.hidden ? ", its directory ignored since" : ""}`;

/** The ignored files of a case that the second restore must leave as they were: not moved, not the checkpoint's. */
const keptIgnored = (r: Round, c: Case) =>
  Object.keys(r.ignoredBefore.get(c.name) ?? {}).filter(
    (file) =>
      !(file in (r.captured.get(c.name) ?? {})) &&
      !r.named.some((named) => covers(named, `${c.name}/${file}`)),
  );

describe("checkpoint restore round trip", () => {
  it("a restore that would delete ignored files refuses, naming exactly what it would delete, and changes nothing", () => {
    for (const r of rounds) {
      const repo = `the ${r.kind} repo`;
      const risks = r.cases.map((c) => atRisk(c, r.ignoredBefore.get(c.name) ?? {}));
      const expected = risks.flatMap((risk) => [...risk.deleted, ...risk.writtenOver]);
      // Each file at risk is named once, as itself or in a named directory; each name holds one.
      const missed = expected.filter(
        (file) => r.named.filter((named) => covers(named, file)).length !== 1,
      );
      const extra = r.named.filter((named) => !expected.some((file) => covers(named, file)));
      expect(
        { missed: missed.slice(0, 5), extra: extra.slice(0, 5) },
        `${repo}: ${missed.length} of ${expected.length} at risk not named once, ${extra.length} of ${r.named.length} named though in no one's way`,
      ).toEqual({ missed: [], extra: [] });
      // A file the restore would write over is named as itself, in the refusal's own sentence.
      expect([...r.writtenOver].sort(), `${repo}: written over`).toEqual(
        risks.flatMap((risk) => risk.writtenOver).sort(),
      );
      const deleted = r.named.filter((named) => !r.writtenOver.includes(named));
      expect(r.refused, `${repo}: the first restore`).toBe(REFUSAL(deleted, r.writtenOver));
      expect(r.workspaceAfterRefusal, `${repo}: the workspace after the refused restore`).toBe(
        r.workspaceBeforeRefusal,
      );
    }
  });

  it("every restore reports the checkpoint found", () => {
    for (const r of [...rounds, ...empties]) expect(r.restored).toBe(true);
  });

  it("the files under the workspace end byte-identical to the checkpoint, beside the ignored files it kept", () => {
    const broken: Array<string> = [];
    for (const r of rounds)
      for (const c of r.cases) {
        const kept = new Set(keptIgnored(r, c));
        const expected = JSON.stringify(r.captured.get(c.name) ?? {});
        const actual = JSON.stringify(
          Object.fromEntries(
            Object.entries(r.files.get(c.name) ?? {}).filter(([file]) => !kept.has(file)),
          ),
        );
        if (expected !== actual)
          broken.push(`${describeCase(r, c)}\n  restored ${actual}\n  checkpoint ${expected}`);
      }
    expect(broken.slice(0, 5).join("\n"), `${broken.length} cases broken`).toBe("");
  });

  it("ignored files the checkpoint does not hold are never touched", () => {
    const broken: Array<string> = [];
    // What the checkpoint held at the path whose ignored file changed, to tell a new break from a known one.
    const heldAtPath = new Map<string, number>();
    for (const r of rounds)
      for (const c of r.cases) {
        const ignored = r.ignoredBefore.get(c.name) ?? {};
        const after = r.files.get(c.name) ?? {};
        for (const file of keptIgnored(r, c)) {
          if (after[file] === ignored[file]) continue;
          broken.push(
            `${describeCase(r, c)}\n  ${c.name}/${file} is now ${after[file] ?? "<deleted>"}`,
          );
          const held = file.startsWith("p")
            ? c.captured[0]
            : file.startsWith("q")
              ? c.captured[1]
              : "-";
          heldAtPath.set(held, (heldAtPath.get(held) ?? 0) + 1);
        }
      }
    expect(
      broken.slice(0, 5).join("\n"),
      `${broken.length} ignored files changed; the checkpoint held their path as ${JSON.stringify(Object.fromEntries(heldAtPath))}`,
    ).toBe("");
  });

  it("nothing outside the workspace, the index outside it, HEAD or other refs change", () => {
    for (const r of [...rounds, ...empties]) {
      expect(r.after.outside, "files outside ws/").toBe(r.before.outside);
      expect(r.after.indexOutside, "the index outside ws/").toBe(r.before.indexOutside);
      expect(r.after.head, "HEAD").toBe(r.before.head);
      expect(r.after.refs, "refs").toBe(r.before.refs);
    }
  });

  it("an empty checkpoint restores to an empty workspace that still exists, its ignored file kept", () => {
    expect(empties.map((r) => r.tree)).toEqual([{ "z.log": "644 ignored\n" }, {}]);
  });
});

/** What the checkpoint holds of a rules case: its .gitignore then, and the files that .gitignore did not ignore. */
const heldBy = (c: RulesCase): Record<string, string> => {
  const held: Record<string, string> = {};
  if (c.captured.length > 0) held[".gitignore"] = `644 ${gitignoreOf(c.captured)}`;
  if (c.filesAtCapture)
    for (const file of RULES_FILES) if (!ignoredUnder(c.captured, file)) held[file] = "644 then\n";
  return held;
};
/**
 * The case's rules on disk once git restore has run: the checkpoint's .gitignore, or, where it holds none, a new one
 * that was never staged (git restore leaves what the index does not hold; the clean then removes it, rules read).
 */
const rulesAfterRestore = (c: RulesCase) =>
  c.captured.length > 0 ? c.captured : c.recorded === "written" ? c.now : [];

const describeRulesCase = (c: RulesCase) =>
  `case ${c.name}: .gitignore at capture [${c.captured.join(", ")}], at restore [${c.now.join(", ")}] ` +
  `(${c.recorded}), files ${c.filesAtCapture ? "at capture and" : "only"} at restore`;

describe("checkpoint restore round trip, with the workspace's .gitignore changed since the checkpoint", () => {
  it("the check's rules agree with git's, at the capture and before the restore", () => {
    const disagree: Array<string> = [];
    for (const c of RULES_CASES)
      for (const file of RULES_FILES) {
        const at = `${c.name}/${file}`;
        if (c.filesAtCapture && ignoredUnder(c.captured, file) !== rules.ignoredAtCapture.has(at))
          disagree.push(`${describeRulesCase(c)}: ${file} at the capture`);
        if (ignoredUnder(c.now, file) !== rules.ignoredBefore.has(at))
          disagree.push(`${describeRulesCase(c)}: ${file} before the restore`);
      }
    expect(disagree.slice(0, 5), `${disagree.length} disagreements`).toEqual([]);
  });

  it("a restore that would write over a file git now ignores and the person changed refuses, naming those", () => {
    // Every file is written again after the capture with other contents, so each held one git now ignores changed.
    const expected = RULES_CASES.flatMap((c) =>
      Object.keys(heldBy(c))
        .filter((file) => rules.ignoredBefore.has(`${c.name}/${file}`))
        .map((file) => `${c.name}/${file}`),
    ).sort();
    expect(rules.named).toEqual(expected);
    expect(rules.writtenOver).toEqual(expected);
    expect(rules.refused).toBe(REFUSAL([], rules.writtenOver));
    expect(rules.workspaceAfterRefusal, "the workspace after the refused restore").toBe(
      rules.workspaceBeforeRefusal,
    );
  });

  it("once those are moved, the restore goes ahead", () => {
    expect(rules.restored).toBe(true);
  });

  it("ignored files the checkpoint does not hold are never touched", () => {
    const broken: Array<string> = [];
    for (const c of RULES_CASES) {
      const before = rules.filesBefore.get(c.name) ?? {};
      const after = rules.files.get(c.name) ?? {};
      for (const [file, text] of Object.entries(before))
        if (
          rules.ignoredBefore.has(`${c.name}/${file}`) &&
          !(file in heldBy(c)) &&
          after[file] !== text
        )
          broken.push(
            `${describeRulesCase(c)}\n  ${c.name}/${file} is now ${after[file] ?? "<deleted>"}`,
          );
    }
    expect(broken.slice(0, 5).join("\n"), `${broken.length} ignored files changed`).toBe("");
  });

  it("the files end as the checkpoint holds them, beside what git ignores before or after the restore", () => {
    const broken: Array<string> = [];
    const sorted = (files: Record<string, string>) =>
      JSON.stringify(Object.fromEntries(Object.entries(files).sort()));
    for (const c of RULES_CASES) {
      const expected = heldBy(c);
      for (const [file, text] of Object.entries(rules.filesBefore.get(c.name) ?? {}))
        if (
          !(file in expected) &&
          (ignoredUnder(c.now, file) || ignoredUnder(rulesAfterRestore(c), file))
        )
          expected[file] = text;
      const actual = sorted(rules.files.get(c.name) ?? {});
      if (actual !== sorted(expected))
        broken.push(
          `${describeRulesCase(c)}\n  restored ${actual}\n  expected ${sorted(expected)}`,
        );
    }
    expect(
      broken.slice(0, 5).join("\n"),
      `${broken.length} of ${RULES_CASES.length} cases broken`,
    ).toBe("");
  });

  it("nothing outside the workspace, the index outside it, HEAD or other refs change", () => {
    expect(rules.after.outside, "files outside ws/").toBe(rules.before.outside);
    expect(rules.after.indexOutside, "the index outside ws/").toBe(rules.before.indexOutside);
    expect(rules.after.head, "HEAD").toBe(rules.before.head);
    expect(rules.after.refs, "refs").toBe(rules.before.refs);
  });
});
