// A chat's preview through a real runtime: its agent registers it (register_preview's ChatPreviews, as the MCP tool
// calls it), the workspace carries it with the chat's own port, workspace.preview.open serves the page from the chat's
// worktree, and the server goes when the chat is archived and when the runtime stops.
import * as fs from "node:fs";

import { connect, type Workspace } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { PORT_RANGE } from "./lifecycle.ts";
import { ChatPreviews, previewOf, previewPort } from "./previewHandlers.ts";
import { listening } from "./previews.ts";
import * as Store from "./store.ts";
import {
  createReady,
  makeConfig,
  makeRepo,
  MODEL,
  startRuntime,
  tempRoot,
  until,
} from "./testHarness.ts";

test("what register_preview takes, cleaned, or the agent's one-line reason", () => {
  expect(previewOf({ command: "  pnpm vite --port {port}  " }, "t")).toEqual({
    command: "pnpm vite --port {port}",
    path: "/",
    registered_at: "t",
  });
  expect(previewOf({ command: "pnpm dev", path: "/settings?tab=2", port: 3000 }, "t")).toEqual({
    command: "pnpm dev",
    path: "/settings?tab=2",
    port: 3000,
    registered_at: "t",
  });
  expect(previewOf({ command: " " }, "t")).toMatch(/Give the command/);
  expect(previewOf({ command: "pnpm i\npnpm dev" }, "t")).toMatch(/one line/);
  expect(previewOf({ command: "pnpm dev", path: "settings" }, "t")).toMatch(/from \//);
  expect(previewOf({ command: "pnpm dev", port: 70_000 }, "t")).toMatch(/1 to 65535/);
});

test("its port: a fixed one, else the chat's first [run] port, else its preview port", () => {
  expect(
    previewPort(
      {
        ports: { web: 42101, api: 42102 },
        preview: { command: "x", path: "/", port: 3000, registered_at: "t" },
      },
      ["web", "api"],
    ),
  ).toBe(3000);
  expect(previewPort({ ports: { api: 42102, web: 42101 } }, ["web", "api"])).toBe(42101);
  expect(previewPort({ ports: { preview: 42150 } })).toBe(42150);
  expect(previewPort({})).toBeUndefined();
});

const posix = process.platform !== "win32";

describe.runIf(posix)("through a runtime", () => {
  const root = tempRoot("sp-preview-");
  let runtime: Awaited<ReturnType<typeof startRuntime>>;
  let client: ReturnType<typeof connect>;
  let sessions!: Store.SessionStore["Service"];
  class Grab extends Context.Service<Grab, { readonly ok: true }>()("test/previewHandlers/Grab") {}
  const grab = Layer.effect(
    Grab,
    Effect.gen(function* () {
      sessions = yield* Store.SessionStore;
      return Grab.of({ ok: true });
    }),
  ).pipe(Layer.provide(Store.layer)) as Layer.Layer<Grab>;

  beforeAll(async () => {
    runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, { provide: grab });
    client = connect(runtime.url, runtime.token);
  });
  afterAll(async () => {
    client.close();
    await runtime?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const register = async (
    workspace: Workspace,
    input: { command: string; path?: string; port?: number },
  ) => {
    const record = await Effect.runPromise(sessions.getWorkspace(workspace.id));
    const previews = Context.get(
      runtime.context as unknown as Context.Context<ChatPreviews>,
      ChatPreviews,
    );
    return Effect.runPromise(previews.register(record!.internal.threadId, input));
  };
  const chat = async (title: string) => {
    const repo = makeRepo(root, {
      "server.js": `require("node:http").createServer((q, r) => r.end(${JSON.stringify(title)} + " " + q.url + " from " + process.cwd())).listen(Number(process.env.PORT), "127.0.0.1");\n`,
    });
    return createReady(client, {
      request_id: `w-${title}`,
      repo: { path: repo },
      title,
      engine: "claude-agent",
      options: { model: MODEL },
    });
  };
  /** A protocol refusal as "reason: message"; a tool's refusal (no reason) as ": message". */
  const reason = (p: Promise<unknown>) =>
    p.then(
      () => "ok",
      (e: { error?: { data?: { reason?: string }; message?: string }; message?: string }) =>
        e.error ? `${e.error.data?.reason}: ${e.error.message}` : `: ${e.message}`,
    );

  test("registered, it serves the chat's own checkout on the chat's port; archived, it is gone", async () => {
    const workspace = await chat("Landing page");
    expect(
      await reason(
        client.call("workspace.preview.open", { request_id: "o-0", workspace_id: workspace.id }),
      ),
    ).toBe("not_found: This chat registered no preview.");

    const changed: Array<Workspace> = [];
    client.on("workspace.changed", (w) => {
      if (w.id === workspace.id) changed.push(w);
    });
    const registered = await register(workspace, {
      command: "PORT={port} node server.js",
      path: "/pricing",
    });
    // A port of its own from the runtime's range, for as long as the chat lives.
    expect(registered.port).toBeGreaterThanOrEqual(PORT_RANGE.from);
    expect(registered.port).toBeLessThanOrEqual(PORT_RANGE.to);
    expect(registered.url).toBe(`http://localhost:${registered.port}/pricing`);
    const got = await client.call("workspace.get", { workspace_id: workspace.id });
    expect(got.preview).toMatchObject({ command: "PORT={port} node server.js", path: "/pricing" });
    expect(got.ports).toEqual({ preview: registered.port });
    // Every window hears it, without the chat moving in a list.
    await until(() => changed.some((w) => w.preview !== undefined));
    expect(changed.at(-1)!.updated_at).toBe(workspace.updated_at);
    // Nothing runs until the person opens it.
    expect(await listening(registered.port)).toBe(false);

    const opened = await client.call("workspace.preview.open", {
      request_id: "o-1",
      workspace_id: workspace.id,
    });
    expect(opened).toEqual({ url: registered.url, started: true });
    const page = await (await fetch(opened.url)).text();
    expect(page).toBe(`Landing page /pricing from ${fs.realpathSync(got.root_path!)}`);
    expect(
      await client.call("workspace.preview.open", {
        request_id: "o-2",
        workspace_id: workspace.id,
      }),
    ).toEqual({ url: registered.url, started: false });

    // A second chat gets a port of its own.
    const other = await chat("Docs site");
    const second = await register(other, { command: "PORT={port} node server.js" });
    expect(second.port).not.toBe(registered.port);

    await client.call("workspace.archive", { request_id: "a-1", workspace_id: workspace.id });
    expect(await listening(registered.port)).toBe(false);
    expect(await reason(register(workspace, { command: "node server.js" }))).toBe(
      ": This chat is archived.",
    );
  });

  test("Stop ends it; a new command replaces the old server; a page that never listens says why", async () => {
    const workspace = await chat("Pricing");
    const { port } = await register(workspace, { command: "PORT={port} node server.js" });
    await client.call("workspace.preview.open", { request_id: "s-1", workspace_id: workspace.id });
    await client.call("workspace.preview.stop", { request_id: "s-2", workspace_id: workspace.id });
    expect(await listening(port)).toBe(false);
    // Stopping what is not running is fine.
    await client.call("workspace.preview.stop", { request_id: "s-3", workspace_id: workspace.id });

    await client.call("workspace.preview.open", { request_id: "s-4", workspace_id: workspace.id });
    await register(workspace, { command: "echo the build broke >&2; exit 1" });
    expect(await listening(port)).toBe(false);
    expect(
      await reason(
        client.call("workspace.preview.open", { request_id: "s-5", workspace_id: workspace.id }),
      ),
    ).toMatch(
      /^invalid_state: `echo the build broke >&2; exit 1` exited \(code 1\) before it listened on port \d+\.\nthe build broke$/,
    );
  });

  test("the runtime stopping takes every preview server with it", async () => {
    const workspace = await chat("Shutdown");
    const { port } = await register(workspace, { command: "PORT={port} node server.js" });
    await client.call("workspace.preview.open", { request_id: "q-1", workspace_id: workspace.id });
    expect(await listening(port)).toBe(true);
    client.close();
    await runtime.close();
    runtime = undefined as never;
    expect(await listening(port)).toBe(false);
  });
});
