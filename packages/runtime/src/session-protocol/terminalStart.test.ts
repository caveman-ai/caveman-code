// A terminal whose shell cannot start: the machine has no PTY left, or node-pty cannot spawn any shell. upstream
// TerminalManager does not fail open() then: it answers with a session in "error" and publishes an "error" event. The
// person must still hear why, as the terminal tab's "The terminal didn't start", and no run is left showing as running.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { connect } from "@caveman-app/session-protocol";
import * as PtyAdapter from "@caveman-app/shared/PtyAdapter";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, expect, test } from "vitest";

import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { createReady, makeConfig, makeRepo, MODEL, startRuntime, tempRoot } from "./testHarness.ts";

const spawned: Array<string> = [];
/** A PTY backend that can start no shell, as node-pty fails when the machine is out of PTYs. */
const noPty = {
  spawn: (input) =>
    Effect.sync(() => void spawned.push(input.shell)).pipe(
      Effect.andThen(
        Effect.fail(
          new PtyAdapter.PtySpawnError({
            adapter: "node-pty",
            shell: input.shell,
            cause: new Error("forkpty(3) failed."),
          }),
        ),
      ),
    ),
} as PtyAdapter.PtyAdapter["Service"];

const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-terminal-start-logs-"));
/** The real manager, on that backend. */
const layerTerminal = Layer.effect(
  TerminalManager.TerminalManager,
  TerminalManager.makeWithOptions({
    logsDir,
    ptyAdapter: noPty,
    shellResolver: () => "/bin/sh",
    processKillGraceMs: 1,
  }),
).pipe(
  Layer.provide(ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
  Layer.provide(NodeServices.layer),
);

const root = tempRoot("sp-terminal-start-");
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;

beforeAll(async () => {
  runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, {
    provide: layerTerminal as Layer.Layer<any, never, any>,
  });
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(logsDir, { recursive: true, force: true });
});

const refusal = (call: Promise<unknown>) =>
  call.then(
    () => undefined,
    (error: { error?: { message: string; data?: { reason?: string } } }) => ({
      reason: error.error?.data?.reason ?? String(error),
      message: error.error?.message ?? "",
    }),
  );

test("a terminal whose shell cannot start fails term.open with why, and term.list never shows it running", async () => {
  const repo = makeRepo(root, { "README.md": "no pty\n" });
  const w = await createReady(client, {
    request_id: "ts-w",
    repo: { path: repo },
    engine: "claude-agent",
    options: { model: MODEL },
  });

  // The Run button's command, and a plain shell.
  const run = await refusal(
    client.call("term.open", {
      request_id: "ts-run",
      workspace_id: w.id,
      cols: 80,
      rows: 24,
      command: "make test",
    }),
  );
  const shell = await refusal(
    client.call("term.open", { request_id: "ts-shell", workspace_id: w.id, cols: 80, rows: 24 }),
  );
  // A directory that is not there fails open() itself, before any spawn.
  const nowhere = await refusal(
    client.call("term.open", {
      request_id: "ts-nowhere",
      workspace_id: w.id,
      cols: 80,
      rows: 24,
      cwd: "nowhere",
    }),
  );
  expect(spawned.length).toBeGreaterThan(0);
  expect({ run, shell, nowhere: nowhere?.reason }).toEqual({
    run: {
      reason: "invalid_state",
      message: expect.stringContaining("Failed to spawn PTY process"),
    },
    shell: {
      reason: "invalid_state",
      message: expect.stringContaining("Failed to spawn PTY process"),
    },
    nowhere: "invalid_state",
  });
  expect((await client.call("term.list", { workspace_id: w.id })).terminals).toEqual([]);
}, 60_000);
