// The Chief's queue end to end in a browser: the real runtime (the Chief test's, model scripted), the real web client
// on it (Vite), driven in Chrome. While the Chief thinks and a chat works, a note queued with Alt+Enter leaves the box,
// shows in the box's tray, and leaves the tray once the Chief starts it. Opt-in, as it starts Vite and a browser:
//   CHIEF_BROWSER_CHROME=/path/to/chrome pnpm --filter @caveman-app/runtime exec vitest run src/chief/chief-queue.browser.test.ts
// CHIEF_BROWSER_OUT=<dir> also keeps a screenshot of each step.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import { ProviderInstanceId } from "@caveman-app/protocol";
import { CAVEMAN_PROVIDER, CavemanAdapterV2Driver, makeCavemanAdapterV2 } from "@caveman-app/provider-caveman/server";
import { createAssistantMessageEventStream, fauxModel, type AssistantMessage, type ModelContext as PiContext } from "@caveman-app/provider-caveman/testing";
import { connect } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { chromium } from "playwright-core";
import { expect, test } from "vitest";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeConfig, makeRepo, startRuntime, tempRoot, until } from "../session-protocol/testHarness.ts";

const OUT = process.env.CHIEF_BROWSER_OUT;
const CHROME = process.env.CHIEF_BROWSER_CHROME;
const WEB = path.resolve(import.meta.dirname, "../../../../apps/web");
interface Turn { text?: string; tools?: ReadonlyArray<{ name: string; args: unknown }>; wait?: Promise<void> }
const chiefTurns: Array<Turn | ((c: PiContext) => Turn)> = [];
let chatTurn: (c: PiContext) => Turn = () => ({ text: "Done." });
const isChief = (c: PiContext) => JSON.stringify(c).includes("You are a Chief in Caveman Code");
let serial = 0;
const streamFn = ((model: { api: string; provider: string; id: string }, context: PiContext, options?: { signal?: AbortSignal }) => {
  const s = isChief(context) ? (chiefTurns.shift() ?? { text: "Noted." }) : chatTurn(context);
  const turn = typeof s === "function" ? s(context) : s;
  const call = ++serial;
  const content: AssistantMessage["content"] = [
    ...(turn.text === undefined ? [] : [{ type: "text" as const, text: turn.text }]),
    ...(turn.tools ?? []).map((t, i) => ({ type: "toolCall" as const, id: `c${call}-${i}`, name: t.name, arguments: JSON.parse(JSON.stringify(t.args)) as never })),
  ];
  const stopReason = (turn.tools ?? []).length > 0 ? "toolUse" : "stop";
  const message: AssistantMessage = { role: "assistant", content, api: model.api as never, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: Date.now() };
  const stream = createAssistantMessageEventStream();
  const aborted = new Promise<"aborted">((r) => options?.signal?.addEventListener("abort", () => r("aborted"), { once: true }));
  void Promise.race([(turn.wait ?? Promise.resolve()).then(() => "ok" as const), aborted]).then((how) => {
    if (how === "aborted") { const m = { ...message, content: [], stopReason: "aborted" as const }; stream.push({ type: "error", reason: "aborted", error: m }); stream.end(m); return; }
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({ type: "done", reason: stopReason, message });
    stream.end(message);
  });
  return stream;
}) as never;

test.skipIf(!CHROME)("a note queued while the Chief and a chat work shows in the box's tray until the Chief starts it", async () => {
  if (OUT) fs.mkdirSync(OUT, { recursive: true });
  const shot = async (page: import("playwright-core").Page, name: string) => void (OUT ? await page.screenshot({ path: path.join(OUT, `${name}.png`) }) : undefined);
  const root = tempRoot("chief-live-");
  const config = await makeConfig();
  const host = Layer.succeedContext(await Effect.runPromise(Effect.scoped(Layer.build(TestProviderHost.layer({ attachmentsDir: config.attachmentsDir, resolveAttachmentPath: (a) => resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment: a }) }).pipe(Layer.provide(NodeServices.layer))))));
  const scripted: typeof CavemanAdapterV2Driver = { ...CavemanAdapterV2Driver, create: (input) => makeCavemanAdapterV2({ instanceId: input.instanceId, settings: { ...input.config, enabled: input.enabled }, engine: { streamFn, model: fauxModel({ priced: true }) } }).pipe(Effect.orDie) };
  const registry = ProviderAdapterRegistry.layerFromDrivers({ drivers: [scripted], configMap: { [ProviderInstanceId.make("caveman")]: { driver: CAVEMAN_PROVIDER, config: { optimization: "off" } } } }).pipe(Layer.provide(Layer.mergeAll(host, IdAllocator.layer, NodeServices.layer)), Layer.orDie);
  const runtime = await startRuntime(config, "fake-claude", undefined, { provide: host, registry, recoverOnStartup: true });
  const client = connect(runtime.url, runtime.token());
  // Everything started from here is stopped however the test ends (a setup call refused, Chrome failing to launch).
  let vite: ReturnType<typeof spawn> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    let n = 0;
    const rid = () => `live-${++n}`;
    await client.call("engine.account.add", { request_id: rid(), engine: "caveman", provider: "anthropic", key: ("sk-" + "ant-live-test-0123456789abcdef") });
    await client.call("settings.set", { request_id: rid(), settings: { default_engine: "caveman", engines: { caveman: { model: "anthropic/claude-haiku-4-5" } } } });
    const app = await client.call("project.create", { request_id: rid(), path: makeRepo(root, { "README.md": "app\n" }), name: "app" });
    await client.call("chief.get", {});
    const items = async () => (await client.call("chief.items.list", {})).items;

    // A chat that works until released.
    let releaseChat = () => {};
    const chatGate = new Promise<void>((r) => (releaseChat = r));
    chatTurn = () => ({ text: "Done.", wait: chatGate });
    chiefTurns.push({ tools: [{ name: "chat_start", args: { project_ids: [app.id], title: "Refactor the parser", brief: "Refactor the parser." } }] }, { text: "Started the parser refactor." });
    await client.call("chief.capture", { request_id: rid(), text: "Refactor the parser", mode: "decide" });
    await until(async () => (await items()).some((i) => i.title === "Refactor the parser" && i.state === "started"), 30_000);
    // The Chief itself thinking, until released.
    let releaseChief = () => {};
    const chiefGate = new Promise<void>((r) => (releaseChief = r));
    chiefTurns.push({ text: "Looking over the parser work.", wait: chiefGate });
    await client.call("chief.capture", { request_id: rid(), text: "How is the parser going?", mode: "decide" });

    // The web client on this runtime.
    const port = 5811;
    vite = spawn("npx", ["vite", "--port", String(port), "--strictPort"], { cwd: WEB, env: { ...process.env, VITE_RUNTIME_URL: runtime.url, VITE_RUNTIME_TOKEN: runtime.token() }, stdio: "ignore", detached: true });
    browser = await chromium.launch({ executablePath: CHROME!, headless: true });
    await until(async () => (await fetch(`http://localhost:${port}/`).catch(() => null))?.ok === true, 60_000);
    const page = await browser.newPage({ viewport: { width: 1400, height: 860 }, deviceScaleFactor: 2 });
    await page.goto(`http://localhost:${port}/chief`, { waitUntil: "commit", timeout: 120_000 });
    const box = page.locator("[data-composer] textarea").first();
    await box.waitFor({ timeout: 150_000 });
    await page.getByText("Thinking", { exact: true }).first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    await shot(page, "1-working");
    // Queue a note with ⌥Enter while both work.
    await box.click();
    await box.fill("Then add tests for the tokenizer");
    await box.press("Alt+Enter");
    await until(async () => (await items()).some((i) => i.text === "Then add tests for the tokenizer" && i.state === "queued"), 10_000);
    const tray = page.locator("section[aria-label^='Queued follow-up']");
    await expect.poll(() => tray.innerText().catch(() => ""), { timeout: 10_000 }).toContain("Then add tests for the tokenizer");
    expect(await box.inputValue()).toBe("");
    // Both still at work: the queue never waited for them.
    expect(await page.getByText("Thinking", { exact: true }).first().isVisible()).toBe(true);
    // The work under way shares the box's tray with the queue (its strip), not a row of its own above it.
    expect(await page.getByRole("button", { name: /^Waiting on 1 task: Refactor the parser/ }).isVisible()).toBe(true);
    await shot(page, "2-queued");
    // Queue a second one, to see the tray's header.
    await box.fill("And update the changelog");
    await box.press("Alt+Enter");
    await expect.poll(() => tray.innerText().catch(() => ""), { timeout: 10_000 }).toMatch(/Queued[\s\S]*2[\s\S]*Then add tests for the tokenizer[\s\S]*And update the changelog/);
    await shot(page, "3-queued-two");
    // Picked up: the Chief, next turn, starts the first queued note.
    const note = (await items()).find((i) => i.text === "Then add tests for the tokenizer")!;
    chiefTurns.push({ tools: [{ name: "chat_start", args: { item_id: note.id, project_ids: [app.id], title: "Tokenizer tests", brief: note.text } }] }, { text: "Started the tokenizer tests." });
    chatTurn = () => ({ text: "Done." });
    releaseChief();
    releaseChat();
    await until(async () => (await items()).find((i) => i.id === note.id)?.state !== "queued", 60_000);
    expect((await items()).find((i) => i.id === note.id)?.state).toBe("started");
    // Picked up: it leaves the tray; the other note waits on.
    await expect.poll(() => tray.innerText().catch(() => ""), { timeout: 10_000 }).not.toContain("Then add tests for the tokenizer");
    expect(await tray.innerText()).toContain("And update the changelog");
    await shot(page, "4-picked-up");
  } finally {
    await browser?.close();
    try { if (vite?.pid) process.kill(-vite.pid, "SIGTERM"); } catch {}
    client.close();
    await runtime.close();
  }
}, 300_000);
