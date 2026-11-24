/**
 * Text generation on the Caveman engine, end to end: DeepSeek Flash on Caveman credits through a stand-in gateway (pi-ai
 * on the wire, the harness's general loadout, the app's own tools). A review guide reads its checkout: the model asks
 * for read_file, grep and git in one turn, reads what they returned, then answers the guide; a title has no tools at
 * all. Its own file: the gateway URL is read when the credits module loads.
 */
import { execFileSync } from "node:child_process";
import * as http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@caveman-app/protocol";
import type { TextGenerationUsage } from "@caveman-app/engine-core/server/textGeneration";
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

interface Sent {
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content?: unknown; readonly tool_call_id?: string }>;
  readonly tools?: ReadonlyArray<{ readonly function: { readonly name: string } }>;
}
const requests: Array<Sent> = [];
const chunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const GUIDE = {
  tldr: "Adds a second line.",
  overview: "what: a.txt gains a line\nwhy: asked",
  before_after: { title: "a.txt", rows: [{ op: "+", depth: 0, text: "two", stop: 1 }] },
  stops: [
    {
      title: "Second line lands",
      summary: "before: one line\nafter: two lines\nwhy: asked",
      attention: null,
      excerpts: [{ path: "a.txt", side: "new", start: 2, end: 2, caption: "" }],
      files: [],
      notes: [],
      questions: [],
    },
  ],
};
const call = (index: number, name: string, args: object) => ({ index, id: `call_${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const server = http.createServer(async (request, response) => {
  let raw = "";
  for await (const part of request) raw += part;
  const sent = JSON.parse(raw || "{}") as Sent;
  requests.push(sent);
  response.writeHead(200, { "content-type": "text/event-stream" });
  const answered = sent.messages.some((message) => message.role === "tool");
  if (sent.tools === undefined || sent.tools.length === 0) {
    response.write(chunk({ role: "assistant", content: JSON.stringify({ title: "Fix the login bug" }) }));
    response.write(chunk({}, "stop"));
  } else if (!answered) {
    // Every tool the guide may use, in one turn: the harness runs them side by side.
    response.write(
      chunk({
        role: "assistant",
        tool_calls: [
          call(0, "git", { args: ["diff", "--stat", "HEAD~1...HEAD"] }),
          call(1, "read_file", { path: "a.txt", offset: 2 }),
          call(2, "grep", { pattern: "^two$" }),
          // Refused, and the model is told so: the turn goes on.
          call(3, "git", { args: ["checkout", "-b", "evil"] }),
        ],
      }),
    );
    response.write(chunk({}, "tool_calls"));
  } else {
    response.write(chunk({ role: "assistant", content: JSON.stringify(GUIDE) }));
    response.write(chunk({}, "stop"));
  }
  response.write(
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.CAVEMAN_CREDITS_GATEWAY_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const { makeCavemanTextGeneration } = await import("./driver.ts");
const { setCavemanKey } = await import("./credentials.ts");

const INSTANCE_ID = ProviderInstanceId.make("caveman");
const layer = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));

const checkout = () => {
  const dir = mkdtempSync(join(tmpdir(), "caveman-guide-"));
  const git = (...args: Array<string>) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "--quiet", "-m", "first");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  git("commit", "--quiet", "-am", "second");
  return { dir, base };
};

const toolResults = (sent: Sent | undefined) =>
  Object.fromEntries((sent?.messages ?? []).filter((message) => message.role === "tool").map((message) => [message.tool_call_id, JSON.stringify(message.content)]));

it.effect("writes a guide on DeepSeek Flash by reading the checkout with read_file, grep and git, and a title with no tools", () =>
  Effect.gen(function* () {
    yield* setCavemanKey(INSTANCE_ID, "caveman", "cave_credits_test_key");
    const { dir, base } = checkout();
    const textGeneration = yield* makeCavemanTextGeneration(INSTANCE_ID);
    const usages: Array<TextGenerationUsage> = [];
    const guide = yield* textGeneration.generateReviewGuide({
      cwd: dir,
      number: 7,
      title: "Second line",
      description: "",
      baseBranch: "main",
      baseCommit: base,
      settledReview: "",
      modelSelection: { instanceId: INSTANCE_ID, model: "caveman/deepseek/deepseek-flash" },
      onUsage: (usage) => usages.push(usage),
    });
    assert.strictEqual(guide.stops[0]?.title, "Second line lands");
    assert.deepStrictEqual(guide.beforeAfter?.rows, [{ op: "+", depth: 0, text: "two", stop: 1 }]);
    // Two requests: the tool calls, then the answer, which saw what each tool read in the checkout.
    assert.strictEqual(requests.length, 2);
    // The investigation's tools are the whole surface: none of the harness's own (read, bash, edit, write, program).
    assert.deepStrictEqual(requests[0]!.tools?.map((tool) => tool.function.name), ["read_file", "grep", "git"]);
    const system = JSON.stringify(requests[0]!.messages[0]);
    assert.include(system, "Answer with exactly the JSON the user asks for.");
    assert.notInclude(system, "bash");
    const results = toolResults(requests[1]);
    assert.include(results.call_0, "a.txt | 1 +");
    assert.include(results.call_1, "2\\ttwo");
    assert.include(results.call_2, "a.txt:2:two");
    assert.include(results.call_3, "Only git diff, git log and git show run here.");
    assert.strictEqual(execFileSync("git", ["branch", "--list", "evil"], { cwd: dir, encoding: "utf8" }), "");
    // Both requests' tokens, told to the caller for the guide's spend row.
    assert.deepStrictEqual(usages.map((usage) => [usage.inputTokens, usage.outputTokens]), [[24, 4]]);

    const title = yield* textGeneration.generateThreadTitle({
      cwd: dir,
      message: "The login button does nothing",
      modelSelection: { instanceId: INSTANCE_ID, model: "caveman/deepseek/deepseek-flash" },
    });
    assert.strictEqual(title.title, "Fix the login bug");
    assert.strictEqual(requests.length, 3);
    assert.deepStrictEqual(requests[2]!.tools ?? [], []);
  }).pipe(
    Effect.scoped,
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => (server.closeAllConnections(), server.close()))),
  ),
);
