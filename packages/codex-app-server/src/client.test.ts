// ), packages/effect-codex-app-server/src/client.test.ts @ ab3a3cd1.
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";

import * as CodexClient from "./client.ts";
import * as CodexError from "./errors.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";

const mockPeerPath = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(import.meta.dirname, "../test/fixtures/codex-app-server-mock-peer.ts"),
);
const mockPeerArgs = (path: string) => [path];

it.layer(NodeServices.layer)("@caveman-app/codex-app-server client", (it) => {
  const makeHandle = (env?: Record<string, string>) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const peerCwd = path.join(import.meta.dirname, "..");
      const command = ChildProcess.make(process.execPath, mockPeerArgs(yield* mockPeerPath), {
        cwd: peerCwd,
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
      return yield* spawner.spawn(command);
    });

  it.effect("initializes, handles typed server requests, and reads account and skills data", () =>
    Effect.gen(function* () {
      const userInputRequests = yield* Ref.make<Array<unknown>>([]);
      const messageDeltas = yield* Ref.make<Array<unknown>>([]);
      const handle = yield* makeHandle();
      const scope = yield* Scope.make();
      const layerClient = CodexClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(layerClient, scope);

      const result = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;

        yield* client.handleServerRequest("item/tool/requestUserInput", (payload) =>
          Ref.update(userInputRequests, (current) => [...current, payload]).pipe(
            Effect.as({
              answers: {
                approved: {
                  answers: ["yes"],
                },
              },
            }),
          ),
        );

        yield* client.handleServerNotification("item/agentMessage/delta", (payload) =>
          Ref.update(messageDeltas, (current) => [...current, payload]),
        );

        const initialized = yield* client.request("initialize", {
          clientInfo: {
            name: "@caveman-app/codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        });
        assert.equal(initialized.userAgent, "mock-codex-app-server");

        yield* client.notify("initialized", undefined);

        const account = yield* client.request("account/read", {});
        assert.equal(account.requiresOpenaiAuth, false);
        assert.deepEqual(account.account, {
          type: "chatgpt",
          email: "mock@example.com",
          planType: "plus",
        });

        const path = yield* Path.Path;
        const peerCwd = path.join(import.meta.dirname, "..");
        const skills = yield* client.request("skills/list", { cwds: [peerCwd] });
        assert.equal(skills.data.length, 1);
        assert.equal(skills.data[0]?.cwd, peerCwd);

        return {
          account,
          skills,
        };
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

      assert.equal(result.skills.data[0]?.skills.length, 0);
      assert.deepEqual(yield* Ref.get(userInputRequests), [
        {
          isBlocking: true,
          itemId: "item-approval-1",
          threadId: "thread-1",
          turnId: "turn-1",
          questions: [
            {
              id: "approved",
              header: "Approve",
              question: "Continue with the mock skills request?",
              options: [
                {
                  label: "yes",
                  description: "Approve the request",
                },
              ],
            },
          ],
        },
      ]);
      assert.deepEqual(yield* Ref.get(messageDeltas), [
        {
          delta: "Mock server is ready.",
          itemId: "item-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      ]);
    }),
  );
  it.effect("drains child stderr so large diagnostics cannot block protocol responses", () =>
    Effect.gen(function* () {
      const handle = yield* makeHandle({
        CODEX_APP_SERVER_TEST_STDERR_BYTES: String(512 * 1024),
      });
      const scope = yield* Scope.make();
      const layerClient = CodexClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(layerClient, scope);

      const initialized = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;
        return yield* client.request("initialize", {
          clientInfo: {
            name: "@caveman-app/codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        });
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.provide(context),
        Effect.ensuring(Scope.close(scope, Exit.void)),
      );

      assert.equal(initialized.userAgent, "mock-codex-app-server");
    }),
  );

  it.effect("names the child's stderr when it exits before answering", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // What a broken npm `codex` wrapper does: one Node error on stderr, exit 1.
      const handle = yield* spawner.spawn(
        ChildProcess.make(process.execPath, [
          "-e",
          ("process.stderr.write('x'.repeat(5000) + '\\n\\x1b[31mError\\x1b[0m: spawn /opt/homebrew/lib/codex ENOENT\\nauth sk-" + "proj-FAKEKEY_0123456789\\n'); process.exit(1)"),
        ]),
      );
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(CodexClient.layerChildProcess(handle), scope);

      const error = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;
        return yield* client.request("initialize", {
          clientInfo: { name: "test", title: "test", version: "0.0.0" },
          capabilities: { experimentalApi: true, optOutNotificationMethods: null },
        });
      }).pipe(
        Effect.flip,
        Effect.timeout("5 seconds"),
        Effect.provide(context),
        Effect.ensuring(Scope.close(scope, Exit.void)),
      );

      assert.equal(error._tag, "CodexAppServerProcessExitedError");
      assert.include(error.message, "exited with code 1: ");
      assert.include(error.message, "Error: spawn /opt/homebrew/lib/codex ENOENT\nauth [api key]");
      // Colours stripped, and the cut line (where a half key could sit) dropped.
      assert.notInclude(error.message, "\x1b");
      assert.notInclude(error.message, "xxx");
      assert.notInclude(error.message, "FAKEKEY");
      assert.isBelow(error.message.length, 2_100);
    }),
  );

  it.effect("warns once about a notification that fails to decode and keeps dispatching", () =>
    Effect.gen(function* () {
      const secret = "codex-notification-secret-sentinel";
      const { stdio, input } = yield* makeInMemoryStdio();
      const warnings: Array<unknown> = [];
      const client = yield* CodexClient.make(stdio).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make(({ logLevel, fiber }) => {
              if (logLevel === "Warn")
                warnings.push(fiber.getRef(References.CurrentLogAnnotations));
            }),
          ]),
        ),
      );
      const delivered = yield* Deferred.make<unknown>();
      yield* client.handleServerNotification("item/agentMessage/delta", (payload) =>
        Deferred.succeed(delivered, payload).pipe(Effect.asVoid),
      );

      const send = (params: unknown) =>
        Queue.offer(
          input,
          new TextEncoder().encode(
            `${JSON.stringify({ method: "item/agentMessage/delta", params })}\n`,
          ),
        );
      const malformed = { itemId: "item-1", threadId: "thread-1", turnId: secret };
      yield* send(malformed);
      yield* send(malformed);
      yield* send({ delta: "ok", itemId: "item-1", threadId: "thread-1", turnId: "turn-1" });

      assert.deepEqual(yield* Deferred.await(delivered), {
        delta: "ok",
        itemId: "item-1",
        threadId: "thread-1",
        turnId: "turn-1",
      });
      assert.lengthOf(warnings, 1);
      expect(warnings[0]).toMatchObject({
        operation: "decode-notification-payload",
        method: "item/agentMessage/delta",
        issueKinds: expect.arrayContaining(["MissingKey"]),
      });
      assert.notInclude(JSON.stringify(warnings), secret);
    }),
  );
});

const encoder = new TextEncoder();
const jsonLine = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`);
const turnCompleted = (id: string, status: string) => ({
  method: "turn/completed",
  params: { threadId: "thread-1", turn: { id, items: [], status } },
});

it.layer(NodeServices.layer)("@caveman-app/codex-app-server client notifications", (it) => {
  // A newer Codex can send a value this schema does not know yet.
  it.effect(
    "warns once about a notification it cannot decode and delivers the ones after it",
    () => {
      const secret = "codex-notification-secret-sentinel";
      const warnings: Array<Record<string, unknown>> = [];
      return Effect.gen(function* () {
        const { stdio, input } = yield* makeInMemoryStdio();
        const client = yield* CodexClient.make(stdio);
        const delivered: Array<string> = [];
        const last = yield* Deferred.make<void>();
        yield* client.handleServerNotification("turn/completed", (payload) =>
          Effect.gen(function* () {
            delivered.push(payload.turn.id);
            if (payload.turn.id === "turn-3") yield* Deferred.succeed(last, undefined);
          }),
        );

        yield* Queue.offer(input, jsonLine(turnCompleted("turn-1", secret)));
        yield* Queue.offer(input, jsonLine(turnCompleted("turn-2", secret)));
        yield* Queue.offer(input, jsonLine(turnCompleted("turn-3", "completed")));
        yield* Deferred.await(last);

        assert.deepEqual(delivered, ["turn-3"]);
        assert.lengthOf(warnings, 1);
        assert.include(warnings[0], {
          method: "turn/completed",
          operation: "decode-notification-payload",
        });
        assert.notInclude(JSON.stringify(warnings), secret);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Logger.layer([
            Logger.make(({ logLevel, fiber }) => {
              if (logLevel === "Warn")
                warnings.push(fiber.getRef(References.CurrentLogAnnotations));
            }),
          ]),
        ),
      );
    },
  );

  for (const failure of ["typed", "defect", "throw"] as const)
    it.effect(`keeps handlers and RPC replies flowing after a notification ${failure}`, () => {
      const warnings: Array<Record<string, unknown>> = [];
      return Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const client = yield* CodexClient.make(stdio);
        const second: Array<string> = [];
        const last = yield* Deferred.make<void>();
        yield* client.handleServerNotification("turn/completed", (payload) => {
          if (payload.turn.id !== "turn-1") return Effect.void;
          if (failure === "throw") throw new Error("notification callback threw");
          return failure === "defect"
            ? Effect.die(new Error("notification callback defect"))
            : Effect.fail(CodexError.CodexAppServerRequestError.methodNotFound("turn/completed"));
        });
        yield* client.handleServerNotification("turn/completed", (payload) =>
          Effect.gen(function* () {
            second.push(payload.turn.id);
            if (payload.turn.id === "turn-2") yield* Deferred.succeed(last, undefined);
          }),
        );

        yield* Queue.offer(input, jsonLine(turnCompleted("turn-1", "completed")));
        yield* Queue.offer(input, jsonLine(turnCompleted("turn-2", "completed")));
        yield* Deferred.await(last);
        // Another chat's control request still receives its reply on the same input reader.
        const pending = yield* client
          .request("turn/interrupt", { threadId: "another-chat", turnId: "turn-3" })
          .pipe(Effect.forkScoped);
        const request = JSON.parse(yield* Queue.take(output)) as { id: number };
        yield* Queue.offer(input, jsonLine({ id: request.id, result: {} }));
        assert.deepEqual(yield* Fiber.join(pending), {});

        assert.deepEqual(second, ["turn-1", "turn-2"]);
        assert.lengthOf(warnings, 1);
        assert.include(warnings[0], { method: "turn/completed" });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Logger.layer([
            Logger.make(({ logLevel, fiber }) => {
              if (logLevel === "Warn")
                warnings.push(fiber.getRef(References.CurrentLogAnnotations));
            }),
          ]),
        ),
      );
    });
});
