// Test-only: one Cloud computer's runtime process for projectComputers.e2e.test.ts. The real runtime with the real
// Claude Agent adapter on the stand-in CLI (scripts/smoke-claude.mjs: no model, no network), started the way the
// computers service starts one: CAVEMAN_CLOUD_LINK_DIR holds its enrolled identity and CAVEMAN_WORKSPACE_ROOT is its
// checkout. Writes {url, token, stateDir, worktreesDir, control} to PC_OUT once it serves, and runs until killed.
//
// `control` is a loopback endpoint for the test alone, behind a bearer of its own (PC_CONTROL_TOKEN): what a lead's
// agent does with delegate_task (isolation worktree) is POST /start, as the MCP tool calls Builders.start; GET /tree
// reads the lead's builders as Settings > Agents' limits count them. PC_AGENTS_AT_ONCE is this computer's
// Settings > Agents "Agents working at once", for a lead that runs more than the default eight.
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import { Builders } from "../session-protocol/builders.ts";
import { makeConfig, startRuntime } from "../session-protocol/testHarness.ts";

const out = process.env.PC_OUT!;
const bearer = process.env.PC_CONTROL_TOKEN!;
const config = await makeConfig();
const atOnce = Number(process.env.PC_AGENTS_AT_ONCE ?? 0);
const runtime = await startRuntime(
  config,
  "fake-claude",
  undefined,
  atOnce > 0
    ? {
        provide: ServerSettings.layerTest({ subagents: { maxConcurrent: atOnce } }).pipe(
          Layer.orDie,
        ),
      }
    : undefined,
);
const builders = Context.get(runtime.context as unknown as Context.Context<Builders>, Builders);

const control = http.createServer((req, res) => {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== `Bearer ${bearer}`)
    return reply(401, { error: "not the test" });
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const chunks: Array<Buffer> = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    if (req.method === "POST" && url.pathname === "/start") {
      const input = JSON.parse(Buffer.concat(chunks).toString()) as {
        parentThreadId: string;
        task: string;
        title: string;
        requestKey: string;
      };
      return void Effect.runPromise(
        builders.start(input).pipe(
          Effect.match({
            onSuccess: (started) => ({ started: started ?? null }),
            onFailure: (error) => ({ error: `${error.reason}: ${error.message}` }),
          }),
        ),
      ).then(
        (answer) => reply(200, answer),
        (error) => reply(500, { error: String(error) }),
      );
    }
    if (req.method === "GET" && url.pathname === "/tree") {
      return void Effect.runPromise(builders.tree(url.searchParams.get("lead") ?? "")).then(
        (tree) => reply(200, tree),
        (error) => reply(500, { error: String(error) }),
      );
    }
    reply(404, { error: "no such route" });
  });
});
await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
  out,
  JSON.stringify({
    url: runtime.url,
    token: runtime.token(),
    stateDir: config.stateDir,
    worktreesDir: config.worktreesDir,
    control: `http://127.0.0.1:${(control.address() as AddressInfo).port}`,
  }),
);
setInterval(() => {}, 1 << 30);
