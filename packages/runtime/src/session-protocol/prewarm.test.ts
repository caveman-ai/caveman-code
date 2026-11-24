// A worktree the New chat page made ahead (workspace.prewarm) is the next chat's, or it goes: a start that took it and
// was then refused leaves no worktree or branch of it in the person's repository, even when a quit cuts its removal
// short. Runtime code starts these chats (a Chief's chat_start with the person's quotes), so the route's handlers are
// reached as that code reaches them.
import * as fs from "node:fs";
import * as path from "node:path";

import { connect } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, expect, test } from "vitest";

import { layer as layerGrill } from "./grill.ts";
import { type Handlers, makeHandlers } from "./handlers.ts";
import * as Mailbox from "./mailbox.ts";
import * as Store from "./store.ts";
import {
  createReady,
  git,
  makeConfig,
  makeRepo,
  MODEL,
  startRuntime,
  tempRoot,
  until,
} from "./testHarness.ts";

let root: string;
let config: Awaited<ReturnType<typeof makeConfig>>;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
let handlers!: Handlers;

/** The runtime on `config`'s state, and the handlers runtime code reaches. */
const boot = async () => {
  const handlersLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      handlers = yield* makeHandlers;
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(Mailbox.layerLocal, layerGrill).pipe(Layer.provideMerge(Store.layer)),
    ),
  ) as Layer.Layer<any, never, any>;
  runtime = await startRuntime(config, "fake-claude", undefined, { provide: handlersLayer });
  client = connect(runtime.url, runtime.token);
};

beforeAll(async () => {
  root = tempRoot("sp-prewarm-");
  config = await makeConfig();
  await boot();
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const worktreesOf = (repo: string) =>
  // Native paths: git lists worktrees with forward slashes on Windows.
  git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .flatMap((l) => (l.startsWith("worktree ") ? [path.resolve(l.slice("worktree ".length))] : []));

/** The spare workspace.prewarm makes for `repo`, once git lists it, and its branch's name. */
const prewarmed = async (repo: string) => {
  const before = worktreesOf(repo);
  await Effect.runPromise(
    handlers.handlers["workspace.prewarm"](
      { request_id: `pw-${path.basename(repo)}`, repo: { path: repo } },
      { connectionId: "test" },
    ),
  );
  await until(() => worktreesOf(repo).length === before.length + 1);
  const spare = worktreesOf(repo).find((w) => !before.includes(w))!;
  await until(() => git(repo, "branch", "--list", "caveman/chat-*").trim() !== "");
  return {
    spare,
    branch: git(repo, "branch", "--list", "caveman/chat-*")
      .replace(/^[*+ ]+/, "")
      .trim(),
  };
};

/** A chat in `repo` whose agent starts another for the person. */
const leadIn = async (repo: string) => {
  const lead = await createReady(client, {
    request_id: `lead-${path.basename(repo)}`,
    repo: { path: repo },
    engine: "claude-agent",
    options: { model: MODEL },
  });
  return Effect.runPromise(handlers.recordByWorkspace(lead.id));
};

/** The lead's start for the person, quoting words they never typed in its chat: refused once it took the spare. */
const refusedStart = (repo: string, lead: Awaited<ReturnType<typeof leadIn>>) =>
  Effect.runPromise(
    handlers
      .createWorkspace({
        request_id: `start-${path.basename(repo)}`,
        repo: { path: repo },
        engine: "claude-agent",
        options: { model: MODEL },
        task: { text: "rename the helper" },
        from: { record: lead, quotes: ["words nobody ever typed in that chat"] },
      })
      .pipe(Effect.flip),
  );

const leftOf = (repo: string, spare: { readonly spare: string; readonly branch: string }) => ({
  worktreeLeft: worktreesOf(repo).includes(spare.spare),
  branchLeft: git(repo, "branch", "--list", spare.branch).trim() !== "",
});

test("a start refused after it took the spare worktree leaves neither it nor its branch in the repository", async () => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const lead = await leadIn(repo);
  const spare = await prewarmed(repo);
  expect((await refusedStart(repo, lead)).reason).toBe("invalid_params");
  await until(
    () => !leftOf(repo, spare).worktreeLeft && !leftOf(repo, spare).branchLeft,
    10_000,
  ).catch(() => undefined);
  expect(leftOf(repo, spare)).toEqual({ worktreeLeft: false, branchLeft: false });
}, 120_000);

test("a spare whose removal a quit cut short is gone once the app is back", async () => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const lead = await leadIn(repo);
  // git worktree add runs post-checkout: a slow one keeps the spare being made, so its removal waits for it.
  fs.writeFileSync(path.join(repo, ".git", "hooks", "post-checkout"), "#!/bin/sh\nsleep 5\n", {
    mode: 0o755,
  });
  const spare = await prewarmed(repo);
  expect((await refusedStart(repo, lead)).reason).toBe("invalid_params");
  // The app quits while the spare is still being made, so before its removal could run.
  client.close();
  await runtime.close();
  await boot();
  await until(
    () => !leftOf(repo, spare).worktreeLeft && !leftOf(repo, spare).branchLeft,
    10_000,
  ).catch(() => undefined);
  expect(leftOf(repo, spare)).toEqual({ worktreeLeft: false, branchLeft: false });
}, 120_000);
