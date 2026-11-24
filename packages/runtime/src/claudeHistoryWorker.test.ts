// A further Claude login keeps its sessions in its own CLAUDE_CONFIG_DIR, which the Agent SDK in the runtime
// never reads: forking one of its chats goes through the history worker with that login's config dir.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { forkSession, getSubagentMessages } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, expect, test } from "vitest";

import { claudeHistoryWorkerEntry, forkSessionInConfigDir, otherClaudeConfigDir, subagentMessagesInConfigDir } from "./claudeHistoryWorker.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-history-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** A session the way the CLI keeps one: projects/<cwd as a name>/<id>.jsonl under the login's config dir. */
function session(configDir: string, cwd: string) {
  const id = randomUUID();
  const user = randomUUID();
  const answer = randomUUID();
  const dir = path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const base = { sessionId: id, cwd, timestamp: new Date().toISOString(), isSidechain: false, userType: "external", version: "2.1.111" };
  fs.writeFileSync(
    path.join(dir, `${id}.jsonl`),
    [
      { ...base, type: "user", uuid: user, parentUuid: null, message: { role: "user", content: "hi" } },
      { ...base, type: "assistant", uuid: answer, parentUuid: user, message: { id: "msg_1", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  return { id, answer, dir };
}

test("a further login's session forks in its own config dir; the runtime's SDK alone cannot find it", async () => {
  const configDir = path.join(root, "providers", "claudeAgent", "claudeAgent-account-1", "config");
  const cwd = path.join(root, "worktree");
  fs.mkdirSync(cwd, { recursive: true });
  const source = session(configDir, cwd);
  expect(claudeHistoryWorkerEntry()).toMatch(/claude-history-worker\.(mjs|ts)$/);

  await expect(forkSession(source.id, { dir: cwd })).rejects.toThrow(/not found/);
  const forked = await forkSessionInConfigDir(source.id, { dir: cwd, upToMessageId: source.answer }, configDir);
  expect(forked.sessionId).not.toBe(source.id);
  expect(fs.existsSync(path.join(source.dir, `${forked.sessionId}.jsonl`))).toBe(true);
  await expect(forkSessionInConfigDir(randomUUID(), { dir: cwd }, configDir)).rejects.toThrow(/not found/);
});

test("a further login's native subagent transcript is read in its own config dir", async () => {
  const configDir = path.join(root, "providers", "claudeAgent", "claudeAgent-account-2", "config");
  const cwd = path.join(root, "worktree-sub");
  fs.mkdirSync(cwd, { recursive: true });
  const source = session(configDir, cwd);
  const agentId = "a1b2c3";
  fs.mkdirSync(path.join(source.dir, source.id, "subagents"), { recursive: true });
  fs.writeFileSync(
    path.join(source.dir, source.id, "subagents", `agent-${agentId}.jsonl`),
    JSON.stringify({ type: "user", uuid: randomUUID(), parentUuid: null, sessionId: source.id, cwd, timestamp: new Date().toISOString(), isSidechain: true, agentId, userType: "external", version: "2.1.111", message: { role: "user", content: "the subagent's task" } }) + "\n",
  );
  const here = await getSubagentMessages(source.id, agentId, { dir: cwd, limit: 1 }).catch(() => []);
  expect(here).toEqual([]);
  const there = await subagentMessagesInConfigDir(source.id, agentId, { dir: cwd, limit: 1 }, configDir);
  expect(there.map((message) => message.message)).toEqual([{ role: "user", content: "the subagent's task" }]);
});

test("only a config dir other than the runtime's own goes through the worker", () => {
  const env = { CLAUDE_CONFIG_DIR: path.join(root, "own") };
  expect(otherClaudeConfigDir(undefined, root, env)).toBeUndefined();
  expect(otherClaudeConfigDir("  ", root, env)).toBeUndefined();
  expect(otherClaudeConfigDir(path.join(root, "own"), root, env)).toBeUndefined();
  expect(otherClaudeConfigDir("own", root, env)).toBeUndefined();
  expect(otherClaudeConfigDir(path.join(root, "other"), root, env)).toBe(path.join(root, "other"));
  expect(otherClaudeConfigDir(path.join(os.homedir(), ".claude"), root, {})).toBeUndefined();
});
