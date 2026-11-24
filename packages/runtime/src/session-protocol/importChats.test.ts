// project.import_chats: a project's past Claude Code sessions come in as chats in its folder, journaled with their own
// messages and times, and each continues its own session natively. The stand-in CLI (scripts/smoke-claude.mjs) resumes
// only from a session file under its CLAUDE_CONFIG_DIR, as the real one does, so "history?" proves the resume.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId } from "@caveman-app/protocol";
import { connect, type SessionEvent, type Workspace } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, expect, test } from "vitest";

import { claudeProjectKey } from "../cloudLink/nativeSessions.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as AgentSessionScanner from "../project/AgentSessionScanner.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  createReady,
  makeConfig,
  makeRepo,
  MODEL,
  startRuntime,
  tempRoot,
  until,
} from "./testHarness.ts";

const root = tempRoot("sp-import-chats-");
const claudeDir = path.join(root, "claude");
let config: Awaited<ReturnType<typeof makeConfig>>;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
const saved = {
  dir: process.env.CLAUDE_CONFIG_DIR,
  strict: process.env.SMOKE_CLAUDE_STRICT_RESUME,
};

beforeAll(async () => {
  // The stand-in CLI the runtime spawns reads both from its environment.
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.SMOKE_CLAUDE_STRICT_RESUME = "1";
  config = await makeConfig();
  // The scanner as runtimeLayer.ts provides it, reading this test's Claude home.
  const scanner = AgentSessionScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: claudeDir },
            },
          },
        }),
        Layer.succeed(ServerConfig.ServerConfig, config),
        Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
        NodeServices.layer,
      ),
    ),
    Layer.orDie,
  );
  runtime = await startRuntime(config, "fake-claude", undefined, { provide: scanner });
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  for (const [key, value] of [
    ["CLAUDE_CONFIG_DIR", saved.dir],
    ["SMOKE_CLAUDE_STRICT_RESUME", saved.strict],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

/** A Claude Code session where the real CLI keeps it: a person's prompts and the answers, `daysAgo` old. */
function claudeSession(
  cwd: string,
  prompts: ReadonlyArray<string>,
  daysAgo: number,
  id = randomUUID(),
) {
  const start = Date.now() - daysAgo * DAY;
  let parent: string | null = null;
  const lines = prompts.flatMap((prompt, n) => {
    const user = randomUUID();
    const reply = randomUUID();
    const entries = [
      {
        type: "user",
        uuid: user,
        parentUuid: parent,
        sessionId: id,
        cwd,
        timestamp: iso(start + n * 60_000),
        isSidechain: false,
        message: { role: "user", content: prompt },
      },
      {
        type: "assistant",
        uuid: reply,
        parentUuid: user,
        sessionId: id,
        cwd,
        timestamp: iso(start + n * 60_000 + 1_000),
        isSidechain: false,
        message: {
          role: "assistant",
          model: MODEL,
          content: [{ type: "text", text: `done: ${prompt}` }],
        },
      },
    ];
    parent = reply;
    return entries;
  });
  const dir = path.join(claudeDir, "projects", claudeProjectKey(fs.realpathSync(cwd))!);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const at = new Date(start + prompts.length * 60_000);
  fs.utimesSync(file, at, at);
  return { id, file };
}

const project = async (repo: string) =>
  client.call("project.create", { request_id: `p:${repo}`, path: repo });
const chats = async (projectId: string) =>
  (await client.call("workspace.list", { include_archived: true })).workspaces.filter(
    (w: Workspace) => w.project_id === projectId,
  );
const journal = async (w: Workspace) => {
  const seen: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e: SessionEvent) => seen.push(e));
  return { seen, close: async () => client.call("session.detach", { session_id: w.session_id }) };
};

test("a folder's recent Claude Code sessions come in as chats in it, with their own messages and times, once", async () => {
  const repo = makeRepo(root, { "README.md": "r\n" });
  const p = await project(repo);
  claudeSession(repo, ["remember alpha", "and beta"], 2);
  claudeSession(repo, ["too old"], 40);
  claudeSession(makeRepo(root, { "README.md": "other\n" }), ["elsewhere"], 1);

  expect(await client.call("project.import_chats", { request_id: "i1", project_id: p.id })).toEqual(
    { imported: 1, already: 0, skipped: 0 },
  );
  const [chat, ...rest] = await chats(p.id);
  expect(rest).toEqual([]);
  expect(chat).toMatchObject({
    engine: "claude-agent",
    status: "idle",
    branch: "",
    root_path: fs.realpathSync(repo),
    title: "remember alpha",
  });
  // Its own times, not the import's: it sorts among the rest by when it ran.
  expect(Date.now() - Date.parse(chat!.updated_at)).toBeGreaterThan(DAY);

  const j = await journal(chat!);
  await until(() => j.seen.filter((e) => e.type === "message.done").length === 4);
  expect(
    j.seen
      .filter((e) => e.type === "message.done")
      .map((e) => (e.payload as { role: string; text: string }).text),
  ).toEqual(["remember alpha", "done: remember alpha", "and beta", "done: and beta"]);
  await j.close();

  // Again: nothing new, nothing twice.
  expect(await client.call("project.import_chats", { request_id: "i2", project_id: p.id })).toEqual(
    { imported: 0, already: 1, skipped: 0 },
  );
  // A session started since comes in on the next import.
  claudeSession(repo, ["gamma"], 0.5);
  expect(
    await client.call("project.import_chats", { request_id: "i3", project_id: p.id }),
  ).toMatchObject({ imported: 1, already: 1 });
  expect((await chats(p.id)).length).toBe(2);
});

test("an imported chat continues its own Claude session natively", async () => {
  const repo = makeRepo(root, { "README.md": "r\n" });
  const p = await project(repo);
  claudeSession(repo, ["remember delta", "and epsilon"], 1);
  await client.call("project.import_chats", { request_id: "r1", project_id: p.id });
  const [chat] = await chats(p.id);
  const j = await journal(chat!);
  await client.call("turn.submit", {
    request_id: "r2",
    session_id: chat!.session_id,
    kind: "followup",
    input: { text: "history?" },
    options: { model: MODEL },
  });
  const reply = () =>
    j.seen
      .filter(
        (e) => e.type === "message.done" && (e.payload as { role: string }).role === "assistant",
      )
      .map((e) => (e.payload as { text: string }).text)
      .at(-1);
  await until(() => reply()?.startsWith("smoke ok: history:") === true, 60_000);
  expect(reply()).toBe("smoke ok: history: remember delta | and epsilon | history?");
  await j.close();
});

test("a session a chat here already runs is not imported; an archived import does not come back", async () => {
  const repo = makeRepo(root, { "README.md": "r\n" });
  const p = await project(repo);
  claudeSession(repo, ["zeta"], 1);
  await client.call("project.import_chats", { request_id: "a1", project_id: p.id });
  const [chat] = await chats(p.id);
  await client.call("workspace.archive", { request_id: "a2", workspace_id: chat!.id });
  expect(await client.call("project.import_chats", { request_id: "a3", project_id: p.id })).toEqual(
    { imported: 0, already: 1, skipped: 0 },
  );

  // A plain folder's own chat runs Claude in the folder: its session is that chat's, not one to import.
  const folder = fs.mkdtempSync(path.join(root, "plain-"));
  const plain = await project(folder);
  const own = await createReady(client, {
    request_id: "a4",
    repo: { path: folder },
    engine: "claude-agent",
    task: { text: "hello" },
    options: { model: MODEL },
  });
  await until(
    async () => (await client.call("workspace.get", { workspace_id: own.id })).status === "idle",
    60_000,
  );
  expect(
    await client.call("project.import_chats", { request_id: "a5", project_id: plain.id }),
  ).toMatchObject({ imported: 0 });
  expect((await chats(plain.id)).map((w: Workspace) => w.id)).toEqual([own.id]);
});
