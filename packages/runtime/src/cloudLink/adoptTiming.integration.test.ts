// K10: how long a Cloud computer takes to adopt a chat moved onto it, step by step. A Claude Agent chat on This Mac
// (in this process) runs TURNS turns, each changing a file, so its copy in the test Cloud holds a segment per turn,
// each with its own work-in-progress bundle. The person moves it to a Cloud computer: a runtime process of its own
// (chaos.runtime.ts) with git and the CLI in a tools container (a tools exec server over a socket), Cloud's git
// proxy over `git http-backend`. The computer's log line for the adopt says each step's milliseconds; they are
// printed, and written to CAVEMAN_ADOPT_RESULTS when set. The work in progress always goes in as one pack; the
// budgets (the adopt, and the move from the person's ask to the chat continuing there) are judged up to a load of
// MAX_LOAD per core, past which the timings measure the machine.
import { spawn, type ChildProcess } from "node:child_process";
import { createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import { afterEach, expect, test } from "vitest";

import { createReady, git, makeConfig, MODEL, startRuntime, tempRoot, until } from "../session-protocol/testHarness.ts";
import { startTestCloud } from "./testCloud.ts";
import { RUNTIME_GIT_EMAIL, TOOLS_EXEC } from "./tools.ts";

const CHAOS_RUNTIME = fileURLToPath(new URL("./chaos/chaos.runtime.ts", import.meta.url));
const TURNS = 12;
/** The adopt itself (K10 asks for a few seconds on a loaded node; it took 5.4 s here before, 21 s on kind). */
const ADOPT_BUDGET_MS = 2_500;
/** From the move to the adopted chat on the computer: both phases of the move, the last copy and the adopt (S12: 5 s). */
const MOVE_BUDGET_MS = 5_000;
const MAX_LOAD = 3.5;
/**
 * A chat like the one measured on the real stack (docs/ §7.13): 8 segments, a
 * small repository, a new computer whose checkout is still empty, and Cloud a round trip away. FAR_MS is that round
 * trip (CAVEMAN_ADOPT_FAR_MS, 25): each request to the stand-in Cloud, the git proxy's too, waits that long.
 */
const FAR_TURNS = 4;
const FAR_MS = Number(process.env.CAVEMAN_ADOPT_FAR_MS ?? 25);
/**
 * That adopt, clone included. On an idle machine it is well under a second; the budget leaves the room ADOPT_BUDGET_MS
 * does, for a loaded one. What keeps the clone beside the copy's download is the test after this one, not the clock.
 */
const FAR_ADOPT_BUDGET_MS = 2_500;
/** From a claimed computer's link coming up to the start of the adopt of a move that waited for it (K13: 3 s before). */
const LINK_TO_ADOPT_MS = 1_000;
const loadPerCore = () => os.loadavg()[0]! / os.cpus().length;
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** When the first log line holding `text` was written, in milliseconds of its day (the runtime's `[HH:MM:SS.mmm]`). */
const loggedAt = (log: string, text: string) => {
  const m = log.split("\n").find((l) => l.includes(text))?.match(/^\[(\d\d):(\d\d):(\d\d)\.(\d{3})\]/);
  return m ? ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]) : undefined;
};

/** The computer's adopt as its log line says it: the total and each step, in milliseconds. */
export const adoptTimings = (log: string, sessionId: string) => {
  const line = log.split("\n").find((l) => l.includes(`moves: adopted ${sessionId} `));
  const m = line && /from (\d+) segments in (\d+) ms \((.*)\)/.exec(line);
  if (!m) return undefined;
  const steps = Object.fromEntries(m[3]!.split(", ").map((part) => [part.slice(0, part.lastIndexOf(" ")), Number(part.slice(part.lastIndexOf(" ") + 1))]));
  return { segments: Number(m[1]), total: Number(m[2]), steps };
};

/**
 * The test Cloud with GitHub behind its git proxy, a Cloud computer (its checkout the snapshot of main, or still empty),
 * and This Mac's chat after `turns` turns that each wrote a file, every one copied. `setup`: the repository has a setup.
 */
async function world(options: { readonly turns: number; readonly emptyCheckout?: boolean; readonly warm?: boolean; readonly setup?: boolean; readonly noIdentity?: boolean }) {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  cloud.state.environments.computers = true;
  cloud.state.chats.engineLogins.set("user-1", { "claude-agent": { vault_key: true, signed_in_on: [] } });
  // GitHub behind Cloud's git proxy: acme/widgets with main.
  const remotes = tempRoot("adopt-github-");
  const bare = path.join(remotes, "acme/widgets.git");
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  git(remotes, "init", "--bare", "-q", "-b", "main", bare);
  const seed = tempRoot("adopt-seed-");
  git(seed, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(seed, "README.md"), "widgets\n");
  // A setup that counts its runs in the checkout, in a file git ignores (so no copy carries it).
  if (options.setup) {
    fs.mkdirSync(path.join(seed, ".caveman"));
    fs.writeFileSync(path.join(seed, ".caveman/computer.toml"), '[setup]\nrun = ["echo ran >> setup-ran.txt"]\n');
    fs.writeFileSync(path.join(seed, ".gitignore"), "setup-ran.txt\n");
  }
  git(seed, "add", ".");
  git(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  git(seed, "push", "-q", bare, "main");
  cloud.state.gitBackend = remotes;
  const cloneOf = (dir: string) => {
    git(path.dirname(dir), "clone", "-q", bare, dir);
    git(dir, "remote", "set-url", "origin", "https://github.com/acme/widgets.git");
    git(dir, "config", "user.email", "t@t");
    git(dir, "config", "user.name", "t");
    return dir;
  };

  // The Cloud computer, as the computers service makes one: its identity, link dir and snapshot checkout, its runtime
  // a process of its own whose git and CLI run in its tools container.
  const root = tempRoot("adopt-computer-");
  const socket = path.join(root, "tools.sock");
  // `noIdentity`: a computer where nobody set a git identity (no EMAIL, an empty system config, no global one), so git
  // there has only what each command brings, or its guess from the machine's name.
  const { EMAIL: _email, ...withoutEmail } = process.env;
  const emptyConfig = path.join(root, "gitconfig-empty");
  fs.writeFileSync(emptyConfig, "");
  const computerEnv = options.noIdentity ? { ...withoutEmail, GIT_CONFIG_SYSTEM: emptyConfig, GIT_CONFIG_GLOBAL: emptyConfig } : process.env;
  const tools = spawn(process.execPath, [TOOLS_EXEC, "serve", socket], { env: { ...computerEnv, TOOLS_SIDE: "yes" }, stdio: "ignore" });
  cleanups.push(() => tools.kill());
  await until(() => fs.existsSync(socket), 10_000);
  const { privateKey } = generateKeyPairSync("ed25519");
  const runtimeId = randomUUID();
  const computerId = randomUUID();
  cloud.state.runtimes.set(runtimeId, { publicKey: createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32).toString("base64"), computerId, lastIssued: 0, status: "active", person: "user-1" });
  cloud.state.chats.computers.set(computerId, { kind: "cloud", name: "Box", person: "user-1", state: "running" });
  const linkDir = path.join(root, "link");
  fs.mkdirSync(linkDir, { recursive: true });
  // A warm computer (K10) starts with an empty link dir and gets its identity at its claim.
  const issued = options.warm ? path.join(root, "issued") : linkDir;
  fs.mkdirSync(issued, { recursive: true });
  fs.writeFileSync(path.join(issued, "runtime.json"), JSON.stringify({ cloud_url: cloud.url, runtime_id: runtimeId, organization_id: cloud.state.organizationId, computer_id: computerId, user_id: "user-1" }));
  fs.writeFileSync(path.join(issued, "runtime.key"), privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const checkout = options.emptyCheckout ? path.join(root, "workspace") : cloneOf(path.join(root, "workspace"));
  fs.mkdirSync(checkout, { recursive: true });
  const logFile = path.join(root, "runtime.log");
  const out = path.join(root, "runtime.json");
  const logFd = fs.openSync(logFile, "a");
  const box: ChildProcess = spawn(process.execPath, ["--no-warnings", CHAOS_RUNTIME], {
    env: {
      ...computerEnv,
      CHAOS_BASE: path.join(root, "state"),
      CHAOS_OUT: out,
      CHAOS_ROLE: "cloud",
      CHAOS_PARENT: String(process.pid),
      CAVEMAN_CLOUD_LINK_DIR: linkDir,
      CAVEMAN_WORKSPACE_ROOT: checkout,
      CAVEMAN_RUNTIME_TOOLS_ADDRESS: socket,
      CLAUDE_CONFIG_DIR: path.join(root, "claude"),
      ...(options.warm ? { CAVEMAN_RUNTIME_LINK_WAIT: "1" } : {}),
    },
    stdio: ["ignore", logFd, logFd],
  });
  fs.closeSync(logFd);
  cleanups.push(() => box.kill("SIGKILL"));
  await until(() => fs.existsSync(out) || box.exitCode !== null, 240_000);
  if (!fs.existsSync(out)) throw new Error(`the computer's runtime exited: ${fs.readFileSync(logFile, "utf8").slice(-3000)}`);
  const boxInfo = JSON.parse(fs.readFileSync(out, "utf8")) as { url: string; token: string; stateDir: string };
  const computer = connect(boxInfo.url, boxInfo.token);
  cleanups.push(() => computer.close());
  /**
   * The claim: the identity lands in the link dir as the bootstrap helper puts it (the key, then the record). How
   * long until Cloud has the box's relay (its own status says so at its next 2 s check).
   */
  const claim = async () => {
    const at = Date.now();
    for (const file of ["runtime.key", "runtime.json"]) {
      fs.copyFileSync(path.join(issued, file), path.join(linkDir, `.${file}.tmp`));
      fs.renameSync(path.join(linkDir, `.${file}.tmp`), path.join(linkDir, file));
    }
    const relayed = () => cloud.state.relays.some((relay) => cloud.state.tokens.get(relay.token)?.runtimeId === runtimeId);
    while (!relayed()) {
      if (Date.now() - at > 60_000) throw new Error("the claimed computer never linked");
      await new Promise((r) => setTimeout(r, 5));
    }
    const linked = Date.now() - at;
    await until(async () => (await computer.call("cloud.status", {})).state === "connected", 60_000);
    return linked;
  };
  if (!options.warm) await until(async () => (await computer.call("cloud.status", {})).state === "connected", 60_000);

  // This Mac: a Claude Agent chat whose turns each change a file, each copied to Cloud.
  const runtime = await startRuntime(await makeConfig(), "fake-claude");
  cleanups.push(runtime.close);
  const mac = connect(runtime.url, runtime.token);
  cleanups.push(() => mac.close());
  await mac.call("cloud.enroll", { request_id: "e1", cloud_url: cloud.url, token: cloud.state.personToken, name: "Test Mac" });
  await mac.call("settings.set", { request_id: "s1", settings: { sync_chats: true, move_to_cloud: true } });
  const repo = cloneOf(path.join(tempRoot("adopt-mac-"), "widgets"));
  const w = await createReady(mac, { request_id: "w1", repo: { path: repo }, title: "Moves to the box", engine: "claude-agent", options: { model: MODEL } });
  const worktree = w.root_path!;
  const chats = cloud.state.chats;
  const events: Array<SessionEvent> = [];
  await mac.attach(w.session_id, 0, (e) => events.push(e));
  for (let turn = 1; turn <= options.turns; turn++) {
    await mac.call("turn.submit", { request_id: `t${turn}`, session_id: w.session_id, kind: "followup", input: { text: `write: file-${turn}.txt ${"line of work\n".repeat(50 * turn)}` } });
    await until(() => events.filter((e) => e.type === "turn.done").length === turn, 60_000);
    await until(() => chats.copyOf(w.session_id).filter((e) => e.type === "turn.done").length === turn, 60_000);
  }
  /** The person moves the chat to the computer: how long until its adopt said it was done, and its log then. */
  const move = async () => {
    const asked = Date.now();
    await mac.call("session.move", { request_id: "move-1", session_id: w.session_id, to: { computer_id: computerId } });
    await until(() => adoptTimings(fs.readFileSync(logFile, "utf8"), w.session_id) !== undefined, 120_000);
    return { moved: Date.now() - asked, log: fs.readFileSync(logFile, "utf8") };
  };
  return { cloud, computer, computerId, checkout, w, worktree, mac, move, claim, logFile, stateDir: boxInfo.stateDir, segments: chats.sessions.get(w.session_id)!.segments.length };
}

/** Every reflog entry under `gitDir`, as `<ref>: <name> <email>`: who git wrote each of its own ref updates as. */
const reflogIdentities = (gitDir: string) => {
  const logs = path.join(gitDir, "logs");
  if (!fs.existsSync(logs)) return [];
  return (fs.readdirSync(logs, { recursive: true }) as Array<string>).flatMap((rel) => {
    const file = path.join(logs, rel);
    if (!fs.statSync(file).isFile()) return [];
    return fs.readFileSync(file, "utf8").split("\n").filter((line) => line !== "").map((line) => `${rel}: ${/^[0-9a-f]+ [0-9a-f]+ (.*) \d+ [+-]\d{4}(\t|$)/.exec(line)?.[1] ?? line}`);
  });
};

// Skipped on Windows: each test adopts the chat on a Cloud computer's runtime, and Cloud computers are Linux.
test.skipIf(process.platform === "win32")(`a Cloud computer adopts a chat of ${TURNS} copied turns, each with work in progress, within its budget`, { timeout: 600_000 }, async (context) => {
  const { cloud, checkout, w, worktree, move, segments } = await world({ turns: TURNS });
  expect(segments).toBeGreaterThanOrEqual(TURNS);
  const loadBefore = loadPerCore();
  const { moved, log } = await move();
  const timings = adoptTimings(log, w.session_id)!;
  // What every other device reads is Cloud's copy: it says the chat resumed here as soon as the adopt let the copy go,
  // never at a running turn's pace (15 s behind), though no turn began or ended here.
  await until(() => cloud.state.chats.copyOf(w.session_id).some((event) => event.type === "session.resumed"), 5_000);
  const load = Math.max(loadBefore, loadPerCore());
  const result = { turns: TURNS, segments: timings.segments, adopt_ms: timings.total, steps: timings.steps, move_ms: moved, load_per_core: Number(load.toFixed(2)), cpus: os.cpus().length };
  console.log(`adopt timing: ${JSON.stringify(result)}`);
  if (process.env.CAVEMAN_ADOPT_RESULTS) fs.appendFileSync(process.env.CAVEMAN_ADOPT_RESULTS, `${JSON.stringify(result)}\n`);
  // The adopted chat is whole: every turn's file is in the box's checkout, as the Mac left it.
  for (let turn = 1; turn <= TURNS; turn++) expect(fs.readFileSync(path.join(checkout, `file-${turn}.txt`), "utf8")).toBe(fs.readFileSync(path.join(worktree, `file-${turn}.txt`), "utf8"));
  expect(timings.segments).toBeGreaterThanOrEqual(segments);
  // However loaded: every bundle went in as one pack.
  expect(log).not.toContain("applying its bundles one at a time");
  if (load > MAX_LOAD) return context.skip(`the machine is overloaded (load per core ${load.toFixed(2)} > ${MAX_LOAD}): timings printed, budgets not judged`);
  expect(timings.total).toBeLessThan(ADOPT_BUDGET_MS);
  expect(moved).toBeLessThan(MOVE_BUDGET_MS);
});

test.skipIf(process.platform === "win32")("a chat moved onto a Cloud computer whose checkout is still empty clones its repository there first", { timeout: 600_000 }, async () => {
  const { computer, checkout, w, worktree, move } = await world({ turns: 2, emptyCheckout: true });
  expect(fs.readdirSync(checkout)).toEqual([]);
  const { log } = await move();
  expect(adoptTimings(log, w.session_id)).toBeDefined();
  // The repository through Cloud's git proxy, then the chat's work in progress on its own branch.
  expect(git(checkout, "remote", "get-url", "origin").trim()).toBe("https://github.com/acme/widgets.git");
  expect(fs.readFileSync(path.join(checkout, "README.md"), "utf8")).toBe("widgets\n");
  for (const turn of [1, 2]) expect(fs.readFileSync(path.join(checkout, `file-${turn}.txt`), "utf8")).toBe(fs.readFileSync(path.join(worktree, `file-${turn}.txt`), "utf8"));
  const adopted = (await computer.call("workspace.list", {})).workspaces.find((x) => x.id === w.id);
  expect(adopted?.status).not.toBe("failed");
  expect(git(checkout, "symbolic-ref", "--short", "HEAD").trim()).toBe(adopted!.branch);
});

test.skipIf(process.platform === "win32")(`a new Cloud computer, its checkout still empty, adopts a chat of ${FAR_TURNS} copied turns from a Cloud ${FAR_MS} ms away within its budget`, { timeout: 600_000 }, async (context) => {
  const { cloud, checkout, w, worktree, move, segments } = await world({ turns: FAR_TURNS, emptyCheckout: true });
  cloud.state.latencyMs = FAR_MS;
  const loadBefore = loadPerCore();
  const { moved, log } = await move();
  cloud.state.latencyMs = 0;
  const timings = adoptTimings(log, w.session_id)!;
  const load = Math.max(loadBefore, loadPerCore());
  const result = { far_ms: FAR_MS, clone: true, turns: FAR_TURNS, segments: timings.segments, adopt_ms: timings.total, steps: timings.steps, move_ms: moved, load_per_core: Number(load.toFixed(2)), cpus: os.cpus().length };
  console.log(`adopt timing: ${JSON.stringify(result)}`);
  if (process.env.CAVEMAN_ADOPT_RESULTS) fs.appendFileSync(process.env.CAVEMAN_ADOPT_RESULTS, `${JSON.stringify(result)}\n`);
  expect(timings.segments).toBeGreaterThanOrEqual(segments);
  expect(git(checkout, "remote", "get-url", "origin").trim()).toBe("https://github.com/acme/widgets.git");
  for (let turn = 1; turn <= FAR_TURNS; turn++) expect(fs.readFileSync(path.join(checkout, `file-${turn}.txt`), "utf8")).toBe(fs.readFileSync(path.join(worktree, `file-${turn}.txt`), "utf8"));
  if (load > MAX_LOAD) return context.skip(`the machine is overloaded (load per core ${load.toFixed(2)} > ${MAX_LOAD}): timings printed, budgets not judged`);
  expect(timings.total).toBeLessThan(FAR_ADOPT_BUDGET_MS);
});

// The clone asks for the default branch's name and fetches what HEAD names side by side. A repository whose default
// branch changes between the two answers gave a checkout one branch's name on the other's commits.
test.skipIf(process.platform === "win32")("a clone whose repository changes its default branch between the clone's two asks gives each branch its own commits", { timeout: 600_000 }, async () => {
  const { cloud, checkout, w, move } = await world({ turns: 2, emptyCheckout: true });
  const bare = path.join(cloud.state.gitBackend!, "acme/widgets.git");
  const scratch = tempRoot("adopt-develop-");
  git(scratch, "clone", "-q", bare, "repo");
  const repo = path.join(scratch, "repo");
  git(repo, "checkout", "-q", "-b", "develop");
  fs.writeFileSync(path.join(repo, "DEVELOP.md"), "develop\n");
  git(repo, "add", ".");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "develop");
  git(repo, "push", "-q", bare, "develop");
  // The first answer that lists the repository's refs leaves while HEAD names main; HEAD names develop before another does.
  let listed: Promise<void> | undefined;
  cloud.state.gitServing = (url, answered) => {
    if (!url.pathname.endsWith("/git-upload-pack")) return undefined;
    if (listed !== undefined) return listed;
    listed = answered.then(() => void git(bare, "symbolic-ref", "HEAD", "refs/heads/develop"));
    return undefined;
  };
  const { log } = await move();
  expect(adoptTimings(log, w.session_id)).toBeDefined();
  // The two asks did see two HEADs, so the default branch was fetched again by its name: a fourth request (and a
  // fifth, when that branch's commits were not fetched yet) where a clone makes three.
  expect(cloud.state.gitRequests.filter((request) => request.url.endsWith("/git-upload-pack")).length).toBeGreaterThanOrEqual(4);
  const branch = git(checkout, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").trim().slice("origin/".length);
  expect(["main", "develop"]).toContain(branch);
  for (const one of git(checkout, "for-each-ref", "--format=%(refname:lstrip=3)", "refs/remotes/origin").split("\n").filter((name) => name !== "" && name !== "HEAD")) {
    expect(`${one} ${git(checkout, "rev-parse", `refs/remotes/origin/${one}`).trim()}`).toBe(`${one} ${git(bare, "rev-parse", `refs/heads/${one}`).trim()}`);
  }
});

/** What the computer's runtime staged in its mirror (stageFetch): the bundles and refs of fetches not yet taken or dropped. */
const stagedIn = (stateDir: string) => {
  const mirror = path.join(stateDir, "git-mirror");
  if (!fs.existsSync(path.join(mirror, "HEAD"))) return { bundles: [] as Array<string>, refs: [] as Array<string> };
  return {
    bundles: fs.readdirSync(mirror).filter((file) => /^fetch-.+\.bundle$/.test(file)),
    refs: git(mirror, "for-each-ref", "--format=%(refname)", "refs/caveman/fetch").split("\n").filter((ref) => ref !== ""),
  };
};
/** The computer's own runtime in the stand-in Cloud. */
const runtimeOf = (cloud: Awaited<ReturnType<typeof startTestCloud>>, computerId: string) => [...cloud.state.runtimes].find(([, runtime]) => runtime.computerId === computerId)![0];

test.skipIf(process.platform === "win32")("the clone an empty checkout needs is fetched while the copy still comes down, and nothing of it is in the checkout until the copy is whole and the lease taken", { timeout: 600_000 }, async () => {
  const { cloud, computerId, checkout, stateDir, logFile, w, worktree, move } = await world({ turns: 2, emptyCheckout: true });
  // The copy's first segment is answered; the rest wait until this test lets them go.
  let release!: () => void;
  cloud.state.chats.segmentReadsHeldOn = { computer: computerId, from: 1, until: new Promise<void>((resolve) => (release = resolve)) };
  const moving = move();
  // That segment named the repository: its default branch is fetched through the proxy and staged in the runtime's
  // own mirror, with the rest of the copy still to come.
  await until(() => stagedIn(stateDir).bundles.length === 1, 60_000);
  expect(cloud.state.gitRequests.some((request) => request.url.includes("/acme/widgets.git/"))).toBe(true);
  // Nothing of it is in the checkout, and the chat is not this computer's yet: no lease, no adopt.
  expect(fs.readdirSync(checkout)).toEqual([]);
  expect(cloud.state.chats.sessions.get(w.session_id)?.lease?.runtime_id).not.toBe(runtimeOf(cloud, computerId));
  expect(adoptTimings(fs.readFileSync(logFile, "utf8"), w.session_id)).toBeUndefined();
  release();
  const { log } = await moving;
  // The adopt took what was staged (its clone step), and the chat's files are there.
  expect(adoptTimings(log, w.session_id)!.steps).toHaveProperty("clone");
  expect(git(checkout, "remote", "get-url", "origin").trim()).toBe("https://github.com/acme/widgets.git");
  for (const turn of [1, 2]) expect(fs.readFileSync(path.join(checkout, `file-${turn}.txt`), "utf8")).toBe(fs.readFileSync(path.join(worktree, `file-${turn}.txt`), "utf8"));
  // Taken, then dropped: the mirror holds nothing staged.
  await until(() => stagedIn(stateDir).bundles.length === 0 && stagedIn(stateDir).refs.length === 0, 20_000);
});

test.skipIf(process.platform === "win32")("an adopt that fails after its clone was fetched ahead leaves the checkout empty and nothing staged", { timeout: 600_000 }, async () => {
  const { cloud, computerId, checkout, stateDir, w, mac } = await world({ turns: 2, emptyCheckout: true });
  let release!: (how: string) => void;
  cloud.state.chats.segmentReadsHeldOn = { computer: computerId, from: 1, until: new Promise<string>((resolve) => (release = resolve)) };
  await mac.call("session.move", { request_id: "move-1", session_id: w.session_id, to: { computer_id: computerId } });
  await until(() => stagedIn(stateDir).bundles.length === 1, 60_000);
  // The rest of the copy cannot be read: the adopt fails, and says so to Cloud, which hands the chat back.
  release("down");
  const move = () => [...cloud.state.chats.moves.values()].find((one) => one.session_id === w.session_id);
  await until(() => move()?.answers.some((answer) => answer.phase === "adopt" && !answer.ok) === true, 60_000);
  cloud.state.chats.segmentReadsHeldOn = undefined;
  // The computer is as it was before the chat came: an empty checkout, and nothing left staged in the mirror.
  expect(fs.readdirSync(checkout)).toEqual([]);
  await until(() => stagedIn(stateDir).bundles.length === 0 && stagedIn(stateDir).refs.length === 0, 20_000);
  expect(fs.readdirSync(checkout)).toEqual([]);
});

test.skipIf(process.platform === "win32")("no git of an adopt asks the machine's resolver for its name: each one that writes a reflog entry carries the runtime's fallback email", { timeout: 600_000 }, async () => {
  // A computer where nobody set a git identity, its checkout still empty: the adopt clones (init, the fetch through the
  // mirror, checkout -B), applies the work in progress, and checks it out (checkout -f -B, clean, restore). git writes
  // a reflog entry for each ref it moves and signs it with the committer's identity; with none set it makes one up as
  // <user>@<the machine's name>, asking the resolver for that name (10 s a command on a computer whose name nothing
  // resolved). An entry signed any other way than with the fallback is a command that would have asked.
  const { checkout, stateDir, w, worktree, move } = await world({ turns: 2, emptyCheckout: true, noIdentity: true });
  const { log } = await move();
  expect(adoptTimings(log, w.session_id)).toBeDefined();
  for (const turn of [1, 2]) expect(fs.readFileSync(path.join(checkout, `file-${turn}.txt`), "utf8")).toBe(fs.readFileSync(path.join(worktree, `file-${turn}.txt`), "utf8"));
  const entries = reflogIdentities(path.join(checkout, ".git"));
  // The clone's fetch, its checkout, and the adopt's own checkout onto the chat's branch each wrote at least one.
  expect(entries.filter((entry) => entry.startsWith("HEAD: ")).length).toBeGreaterThanOrEqual(2);
  expect(entries.some((entry) => entry.startsWith(path.join("refs", "remotes", "origin", "main")))).toBe(true);
  expect(entries.filter((entry) => !entry.endsWith(` <${RUNTIME_GIT_EMAIL}>`))).toEqual([]);
  // The runtime's own mirror (bare: git keeps no reflog there unless told to) has none signed otherwise either.
  expect(reflogIdentities(path.join(stateDir, "git-mirror")).filter((entry) => !entry.endsWith(` <${RUNTIME_GIT_EMAIL}>`))).toEqual([]);
});

test.skipIf(process.platform === "win32")("a chat moved onto a Cloud computer runs its repository's setup there, as a chat made there does", { timeout: 600_000 }, async () => {
  const { computer, checkout, w, worktree, move } = await world({ turns: 1, setup: true });
  // This Mac ran it in the chat's worktree when the chat was made; what it built there stays there.
  await until(() => fs.existsSync(path.join(worktree, "setup-ran.txt")), 20_000);
  expect(fs.existsSync(path.join(checkout, "setup-ran.txt"))).toBe(false);
  const { log } = await move();
  expect(adoptTimings(log, w.session_id)).toBeDefined();
  // Its checkout there has no snapshot of a setup: it runs, beside the chat, and the chat says so after it arrived.
  const events: Array<SessionEvent> = [];
  await computer.attach(w.session_id, 0, (e) => events.push(e));
  const since = () => events.slice(events.findLastIndex((e) => e.type === "session.resumed") + 1);
  const setupNotes = () => since().flatMap((e) => (e.type === "notification" && /^Setup /.test(e.payload.title) ? [e.payload.title] : []));
  await until(() => setupNotes().some((title) => /^Setup (finished|failed|skipped)/.test(title)), 60_000);
  expect(setupNotes()).toEqual([expect.stringMatching(/^Setup finished/)]);
  expect(fs.readFileSync(path.join(checkout, "setup-ran.txt"), "utf8")).toBe("ran\n");
});

test.skipIf(process.platform === "win32")("a warm Cloud computer claimed for the move links in about a second and adopts within the same budget (K10)", { timeout: 600_000 }, async (context) => {
  const { computer, checkout, w, worktree, move, claim } = await world({ turns: TURNS, warm: true });
  // Serving before its claim, and not linked.
  expect((await computer.call("cloud.status", {})).state).toBe("off");
  const loadBefore = loadPerCore();
  const linked = await claim();
  const { moved, log } = await move();
  const timings = adoptTimings(log, w.session_id)!;
  const load = Math.max(loadBefore, loadPerCore());
  const result = { warm: true, turns: TURNS, linked_ms: linked, adopt_ms: timings.total, steps: timings.steps, move_ms: moved, load_per_core: Number(load.toFixed(2)) };
  console.log(`adopt timing: ${JSON.stringify(result)}`);
  if (process.env.CAVEMAN_ADOPT_RESULTS) fs.appendFileSync(process.env.CAVEMAN_ADOPT_RESULTS, `${JSON.stringify(result)}\n`);
  for (let turn = 1; turn <= TURNS; turn++) expect(fs.readFileSync(path.join(checkout, `file-${turn}.txt`), "utf8")).toBe(fs.readFileSync(path.join(worktree, `file-${turn}.txt`), "utf8"));
  if (load > MAX_LOAD) return context.skip(`the machine is overloaded (load per core ${load.toFixed(2)} > ${MAX_LOAD}): timings printed, budgets not judged`);
  expect(linked).toBeLessThan(1_500);
  expect(timings.total).toBeLessThan(ADOPT_BUDGET_MS);
  expect(moved).toBeLessThan(MOVE_BUDGET_MS);
});

test.skipIf(process.platform === "win32")("a move handed to a warm Cloud computer before its claim is adopted as soon as its link is up (K13)", { timeout: 600_000 }, async (context) => {
  const { cloud, computerId, checkout, w, worktree, move, claim, logFile } = await world({ turns: 2, warm: true });
  // The move goes to the computer before it is claimed: Cloud accepts for it and leaves the adopt in its mail.
  const moving = move();
  await until(() => cloud.state.chats.sessions.get(w.session_id)?.computer_id === computerId, 60_000);
  const loadBefore = loadPerCore();
  await claim();
  const { log } = await moving;
  const timings = adoptTimings(log, w.session_id)!;
  for (const turn of [1, 2]) expect(fs.readFileSync(path.join(checkout, `file-${turn}.txt`), "utf8")).toBe(fs.readFileSync(path.join(worktree, `file-${turn}.txt`), "utf8"));
  // From the link coming up to the adopt starting (its log line's time less its total): the old pass slept 3 s first.
  const linkOn = loggedAt(log, "Cloud link on:")!;
  const adoptStart = loggedAt(log, `moves: adopted ${w.session_id} `)! - timings.total;
  const load = Math.max(loadBefore, loadPerCore());
  const result = { warm: true, handed_before_link: true, link_to_adopt_start_ms: adoptStart - linkOn, adopt_ms: timings.total, load_per_core: Number(load.toFixed(2)) };
  console.log(`adopt timing: ${JSON.stringify(result)}`);
  if (process.env.CAVEMAN_ADOPT_RESULTS) fs.appendFileSync(process.env.CAVEMAN_ADOPT_RESULTS, `${JSON.stringify(result)}\n`);
  expect(fs.readFileSync(logFile, "utf8")).toContain("Claimed: the Cloud identity arrived");
  if (load > MAX_LOAD) return context.skip(`the machine is overloaded (load per core ${load.toFixed(2)} > ${MAX_LOAD}): timings printed, budgets not judged`);
  expect(adoptStart - linkOn).toBeLessThan(LINK_TO_ADOPT_MS);
});
