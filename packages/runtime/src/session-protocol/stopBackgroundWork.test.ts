// A chat whose turn ended while a shell it started in the background still runs (a dev server, a watch loop), as a
// Claude Agent chat left one after opening its PR: the next message is taken, and Stop ends the shell. Stop used to
// look only for a running turn or delegated agents, find neither, and do nothing, so the shell ran on. (Its messages
// failed because the workspace's launch config drifted meanwhile; ClaudeAdapterV2.test.ts covers that drift.)
import * as fs from "node:fs";
import * as path from "node:path";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import { afterAll, beforeAll, expect, test } from "vitest";

import {
  createReady,
  makeConfig,
  makeRepo,
  MODEL,
  startRuntime,
  tempRoot,
  until,
} from "./testHarness.ts";

let root: string;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;

beforeAll(async () => {
  root = tempRoot("sp-stop-background-");
  runtime = await startRuntime(await makeConfig(), "fake-claude");
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a finished turn's background shell takes the next message, and Stop ends it", async () => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const w = await createReady(client, {
    request_id: "w",
    repo: { path: repo },
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  const answered = (text: string) =>
    until(
      () =>
        events.some(
          (e) =>
            e.type === "message.done" &&
            e.payload.role === "assistant" &&
            e.payload.text.includes(text),
        ),
      60_000,
    );
  const pidFile = path.join(root, "bg.pid");

  // The turn ends; the shell it started in the background does not.
  await client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: `bg: ${pidFile}` },
  });
  await until(
    () => events.filter((e) => e.type === "turn.done").length === 1 && fs.existsSync(pidFile),
    60_000,
  );
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  expect(alive(pid)).toBe(true);

  // A plain message runs on the live process, and the shell keeps running.
  const sent = await client.call("turn.submit", {
    request_id: "t2",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "after the shell" },
  });
  expect(sent).toMatchObject({ disposition: "started" });
  await answered("after the shell");
  await until(
    () => events.some((e) => e.type === "turn.done" && e.turn_id === sent.turn_id),
    30_000,
  );
  expect(
    events.find((e) => e.type === "turn.done" && e.turn_id === sent.turn_id)?.payload,
  ).toMatchObject({ status: "completed" });
  expect(alive(pid)).toBe(true);

  // No turn runs now. Stop still ends the shell.
  await client.call("turn.interrupt", { request_id: "stop", session_id: w.session_id });
  await until(() => !alive(pid), 15_000);

  // And the chat goes on.
  await client.call("turn.submit", {
    request_id: "t3",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "after the stop" },
  });
  await answered("after the stop");
}, 180_000);
