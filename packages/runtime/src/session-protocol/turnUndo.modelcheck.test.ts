// Model check: the Changes card's Undo (checkpoint.undo in handlers.ts) changes only the files the latest turn wrote,
// and only while each still matches what the turn left; when it goes ahead, every one of them is back as the turn
// found it (both sides of a rename), and when it refuses, nothing moved. On the real runtime: the real Claude adapter
// and SDK running the stand-in CLI (scripts/smoke-claude.mjs) behind a wrapper that applies a turn's file operations
// once the turn's baseline is kept (its turn-start ref is there), as a real CLI's tools wait for it, before the prompt
// reaches the CLI; real checkpoints on a real worktree, the real handler. Each kind of file operation a turn can make appears once, each in its own folder.
// The skill that maintains this check: .claude/skills/checkpoint-rollback/SKILL.md.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { snapshotTree, trackExecBit, treeDiff } from "../testUtils/fileTree.ts";
import {
  FAKE_CLAUDE,
  makeConfig,
  makeRepo,
  MODEL,
  startRuntime,
  tempRoot,
  until,
} from "./testHarness.ts";

trackExecBit();

type Op =
  | { readonly op: "write"; readonly path: string; readonly text: string }
  | { readonly op: "rm"; readonly path: string }
  | { readonly op: "mv"; readonly from: string; readonly to: string }
  | { readonly op: "chmod"; readonly path: string; readonly mode: number }
  | { readonly op: "symlink"; readonly path: string; readonly target: string };

/**
 * The stand-in CLI behind a wrapper: a prompt holding "ops: <base64 JSON>" has those operations applied first, once
 * the repo holds `after` turn-start refs (the turn's baseline is kept).
 */
const WRAPPER = `
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
const [fake, ...args] = process.argv.slice(2);
const child = spawn(process.execPath, [fake, ...args], { stdio: ["pipe", "inherit", "inherit"] });
const applied = new Set();
const apply = (ops) => {
  for (const op of ops) {
    const at = (p) => path.join(process.cwd(), p);
    if (op.op === "write") { fs.rmSync(at(op.path), { recursive: true, force: true }); fs.mkdirSync(path.dirname(at(op.path)), { recursive: true }); fs.writeFileSync(at(op.path), op.text); }
    if (op.op === "rm") fs.rmSync(at(op.path), { recursive: true, force: true });
    if (op.op === "mv") { fs.mkdirSync(path.dirname(at(op.to)), { recursive: true }); fs.renameSync(at(op.from), at(op.to)); }
    if (op.op === "chmod") fs.chmodSync(at(op.path), op.mode);
    if (op.op === "symlink") fs.symlinkSync(op.target, at(op.path));
  }
};
const turnStarts = () =>
  execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/t3/orchestration-v2/checkpoints/"], { encoding: "utf8" })
    .split("\\n").filter((ref) => ref.includes("/turn-start/")).length;
const kept = async (after) => { while (turnStarts() < after) await new Promise((resolve) => setTimeout(resolve, 20)); };
// Lines go on in order: the ones after a prompt whose operations wait, wait too.
let queue = Promise.resolve();
createInterface({ input: process.stdin })
  .on("line", (line) => {
    queue = queue.then(async () => {
      const marker = /ops: ([A-Za-z0-9+/=]+)/.exec(line);
      if (marker && !applied.has(marker[1])) {
        try {
          if (JSON.parse(line).type === "user") {
            applied.add(marker[1]);
            const { after, ops } = JSON.parse(Buffer.from(marker[1], "base64").toString("utf8"));
            await kept(after);
            apply(ops);
          }
        } catch (error) { process.stderr.write(String(error) + "\\n"); }
      }
      child.stdin.write(line + "\\n");
    });
  })
  .on("close", () => { queue = queue.then(() => child.stdin.end()); });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
`;

const LONG = Array.from(
  { length: 12 },
  (_, i) => `line ${i + 1} of a file long enough for rename detection`,
).join("\n");

/** What a turn finds, what it does, and what the person does after it. */
interface Scenario {
  readonly name: string;
  readonly committed: Readonly<Record<string, string>>;
  /** Before the chat's first turn: the person's own files, part of the turn's baseline. */
  readonly personBefore?: (tree: string) => void;
  readonly ops: ReadonlyArray<Op>;
  readonly personAfter?: (tree: string) => void;
  /** Undo is expected to refuse (with this reason) and change nothing. */
  readonly refuses?: RegExp;
}

const SCENARIOS: ReadonlyArray<Scenario> = [
  {
    name: "every-kind",
    committed: {
      "overwrite/p": "base\n",
      "delete/p": "base\n",
      "add/keep": "keep\n",
      "rename/p": `${LONG}\n`,
      "rename-edit/p": `${LONG}\n`,
      "chmod/run.sh": "#!/bin/sh\n",
      "chmod-group/run.sh": "#!/bin/sh\n",
      "untracked/keep": "keep\n",
      "blank-name/ ": "base\n",
      "rename-trailing-space/p": `${LONG}\n`,
      "bystander.txt": "never touched\n",
    },
    personBefore: (tree) => {
      fs.writeFileSync(path.join(tree, "untracked/mine.txt"), "the person's own file\n");
      fs.writeFileSync(path.join(tree, "staged.txt"), "staged by the person\n");
      execFileSync("git", ["add", "staged.txt"], { cwd: tree });
    },
    ops: [
      { op: "write", path: "overwrite/p", text: "changed by the turn\n" },
      { op: "rm", path: "delete/p" },
      { op: "write", path: "add/q", text: "made by the turn\n" },
      { op: "mv", from: "rename/p", to: "rename/q" },
      { op: "mv", from: "rename-edit/p", to: "rename-edit/q" },
      { op: "write", path: "rename-edit/q", text: `${LONG.replace("line 3 ", "line three ")}\n` },
      { op: "chmod", path: "chmod/run.sh", mode: 0o755 },
      // Execute bits for group and others only: git records 100644, as it takes the owner's bit alone.
      { op: "write", path: "chmod-group/run.sh", text: "#!/bin/sh\necho group\n" },
      { op: "chmod", path: "chmod-group/run.sh", mode: 0o654 },
      { op: "write", path: "untracked/mine.txt", text: "the turn rewrote it\n" },
      // Names ending in whitespace, one of a single space: git's names, kept whole.
      { op: "write", path: "blank-name/ ", text: "changed by the turn\n" },
      { op: "write", path: "trailing-space/q ", text: "made by the turn\n" },
      { op: "mv", from: "rename-trailing-space/p", to: "rename-trailing-space/q " },
    ],
  },
  {
    name: "file-to-dir",
    committed: { "swap/p": "base\n" },
    ops: [
      { op: "rm", path: "swap/p" },
      { op: "write", path: "swap/p/x", text: "inside\n" },
    ],
  },
  {
    name: "file-to-dir-then-mine",
    committed: { "swap/p": "base\n" },
    ops: [
      { op: "rm", path: "swap/p" },
      { op: "write", path: "swap/p/x", text: "inside\n" },
    ],
    // Putting swap/p back would take the directory away, the person's file with it.
    personAfter: (tree) =>
      fs.writeFileSync(path.join(tree, "swap/p/mine.md"), "the person's own file\n"),
    refuses: /changed after this turn/,
  },
  {
    name: "dir-to-file",
    committed: { "swap/d/x": "base\n" },
    ops: [
      { op: "rm", path: "swap/d" },
      { op: "write", path: "swap/d", text: "a file now\n" },
    ],
  },
  {
    name: "dir-to-file-after",
    committed: { "swap/e/x": "base\n" },
    ops: [{ op: "write", path: "swap/e/x", text: "changed by the turn\n" }],
    // The person turns the directory the turn wrote in into a file.
    personAfter: (tree) => {
      fs.rmSync(path.join(tree, "swap/e"), { recursive: true });
      fs.writeFileSync(path.join(tree, "swap/e"), "the person's own file\n");
    },
    refuses: /changed after this turn/,
  },
  {
    name: "edited-after",
    committed: { "a/p": "base\n", "b/p": `${LONG}\n` },
    ops: [
      { op: "write", path: "a/p", text: "changed by the turn\n" },
      { op: "mv", from: "b/p", to: "b/q" },
    ],
    personAfter: (tree) =>
      fs.writeFileSync(path.join(tree, "a/p"), "changed by the turn\nand by the person\n"),
    refuses: /changed after this turn/,
  },
  {
    name: "renamed-then-edited",
    committed: { "r/p": `${LONG}\n` },
    ops: [{ op: "mv", from: "r/p", to: "r/q" }],
    personAfter: (tree) => fs.appendFileSync(path.join(tree, "r/q"), "the person's line\n"),
    refuses: /changed after this turn/,
  },
  {
    name: "link",
    committed: { "l/p": "base\n" },
    ops: [{ op: "symlink", path: "l/link", target: "p" }],
    refuses: /links/,
  },
];

const index = (tree: string) =>
  execFileSync("git", ["ls-files", "--stage"], { cwd: tree, encoding: "utf8" });
/** The later turns' baselines kept in this repo so far (CheckpointService's turn starts). */
const turnStarts = (tree: string) =>
  execFileSync(
    "git",
    ["for-each-ref", "--format=%(refname)", "refs/t3/orchestration-v2/checkpoints/"],
    {
      cwd: tree,
      encoding: "utf8",
    },
  )
    .split("\n")
    .filter((ref) => ref.includes("/turn-start/")).length;

interface Outcome {
  readonly scenario: Scenario;
  readonly cardFiles: ReadonlyArray<string>;
  readonly undo: { readonly files: ReadonlyArray<string> } | { readonly refused: string };
  /** The worktree when the turn began (its baseline), after the turn (and the person), and after Undo. */
  readonly began: Record<string, string>;
  readonly beforeUndo: Record<string, string>;
  readonly afterUndo: Record<string, string>;
  readonly indexBeforeUndo: string;
  readonly indexAfterUndo: string;
}

let root: string;
let config: Awaited<ReturnType<typeof makeConfig>>;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
const outcomes = new Map<string, Outcome>();

const done = (events: ReadonlyArray<SessionEvent>) =>
  events.filter((e) => e.type === "turn.done").length;
const checkpoints = (events: ReadonlyArray<SessionEvent>) =>
  events.flatMap((e) => (e.type === "checkpoint.created" ? [e.payload] : []));

async function play(scenario: Scenario): Promise<Outcome> {
  const repo = makeRepo(root, scenario.committed);
  const w = await client.call("workspace.create", {
    request_id: scenario.name,
    repo: { path: repo },
    title: scenario.name,
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  const tree = w.root_path!;
  const first = Object.keys(scenario.committed)[0]!;
  await until(() => fs.existsSync(path.join(tree, first)), 30_000);
  let n = 0;
  const turn = async (text: string) => {
    const before = done(events);
    await client.call("turn.submit", {
      request_id: `${scenario.name}-${n++}`,
      session_id: w.session_id,
      kind: "followup",
      input: { text },
    });
    await until(() => done(events) > before && checkpoints(events).length > before, 30_000);
    return checkpoints(events).at(-1)!;
  };
  scenario.personBefore?.(tree);
  await turn("hello");
  const began = snapshotTree(tree);
  const after = turnStarts(tree) + 1;
  const ops = Buffer.from(JSON.stringify({ after, ops: scenario.ops })).toString("base64");
  const card = await turn(`ops: ${ops}`);
  scenario.personAfter?.(tree);
  const beforeUndo = snapshotTree(tree);
  const indexBeforeUndo = index(tree);
  const undo = await client
    .call("checkpoint.undo", {
      request_id: `${scenario.name}-undo`,
      session_id: w.session_id,
      checkpoint_id: card.checkpoint_id,
    })
    .then(
      (result) => ({ files: result.files }),
      (error: { error?: { message?: string } }) => ({
        refused: error.error?.message ?? String(error),
      }),
    );
  return {
    scenario,
    cardFiles: (card.files ?? []).map((file) => file.path),
    undo,
    began,
    beforeUndo,
    afterUndo: snapshotTree(tree),
    indexBeforeUndo,
    indexAfterUndo: index(tree),
  };
}

beforeAll(async () => {
  root = tempRoot("mc-turn-undo-");
  const wrapper = path.join(root, "ops-claude.mjs");
  fs.writeFileSync(wrapper, WRAPPER);
  // No script extension, so the SDK runs it as the CLI binary.
  const claude = path.join(root, "claude");
  fs.writeFileSync(
    claude,
    `#!/bin/sh\nexec '${process.execPath}' '${wrapper}' '${FAKE_CLAUDE}' "$@"\n`,
    { mode: 0o755 },
  );
  config = await makeConfig();
  runtime = await startRuntime(config, "fake-claude", undefined, { claudeBinary: claude });
  client = connect(runtime.url, runtime.token);
  const started = Date.now();
  for (const scenario of SCENARIOS) outcomes.set(scenario.name, await play(scenario));
  const operations = SCENARIOS.reduce((sum, scenario) => sum + scenario.ops.length, 0);
  process.stdout.write(
    `turn undo model check: ${SCENARIOS.length} sessions, ${operations} turn file operations, ${[...outcomes.values()].filter((o) => "refused" in o.undo).length} refusals, ${((Date.now() - started) / 1000).toFixed(1)} s\n`,
  );
}, 300_000);

afterAll(async () => {
  client?.close();
  await runtime?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const tell = (o: Outcome) =>
  [
    `scenario ${o.scenario.name}: the turn's card lists [${o.cardFiles.join(", ")}];`,
    `the turn did ${JSON.stringify(o.scenario.ops)}`,
    "refused" in o.undo
      ? `Undo refused: ${o.undo.refused}`
      : `Undo went ahead on [${o.undo.files.join(", ")}]`,
  ].join("\n");

const goesAhead = SCENARIOS.filter((s) => s.refuses === undefined).map((s) => s.name);
const refuses = SCENARIOS.filter((s) => s.refuses !== undefined).map((s) => s.name);

describe("turn undo", () => {
  it.each(SCENARIOS.map((s) => s.name))(
    "%s: the turn's operations land inside the turn (its card lists each path they leave or remove)",
    (name) => {
      const o = outcomes.get(name)!;
      const touched = o.scenario.ops.map((op) => (op.op === "mv" ? op.to : op.path));
      expect(
        touched.filter((file) => !o.cardFiles.includes(file)),
        `${tell(o)}\na modelling error: the wrapper's operations missed the turn`,
      ).toEqual([]);
    },
  );

  it.each(SCENARIOS.map((s) => s.name))(
    "%s: Undo either puts back exactly what the turn changed, or changes nothing",
    (name) => {
      const o = outcomes.get(name)!;
      if ("refused" in o.undo)
        expect(treeDiff(o.beforeUndo, o.afterUndo), `${tell(o)}\nyet these files moved`).toEqual(
          [],
        );
      else
        expect(
          treeDiff(o.began, o.afterUndo),
          `${tell(o)}\nthe worktree differs from where the turn began`,
        ).toEqual([]);
    },
  );

  it.each(goesAhead)("%s: with nothing changed since the turn, Undo goes ahead", (name) => {
    const o = outcomes.get(name)!;
    expect("files" in o.undo, tell(o)).toBe(true);
  });

  it.each(refuses)("%s: Undo refuses for its reason", (name) => {
    const o = outcomes.get(name)!;
    expect("refused" in o.undo ? o.undo.refused : "went ahead", tell(o)).toMatch(
      o.scenario.refuses!,
    );
  });

  it("Undo never changes the index (what the person staged)", () => {
    for (const o of outcomes.values()) expect(o.indexAfterUndo, tell(o)).toBe(o.indexBeforeUndo);
  });
});
