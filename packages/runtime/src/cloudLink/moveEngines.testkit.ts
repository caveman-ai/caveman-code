// Claude Agent chats move between computers with their CLI's own session file, against the test Cloud (testCloud.ts):
// real runtime processes (moveEngines.e2e.runtime.ts) on the real Claude Agent adapter and SDK, the CLI a stand-in
// (scripts/smoke-claude.mjs) that resumes only from a session file it finds under its own CLAUDE_CONFIG_DIR, as the
// real one does. One Mac and two Cloud computers, each with its own config dir; GitHub is a bare repository behind
// the test Cloud's git proxy.
//
// In order: a move to a computer without a Claude login there is refused before the chat parks, with the fix; with a
// sign-in on that computer, Move to that named computer moves the chat in the middle of a turn: its session file
// travels (its thinking left out, nothing from the config dir beside it), the stopped turn stays in the transcript,
// the next turn is told which tools already ran, and the conversation resumes natively. The lid keeps a Claude Agent
// chat on the Mac while the setting says so. A session that will not resume where it lands (its file gone) hands the
// conversation over as context instead, and the person's message runs once more. Back on This Mac, a chat never
// resumes from the session file Cloud wrote: it carries on in its own, told what ran on Cloud, when that file is as
// Cloud resumed it (K15), and hands its transcript to a new session otherwise; agent and tool config Cloud changed
// waits for the person. Cloud moves a chat off This Mac only for a device the person allowed there, and hands it one
// only when it asked; a device's word moves a chat once, never again when Cloud passes it a second time. A chat This
// Mac asks back comes home whatever Claude's sign-in there. Between two of the person's Macs a chat moves only on the
// word of a device the target allowed, only where Claude is signed in (asked again before a refusal), and from its
// transcript (never a session file that came through Cloud); a device's word lands it once, even when the adopt it was
// accepted for fails, and the same accept again is answered as before; a Mac that clones the repository to take it
// keeps the repository as GitHub has it.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import { afterAll, afterEach, beforeAll, test } from "vitest";

import { allowedStream, testDevice } from "../session-protocol/devices.testkit.ts";
import { git, MODEL, tempRoot, until } from "../session-protocol/testHarness.ts";
import { claudeProjectKey } from "./nativeSessions.ts";
import { startTestCloud, type TestCloud } from "./testCloud.ts";

const RUNTIME = fileURLToPath(new URL("./moveEngines.e2e.runtime.ts", import.meta.url));

/** The runtimes the running test started, with their clients. */
export const started: Array<{ child: ChildProcess; client: { close(): void } }> = [];

export let cloud: TestCloud;

/**
 * Each test's runtimes end with it, with every process they started (the stand-in Claude CLIs). Left running until the
 * file ended, its 13 runtimes reached 13 GB and took down CI's 16 GB runner.
 */
const stopStarted = () =>
  Promise.all(
    started.splice(0).map(({ child, client }) => {
      client.close();
      if (child.exitCode !== null || child.signalCode !== null) return undefined;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      try {
        // Its process group (spawned detached): the runtime and everything under it.
        process.kill(process.platform === "win32" ? child.pid! : -child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      return Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }),
  );

export const realpath = (p: string) => fs.realpathSync(p);

// Skipped on Windows: each test lands the chat on a Cloud computer's runtime, and a Cloud computer is Linux; with no
// tools container (as here) it runs git in its checkout only where owner uid and mode bits show the agent cannot write
// it (gitTrusts), so on Windows it never adopts the chat.
export const withCloudComputers = test.skipIf(process.platform === "win32");

/** A runtime process: This Mac, or a Cloud computer's runtime on its own link dir and checkout. */
export async function runtime(role: "mac" | "cloud", env: Record<string, string>) {
  const outFile = path.join(tempRoot(`move-engines-${role}-`), "out.json");
  const log = fs.openSync(`${outFile}.log`, "w");
  const claudeDir = tempRoot(`move-engines-claude-${role}-`);
  // Never read: the copy takes the session's own file, nothing else in the config dir.
  fs.writeFileSync(
    path.join(claudeDir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: `oauth-${role}-NEVER-COPIED` } }),
  );
  // Not the host's Claude endpoint (a coding agent running this test sets one): a custom endpoint never reads as signed
  // out (ClaudeProvider), so it would hide the stand-in's SMOKE_CLAUDE_SIGNED_OUT.
  const { ANTHROPIC_BASE_URL: _hostEndpoint, ...hostEnv } = process.env;
  const child = spawn(process.execPath, ["--no-warnings", RUNTIME], {
    env: {
      ...hostEnv,
      ...env,
      MOVES_ROLE: role,
      MOVES_OUT: outFile,
      MOVES_PARENT: String(process.pid),
      CLAUDE_CONFIG_DIR: claudeDir,
      SMOKE_CLAUDE_STRICT_RESUME: "1",
      SMOKE_CLAUDE_TRACE: path.join(path.dirname(outFile), "claude-trace.jsonl"),
    },
    stdio: ["ignore", log, log],
    // Its own process group, so the test's end stops what it started too.
    detached: process.platform !== "win32",
  });
  const entry = { child, client: { close: () => undefined } as { close(): void } };
  started.push(entry);
  // Written, not only made: on a loaded machine the file is there a moment before its line is.
  const written = () => fs.existsSync(outFile) && fs.statSync(outFile).size > 0;
  await until(() => written() || child.exitCode !== null, 90_000);
  if (!written())
    throw new Error(
      `the ${role} runtime exited: ${fs.readFileSync(`${outFile}.log`, "utf8").slice(-2000)}`,
    );
  const info = JSON.parse(fs.readFileSync(outFile, "utf8")) as {
    url: string;
    token: string;
    stateDir: string;
  };
  const client = connect(info.url, info.token);
  entry.client = client;
  return { child, client, claudeDir, log: `${outFile}.log`, ...info };
}

export type Runtime = Awaited<ReturnType<typeof runtime>>;

/** A Cloud computer as the computers service makes one: its runtime identity, its pod, its snapshot checkout. */
export async function box(bare: string, name: string, person = "user-1") {
  const { privateKey } = generateKeyPairSync("ed25519");
  const publicKey = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64");
  const runtimeId = randomUUID();
  const computerId = randomUUID();
  cloud.state.runtimes.set(runtimeId, {
    publicKey,
    computerId,
    lastIssued: 0,
    status: "active",
    person,
  });
  cloud.state.chats.computers.set(computerId, { kind: "cloud", name, person, state: "running" });
  const linkDir = tempRoot("move-engines-link-");
  fs.writeFileSync(
    path.join(linkDir, "runtime.json"),
    JSON.stringify({
      cloud_url: cloud.url,
      runtime_id: runtimeId,
      organization_id: cloud.state.organizationId,
      computer_id: computerId,
      user_id: person,
    }),
  );
  fs.writeFileSync(
    path.join(linkDir, "runtime.key"),
    privateKey.export({ format: "pem", type: "pkcs8" }),
    { mode: 0o600 },
  );
  const workspaceRoot = path.join(tempRoot("move-engines-box-"), "workspace");
  git(path.dirname(workspaceRoot), "clone", "-q", bare, workspaceRoot);
  git(workspaceRoot, "remote", "set-url", "origin", `https://github.com/${GITHUB}`);
  return {
    ...(await runtime("cloud", {
      CAVEMAN_CLOUD_LINK_DIR: linkDir,
      CAVEMAN_WORKSPACE_ROOT: workspaceRoot,
    })),
    computerId,
    runtimeId,
    workspaceRoot,
  };
}

export let GITHUB = "";

export async function transcript(rt: Runtime, sessionId: string) {
  const events: Array<SessionEvent> = [];
  const sub = await rt.client.attach(sessionId, 0, (e) => events.push(e));
  await until(() => (events.at(-1)?.cursor ?? 0) >= sub.session.head, 10_000);
  await sub.detach();
  return events;
}

export const replies = (events: ReadonlyArray<SessionEvent>) =>
  events.flatMap((e) =>
    e.type === "message.done" && e.payload.role === "assistant" ? [e.payload.text] : [],
  );

export const recordOn = async (rt: Runtime, sessionId: string) =>
  (await rt.client.call("workspace.list", {})).workspaces.find((w) => w.session_id === sessionId);

/**
 * The transcript once its last answer matches `reply` and its turn has ended. `after`: only an answer past that cursor
 * counts (one the chat brought home in the same words is not the answer to what was just said).
 */
export async function waitReply(
  rt: Runtime,
  sessionId: string,
  reply: RegExp,
  ms = 60_000,
  after = 0,
) {
  let events: Array<SessionEvent> = [];
  const ended = () =>
    events.findLastIndex((e) => e.type === "turn.done") >
    events.findLastIndex((e) => e.type === "message.done" && e.payload.role === "assistant");
  const answer = () => replies(events.filter((e) => e.cursor > after)).at(-1) ?? "";
  await until(
    async () => (
      (events = await transcript(rt, sessionId).catch(() => events)),
      reply.test(answer()) && ended()
    ),
    ms,
  ).catch((error: Error) => {
    throw new Error(
      `${error.message} waiting for ${reply} on ${rt.stateDir}: ${JSON.stringify(events.slice(-8).map((e) => [e.cursor, e.type, JSON.stringify(e.payload).slice(0, 160)]))}`,
    );
  });
  return events;
}

export const say = (rt: Runtime, sessionId: string, text: string) =>
  rt.client.call("turn.submit", {
    request_id: `say-${randomUUID()}`,
    session_id: sessionId,
    kind: "followup",
    input: { text },
  });

export const notified = (events: ReadonlyArray<SessionEvent>, title: RegExp) =>
  events.some((e) => e.type === "notification" && title.test(JSON.stringify(e.payload)));

/**
 * The transcript once a notification matching `title` is in it. A chat that comes back reads idle here before its
 * return has written what it says about the files (handlers.ts, after the record), so a read at idle can miss them.
 */
export async function waitNotified(rt: Runtime, sessionId: string, title: RegExp, ms = 30_000) {
  let events: Array<SessionEvent> = [];
  // A read that fails (an attach refused mid-return) is a look that saw nothing new, as in waitReply.
  await until(
    async () => notified((events = await transcript(rt, sessionId).catch(() => events)), title),
    ms,
  ).catch((error: Error) => {
    const said = events.flatMap((e) =>
      e.type === "notification" ? [JSON.stringify(e.payload).slice(0, 160)] : [],
    );
    throw new Error(
      `${error.message} waiting for a note ${title}; the chat said: ${JSON.stringify(said)}`,
    );
  });
  return events;
}

/** A person's own call to Cloud (the web and phone's routes), with their bearer. */
export const personCall = async (bearer: string, method: string, route: string, body?: unknown) => {
  const response = await fetch(`${cloud.url}/api/v1/code/${route}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
};

/** This Mac's relay connection (the one whose streams it challenges for a device), among those opened since `before`. A probe stream each: closed again, as the device gate closes one left without a hello. */
export async function macRelay(before: number, user: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const relay of cloud.state.relays.slice(before)) {
      const stream = relay.open({ user_id: user });
      const challenged = await until(
        () => relay.replies(stream).some((r) => r.method === "device.challenge"),
        3_000,
      ).then(
        () => true,
        () => false,
      );
      relay.close(stream);
      if (challenged) return relay;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("This Mac never opened its relay connection");
}

/** The Mac's session file for the chat in `worktree` (the CLI's own, under its config dir). */
export const sessionFileOn = (claudeDir: string, worktree: string) => {
  const dir = path.join(claudeDir, "projects", claudeProjectKey(realpath(worktree))!);
  const name = fs.existsSync(dir)
    ? fs.readdirSync(dir).find((f) => f.endsWith(".jsonl"))
    : undefined;
  return name === undefined ? undefined : path.join(dir, name);
};

/** Every segment Cloud holds for the chat, as the JSON text it was sent. */
export const segmentsText = (sessionId: string) =>
  (cloud.state.chats.sessions.get(sessionId)?.segments ?? [])
    .map((s) => gunzipSync(s.raw).toString("utf8"))
    .join("\n");

/** GitHub: a bare repository the test Cloud's git proxy serves, and This Mac's clone of it (reaching it directly). */
export function githubRepo() {
  const gitRoot = tempRoot("move-engines-git-");
  GITHUB = `octocat/move-${randomUUID().slice(0, 8)}`;
  const bare = path.join(gitRoot, `${GITHUB}.git`);
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  git(gitRoot, "init", "-q", "--bare", "-b", "main", bare);
  cloud.state.gitBackend = gitRoot;
  const seed = tempRoot("move-engines-seed-");
  git(seed, "clone", "-q", bare, "repo");
  fs.writeFileSync(path.join(seed, "repo", "README.md"), "hello from the readme\n");
  git(path.join(seed, "repo"), "add", ".");
  git(
    path.join(seed, "repo"),
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "init",
  );
  git(path.join(seed, "repo"), "push", "-q", "origin", "HEAD:main");
  const gitEnv = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.file://${bare}.insteadOf`,
    GIT_CONFIG_VALUE_0: `https://github.com/${GITHUB}`,
  };
  const macRepo = path.join(tempRoot("move-engines-mac-"), "repo");
  git(path.dirname(macRepo), "clone", "-q", bare, macRepo);
  git(macRepo, "remote", "set-url", "origin", `https://github.com/${GITHUB}`);
  return { bare, gitEnv, macRepo };
}

/**
 * GitHub's main is rewritten (an amended first commit, force-pushed) after a chat began on it: the commit the chat is
 * based on is on no branch of GitHub's any more. `gone`: GitHub dropped it for good; otherwise GitHub still hands it out
 * by its id, as GitHub does for a commit a force-push took off its branches.
 */
export function forcePush(bare: string, gone: boolean) {
  const other = path.join(tempRoot("move-engines-rewrite-"), "repo");
  git(path.dirname(other), "clone", "-q", bare, other);
  fs.writeFileSync(path.join(other, "README.md"), "rewritten on GitHub\n");
  git(
    other,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--amend",
    "-am",
    "init, rewritten",
  );
  git(other, "push", "-q", "--force", "origin", "HEAD:main");
  if (!gone) return;
  // A local clone of the stand-in would copy it along otherwise.
  git(bare, "reflog", "expire", "--expire=now", "--all");
  git(bare, "gc", "-q", "--prune=now");
}

export const adoptsOf = (sessionId: string) =>
  [...cloud.state.chats.moves.values()]
    .filter((m) => m.session_id === sessionId)
    .flatMap((m) => m.answers.filter((a) => a.phase === "adopt").map((a) => a.ok));

// The production web sender, including its device signature and durable Cloud
// queue, rather than an optimistic in-memory acceptance by the departing Mac.
export async function handoffSender(mac: Runtime, sessionId: string, bearer: string) {
  // A phone follows a synced chat; enable the relay before asking the Mac to approve its key.
  await mac.client.call("settings.set", {
    request_id: "enable-phone-sender",
    settings: { sync_chats: true },
  });
  const web = (part: string) =>
    import(
      /* @vite-ignore */ new URL(`../../../../apps/web/src/state/${part}`, import.meta.url).href
    );
  const computerId = cloud.state.chats.sessions.get(sessionId)!.computer_id;
  const runtimeId = [...cloud.state.runtimes].find(([, r]) => r.computerId === computerId)![0];
  let relay: (typeof cloud.state.relays)[number] | undefined;
  await until(() => {
    relay = cloud.state.relays.find(
      (side) =>
        cloud.state.tokens.get(side.token)?.runtimeId === runtimeId &&
        side.ws.readyState === side.ws.OPEN,
    );
    return relay !== undefined;
  }, 20_000);
  const phone = await testDevice("Handoff phone");
  await allowedStream(
    relay!,
    mac.client,
    phone,
    relay!.open({
      user_id: cloud.state.chats.persons.get(bearer)!,
      organization_id: cloud.state.organizationId,
    }),
  );
  const [
    { ChatSender },
    { cloudApi },
    { kvOutbox },
    { memoryKv },
    { installDeviceHooks },
    { deviceHooks },
    { onlyPage },
  ] = await Promise.all([
    web("sync/sender.ts"),
    web("sync/cloud-api.ts"),
    web("sync/outbox.ts"),
    web("sync/kv.ts"),
    web("device-approval.ts"),
    web("sync/device-hooks.ts"),
    web("sync/pages.ts"),
  ]);
  installDeviceHooks({ kindOf: () => "laptop", device: async () => phone });
  return new ChatSender({
    api: cloudApi({
      base: cloud.url,
      headers: async () => ({ authorization: `Bearer ${bearer}` }),
      renew: async () => false,
      credentials: "omit",
    }),
    outbox: kvOutbox(memoryKv(), "cloud", onlyPage()),
    callFields: (call: unknown) => deviceHooks().callFields(call),
  });
}

/** A Cloud computer's worktree for `branch` (it never shows the path: root_path is This Mac's). */
export const treeOf = (checkout: string, branch: string) =>
  git(checkout, "worktree", "list", "--porcelain")
    .split("\n\n")
    .find((t) => t.includes(`branch refs/heads/${branch}`))!
    .split("\n")[0]!
    .replace(/^worktree /, "");

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export type Boundary = {
  wip?: string;
  wip_bundle?: string;
  wip_ref?: { sha256: string; bytes: number; chunks: ReadonlyArray<string> };
  wip_dropped?: boolean;
};

/** The copy's last boundary that carried new work in progress (a later one with nothing new names it only by `wip`). */
export const lastBoundary = (sessionId: string) =>
  cloud.state.chats.sessions
    .get(sessionId)
    ?.segments.findLast(
      (s) =>
        s.boundary &&
        (s.body.wip_bundle !== undefined ||
          s.body.wip_ref !== undefined ||
          s.body.wip_dropped !== undefined),
    )?.body as Boundary | undefined;

/** The copy's last boundary that named its work in progress by chunks (AC-08). */
export const namedBy = (sessionId: string) =>
  cloud.state.chats.sessions
    .get(sessionId)
    ?.segments.findLast((s) => s.boundary && s.body.wip_ref !== undefined)?.body as
    | Boundary
    | undefined;

export const copyIdle = (sessionId: string) =>
  cloud.state.chats.sessions.get(sessionId)?.lease === null;

/**
 * The copy holds the work in progress its last boundary names, as a bundle on that boundary or on a segment before it:
 * a copy made while the turn ran carries the work mid-turn, and the boundary that ends the turn then names it by `wip`
 * without sending it again (copySegments.ts), as a busy machine makes it.
 */
const wipCarried = (sessionId: string) => {
  const segments = cloud.state.chats.sessions.get(sessionId)?.segments ?? [];
  const named = (segments.findLast((s) => s.boundary)?.body as Boundary | undefined)?.wip;
  return (
    named != null &&
    segments.some(
      (s) =>
        (s.body as Boundary | undefined)?.wip === named &&
        typeof (s.body as Boundary).wip_bundle === "string",
    )
  );
};

/** What Cloud holds of a chat's copy, for a wait on it that ran out to say. */
const copyState = (sessionId: string) => {
  const session = cloud.state.chats.sessions.get(sessionId);
  const segments = (session?.segments ?? []).map((s) => {
    const body = s.body as Boundary | undefined;
    return {
      boundary: s.boundary,
      wip: body?.wip ?? null,
      bundle: typeof body?.wip_bundle === "string",
      ref: body?.wip_ref !== undefined,
      dropped: body?.wip_dropped === true,
    };
  });
  return JSON.stringify({ lease: session?.lease ?? null, segments });
};

/** Waits until the copy holds the work in progress its last boundary names and nothing is uploading; says what it held if not. */
export const untilWipHeld = (sessionId: string) =>
  until(() => wipCarried(sessionId) && copyIdle(sessionId), 30_000).catch((error: Error) => {
    throw new Error(
      `${error.message} waiting for the copy to carry the work in progress: ${copyState(sessionId)}`,
    );
  });

/**
 * Cloud has heard a heartbeat of this Mac's own: its link is up. The link starts at the runtime's next look at its
 * settings (every 2 s, cloudLink/index.ts), so a lid closed in the same breath as sync was turned on has no link to say
 * so on yet, and its mark goes out with the link's first heartbeat instead of before the call answers.
 */
export const linked = async (mac: Runtime) => {
  const { runtime_id } = await mac.client.call("cloud.status", {});
  await until(
    () =>
      cloud.state.heartbeats.some((h) => cloud.state.tokens.get(h.token)?.runtimeId === runtime_id),
    30_000,
  );
};

/** A chat of `person`'s on This Mac with a secret-shaped file beside it, moved to a Cloud computer of theirs and idle there. */
export async function secretsAway(
  person: string,
  n: number,
  seedFiles: Record<string, string> = {},
) {
  const { bare, gitEnv, macRepo } = githubRepo();
  if (Object.keys(seedFiles).length > 0) {
    const seed = path.join(tempRoot("move-engines-seed-files-"), "repo");
    git(path.dirname(seed), "clone", "-q", bare, seed);
    for (const [file, text] of Object.entries(seedFiles)) {
      fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
      fs.writeFileSync(path.join(seed, file), text);
    }
    git(seed, "add", ".");
    git(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed files");
    git(seed, "push", "-q", "origin", "HEAD:main");
    git(macRepo, "pull", "-q", bare, "main");
    git(macRepo, "fetch", "-q", bare, "main:refs/remotes/origin/main");
  }
  const bearer = cloud.state.chats.addPerson(person);
  cloud.state.chats.engineLogins.set(person, {
    "claude-agent": { vault_key: true, signed_in_on: [] },
  });
  const mac = await runtime("mac", { ...gitEnv, MOVES_CLOUD_URL: cloud.url, MOVES_BEARER: bearer });
  await mac.client.call("settings.set", { request_id: "moves-on", settings: { sync_chats: true } });
  const away = await box(bare, `Box ${n}`, person);
  // The link up before the chat begins, so its first copy is the one made as it starts: begun before the link, a chat's
  // first copy lands mid-turn, its work in progress rides in that segment, and no boundary carries a bundle (moveThere
  // waits for one that does).
  await linked(mac);
  const w = await mac.client.call("workspace.create", {
    request_id: `w${n}`,
    repo: { path: macRepo },
    title: `Secrets ${n}`,
    engine: "claude-agent",
    options: { model: MODEL, access: "full" },
    task: { text: `remember ${n}` },
  });
  await waitReply(mac, w.session_id, new RegExp(`smoke ok: remember ${n}`));
  return { mac, away, w, root: w.root_path!, sessionId: w.session_id, macRepo };
}

export const moveThere = async (t: Awaited<ReturnType<typeof secretsAway>>, text: string) => {
  await say(t.mac, t.sessionId, text);
  await waitReply(t.mac, t.sessionId, new RegExp(`smoke ok: [\\s\\S]*${text}`));
  await untilWipHeld(t.sessionId);
  await t.mac.client.call("session.move", {
    request_id: `m-${randomUUID()}`,
    session_id: t.sessionId,
    to: { computer_id: t.away.computerId },
  });
  await until(
    async () =>
      (await recordOn(t.away, t.sessionId))?.computer.id === t.away.computerId &&
      (await recordOn(t.away, t.sessionId))?.status === "idle",
    120_000,
  );
  return treeOf(t.away.workspaceRoot, t.w.branch);
};

/** One test Cloud for the file, running Cloud computers; each test's runtimes stop when it ends. */
export function useTestCloud() {
  beforeAll(async () => {
    cloud = await startTestCloud();
    // This Caveman Cloud runs Cloud computers.
    cloud.state.environments.computers = true;
  });
  afterEach(stopStarted);
  afterAll(async () => {
    await stopStarted();
    await cloud?.close();
  });
}
