// "Many agents, one result" end to end (PLAN §7, SPEC §8), for the integration test and for
// scripts/many-builders.ts: a lead on a Cloud computer fans out builders on one repository; each makes a real commit
// in its own area and a few edit one shared file on purpose; the integration step leaves one branch and one pull
// request. Real runtimes with the stand-in Claude CLI, real git, the tools container's exec channel, and the stand-in
// Cloud: its scheduler places builders on the project's other computers ("cells") by their reported capacity, and its
// git proxy takes caveman/ branches only. It checks as it goes (node:assert) and answers the timings.
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import { MAX_BUILDERS_PER_LEAD } from "../session-protocol/builders.ts";
import { createReady, makeRepo, MODEL, tempRoot, until } from "../session-protocol/testHarness.ts";
import { builderKit, gitIn, userTexts } from "./builders.kit.ts";
import { startTestCloud } from "./testCloud.ts";

export interface ManyBuildersOptions {
  readonly builders: number;
  /** Computers of the project: the lead's, and the cells the stand-in Cloud places the rest on. */
  readonly cells: number;
  /** vCPUs and GiB of each computer: what its capacity comes from (capacity.ts). */
  readonly size: { readonly cpus: number; readonly gib: number };
  readonly log?: (line: string) => void;
}

export interface ManyBuildersResult {
  /** From the first delegate_task to the last builder's worktree made and its first turn sent. */
  readonly startAllMs: number;
  /** From every builder having finished to the one branch and the pull request (conflict rounds included). */
  readonly integrateMs: number;
  readonly totalMs: number;
  readonly merged: number;
  readonly leftOut: number;
  /** Builders per computer, the lead's first. */
  readonly placed: ReadonlyArray<number>;
  readonly pullRequest: { readonly number: number; readonly head: string; readonly body: string };
}

const two = (n: number) => String(n).padStart(2, "0");

/**
 * The four that edit shared.txt, by their place in the fan-out: the first merges as it is, the next two bring their
 * branch up to date when told of the conflict, the last never does and is left out.
 */
const sharedEditors = (builders: number) =>
  builders >= 8
    ? { clean: builders - 4, resolveA: builders - 3, resolveB: builders - 2, never: builders - 1 }
    : undefined;

export async function manyBuilders(
  options: ManyBuildersOptions,
  cleanups: Array<() => unknown>,
): Promise<ManyBuildersResult> {
  const log = options.log ?? (() => undefined);
  const { startTools, githubWith, checkoutOf, computerRuntime, delegate } = builderKit(cleanups);
  const began = Date.now();
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  await startTools();
  process.env.CAVEMAN_COMPUTER_CPUS = String(options.size.cpus);
  process.env.CAVEMAN_COMPUTER_MEMORY_GIB = String(options.size.gib);
  cleanups.push(
    () => (
      delete process.env.CAVEMAN_COMPUTER_CPUS,
      delete process.env.CAVEMAN_COMPUTER_MEMORY_GIB
    ),
  );

  // A small repository: a few hundred files, one of them the file several builders will edit.
  const files: Record<string, string> = { "README.md": "widgets\n", "shared.txt": "shared list\n" };
  for (let m = 0; m < 20; m++)
    for (let f = 0; f < 15; f++)
      files[`src/module-${two(m)}/file-${two(f)}.ts`] =
        `export const value${m}_${f} = ${m * 100 + f};\n`;
  const source = makeRepo(tempRoot("many-source-"), files);
  const backend = githubWith(source);
  cloud.state.gitBackend = backend;
  const bare = gitIn(path.join(backend, "acme", "widgets.git"));

  // Settings > Agents on every computer: the lead runs the whole fan-out at once (the default is eight).
  const settings = ServerSettings.layerTest({
    subagents: { maxConcurrent: Math.min(options.builders, MAX_BUILDERS_PER_LEAD) },
  }).pipe(Layer.orDie);
  const computers: Array<Awaited<ReturnType<typeof computerRuntime>>> = [];
  for (let c = 0; c < options.cells; c++)
    computers.push(
      await computerRuntime(
        cloud,
        checkoutOf(backend, `many-cell-${c}-`),
        `cell-${c}`,
        undefined,
        settings,
      ),
    );
  const [leadComputer, ...cells] = computers as [(typeof computers)[number], ...typeof computers];
  cloud.state.tree.cells = cells.map((c) => c.identity.computerId);
  // The scheduler places by what each cell's heartbeat says it holds.
  await until(
    () =>
      computers.every((c) => cloud.state.tree.capacityOf?.(c.identity.computerId) !== undefined),
    60_000,
  );
  const capacity = cloud.state.tree.capacityOf!(leadComputer.identity.computerId)!.chats;
  log(`${options.cells} computer${options.cells === 1 ? "" : "s"}, each holding ${capacity} chats`);

  const { client } = leadComputer;
  const lead = await createReady(client, {
    request_id: "lead",
    repo: { url: "https://github.com/acme/widgets" },
    title: "Ship the widgets",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const leadEvents: Array<SessionEvent> = [];
  await client.attach(lead.session_id, 0, (event) => leadEvents.push(event));
  // The lead's own commit, before any builder: it stays as it is under everything merged on top.
  const leadGit = gitIn(leadComputer.checkout);
  fs.writeFileSync(path.join(leadComputer.checkout, "plan.md"), "the plan\n");
  leadGit("add", "plan.md");
  leadGit("commit", "-qm", "the lead's plan");
  const planned = leadGit("rev-parse", "HEAD");

  // ---- the fan-out: every builder commits one file in an area of its own; four also add a line to shared.txt.
  const shared = sharedEditors(options.builders);
  const resolve = (n: number) =>
    `when /does not merge/: sh: git merge ${lead.branch} || (git show ${lead.branch}:shared.txt > shared.txt && echo "from builder ${two(n)}" >> shared.txt && git add shared.txt && git commit -qm "builder ${two(n)}: merged the lead's branch") => Builder ${two(n)} merged the lead's branch into its own and kept both lists.`;
  const taskOf = (n: number) => {
    const edits = shared !== undefined && Object.values(shared).includes(n);
    const work = `mkdir -p area-${two(n)} && echo "builder ${two(n)}" > area-${two(n)}/work.txt${edits ? ` && echo "from builder ${two(n)}" >> shared.txt` : ""} && git add -A && git commit -qm "builder ${two(n)}: its area"`;
    return [
      `sh: ${work}`,
      ...(shared !== undefined && (n === shared.resolveA || n === shared.resolveB)
        ? [resolve(n)]
        : []),
      `say: Builder ${two(n)} wrote area-${two(n)}/work.txt${edits ? " and added its line to shared.txt" : ""}.</note>`,
    ].join("\n");
  };
  const startAll = Date.now();
  const started: Array<Awaited<ReturnType<typeof delegate>>> = [];
  // As an agent's tool calls arrive: one after another (the lead's starts run one at a time anyway).
  for (let n = 0; n < options.builders; n++)
    started.push(
      await delegate(leadComputer.builders, lead, `k${two(n)}`, `Builder ${two(n)}`, {
        task: taskOf(n),
      }),
    );
  const startAllMs = Date.now() - startAll;
  log(`all ${options.builders} started in ${startAllMs} ms`);
  assert.equal(
    started.filter((s) => s !== undefined).length,
    options.builders,
    "every builder started",
  );
  const here = started.filter((s) => s?.where === "here").length;
  const placed = [
    here,
    ...cells.map((c) => started.filter((s) => s?.computerId === c.identity.computerId).length),
  ];
  assert.equal(
    placed.reduce((a, b) => a + b, 0),
    options.builders,
    `every builder is on one of the project's computers: ${placed.join(" + ")}`,
  );
  for (const count of placed)
    assert.ok(
      count <= capacity,
      `no computer holds more than its capacity (${placed.join(", ")} of ${capacity})`,
    );
  if (options.cells > 1)
    assert.ok(
      placed.slice(1).every((count) => count > 0),
      `the scheduler used every cell: ${placed.join(" + ")}`,
    );
  assert.deepEqual(
    cloud.state.tree.refused,
    [],
    "nothing the runtimes sent was a body Cloud refuses",
  );

  // ---- every builder has finished its first turn: from here on it is the integration step's work.
  const atWork = async () =>
    (await Effect.runPromise(leadComputer.builders.tree(`caveman:${lead.id}`))).running;
  const summary = () =>
    userTexts(leadEvents).find((text) =>
      text.startsWith("[Caveman Code] Your builders have finished."),
    );
  // A conflict sends a builder back to work, so "none at work" is seen once before the rounds and again after them.
  await until(async () => (await atWork()) === 0 || summary() !== undefined, 600_000);
  const allDone = Date.now();
  log(`every builder finished its first turn after ${allDone - startAll} ms`);

  // Every worktree, as git lists them on each computer: one per builder, on its builder's branch.
  /** Where each branch is checked out on a computer (git worktree list). */
  const checkedOut = (checkout: string) =>
    new Map(
      gitIn(checkout)("worktree", "list", "--porcelain")
        .split("\n\n")
        .flatMap((entry) => {
          const at = /^worktree (.+)$/m.exec(entry)?.[1];
          const branch = /^branch refs\/heads\/(.+)$/m.exec(entry)?.[1];
          return at !== undefined && branch !== undefined ? [[branch, at] as const] : [];
        }),
    );
  const buildersOn = async (computer: (typeof computers)[number]) =>
    (await computer.client.call("workspace.list", {})).workspaces.filter(
      (w) => w.id !== lead.id && w.status !== "archived",
    );
  let worktrees = 0;
  for (const computer of computers) {
    const at = checkedOut(computer.checkout);
    const children = await buildersOn(computer);
    for (const child of children) {
      assert.match(child.branch, /^caveman\/builder-\d\d-[0-9a-f]{6}$/);
      assert.ok(
        at.has(child.branch),
        `${child.title} has a worktree on its branch ${child.branch}`,
      );
      worktrees += 1;
    }
    // The computer's checkout and a worktree for each chat beside the one that holds it: no more, none twice.
    assert.equal(at.size, Math.max(1, children.length + (computer === leadComputer ? 1 : 0)));
  }
  assert.equal(worktrees, options.builders, "a worktree for every builder");

  await until(() => summary() !== undefined, 600_000);
  const integrateMs = Date.now() - allDone;
  log(`one branch and one pull request ${integrateMs} ms after the builders finished`);
  for (const computer of computers) {
    const at = checkedOut(computer.checkout);
    for (const child of await buildersOn(computer))
      assert.equal(
        gitIn(at.get(child.branch)!)("status", "--porcelain"),
        "",
        `${child.title}'s worktree is clean`,
      );
  }

  // ---- one branch: every builder's work that merged, exactly once, on top of the lead's own commit.
  const leftOut = shared === undefined ? [] : [shared.never];
  const inside = Array.from({ length: options.builders }, (_, n) => n).filter(
    (n) => !leftOut.includes(n),
  );
  assert.equal(leadGit("symbolic-ref", "--short", "HEAD"), lead.branch);
  assert.equal(leadGit("status", "--porcelain"), "", "the lead's worktree is clean");
  // The lead's own commit is still in its history, as it was (git fails this when it is not an ancestor).
  execFileSync("git", ["merge-base", "--is-ancestor", planned, "HEAD"], {
    cwd: leadComputer.checkout,
  });
  for (const n of inside)
    assert.equal(
      fs.readFileSync(path.join(leadComputer.checkout, `area-${two(n)}`, "work.txt"), "utf8"),
      `builder ${two(n)}\n`,
    );
  for (const n of leftOut)
    assert.equal(
      fs.existsSync(path.join(leadComputer.checkout, `area-${two(n)}`)),
      false,
      `builder ${two(n)}'s work is left out`,
    );
  // Each builder's own commit is in the lead's history once: one commit per builder with its subject.
  const subjects = leadGit("log", "--format=%s", `${planned}..HEAD`).split("\n");
  for (const n of inside)
    assert.equal(
      subjects.filter((s) => s === `builder ${two(n)}: its area`).length,
      1,
      `builder ${two(n)}'s commit is in once`,
    );
  // One merge commit of the app's per builder branch: none merged twice.
  const merges = subjects.filter((s) => s.startsWith("Merge Builder "));
  assert.equal(merges.length, inside.length, "one merge per builder whose work is in");
  assert.equal(new Set(merges).size, merges.length);
  if (shared !== undefined) {
    const lines = fs
      .readFileSync(path.join(leadComputer.checkout, "shared.txt"), "utf8")
      .trim()
      .split("\n");
    assert.deepEqual(
      [...lines].sort(),
      [
        "shared list",
        ...[shared.clean, shared.resolveA, shared.resolveB].map((n) => `from builder ${two(n)}`),
      ].sort(),
      "shared.txt holds each merged builder's line once",
    );
  }

  // ---- one pull request, from the lead's branch as it stands, with a note from each builder.
  assert.equal(cloud.state.automations.pullRequests.length, 1, "one pull request");
  const pr = cloud.state.automations.pullRequests[0]!;
  assert.equal(pr.head, lead.branch);
  assert.equal(pr.sha, leadGit("rev-parse", "HEAD"));
  assert.equal(
    bare("rev-parse", `refs/heads/${lead.branch}`),
    pr.sha,
    "the lead's branch on GitHub is what the pull request names",
  );
  for (const n of inside)
    assert.match(
      pr.body,
      new RegExp(
        `- \\*\\*Builder ${two(n)}\\*\\* \\(\`caveman/builder-${two(n)}-[0-9a-f]{6}\`\\): Builder ${two(n)} `,
      ),
      `a note from builder ${two(n)}`,
    );
  if (shared !== undefined) {
    assert.match(pr.body, /## Left out/);
    assert.match(
      pr.body,
      new RegExp(
        `- \\*\\*Builder ${two(shared.never)}\\*\\* .*it still conflicts with the rest in shared.txt after 2 tries`,
      ),
    );
    // The two that were sent back say so in their own words.
    for (const n of [shared.resolveA, shared.resolveB])
      assert.match(
        pr.body,
        new RegExp(
          `Builder ${two(n)} merged the lead's branch into its own and kept both lists\\.`,
        ),
      );
  }
  assert.match(
    summary()!,
    new RegExp(
      `${inside.length} of ${options.builders} branches are merged into ${lead.branch.replace(/[/-]/g, "\\$&")}`,
    ),
  );
  // The lead heard once that it came together, however many passes it took.
  assert.equal(
    userTexts(leadEvents).filter((text) =>
      text.startsWith("[Caveman Code] Your builders have finished."),
    ).length,
    1,
  );

  // ---- nothing left the caveman/ namespace and nothing was forced: the proxy refused no push.
  assert.deepEqual(cloud.state.gitRefused, []);
  if (options.cells > 1) {
    // Builders on the other cells pushed their branches through the proxy, and the lead's computer fetched them.
    const remote = started.filter((s) => s?.where === "cloud").length;
    assert.equal(
      bare("for-each-ref", "--format=%(refname)", "refs/heads/caveman/builder-*")
        .split("\n")
        .filter(Boolean).length,
      remote,
      "each builder on another cell pushed its branch",
    );
    assert.equal(
      leadGit("for-each-ref", "--format=%(refname)", "refs/caveman/builders")
        .split("\n")
        .filter(Boolean).length,
      remote,
      "the lead's computer fetched each of them",
    );
  }
  return {
    startAllMs,
    integrateMs,
    totalMs: Date.now() - began,
    merged: inside.length,
    leftOut: leftOut.length,
    placed,
    pullRequest: { number: pr.number, head: pr.head, body: pr.body },
  };
}
