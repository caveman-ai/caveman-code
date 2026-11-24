// Real stack: project computers end to end, Cloud's half and the runtime's together (CONTRACT §6, SPEC §8). A REAL
// local Caveman Cloud (control-api on Postgres, named by CAVEMAN_E2E_CLOUD_URL, SQL through CAVEMAN_E2E_PSQL) places
// one person's chats of one repository on Cloud computers and makes cells when they are full; REAL runtime processes
// (projectComputers.e2e.runtime.ts: the Claude Agent adapter on the stand-in CLI, no model) are those computers. The
// test plays two parts Cloud has no hand in here: the person's client (POST workspaces, then workspace.create on the
// computer, naming the workspace Cloud placed) and the computers service (each computer Cloud makes gets a runtime
// identity by SQL, a checkout cloned from the repository as a snapshot's is, its tools container's exec channel, and
// a runtime process sized 4 vCPU x 16 GiB, the default size: 8 chats). GitHub is a bare repository git reaches by a
// rewritten URL, so no pull request can be opened unless the stack names a GitHub stand-in; what the lead hears of
// it is recorded as it is.
//
// Run by Caveman Cloud's scripts/tests/cloud-computers-e2e.sh app-e2e (suite projectComputers), which sets the
// switch and the person; the numbers go to CAVEMAN_E2E_RESULTS.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { connect, type SessionEvent, type Workspace } from "@caveman-app/session-protocol";
import { afterAll, beforeAll, expect, test } from "vitest";

import { git, tempRoot, until } from "../session-protocol/testHarness.ts";
import { userTexts } from "./builders.kit.ts";
import {
  api,
  CLOUD,
  labFunding,
  person,
  PSQL,
  retireLabComputers,
  sql,
  type Person,
} from "./moves.e2e.kit.ts";
import { TOOLS_EXEC } from "./tools.ts";

const ON = Boolean(process.env.CAVEMAN_E2E_PROJECT_COMPUTERS && CLOUD && PSQL);
const RUNTIME = fileURLToPath(new URL("./projectComputers.e2e.runtime.ts", import.meta.url));
const MODEL = "claude-sonnet-4-6";
/** The default size's room (capacity.ts: 4 vCPU x 16 GiB), which each runtime here reports and Cloud places by. */
const ROOM = 8;
const BUILDERS = 50;
const two = (n: number) => String(n).padStart(2, "0");

interface Repo {
  /** owner/name, as a client names it to Cloud. */
  readonly name: string;
  readonly url: string;
  readonly bare: string;
}
interface Computer {
  readonly id: string;
  readonly root: string;
  readonly client: ReturnType<typeof connect>;
  readonly child: ChildProcess;
  readonly control: string;
  readonly controlToken: string;
  readonly worktreesDir: string;
  readonly log: string;
}

let me: Person;
const repos: Array<Repo> = [];
let gitEnv: Record<string, string> = {};
const computers = new Map<string, Promise<Computer>>();
const children: Array<ChildProcess> = [];
const results: Record<string, unknown> = {};

afterAll(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  if (process.env.CAVEMAN_E2E_RESULTS && Object.keys(results).length > 0)
    fs.writeFileSync(process.env.CAVEMAN_E2E_RESULTS, `${JSON.stringify(results, null, 1)}\n`);
});

/** GitHub for this file: a bare repository per case, which git reaches in place of https://github.com/octocat/<name>. */
function makeRepo(root: string, name: string, files: Record<string, string>): Repo {
  const bare = path.join(root, `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  const url = `https://github.com/octocat/${name}`;
  const n = repos.length;
  gitEnv = {
    ...gitEnv,
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: `url.file://${bare}.insteadOf`,
    [`GIT_CONFIG_VALUE_${n}`]: url,
  };
  Object.assign(process.env, gitEnv);
  const seed = path.join(root, `${name}-seed`);
  execFileSync("git", ["clone", "-q", url, seed]);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
    fs.writeFileSync(path.join(seed, file), content);
  }
  git(seed, "add", ".");
  git(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const repo = { name: `octocat/${name}`, url, bare };
  repos.push(repo);
  return repo;
}

beforeAll(async () => {
  if (!ON) return;
  me = await person();
  retireLabComputers(me);
  labFunding(me);
  const root = tempRoot("project-computers-e2e-");
  const tag = randomUUID().slice(0, 8);
  // The fan-out's repository: a few hundred files, one of them the file several builders edit on purpose.
  const files: Record<string, string> = { "README.md": "widgets\n", "shared.txt": "shared list\n" };
  for (let m = 0; m < 20; m++)
    for (let f = 0; f < 15; f++)
      files[`src/module-${two(m)}/file-${two(f)}.ts`] =
        `export const value${m}_${f} = ${m * 100 + f};\n`;
  makeRepo(root, `fifty-${tag}`, files);
  makeRepo(root, `twins-${tag}`, { "README.md": "twins\n" });
  makeRepo(root, `empties-${tag}`, { "README.md": "empties\n" });
  makeRepo(root, `smaller-${tag}`, { "README.md": "smaller\n" });
  makeRepo(root, `refused-${tag}`, { "README.md": "refused\n" });
}, 120_000);

/**
 * Lab hygiene before each case: the computers earlier cases had Cloud make are marked deleted and their runtimes
 * stopped, so the person's computer limits are this case's own (the kit's retireLabComputers, between cases too).
 */
function ownLimits() {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  computers.clear();
  retireLabComputers(me);
}

const rows = (text: string) =>
  sql(text)
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("|"));
const org = () => me.user.organization_id;
const repoKey = (repo: Repo) => `github.com/${repo.name}`;
/** A project's computers as Cloud's rows have them, oldest first: what each holds, its room, what its runtime last said, and whose it is. */
const projectComputers = (repo: Repo) =>
  rows(
    `SELECT c.id, public.cave_code_computer_held(c.organization_id, c.id, NULL), public.cave_code_computer_room(c.size, c.capacity_chats), coalesce(c.capacity_chats::text, ''), c.created_by, c.desired_state, c.size
       FROM code_computers c WHERE c.organization_id = '${org()}' AND c.project_repo = '${repoKey(repo)}' AND c.driver <> 'local' ORDER BY c.created_at, c.id`,
  ).map(([id, held, room, said, by, desired, size]) => ({
    id: id!,
    held: Number(held),
    room: Number(room),
    said: said === "" ? undefined : Number(said),
    by: by!,
    desired: desired!,
    size: size!,
  }));

/** The person's client: Cloud places a chat of `repo` on one of their project computers, or makes a cell for it. */
async function place(repo: Repo, title: string) {
  const made = await api(me.access_token, "/api/v1/code/workspaces", {
    method: "POST",
    body: {
      title,
      repo: repo.name,
      base_branch: "main",
      engine: "claude-agent",
      computer: { kind: "cloud" },
    },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  expect(made.body.computer_id).toMatch(/^[0-9a-f-]{36}$/);
  return { workspace_id: made.body.id as string, computer_id: made.body.computer_id as string };
}

/**
 * The computers service's part for a computer Cloud made: its runtime identity (SQL), the pod running, a checkout of
 * its repository as its snapshot holds one, and its runtime process. Once per computer; asked again, the same one.
 */
function computer(
  id: string,
  repo: Repo,
  size: { readonly cpus: number; readonly gib: number } = { cpus: 4, gib: 16 },
): Promise<Computer> {
  let started = computers.get(id);
  if (started === undefined) {
    started = (async () => {
      const root = path.join(tempRoot("pc-computer-"), "workspace");
      execFileSync("git", ["clone", "-q", repo.url, root]);
      git(root, "config", "user.email", "t@t");
      git(root, "config", "user.name", "t");
      const { privateKey } = generateKeyPairSync("ed25519");
      const pub = createPublicKey(privateKey)
        .export({ format: "der", type: "spki" })
        .subarray(-32)
        .toString("hex");
      const runtimeId = randomUUID();
      sql(`INSERT INTO code_runtimes (id, organization_id, computer_id, name, public_key) VALUES ('${runtimeId}', '${org()}', '${id}', 'Cloud computer', '\\x${pub}');
        UPDATE code_computers SET observed_state='running', observed_generation=desired_generation, observed_at=now() WHERE id='${id}';`);
      const linkDir = tempRoot("pc-link-");
      fs.writeFileSync(
        path.join(linkDir, "runtime.json"),
        JSON.stringify({
          cloud_url: CLOUD,
          runtime_id: runtimeId,
          organization_id: org(),
          computer_id: id,
          user_id: me.user.id,
        }),
      );
      fs.writeFileSync(
        path.join(linkDir, "runtime.key"),
        privateKey.export({ format: "pem", type: "pkcs8" }),
        { mode: 0o600 },
      );
      const outFile = path.join(tempRoot("pc-runtime-"), "out.json");
      const logFile = `${outFile}.log`;
      const log = fs.openSync(logFile, "w");
      // Its tools container's exec channel, where git and the engine's commands run and through which the runtime's
      // mirror trades branches with GitHub: a computer has one, and a builder's base comes only through it. Tools has no
      // way to GitHub of its own, so it gets none of the rewrite: its origin reads as the github.com URL it is, and only
      // the runtime's own git (the mirror, which holds the token) reaches the bare repository behind it.
      const socket = path.join(tempRoot("pc-tools-"), "tools.sock");
      const toolsEnv = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_CONFIG_")),
      );
      const tools = spawn(process.execPath, [TOOLS_EXEC, "serve", socket], {
        env: toolsEnv,
        stdio: "ignore",
      });
      children.push(tools);
      await until(() => fs.existsSync(socket), 30_000);
      const controlToken = randomBytes(16).toString("hex");
      const child = spawn(process.execPath, ["--no-warnings", RUNTIME], {
        env: {
          ...process.env,
          ...gitEnv,
          CAVEMAN_CLOUD_LINK_DIR: linkDir,
          CAVEMAN_WORKSPACE_ROOT: root,
          CAVEMAN_RUNTIME_TOOLS_ADDRESS: socket,
          CAVEMAN_COMPUTER_CPUS: String(size.cpus),
          CAVEMAN_COMPUTER_MEMORY_GIB: String(size.gib),
          PC_OUT: outFile,
          PC_CONTROL_TOKEN: controlToken,
          // Settings > Agents on every computer here: a lead runs the whole fan-out at once.
          PC_AGENTS_AT_ONCE: String(BUILDERS),
        },
        stdio: ["ignore", log, log],
      });
      children.push(child);
      await until(() => fs.existsSync(outFile) || child.exitCode !== null, 180_000);
      if (!fs.existsSync(outFile))
        throw new Error(
          `the runtime of computer ${id} exited: ${fs.readFileSync(logFile, "utf8").slice(-2000)}`,
        );
      const info = JSON.parse(fs.readFileSync(outFile, "utf8")) as {
        url: string;
        token: string;
        worktreesDir: string;
        control: string;
      };
      const client = connect(info.url, info.token);
      await until(
        async () => (await client.call("cloud.status", {})).state === "connected",
        60_000,
      );
      return {
        id,
        root,
        client,
        child,
        control: info.control,
        controlToken,
        worktreesDir: info.worktreesDir,
        log: logFile,
      };
    })();
    computers.set(id, started);
  }
  return started;
}

/** What a lead's agent does with delegate_task (isolation worktree), on the lead's own runtime. */
async function delegate(on: Computer, lead: Workspace, key: string, title: string, task: string) {
  const response = await fetch(`${on.control}/start`, {
    method: "POST",
    headers: { authorization: `Bearer ${on.controlToken}`, "content-type": "application/json" },
    body: JSON.stringify({ parentThreadId: `caveman:${lead.id}`, task, title, requestKey: key }),
  });
  return (await response.json()) as {
    started?: {
      workspaceId: string;
      where: "here" | "cloud";
      computerId?: string;
      title: string;
    } | null;
    error?: string;
  };
}
const tree = async (on: Computer, lead: Workspace) =>
  (await (
    await fetch(`${on.control}/tree?lead=${encodeURIComponent(`caveman:${lead.id}`)}`, {
      headers: { authorization: `Bearer ${on.controlToken}` },
    })
  ).json()) as { running: number; tokens: number };

/** The person's client on the computer: the chat Cloud placed, started there under the workspace it names. */
async function start(
  on: Computer,
  repo: Repo,
  placed: { workspace_id: string },
  title: string,
  extra: { task?: string } = {},
) {
  const workspace = await on.client.call("workspace.create", {
    request_id: `start-${placed.workspace_id}`,
    repo: { url: repo.url },
    title,
    engine: "claude-agent",
    options: { model: MODEL },
    placed_workspace_id: placed.workspace_id,
    ...(extra.task === undefined ? {} : { task: { text: extra.task } }),
  });
  await on.client.call("queue.list", { session_id: workspace.session_id });
  return on.client.call("workspace.get", { workspace_id: workspace.id });
}
const cloudWorkspaceOf = (sessionId: string) =>
  sql(`SELECT workspace_id FROM code_sessions WHERE id = '${sessionId}'`);
const chatsOn = async (on: Computer) =>
  (await on.client.call("workspace.list", {})).workspaces.filter((w) => w.status !== "archived");

test.skipIf(!ON)(
  "fifty agents, one repository, one result: a lead and 50 builders fill 7 computers of the default size, none over its room and none another person's, every builder starts and commits, and one branch comes of it with 49 merged and the one that still conflicts left out by name",
  async () => {
    const repo = repos[0]!;
    ownLimits();
    const began = Date.now();
    // The person starts the lead: Cloud makes the project's first computer and places the chat on it.
    const placed = await place(repo, "Ship the widgets");
    const leadComputer = await computer(placed.computer_id, repo);
    const lead = await start(leadComputer, repo, placed, "Ship the widgets");
    expect(cloudWorkspaceOf(lead.session_id)).toBe(placed.workspace_id);
    const leadEvents: Array<SessionEvent> = [];
    await leadComputer.client.attach(lead.session_id, 0, (event) => leadEvents.push(event));
    // The lead's own commit, before any builder: it stays as it is under everything merged on top.
    fs.writeFileSync(path.join(leadComputer.root, "plan.md"), "the plan\n");
    git(leadComputer.root, "add", "plan.md");
    git(leadComputer.root, "commit", "-qm", "the lead's plan");
    const planned = git(leadComputer.root, "rev-parse", "HEAD").trim();

    // ---- the fan-out: every builder commits one file in an area of its own; four also add a line to shared.txt. The
    // first merges as it is, the next two bring their branch up to date when told of the conflict, the last never does.
    const shared = {
      clean: BUILDERS - 4,
      resolveA: BUILDERS - 3,
      resolveB: BUILDERS - 2,
      never: BUILDERS - 1,
    };
    const resolve = (n: number) =>
      `when /does not merge/: sh: git merge ${lead.branch} || (git show ${lead.branch}:shared.txt > shared.txt && echo "from builder ${two(n)}" >> shared.txt && git add shared.txt && git commit -qm "builder ${two(n)}: merged the lead's branch") => Builder ${two(n)} merged the lead's branch into its own and kept both lists.`;
    const taskOf = (n: number) => {
      const edits = Object.values(shared).includes(n);
      const work = `mkdir -p area-${two(n)} && echo "builder ${two(n)}" > area-${two(n)}/work.txt${edits ? ` && echo "from builder ${two(n)}" >> shared.txt` : ""} && git add -A && git commit -qm "builder ${two(n)}: its area"`;
      return [
        `sh: ${work}`,
        ...(n === shared.resolveA || n === shared.resolveB ? [resolve(n)] : []),
        `say: Builder ${two(n)} wrote area-${two(n)}/work.txt${edits ? " and added its line to shared.txt" : ""}.</note>`,
      ].join("\n");
    };
    const startAll = Date.now();
    const answers: Array<Awaited<ReturnType<typeof delegate>>> = [];
    const cells: Array<Promise<Computer>> = [];
    // As an agent's tool calls arrive: one after another. A cell Cloud makes boots beside them, as the computers service boots one.
    for (let n = 0; n < BUILDERS; n++) {
      const answer = await delegate(
        leadComputer,
        lead,
        `k${two(n)}`,
        `Builder ${two(n)}`,
        taskOf(n),
      );
      answers.push(answer);
      const on = answer.started?.computerId;
      if (answer.started?.where === "cloud" && on !== undefined && !computers.has(on))
        cells.push(computer(on, repo));
    }
    const placedAllMs = Date.now() - startAll;
    const refusedStarts = answers.flatMap((a, n) =>
      a.started ? [] : [`Builder ${two(n)}: ${a.error ?? "T3's child"}`],
    );
    expect(refusedStarts).toEqual([]);
    await Promise.all(cells);
    const all = await Promise.all(
      [...computers.entries()]
        .filter(
          ([id]) => answers.some((a) => a.started?.computerId === id) || id === leadComputer.id,
        )
        .map(([, c]) => c),
    );

    // Every builder is a chat on its computer, its worktree made and its first turn sent.
    const builderChats = async () =>
      (
        await Promise.all(
          all.map(async (c) =>
            (await chatsOn(c))
              .filter((w) => /^Builder \d\d$/.test(w.title))
              .map((w) => ({ ...w, on: c.id })),
          ),
        )
      ).flat();
    await until(async () => {
      const chats = await builderChats();
      return chats.length === BUILDERS && chats.every((w) => w.status !== "starting");
    }, 600_000);
    const startedAllMs = Date.now() - startAll;
    const chats = await builderChats();
    expect(new Set(chats.map((w) => w.title)).size).toBe(BUILDERS);
    expect(chats.filter((w) => w.status === "failed").map((w) => w.title)).toEqual([]);

    // ---- placement, as Cloud's rows have it and as each runtime has it.
    const made = projectComputers(repo);
    const perComputer = await Promise.all(
      all.map(async (c) => ({ id: c.id, chats: (await chatsOn(c)).length })),
    );
    // Seven computers of the default size, each this person's, each told by its runtime that it holds eight.
    expect(made).toHaveLength(7);
    expect(new Set(all.map((c) => c.id))).toEqual(new Set(made.map((c) => c.id)));
    for (const c of made)
      expect(c).toMatchObject({ by: me.user.id, room: ROOM, said: ROOM, desired: "running" });
    // None over its room, by Cloud's count and by the runtime's own; the lead and its fifty are all counted, once each.
    for (const c of made)
      expect(c.held, `${c.id} holds ${c.held} of ${c.room}`).toBeLessThanOrEqual(c.room);
    for (const c of perComputer)
      expect(c.chats, `${c.id} runs ${c.chats}`).toBeLessThanOrEqual(ROOM);
    expect(made.reduce((sum, c) => sum + c.held, 0)).toBe(BUILDERS + 1);
    expect(perComputer.reduce((sum, c) => sum + c.chats, 0)).toBe(BUILDERS + 1);
    expect(made.map((c) => c.held)).toEqual(
      perComputer
        .sort((a, b) => made.findIndex((c) => c.id === a.id) - made.findIndex((c) => c.id === b.id))
        .map((c) => c.chats),
    );
    // None on anyone else's: every workspace of the lead's tree, and every chat registered from these computers, sits
    // on a computer this person made for this repository.
    expect(
      sql(`SELECT count(*) FROM code_workspaces w JOIN code_computers c ON c.id = w.computer_id
      WHERE w.organization_id = '${org()}' AND (w.root_id = '${placed.workspace_id}' OR w.computer_id IN (${made.map((c) => `'${c.id}'`).join(",")}))
        AND (c.created_by <> '${me.user.id}' OR c.project_repo IS DISTINCT FROM '${repoKey(repo)}')`),
    ).toBe("0");
    const here = answers.filter((a) => a.started?.where === "here").length;
    expect(here).toBe(ROOM - 1);
    expect(
      sql(
        `SELECT count(*) FROM code_workspaces WHERE organization_id = '${org()}' AND root_id = '${placed.workspace_id}' AND parent_id IS NOT NULL`,
      ),
    ).toBe(String(BUILDERS - here));
    // No computer turned a builder away: Cloud placed none where there was no room.
    const turnedAway = Number(
      sql(
        `SELECT count(*) FROM code_workspaces WHERE organization_id = '${org()}' AND root_id = '${placed.workspace_id}' AND run_state = 'failed'`,
      ),
    );

    // ---- the integration: one branch, and what the lead hears of the pull request.
    const summary = () =>
      userTexts(leadEvents).find((text) =>
        text.startsWith("[Caveman Code] Your builders have finished."),
      );
    await until(() => summary() !== undefined, 1_200_000);
    const resultMs = Date.now() - startAll;
    const heardFailures = userTexts(leadEvents).filter((text) =>
      /^\[Builder "[^"]+" failed/.test(text),
    );
    expect(heardFailures).toEqual([]);
    const inside = Array.from({ length: BUILDERS }, (_, n) => n).filter((n) => n !== shared.never);
    // What the lead heard: 49 are in, and the one that never brought its branch up to date is left out by name.
    expect(summary()).toContain(
      `${inside.length} of ${BUILDERS} branches are merged into ${lead.branch}`,
    );
    expect(summary()).toMatch(
      new RegExp(
        `Not in: Builder ${two(shared.never)} \\(.*it still conflicts with the rest in shared\\.txt after 2 tries`,
      ),
    );
    expect(
      userTexts(leadEvents).filter((text) =>
        text.startsWith("[Caveman Code] Your builders have finished."),
      ),
    ).toHaveLength(1);
    const leadGit = (...args: Array<string>) => git(leadComputer.root, ...args).trim();
    expect(leadGit("symbolic-ref", "--short", "HEAD")).toBe(lead.branch);
    expect(leadGit("status", "--porcelain")).toBe("");
    execFileSync("git", ["merge-base", "--is-ancestor", planned, "HEAD"], {
      cwd: leadComputer.root,
    });
    for (const n of inside)
      expect(
        fs.readFileSync(path.join(leadComputer.root, `area-${two(n)}`, "work.txt"), "utf8"),
      ).toBe(`builder ${two(n)}\n`);
    expect(fs.existsSync(path.join(leadComputer.root, `area-${two(shared.never)}`))).toBe(false);
    const subjects = leadGit("log", "--format=%s", `${planned}..HEAD`).split("\n");
    for (const n of inside)
      expect(
        subjects.filter((s) => s === `builder ${two(n)}: its area`),
        `builder ${two(n)}'s commit`,
      ).toHaveLength(1);
    const merges = subjects.filter((s) => s.startsWith("Merge Builder "));
    expect(merges).toHaveLength(inside.length);
    expect(new Set(merges).size).toBe(merges.length);
    expect(
      fs.readFileSync(path.join(leadComputer.root, "shared.txt"), "utf8").trim().split("\n").sort(),
    ).toEqual(
      [
        "shared list",
        ...[shared.clean, shared.resolveA, shared.resolveB].map((n) => `from builder ${two(n)}`),
      ].sort(),
    );
    // The left-out builder's work is not lost: its branch is on GitHub, as every builder's on another computer is.
    const pushed = execFileSync(
      "git",
      [
        "--git-dir",
        repo.bare,
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/caveman/builder-*",
      ],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(pushed).toHaveLength(BUILDERS - here);
    expect(
      pushed.some((ref) => ref.startsWith(`refs/heads/caveman/builder-${two(shared.never)}-`)),
    ).toBe(true);
    // A builder on another computer said what its turns used, and the lead's tree counts it (never shown in a chat).
    const counted = await tree(leadComputer, lead);
    expect(counted.running).toBe(0);
    expect(counted.tokens).toBeGreaterThan(0);
    expect(userTexts(leadEvents).join("\n")).not.toMatch(/tokens/i);

    const pullRequest =
      /One pull request carries it all, with a note from each builder: (\S+)/.exec(summary()!)?.[1];
    const noPullRequest = /No pull request was opened: (.*)$/s.exec(summary()!)?.[1];
    results.fifty = {
      computers: made.length,
      room: ROOM,
      placed: made.map((c) => c.held),
      builders: BUILDERS,
      startedHere: here,
      startedThroughCloud: BUILDERS - here,
      refusedStarts: refusedStarts.length,
      failedBuilders: heardFailures.length + chats.filter((w) => w.status === "failed").length,
      turnedAwayAndPlacedAgain: turnedAway,
      msUntilAllPlaced: placedAllMs,
      msUntilAllStarted: startedAllMs,
      msUntilOneBranch: resultMs,
      msTotal: Date.now() - began,
      merged: inside.length,
      leftOut: [`Builder ${two(shared.never)}`],
      tokensCountedFromOtherComputers: counted.tokens,
      pullRequest: pullRequest ?? null,
      noPullRequest: noPullRequest ?? null,
    };
    // One pull request where the stack has a GitHub to open it on; where it has none, the lead is told so in words.
    expect(pullRequest !== undefined || noPullRequest !== undefined).toBe(true);
  },
  2_400_000,
);

test.skipIf(!ON)(
  "two chats started at the same instant on one computer each take the workspace Cloud placed for them, and one started out of order takes its own, not the oldest",
  async () => {
    const repo = repos[1]!;
    ownLimits();
    const [one, other, last] = [
      await place(repo, "First"),
      await place(repo, "Second"),
      await place(repo, "Third"),
    ];
    // One computer for all three: each found room on the first's.
    expect([other.computer_id, last.computer_id]).toEqual([one.computer_id, one.computer_id]);
    expect(projectComputers(repo).map((c) => c.held)).toEqual([3]);
    const on = await computer(one.computer_id, repo);
    // The one placed last starts first, alone: it takes its own workspace, never the oldest one waiting (which a runtime
    // from before placed_workspace_id would be given).
    const third = await start(on, repo, last, "Third", { task: "say: third here" });
    expect(cloudWorkspaceOf(third.session_id)).toBe(last.workspace_id);
    // The other two start at the same instant, the one placed later first; each names its own.
    const [second, first] = await Promise.all([
      start(on, repo, other, "Second", { task: "say: second here" }),
      start(on, repo, one, "First", { task: "say: first here" }),
    ]);
    expect([cloudWorkspaceOf(first.session_id), cloudWorkspaceOf(second.session_id)]).toEqual([
      one.workspace_id,
      other.workspace_id,
    ]);
    // Each workspace is its own chat's (the registration wrote the chat's branch on it), and there are still three.
    expect(
      rows(
        `SELECT id, branch FROM code_workspaces WHERE organization_id = '${org()}' AND computer_id = '${on.id}' AND status = 'active' ORDER BY created_at, id`,
      ),
    ).toEqual([
      [one.workspace_id, first.branch],
      [other.workspace_id, second.branch],
      [last.workspace_id, third.branch],
    ]);
    expect(projectComputers(repo).map((c) => [c.held, c.room])).toEqual([[3, ROOM]]);
    // One more the person starts with no placement of its own (a further run of one start) takes a free place, as one more.
    const further = await on.client.call("workspace.create", {
      request_id: "further",
      repo: { url: repo.url },
      title: "Further",
      engine: "claude-agent",
      options: { model: MODEL },
      placed_workspace_id: "",
    });
    await until(() => cloudWorkspaceOf(further.session_id) !== "", 30_000);
    expect([one.workspace_id, other.workspace_id, last.workspace_id]).not.toContain(
      cloudWorkspaceOf(further.session_id),
    );
    expect(projectComputers(repo).map((c) => c.held)).toEqual([4]);
    results.twins = {
      computer: on.id,
      placed: [one.workspace_id, other.workspace_id, last.workspace_id],
      took: [
        cloudWorkspaceOf(first.session_id),
        cloudWorkspaceOf(second.session_id),
        cloudWorkspaceOf(third.session_id),
      ],
    };
  },
  600_000,
);

test.skipIf(!ON)(
  "a computer whose last chat is archived is told so at once, stands empty, and is deleted by the ten-minute rule with the chat's copy whole in Cloud",
  async () => {
    const repo = repos[2]!;
    ownLimits();
    const placed = await place(repo, "Short lived");
    const on = await computer(placed.computer_id, repo);
    const chat = await start(on, repo, placed, "Short lived", { task: "say: done here" });
    // Its copy in Cloud is whole: every event of the chat, up to its head.
    const head = async () => {
      const events: Array<SessionEvent> = [];
      const sub = await on.client.attach(chat.session_id, 0, (event) => events.push(event));
      await sub.detach();
      return sub.session.head;
    };
    await until(
      async () =>
        (await on.client.call("workspace.get", { workspace_id: chat.id })).status === "idle" &&
        (await head()) > 0,
      60_000,
    );
    const copied = () =>
      Number(
        sql(`SELECT cursor_seq FROM code_journal_index WHERE session_id = '${chat.session_id}'`) ||
          0,
      );
    let whole = 0;
    await until(async () => (whole = await head()) > 0 && copied() >= whole, 120_000);
    expect(projectComputers(repo).map((c) => [c.held, c.desired])).toEqual([[1, "running"]]);

    // Archived: Cloud hears at once (a summary of its own, not the next period's), and the computer holds no chat.
    const archivedAt = Date.now();
    await on.client.call("workspace.archive", { request_id: "archive", workspace_id: chat.id });
    await until(
      () =>
        sql(`SELECT archived FROM code_chat_summaries WHERE session_id = '${chat.session_id}'`) ===
        "t",
      15_000,
    );
    const heardMs = Date.now() - archivedAt;
    expect(projectComputers(repo).map((c) => c.held)).toEqual([0]);
    // Cloud's sweep (every 30 s) notes it empty. It is not deleted because its chat left: it stands, warm for the next.
    await until(
      () => sql(`SELECT empty_since IS NOT NULL FROM code_computers WHERE id = '${on.id}'`) === "t",
      90_000,
    );
    expect(sql(`SELECT desired_state FROM code_computers WHERE id = '${on.id}'`)).toBe("running");
    // Nine minutes on it still stands; past ten it goes. The clock is the row's (empty_since), moved here by SQL.
    sql(
      `UPDATE code_computers SET empty_since = now() - interval '9 minutes' WHERE id = '${on.id}'`,
    );
    await new Promise((resolve) => setTimeout(resolve, 45_000));
    expect(sql(`SELECT desired_state FROM code_computers WHERE id = '${on.id}'`)).toBe("running");
    sql(
      `UPDATE code_computers SET empty_since = now() - interval '10 minutes 1 second' WHERE id = '${on.id}'`,
    );
    const movedAt = Date.now();
    await until(
      () => sql(`SELECT desired_state FROM code_computers WHERE id = '${on.id}'`) === "deleted",
      90_000,
    );
    const retiredMs = Date.now() - movedAt;
    // Cloud deleted it as it deletes one for a person: its workspace archived, and the chat's copy as whole as it was.
    expect(sql(`SELECT status FROM code_workspaces WHERE id = '${placed.workspace_id}'`)).toBe(
      "archived",
    );
    expect(copied()).toBe(whole);
    expect(
      sql(
        `SELECT metadata->>'reason' FROM audit_logs WHERE organization_id = '${org()}' AND action = 'code.computer.delete' AND resource_id = '${on.id}' ORDER BY created_at DESC LIMIT 1`,
      ),
    ).toBe("empty");
    // The person still has the chat, archived, in their list.
    const listed = await api(me.access_token, "/api/v1/code/chats?archived=true");
    expect(listed.status).toBe(200);
    expect(
      (listed.body.chats as Array<{ session_id: string }>).some(
        (c) => c.session_id === chat.session_id,
      ),
    ).toBe(true);
    // What Cloud answers today when the person asks for it back on a Cloud computer: recorded, not required (the todo below).
    const back = await api(me.access_token, `/api/v1/code/chats/${chat.session_id}/move`, {
      method: "POST",
      body: { to: "cloud" },
    });
    results.empties = {
      computer: on.id,
      msUntilCloudHeardTheArchive: heardMs,
      msUntilDeletedOnceTenMinutesPassed: retiredMs,
      copyWholeAt: whole,
      askedBackOnCloud: { status: back.status, code: back.body?.error?.code ?? null },
    };
  },
  900_000,
);

// Not built in either half: only the runtime that holds a chat can restore it (workspace.restore), and that runtime
// went with the computer; Cloud has no route that un-archives a chat, and refuses to move an archived one.
test.todo(
  "a chat un-archived after its computer was retired comes back on a computer from its copy",
);

// 2 vCPU x 4 GiB holds one chat (capacity.ts). Cloud takes a computer it has not heard from yet to hold what its size
// holds bare (8), so a computer that boots smaller than that has been given more chats than it can take.
const SMALL = { cpus: 2, gib: 4 };

test.skipIf(!ON)(
  "a computer that holds fewer chats than Cloud believed turns the extra one away and tells Cloud its room: its lead's runtime has Cloud place the builder again on a new cell and the lead hears no failure; a person's chat is refused with nothing made, and asked of Cloud again it lands on another computer",
  async () => {
    const repo = repos[3]!;
    ownLimits();
    const placed = await place(repo, "Lead");
    // The lead's computer holds one chat, and says so: its builders go through Cloud.
    const leadComputer = await computer(placed.computer_id, repo, SMALL);
    const lead = await start(leadComputer, repo, placed, "Lead");
    await until(() => projectComputers(repo)[0]?.said === 1, 60_000);
    const events: Array<SessionEvent> = [];
    await leadComputer.client.attach(lead.session_id, 0, (event) => events.push(event));
    // Two builders: Cloud makes one cell and, not having heard from it, places both there.
    const [a, b] = [
      await delegate(leadComputer, lead, "k1", "Part one", "say: part one done"),
      await delegate(leadComputer, lead, "k2", "Part two", "say: part two done"),
    ];
    expect([a.error, b.error]).toEqual([undefined, undefined]);
    expect(a.started).toMatchObject({ where: "cloud" });
    expect(b.started?.computerId).toBe(a.started?.computerId);
    // The cell boots holding one. It takes one builder and turns the other away, having told Cloud its room.
    const cell = await computer(a.started!.computerId!, repo, SMALL);
    const spawned = () =>
      rows(
        `SELECT id, computer_id, run_state FROM code_workspaces WHERE organization_id = '${org()}' AND root_id = '${placed.workspace_id}' AND parent_id IS NOT NULL ORDER BY created_at, id`,
      );
    // The lead's runtime asks Cloud again: a third workspace for the same builder, on a new cell (both others are full).
    await until(() => spawned().length === 3, 120_000);
    const again = spawned()[2]!;
    expect(again[1]).not.toBe(cell.id);
    expect(again[1]).not.toBe(leadComputer.id);
    expect(
      projectComputers(repo)
        .map((c) => [c.said, c.room])
        .slice(0, 2),
    ).toEqual([
      [1, 1],
      [1, 1],
    ]);
    // Cloud's rows for the one turned away: its run failed and its chat archived, so it holds no place on the cell.
    const turnedAway = spawned().filter((w) => w[2] === "failed");
    expect(turnedAway).toHaveLength(1);
    expect(turnedAway[0]![1]).toBe(cell.id);
    await until(
      () =>
        sql(
          `SELECT cs.archived FROM code_chat_summaries cs JOIN code_sessions s ON s.id = cs.session_id WHERE s.workspace_id = '${turnedAway[0]![0]}'`,
        ) === "t",
      30_000,
    );
    expect(projectComputers(repo).find((c) => c.id === cell.id)).toMatchObject({
      held: 1,
      room: 1,
    });
    expect((await chatsOn(cell)).map((w) => w.title)).toHaveLength(1);
    // The new cell runs it. The lead hears two builders finish and none fail.
    await computer(again[1]!, repo);
    await until(
      () =>
        ["Part one", "Part two"].every((title) =>
          userTexts(events).some((text) => text.includes(`Builder "${title}" finished its turn`)),
        ),
      180_000,
    );
    expect(userTexts(events).filter((text) => /^\[Builder "[^"]+" failed/.test(text))).toEqual([]);
    expect(userTexts(events).join("\n")).not.toMatch(/could not start|is full/);
    expect((await tree(leadComputer, lead)).running).toBe(0);

    // ---- a person's own chat, on a computer Cloud believed held both of two.
    const other = repos[4]!;
    const [one, two] = [await place(other, "One"), await place(other, "Two")];
    expect(two.computer_id).toBe(one.computer_id);
    const small = await computer(one.computer_id, other, SMALL);
    await start(small, other, one, "One", { task: "say: one here" });
    // The second is refused in the computer's own words, before anything is made, once Cloud has heard its room.
    const refused = await start(small, other, two, "Two").then(
      () => "started",
      (error: { error?: { message?: string } }) => error.error?.message ?? String(error),
    );
    expect(refused).toBe("Cloud is busy. Trying again.");
    expect(
      (await small.client.call("workspace.list", { include_archived: true })).workspaces.map(
        (w) => w.title,
      ),
    ).toEqual(["One"]);
    expect(projectComputers(other).map((c) => [c.said, c.room])).toEqual([[1, 1]]);
    // Asked of Cloud again (the person starts it again): Cloud knows that computer's room now and makes another.
    const retry = await place(other, "Two");
    expect(retry.computer_id).not.toBe(one.computer_id);
    const roomy = await computer(retry.computer_id, other);
    const started = await start(roomy, other, retry, "Two", { task: "say: two here" });
    expect(cloudWorkspaceOf(started.session_id)).toBe(retry.workspace_id);
    results.smaller = {
      builderPlacedAgainOn: again[1],
      builderTurnedAwayOn: cell.id,
      personsChatRefusedOn: one.computer_id,
      personsChatStartedOn: retry.computer_id,
    };
  },
  900_000,
);
