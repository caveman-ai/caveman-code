/**
 * Paid voice regression on a real Chief and provider, with no engine overrides.
 * CAVEMAN_LIVE_CHIEF=1 enables it; otherwise the suite skips without reading a key.
 * CAVEMAN_LIVE_CHIEF_KEY_FILE: file containing the provider API key (never printed).
 * CAVEMAN_LIVE_CHIEF_PROVIDER: key's provider, default anthropic.
 * CAVEMAN_LIVE_CHIEF_MODEL: full provider/model id, default anthropic/claude-sonnet-5-5.
 * CAVEMAN_LIVE_OUT: optional path for the JSON report, including failures.
 * Run from packages/runtime: npx vitest run src/chief/voice.live.test.ts
 */
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import { ProviderInstanceId } from "@caveman-app/protocol";
import {
  CAVEMAN_PROVIDER,
  CavemanAdapterV2Driver,
  makeCavemanAdapterV2,
  setCavemanKey,
} from "@caveman-app/provider-caveman/server";
import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import { describe, expect, test } from "vitest";

import * as ServerConfig from "../config.ts";
import { make as makeMemory, Memory } from "../memory/MemoryService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Store from "../session-protocol/store.ts";
import {
  makeConfig,
  makeRepo,
  startRuntime,
  tempRoot,
  until,
} from "../session-protocol/testHarness.ts";
import { textingProblems } from "./texting.ts";

const NOTES: ReadonlyArray<{ readonly text: string; readonly listAsked?: boolean }> = [
  { text: "What do you do when I hand you a mission?" },
  { text: "The login button on the web app is misaligned on mobile; fix it." },
  { text: "For the login button fix: also check the tablet breakpoint." },
  { text: "Someday: dark mode for the web app. Park it." },
  { text: "Queue this, don't start it: a changelog page for the docs." },
  { text: "Check the web app for new bugs every morning until Sunday." },
  { text: "Make the thing we talked about faster." },
  { text: "Use the other one instead." },
  { text: "Remember: I review every pull request myself before it merges." },
  { text: "What's running right now?" },
  { text: "Has anything finished yet?" },
  { text: "Give me a bullet list of the work waiting on me.", listAsked: true },
];

interface Result {
  readonly note: string;
  readonly listAsked: boolean;
  readonly replies: ReadonlyArray<{
    readonly text: string;
    readonly problems: ReturnType<typeof textingProblems>;
  }>;
  readonly status?: string;
  readonly error?: string;
}

describe.skipIf(process.env.CAVEMAN_LIVE_CHIEF !== "1")("Chief texting voice live", () => {
  test(
    "texts through twelve real notes without voice regressions",
    async () => {
      const provider = process.env.CAVEMAN_LIVE_CHIEF_PROVIDER ?? "anthropic";
      const model = process.env.CAVEMAN_LIVE_CHIEF_MODEL ?? "anthropic/claude-sonnet-5-5";
      const keyFile = process.env.CAVEMAN_LIVE_CHIEF_KEY_FILE;
      if (!keyFile) throw new Error("CAVEMAN_LIVE_CHIEF_KEY_FILE is required");
      const key = fs.readFileSync(keyFile, "utf8").trim();
      if (!key) throw new Error("CAVEMAN_LIVE_CHIEF_KEY_FILE is empty");
      // Error reports must not expose the key even if a provider includes it in an error.
      const safe = (value: unknown) => String(value).replaceAll(key, "[redacted]");
      const root = tempRoot("chief-voice-live-");
      const config = await makeConfig();
      const scope = await Effect.runPromise(Scope.make());
      const results: Array<Result> = [];
      let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
      let client: ReturnType<typeof connect> | undefined;
      let failure: string | undefined;
      try {
        const repo = makeRepo(root, {
          "README.md": "# shop-web\n\nThe shop's web app and docs. Login and cart pages.\n",
          "src/Login.tsx":
            "export const Login = () => <button style={{ width: 80 }}>Log in</button>;\n",
          "docs/setup.md": "# Setup\n\nInstall Node 24.\n",
        });
        const home = path.join(root, "home");
        fs.mkdirSync(home);
        // One host for the registry and route, alive until the runtime has closed.
        const host = Layer.succeedContext(
          await Effect.runPromise(
            Layer.buildWithScope(
              TestProviderHost.layer({ cwd: repo, attachmentsDir: config.attachmentsDir }).pipe(
                Layer.provide(NodeServices.layer),
              ),
              scope,
            ),
          ),
        );
        await Effect.runPromise(
          setCavemanKey(ProviderInstanceId.make("caveman"), provider, key).pipe(
            Effect.provide(host),
          ),
        );
        const driver: typeof CavemanAdapterV2Driver = {
          ...CavemanAdapterV2Driver,
          create: (input) =>
            makeCavemanAdapterV2({
              instanceId: input.instanceId,
              settings: { ...input.config, enabled: input.enabled },
            }).pipe(Effect.orDie),
        };
        const registry = ProviderAdapterRegistry.layerFromDrivers({
          drivers: [driver],
          configMap: {
            [ProviderInstanceId.make("caveman")]: { driver: CAVEMAN_PROVIDER, config: {} },
          },
        }).pipe(
          Layer.provide(Layer.mergeAll(host, IdAllocator.layer, NodeServices.layer)),
          Layer.orDie,
        );
        const memoryKey = randomBytes(32);
        const memory = Layer.effect(
          Memory,
          Effect.gen(function* () {
            const { stateDir } = yield* ServerConfig.ServerConfig;
            return yield* makeMemory({
              stateDir,
              copiesDir: path.join(root, "copies"),
              keyFor: () => Effect.succeed(memoryKey),
              claudeHome: path.join(home, ".claude"),
            });
          }),
        ).pipe(Layer.provide(Store.layer));
        runtime = await startRuntime(config, "fake-claude", undefined, {
          registry,
          provide: Layer.mergeAll(host, memory, Layer.succeed(HostProcess.HomeDirectory, home)),
        });
        const c = (client = connect(runtime.url, runtime.token));
        await c.call("settings.set", {
          request_id: randomUUID(),
          settings: { default_engine: "caveman", engines: { caveman: { model } } },
        });
        const project = await c.call("project.create", {
          request_id: randomUUID(),
          path: repo,
          name: "shop-web",
        });
        const { chief } = await c.call("chief.create", {
          request_id: randomUUID(),
          name: "Voice check",
          project_ids: [project.id],
        });
        // Explicitly pin the profile's model; a stored paid key alone does not enable Auto.
        // Ask-first exercises real tools and proposals without launching coding work for these fixtures.
        await c.call("chief.update", {
          request_id: randomUUID(),
          chief_id: chief.id,
          model: { engine: "caveman", model },
          autonomy: 1,
        });
        const view = await c.call("chief.get", { chief_id: chief.id });
        expect(view.availability, "Chief must have a usable provider and model").toBe("ready");
        const events: Array<SessionEvent> = [];
        await c.attach(view.workspace.session_id, 0, (event) => events.push(event));
        let lastEventAt = Date.now();
        let eventCount = events.length;
        const quiet = () =>
          until(() => {
            if (events.length !== eventCount) {
              eventCount = events.length;
              lastEventAt = Date.now();
            }
            const between =
              events.findLastIndex((e) => e.type === "turn.done") >=
              events.findLastIndex((e) => e.type === "turn.started");
            return between && Date.now() - lastEventAt >= 4_000;
          }, 180_000);

        for (const note of NOTES) {
          await quiet();
          const from = events.length;
          await c.call("chief.capture", {
            request_id: randomUUID(),
            chief_id: chief.id,
            project_id: project.id,
            text: note.text,
            mode: "decide",
          });
          let error: string | undefined;
          try {
            await until(() => {
              const window = events.slice(from);
              const heard = window.findIndex(
                (e) =>
                  e.type === "message.done" &&
                  e.payload.role === "user" &&
                  e.payload.text === note.text,
              );
              return heard >= 0 && window.some((e, i) => i > heard && e.type === "turn.done");
            }, 180_000);
            await quiet();
          } catch (cause) {
            error = safe(cause);
          }
          const window = events.slice(from);
          const terminal = window.findLast((e) => e.type === "turn.done");
          const replies = window.flatMap((e) =>
            e.type === "message.done" &&
            e.payload.role === "assistant" &&
            e.parent_item_id === undefined
              ? [
                  {
                    text: safe(e.payload.text),
                    problems: textingProblems(e.payload.text, {
                      listAsked: note.listAsked === true,
                    }).map((p) => ({ ...p, at: safe(p.at) })),
                  },
                ]
              : [],
          );
          const failedTurn = window.find(
            (e) => e.type === "turn.done" && e.payload.status !== "completed",
          );
          if (failedTurn?.type === "turn.done")
            error = safe(failedTurn.payload.error ?? `Chief turn ${failedTurn.payload.status}`);
          const result: Result = {
            note: note.text,
            listAsked: note.listAsked === true,
            replies,
            ...(terminal?.type === "turn.done" ? { status: terminal.payload.status } : {}),
            ...(error === undefined ? {} : { error }),
          };
          results.push(result);
          console.log(JSON.stringify(result));
          // A missing or failed turn cannot become a silent voice pass or contaminate the next note.
          if (error !== undefined) break;
        }
        const report = results.flatMap((result) => [
          ...(result.error === undefined ? [] : [`${result.note}\n  turn: ${result.error}`]),
          ...result.replies.flatMap((reply) =>
            reply.problems.map((p) => `${result.note}\n  ${p.rule}: ${p.at}`),
          ),
        ]);
        if (report.length > 0) throw new Error(`Chief texting problems:\n${report.join("\n")}`);
        expect(results).toHaveLength(NOTES.length);
        expect(
          results.some((result) => result.replies.some((reply) => reply.text.trim() !== "")),
          "The Chief must produce some real reply text",
        ).toBe(true);
      } catch (cause) {
        failure = safe(cause);
        // oxlint-disable-next-line eslint/preserve-caught-error -- Provider errors may contain the key; only a redacted cause may escape.
        throw new Error(failure, { cause: safe(cause) });
      } finally {
        try {
          if (process.env.CAVEMAN_LIVE_OUT)
            fs.writeFileSync(
              process.env.CAVEMAN_LIVE_OUT,
              `${JSON.stringify({ at: new Date().toISOString(), provider, model, n: results.length, notes: results, ...(failure === undefined ? {} : { error: failure }) }, null, 2)}\n`,
            );
        } finally {
          client?.close();
          try {
            await runtime?.close();
          } finally {
            await Effect.runPromise(Scope.close(scope, Exit.void));
            fs.rmSync(root, { recursive: true, force: true });
            fs.rmSync(config.baseDir, { recursive: true, force: true });
          }
        }
      }
    },
    20 * 60_000,
  );
});
