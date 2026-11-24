// What the builders' integration tests share: Cloud computers' runtimes against the stand-in Cloud, with the tools
// container's exec channel and the stand-in Claude CLI (no model), and a bare acme/widgets as GitHub behind the git
// proxy. Each helper leaves what it started in `cleanups`, which the test runs in reverse when it ends.
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { connect, type SessionEvent, type Workspace } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { Builders } from "../session-protocol/builders.ts";
import { makeConfig, startRuntime, tempRoot, until } from "../session-protocol/testHarness.ts";
import { enroll } from "./identity.ts";
import { CloudComputer, CloudLinkState, type LinkState } from "./index.ts";
import type { startTestCloud } from "./testCloud.ts";
import { TOOLS_EXEC } from "./tools.ts";

export type TestCloud = Awaited<ReturnType<typeof startTestCloud>>;

/** A refused call as `reason/capability: message`, or "ok". */
export const refusalOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { error?: { message?: string; data?: { reason?: string; capability?: string } } }) =>
      `${error.error?.data?.reason}/${error.error?.data?.capability}: ${error.error?.message}`,
  );
export const gitIn =
  (cwd: string) =>
  (...args: Array<string>) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
export const userTexts = (events: ReadonlyArray<SessionEvent>) =>
  events.flatMap((e) =>
    e.type === "message.done" && e.payload.role === "user" ? [e.payload.text] : [],
  );
export const assistantTexts = (events: ReadonlyArray<SessionEvent>) =>
  events.flatMap((e) =>
    e.type === "message.done" && e.payload.role === "assistant" ? [e.payload.text] : [],
  );

export function builderKit(cleanups: Array<() => unknown>) {
  /** The tools container's exec channel (TOOLS_SIDE marks what ran there); the computers service sets the address. */
  async function startTools() {
    const socket = path.join(tempRoot("builders-tools-sock-"), "tools.sock");
    const tools = spawn(process.execPath, [TOOLS_EXEC, "serve", socket], {
      env: { ...process.env, TOOLS_SIDE: "yes" },
      stdio: "ignore",
    });
    cleanups.push(() => tools.kill());
    await until(() => fs.existsSync(socket));
    process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS = socket;
    cleanups.push(() => delete process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS);
  }

  /** GitHub as the git proxy serves it: a bare acme/widgets the computers fetch from and push caveman/ branches to. */
  function githubWith(source: string) {
    const backend = tempRoot("builders-github-");
    fs.mkdirSync(path.join(backend, "acme"), { recursive: true });
    execFileSync("git", [
      "clone",
      "--bare",
      "--quiet",
      source,
      path.join(backend, "acme", "widgets.git"),
    ]);
    return backend;
  }

  /** A computer's snapshot checkout of acme/widgets. */
  function checkoutOf(backend: string, prefix: string) {
    const at = path.join(tempRoot(prefix), "workspace");
    execFileSync("git", ["clone", "--quiet", path.join(backend, "acme", "widgets.git"), at]);
    const git = gitIn(at);
    git("remote", "set-url", "origin", "https://github.com/acme/widgets.git");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    return at;
  }

  /**
   * A Cloud computer's runtime at `checkout`; `engines` also serves those engines with the stand-in CLI, with their
   * models; `also`: services its route sees besides (Settings > Agents as a test holds them); `enrolled` runs once
   * Cloud knows the computer and before its runtime starts (what Cloud holds for a computer that is still on its way up).
   */
  async function computerRuntime(
    cloud: TestCloud,
    checkout: string,
    name: string,
    engines?: {
      readonly alsoAs: ReadonlyArray<"codex">;
      readonly providers: Layer.Layer<ProviderRegistry.ProviderRegistry>;
    },
    also?: Layer.Layer<any>,
    enrolled?: (identity: Awaited<ReturnType<typeof enroll>>) => unknown,
  ) {
    const linkDir = path.join(tempRoot(`builders-${name}-link-`), "link");
    const identity = await enroll({
      dir: linkDir,
      cloudUrl: cloud.url,
      bearer: cloud.state.personToken,
      name,
    });
    await enrolled?.(identity);
    const config = await makeConfig();
    // The link's own state (its Cloud URL and token): what the runtime's git reaches the proxy with.
    const link: LinkState = {};
    const provide = Layer.mergeAll(
      Layer.succeed(CloudComputer, {
        linkDir,
        computerId: identity.computerId,
        workspaceRoot: checkout,
      }),
      Layer.succeed(CloudLinkState, link),
      engines?.providers ?? Layer.empty,
      also ?? Layer.empty,
    ) as unknown as Layer.Layer<any>;
    const runtime = await startRuntime(config, "fake-claude", undefined, {
      provide,
      ...(engines ? { alsoAs: engines.alsoAs } : {}),
    });
    cleanups.push(runtime.close);
    const client = connect(runtime.url, runtime.token);
    cleanups.push(() => client.close());
    await until(async () => (await client.call("cloud.status", {})).state === "connected", 15_000);
    const builders = Context.get(runtime.context as unknown as Context.Context<Builders>, Builders);
    return { identity, config, runtime, client, builders, checkout, link };
  }

  /** What the lead's agent does with delegate_task (isolation worktree), as the MCP tool calls it. */
  const delegate = (
    builders: Builders["Service"],
    lead: Workspace,
    key: string,
    title: string,
    extra: {
      where?: "cloud";
      computerId?: string;
      engine?: string;
      model?: string;
      task?: string;
    } = {},
  ) => {
    const { task, ...rest } = extra;
    return Effect.runPromise(
      builders.start({
        parentThreadId: `caveman:${lead.id}`,
        task: task ?? `slow 0: ${title}`,
        title,
        requestKey: key,
        ...rest,
      }),
    );
  };

  return { startTools, githubWith, checkoutOf, computerRuntime, delegate };
}
