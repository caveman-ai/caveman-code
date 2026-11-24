// Real stack (moves.e2e.kit.ts): Settings › Computers deletes a Cloud computer through This Mac's runtime
// (cloud.computer.delete, Cloud's AsEnroller route). Cloud marks it deleted, archives the chat on it and the person's
// kept computers go down by one, so a limit refusal's "delete one" has a way through (audit C3).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { afterAll, beforeAll, expect, test } from "vitest";

import { git, tempRoot, until } from "../session-protocol/testHarness.ts";
import { labFunding, MODEL, person, proxy, REAL_STACK, retireLabComputers, runtime, sql, stopAll, waitReply, type Person } from "./moves.e2e.kit.ts";

afterAll(stopAll);
let me: Person;
let gitEnv: Record<string, string>;
beforeAll(async () => {
  if (!REAL_STACK) return;
  me = await person();
  retireLabComputers(me);
  labFunding(me);
  const root = tempRoot("delete-e2e-");
  const name = `delete-${randomUUID().slice(0, 8)}`;
  const bare = path.join(root, `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  gitEnv = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.file://${bare}.insteadOf`, GIT_CONFIG_VALUE_0: `https://github.com/octocat/${name}` };
  Object.assign(process.env, gitEnv);
  const seed = path.join(root, "seed");
  execFileSync("git", ["clone", "-q", gitEnv.GIT_CONFIG_VALUE_0!, seed]);
  fs.writeFileSync(path.join(seed, "README.md"), "delete\n");
  git(seed, "add", ".");
  git(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
}, 120_000);

test.skipIf(!REAL_STACK)("Settings deletes a Cloud computer: Cloud archives the chat on it and the person keeps one computer fewer (C3)", async () => {
  const net = await proxy();
  const repo = path.join(tempRoot("delete-mac-"), "repo");
  execFileSync("git", ["clone", "-q", gitEnv.GIT_CONFIG_VALUE_0!, repo]);
  const mac = await runtime("mac", { ...gitEnv, MOVES_CLOUD_URL: net.url, MOVES_BEARER: me.access_token });
  await mac.client.call("settings.set", { request_id: "moves-on", settings: { sync_chats: true, move_to_cloud: true } });
  const macComputer = (await mac.client.call("cloud.status", {})).computer_id!;
  const w = await mac.client.call("workspace.create", { request_id: "w1", repo: { path: repo }, title: "Delete me", engine: "caveman", options: { model: MODEL, access: "auto" }, task: { text: "ask d1" } });
  await waitReply(mac, w.session_id, /ask d1 \(on mac\)$/);
  await until(() => sql(`SELECT follow FROM code_sessions WHERE id = '${w.session_id}'`) === "t" && Number(sql(`SELECT cursor_seq FROM code_journal_index WHERE session_id = '${w.session_id}'`) || 0) > 0, 60_000);
  // Moved to Cloud: Cloud makes a Cloud computer for it.
  await mac.client.call("session.move", { request_id: "to-cloud", session_id: w.session_id, to: "cloud" });
  let computer = "";
  await until(() => ((computer = sql(`SELECT w.computer_id FROM code_sessions s JOIN code_workspaces w ON w.id = s.workspace_id WHERE s.id = '${w.session_id}'`)), computer !== "" && computer !== macComputer), 120_000);
  const kept = () => Number(sql(`SELECT count(*) FROM code_computers WHERE created_by = '${me.user.id}' AND driver = 'kubernetes' AND desired_state <> 'deleted'`));
  const before = kept();
  const row = await mac.client.call("cloud.computer.delete", { request_id: "del-1", computer_id: computer });
  expect(row).toMatchObject({ id: computer, desired_state: "deleted" });
  expect(sql(`SELECT desired_state FROM code_computers WHERE id = '${computer}'`)).toBe("deleted");
  expect(sql(`SELECT w.status FROM code_sessions s JOIN code_workspaces w ON w.id = s.workspace_id WHERE s.id = '${w.session_id}'`)).toBe("archived");
  expect(kept()).toBe(before - 1);
  // Listed as deleted (or gone) in Settings › Computers' own read.
  const listed = (await mac.client.call("cloud.computers", {})).computers.find((c) => c.id === computer);
  expect(listed === undefined || listed.desired_state === "deleted").toBe(true);
  // The move onto it was still open (no runtime there ever took the chat): once its adopt is overdue, Cloud fails it and
  // hands the archived chat nowhere: no new Cloud computer made for it, no move back to the Mac (S2 verifier, bug 1).
  const moves = () => sql(`SELECT count(*) FROM code_session_moves WHERE session_id = '${w.session_id}'`);
  const movesAtDelete = moves();
  const computersAtDelete = sql(`SELECT count(*) FROM code_computers WHERE created_by = '${me.user.id}'`);
  await until(() => sql(`SELECT count(*) FROM code_session_moves WHERE session_id = '${w.session_id}' AND state IN ('offered','accepted','handed')`) === "0", 240_000);
  await new Promise((r) => setTimeout(r, 30_000));
  expect(moves()).toBe(movesAtDelete);
  expect(sql(`SELECT count(*) FROM code_computers WHERE created_by = '${me.user.id}'`)).toBe(computersAtDelete);
  expect(sql(`SELECT w.computer_id FROM code_sessions s JOIN code_workspaces w ON w.id = s.workspace_id WHERE s.id = '${w.session_id}'`)).toBe(computer);
  expect(sql(`SELECT w.status FROM code_sessions s JOIN code_workspaces w ON w.id = s.workspace_id WHERE s.id = '${w.session_id}'`)).toBe("archived");
  expect(sql(`SELECT state FROM code_session_moves WHERE session_id = '${w.session_id}' ORDER BY created_at DESC LIMIT 1`)).toBe("failed");
}, 600_000);
