import * as fs from "node:fs";
import * as path from "node:path";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";

import { createReady, loadTranscript, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

test("git.status over the Session Protocol returns literal tracked and untracked filenames", async () => {
  const root = tempRoot("sp-diff-paths-");
  const tracked = process.platform === "win32" ? "café tracked.txt" : "café\ttracked.txt";
  const untracked = process.platform === "win32" ? "new file.txt" : "new\nfile.txt";
  const repo = makeRepo(root, { [tracked]: "before\n" });
  const runtime = await startRuntime(await makeConfig(), await loadTranscript());
  const client = connect(runtime.url, runtime.token);
  try {
    const workspace = await createReady(client, {
      request_id: "diff-paths", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL },
    });
    fs.writeFileSync(path.join(workspace.root_path!, tracked), "after\nsecond\n");
    fs.writeFileSync(path.join(workspace.root_path!, untracked), "new\n");
    const status = await client.call("git.status", { workspace_id: workspace.id });
    expect(status.files).toEqual(expect.arrayContaining([
      { path: tracked, status: "modified", additions: 2, deletions: 1 },
      { path: untracked, status: "added", additions: 1, deletions: 0 },
    ]));
  } finally {
    client.close();
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A worktree's symlinked folder (`ln -s src lib`, a linked node_modules a `node_modules/` ignore does not match) is
// what git lists as an untracked file: its chat gets its diff, and every other chat keeps getting its events.
test.skipIf(process.platform === "win32")("one chat's symlinked folder stops no chat's events", async () => {
  const root = tempRoot("sp-diff-link-");
  const runtime = await startRuntime(await makeConfig(), "fake-claude");
  const client = connect(runtime.url, runtime.token);
  try {
    const chat = async (title: string) => {
      const w = await createReady(client, { request_id: title, repo: { path: makeRepo(root, { "src/a.ts": "export const a = 1;\n" }) }, title, engine: "claude-agent", options: { model: MODEL } });
      const events: Array<SessionEvent> = [];
      await client.attach(w.session_id, 0, (e) => events.push(e));
      return { w, events };
    };
    const linked = await chat("linked");
    fs.symlinkSync("src", path.join(linked.w.root_path!, "lib"));
    await client.call("turn.submit", { request_id: "linked-1", session_id: linked.w.session_id, kind: "followup", input: { text: "hello" } });
    await until(() => linked.events.some((e) => e.type === "diff.changed"), 30_000);
    expect(linked.events.findLast((e) => e.type === "diff.changed")?.payload).toEqual({ files: [{ path: "lib", status: "added", additions: 1, deletions: 0 }] });

    const other = await chat("other");
    await client.call("turn.submit", { request_id: "other-1", session_id: other.w.session_id, kind: "followup", input: { text: "hello" } });
    await until(() => other.events.some((e) => e.type === "turn.done"), 30_000);
    expect((await client.call("git.status", { workspace_id: linked.w.id })).files).toEqual([{ path: "lib", status: "added", additions: 1, deletions: 0 }]);
  } finally {
    client.close();
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
