// What the every-system tests share (everySystem.*.integration.test.ts): the same real runtime started as This Mac and
// as a Cloud computer whose person's credentials stay outside it (credentialRule.ts), so one case runs in both places
// and the difference can be read off. The Cloud is the stand-in (testCloud.ts) behind the one that plays the rule, the
// data plane and the connector proxy in a process of its own (testCloudEngine.ts); the engines are the stand-in CLI
// (scripts/smoke-claude.mjs), which also answers as Codex and as the Caveman engine. No model, GitHub or provider is
// ever called. Each helper leaves what it started in `cleanups`, which the test runs in reverse when it ends.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { connect, type SessionEvent, type Workspace } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import {
  makeConfig,
  makeRepo,
  startRuntime,
  tempRoot,
  until,
} from "../session-protocol/testHarness.ts";
import { forgetComputerCredits } from "./computerCredits.ts";
import { CloudValues, layerBroker } from "./computerSecrets.ts";
import { enroll } from "./identity.ts";
import { CloudComputer, CloudLinkState, type LinkState } from "./index.ts";
import { startTestCloud } from "./testCloud.ts";
import {
  startEngineCloud,
  type EngineCloudConfig,
  type EngineConnection,
} from "./testCloudEngine.ts";

type Client = ReturnType<typeof connect>;
type AlsoAs = ReadonlyArray<"caveman" | "codex">;

/** A person's connections as Cloud lists them: a plan for each of the two CLIs and a key for each provider. */
export const CLAUDE_PLAN: EngineConnection = {
  id: "conn-claude-plan",
  kind: "claude_plan",
  provider: "anthropic",
  label: "Claude Max",
  position: 0,
  status: "ready",
  serves: ["claude-agent"],
};
export const CHATGPT_PLAN: EngineConnection = {
  id: "conn-chatgpt-plan",
  kind: "chatgpt_plan",
  provider: "openai",
  label: "ChatGPT Pro",
  position: 1,
  status: "ready",
  serves: ["codex"],
};
export const ANTHROPIC_KEY: EngineConnection = {
  id: "conn-anthropic-key",
  kind: "api_key",
  provider: "anthropic",
  label: "Anthropic",
  position: 2,
  status: "ready",
  serves: ["claude-agent", "caveman"],
};
export const OPENAI_KEY: EngineConnection = {
  id: "conn-openai-key",
  kind: "api_key",
  provider: "openai",
  label: "OpenAI",
  position: 3,
  status: "ready",
  serves: ["codex", "caveman"],
};

/** A refused call as `reason: message`, or "ok". */
export const refusalOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { error?: { message?: string; data?: { reason?: string } } }) =>
      `${error.error?.data?.reason}: ${error.error?.message}`,
  );

/** A chat's events as they arrive, and what a person reads of them. `again` names a second watch of one chat, whose messages are new ones. */
export async function watch(client: Client, workspace: Pick<Workspace, "session_id">, again = "") {
  const events: Array<SessionEvent> = [];
  await client.attach(workspace.session_id, 0, (event) => events.push(event));
  let n = 0;
  const done = () => events.filter((event) => event.type === "turn.done").length;
  return {
    events,
    /** One message, and its turn's end. */
    turn: async (text: string, options?: { readonly model?: string }) => {
      const before = done();
      await client.call("turn.submit", {
        request_id: `turn-${again}${workspace.session_id}-${++n}`,
        session_id: workspace.session_id,
        kind: "followup",
        input: { text },
        ...(options ? { options } : {}),
      });
      await until(() => done() > before, 60_000);
    },
    said: () =>
      events.flatMap((event) =>
        event.type === "message.done" && event.payload.role === "assistant"
          ? [event.payload.text]
          : [],
      ),
    notes: () =>
      events.flatMap((event) =>
        event.type === "notification"
          ? [
              {
                level: event.payload.level,
                title: event.payload.title,
                ...(event.payload.body === undefined ? {} : { body: event.payload.body }),
              },
            ]
          : [],
      ),
    /** Everything the chat shows a person, as text: no amount of money may be in it. */
    shown: () =>
      JSON.stringify(
        events.filter((event) =>
          ["notification", "ask.user", "error", "message.done"].includes(event.type),
        ),
      ),
  };
}

/** No amount of money: a currency sign with digits, or the words. */
export const MONEY = /[$€£]\s?\d|\d\s?(?:usd|dollars?|cents?)\b|\bcost\b|\bspent\b/i;

export function everySystemKit(cleanups: Array<() => unknown>) {
  /** This Mac: the runtime as the desktop app starts it, with a project of its own on disk. No Cloud, no rule. */
  async function mac(
    options: {
      readonly alsoAs?: AlsoAs;
      readonly provide?: Layer.Layer<any, never, any>;
      readonly files?: Record<string, string>;
    } = {},
  ) {
    const config = await makeConfig();
    const runtime = await startRuntime(config, "fake-claude", undefined, {
      ...(options.alsoAs ? { alsoAs: options.alsoAs } : {}),
      ...(options.provide ? { provide: options.provide } : {}),
    });
    cleanups.push(runtime.close);
    const client = connect(runtime.url, runtime.token);
    cleanups.push(() => client.close());
    const repo = makeRepo(
      tempRoot("every-system-mac-"),
      options.files ?? { "README.md": "widgets\n" },
    );
    return {
      place: "mac" as const,
      config,
      runtime,
      client,
      repo,
      where: { path: repo } as { path: string } | { url: string },
    };
  }

  /**
   * A Cloud computer whose person's credentials stay outside it: enrolled at a Cloud that says so, its engines'
   * model requests routed through the egress scrub to that Cloud's data plane, its checkout a clone of acme/widgets.
   * `connections` is the person's list. `rule: false` is the same computer at a Cloud from before the rule.
   */
  async function computer(
    options: Partial<
      Pick<
        EngineCloudConfig,
        | "connections"
        | "placed"
        | "connectorProxy"
        | "usedUpOnUse"
        | "kinds"
        | "routesAuto"
        | "router"
      >
    > & {
      readonly rule?: boolean;
      readonly alsoAs?: AlsoAs;
      readonly provide?: Layer.Layer<any, never, any>;
      readonly files?: Record<string, string>;
      /** The stand-in Cloud to enrol at (several computers share one); a new one when absent. */
      readonly inner?: Awaited<ReturnType<typeof startTestCloud>>;
      readonly cloud?: Awaited<ReturnType<typeof startEngineCloud>>;
      readonly name?: string;
      /** The computer's checkout, when the test made one (a clone the git proxy serves). */
      readonly checkout?: string;
    } = {},
  ) {
    const { rule = true, alsoAs, provide, files, name = "computer", ...config } = options;
    const inner = options.inner ?? (await startTestCloud());
    if (options.inner === undefined) cleanups.push(inner.close);
    const cloud =
      options.cloud ??
      (await startEngineCloud(inner.url, {
        credentialsOutside: rule ? true : null,
        connections: [CLAUDE_PLAN],
        placed: ["acme/widgets"],
        ...config,
      }));
    if (options.cloud === undefined) cleanups.push(cloud.close);
    const root = tempRoot(`every-system-${name}-`);
    const linkDir = path.join(root, "link");
    const identity = await enroll({
      dir: linkDir,
      cloudUrl: cloud.url,
      bearer: inner.state.personToken,
      name,
    });
    const checkout =
      options.checkout ??
      makeRepo(path.join(root, "workspace"), files ?? { "README.md": "widgets\n" });
    if (options.checkout === undefined)
      execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], {
        cwd: checkout,
      });
    fs.chmodSync(checkout, 0o755);
    const info = { linkDir, computerId: identity.computerId, workspaceRoot: checkout };
    const serverConfig = await makeConfig();
    const started = { ...(alsoAs ? { alsoAs } : {}), ...(provide ? { provide } : {}) };
    const up = await boot(info, serverConfig, started);
    return {
      place: "cloud" as const,
      inner,
      cloud,
      identity,
      info,
      config: serverConfig,
      started,
      name,
      repo: checkout,
      where: { url: "https://github.com/acme/widgets" } as { path: string } | { url: string },
      ...up,
    };
  }

  /** A Cloud computer's runtime on its disk, linked, and its broker as server.ts builds it (it joins the engines' launches to this computer's connections). */
  async function boot(
    info: { readonly linkDir: string; readonly computerId: string; readonly workspaceRoot: string },
    serverConfig: Awaited<ReturnType<typeof makeConfig>>,
    started: { readonly alsoAs?: AlsoAs; readonly provide?: Layer.Layer<any, never, any> },
  ) {
    const link: LinkState = {};
    const runtime = await startRuntime(serverConfig, "fake-claude", undefined, {
      cloudComputer: { computer: info, link },
      egress: true,
      ...started,
    });
    const client = connect(runtime.url, runtime.token);
    const scope = await Effect.runPromise(Scope.make());
    let closed = false;
    /** The runtime stops: its memory goes (the link, a credits key it held), its disk stays. */
    const stop = async () => {
      if (closed) return;
      closed = true;
      await Effect.runPromise(Scope.close(scope, Exit.void));
      client.close();
      await runtime.close();
    };
    cleanups.push(stop);
    await until(async () => (await client.call("cloud.status", {})).state === "connected", 15_000);
    await Effect.runPromise(
      Layer.buildWithScope(
        layerBroker.pipe(
          Layer.provideMerge(ServerSettingsModule.layer),
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(CloudComputer, info),
              Layer.succeed(CloudLinkState, link),
              Layer.succeed(CloudValues, { seen: new Map(), version: 0 }),
            ),
          ),
          Layer.provideMerge(ServerSecretStore.layer),
          Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
          Layer.provideMerge(Layer.succeed(ServerConfig.ServerConfig, serverConfig)),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ) as Layer.Layer<any, unknown, never>,
        scope,
      ),
    );
    return { link, runtime, client, stop };
  }

  /**
   * The computer sleeps and wakes as Cloud does it (CONTRACT §5.3): its runtime stops, Cloud mints a new identity for
   * the same computer and disk and refuses the one it stopped under, and a runtime starts there again. Answers the
   * computer as it is now: a new runtime id, a new link, the same disk.
   */
  async function wake(there: Awaited<ReturnType<typeof computer>>) {
    await there.stop();
    forgetComputerCredits(there.info.linkDir);
    const before = there.identity.runtimeId;
    const known = there.inner.state.runtimes.get(before);
    if (known) known.status = "revoked";
    for (const [token, record] of there.inner.state.tokens)
      if (record.runtimeId === before) there.inner.state.tokens.delete(token);
    const identity = await enroll({
      dir: there.info.linkDir,
      cloudUrl: there.cloud.url,
      bearer: there.inner.state.personToken,
      name: there.name,
    });
    if (identity.computerId !== there.identity.computerId || identity.runtimeId === before)
      throw new Error("a wake keeps the computer and changes its runtime id");
    return { ...there, identity, ...(await boot(there.info, there.config, there.started)) };
  }

  return { mac, computer, wake };
}
