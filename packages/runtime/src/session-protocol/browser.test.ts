// browser.* on upstream server browser with a real headless shell (upstream pinned
// Chrome for Testing, installed once into TEST_BROWSER_HOME): screencast
// sends the state and a frame at once, navigate and history act as the user,
// input lands in frame pixels, snapshot carries element refs, control goes
// back to the agent on hand-back and when the controlling connection drops;
// an agent's preview_open is told to every window, and viewers follow it;
// the agent using its browser is told to every window, throttled; a window
// watching a tab that closes hears it and streams the agent's next tab.
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { ProviderInstanceId, ThreadId, type PreviewAutomationStatus } from "@caveman-app/protocol";
import { connect, type NotificationParams } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { afterAll, expect, test } from "vitest";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as PreviewManager from "../preview/Manager.ts";
import { ACTIVE_NOTICE_MS } from "./browser.ts";
import { ensureTestBrowser, loadTranscript, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, TEST_BROWSER_HOME, until } from "./testHarness.ts";

// The headless shell is about 100 MB: without it (fresh CI, offline) this is BLOCKED, never a hang.
const haveBrowser = process.env.CAVEMAN_TEST_BROWSER === "1" || fs.existsSync(TEST_BROWSER_HOME);
if (!haveBrowser) {
  console.warn(`BLOCKED: no headless shell in ${TEST_BROWSER_HOME}; set CAVEMAN_TEST_BROWSER=1 to install it there, or CAVEMAN_TEST_BROWSER_HOME to an installed one`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const root = tempRoot("sp-browser-");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const reason = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { error?: { data?: { reason?: string } } }) => error.error?.data?.reason,
  );

// The top half is a text field that names the page; the bottom half a button.
const PAGE_ONE = `<!doctype html><title>One</title>
<style>body{margin:0}input,button{position:fixed;left:0;width:100vw;height:50vh;border:0}input{top:0}button{top:50vh}</style>
<input autofocus aria-label="Name" oninput="document.title=this.value"><button onclick="document.title='Clicked'">Press</button>`;
const PAGE_TWO = `<!doctype html><title>Two</title><p>second page</p>`;
// A click turns the page solid red, then 300 ms later fills it with text (a much larger JPEG), and it never repaints after.
const PAGE_CHANGE = `<!doctype html><title>Change</title><style>html,body{margin:0;height:100%}</style>
<body onclick="this.style.background='red';setTimeout(()=>{this.style.background='white';this.textContent='busy text '.repeat(3000)},300)">`;

test.skipIf(!haveBrowser)("screencast, navigate, input, snapshot, history and control on a real headless browser", { timeout: 600_000 }, async () => {
  await ensureTestBrowser();
  const requests: Array<{ path: string; cacheControl: string | undefined }> = [];
  const site = http.createServer((request, response) => {
    requests.push({ path: request.url ?? "", cacheControl: request.headers["cache-control"] });
    response.writeHead(200, { "content-type": "text/html" });
    response.end(request.url === "/two" ? PAGE_TWO : request.url === "/change" ? PAGE_CHANGE : PAGE_ONE);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

  const runtime = await startRuntime(await makeConfig(), await loadTranscript(), undefined, { browser: true });
  const client = connect(runtime.url, runtime.token);
  const other = connect(runtime.url, runtime.token);
  try {
    const w = await client.call("workspace.create", { request_id: "w", repo: { path: makeRepo(root, { "README.md": "hi\n" }) }, engine: "claude-agent", options: { model: MODEL } });
    const states: Array<NotificationParams<"browser.state">> = [];
    const frames: Array<NotificationParams<"browser.frame">> = [];
    client.on("browser.state", (s) => states.push(s));
    client.on("browser.frame", (f) => frames.push(f));
    const last = () => states.at(-1)!;

    // Live view rule: the state and one frame right away, even for a blank tab.
    expect(await client.call("browser.screencast", { workspace_id: w.id, enabled: true })).toEqual({});
    await until(() => states.length > 0 && frames.length > 0, 60_000);
    expect(states[0]).toMatchObject({ workspace_id: w.id, url: "about:blank", controller: "agent", can_go_back: false });
    expect(frames[0]).toMatchObject({ workspace_id: w.id, mime_type: "image/jpeg" });
    expect(frames[0]!.width).toBeGreaterThan(0);
    expect(Buffer.from(frames[0]!.data, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    // Input needs control.
    expect(await reason(client.call("browser.input", { request_id: "i0", workspace_id: w.id, events: [{ type: "text", text: "x" }] }))).toBe("invalid_state");

    // Navigating is the user acting: it takes control.
    await client.call("browser.navigate", { request_id: "n1", workspace_id: w.id, url: `${origin}/` });
    await until(() => last().title === "One" && !last().loading && last().controller === "user");
    expect(last().url).toBe(`${origin}/`);

    // Clicks land in frame pixels: the top half focuses the field, typing names the page; the bottom half is the button.
    const frame = frames.at(-1)!;
    const click = (x: number, y: number) =>
      (["down", "up"] as const).map((action) => ({ type: "pointer" as const, action, button: "left" as const, x, y, modifiers: 0 }));
    await client.call("browser.input", {
      request_id: "i1",
      workspace_id: w.id,
      events: [...click(frame.width / 2, frame.height / 4), { type: "key", action: "down", key: "a", code: "KeyA", modifiers: 0 }, { type: "key", action: "up", key: "a", code: "KeyA", modifiers: 0 }, { type: "text", text: "-typed" }],
    });
    // A script's title change is no navigation, so it shows in a snapshot, not in browser.state.
    const title = async () => (await client.call("browser.snapshot", { workspace_id: w.id })).title;
    await until(async () => (await title()) === "a-typed");
    await client.call("browser.input", { request_id: "i2", workspace_id: w.id, events: click(frame.width / 2, (frame.height * 3) / 4) });
    await until(async () => (await title()) === "Clicked");

    const snapshot = await client.call("browser.snapshot", { workspace_id: w.id });
    expect(snapshot).toMatchObject({ url: `${origin}/`, title: "Clicked", image: { mime_type: "image/png" } });
    expect(snapshot.refs).toMatch(/button "Press".*\[ref=/);
    expect(snapshot.refs).toMatch(/textbox "Name"/);

    // History, and a hard reload that refetches past the cache.
    await client.call("browser.navigate", { request_id: "n2", workspace_id: w.id, url: `${origin}/two` });
    await until(() => last().title === "Two" && last().can_go_back);
    await client.call("browser.history", { request_id: "h1", workspace_id: w.id, action: "back" });
    await until(() => last().url === `${origin}/` && last().can_go_forward);
    const fetched = requests.length;
    await client.call("browser.history", { request_id: "h2", workspace_id: w.id, action: "reload", ignore_cache: true });
    await until(() => requests.length > fetched);
    expect(requests.at(-1)).toEqual({ path: "/", cacheControl: "no-cache" });

    // Turning the screencast back on for a viewer that stayed (it holds control) sends a frame, though the page is still.
    await client.call("browser.navigate", { request_id: "n3", workspace_id: w.id, url: `${origin}/change` });
    await until(() => last().title === "Change" && !last().loading);
    await sleep(1500);
    await client.call("browser.screencast", { workspace_id: w.id, enabled: false });
    const paused = frames.length;
    await client.call("browser.screencast", { workspace_id: w.id, enabled: true });
    await until(() => frames.length > paused, 3000);

    // max_fps defers a frame instead of dropping it: the page's last change (the text, 300 ms after red) still arrives.
    await client.call("browser.screencast", { workspace_id: w.id, enabled: true, max_fps: 1 });
    await sleep(1500);
    const before = frames.length;
    await client.call("browser.input", { request_id: "i3", workspace_id: w.id, events: click(frame.width / 2, frame.height / 2) });
    await sleep(3000);
    expect(frames.length).toBeGreaterThan(before);
    expect(frames.at(-1)!.data.length).toBeGreaterThan(2 * frames[before - 1]!.data.length);
    await client.call("browser.screencast", { workspace_id: w.id, enabled: true });

    // Hand back; another connection takes over, so this one is refused until it drops.
    expect(await client.call("browser.control", { request_id: "c1", workspace_id: w.id, controller: "agent" })).toEqual({ controller: "agent" });
    await until(() => last().controller === "agent");
    expect(await other.call("browser.control", { request_id: "c2", workspace_id: w.id, controller: "user" })).toEqual({ controller: "user" });
    await until(() => last().controller === "user");
    expect(await reason(client.call("browser.control", { request_id: "c3", workspace_id: w.id, controller: "user" }))).toBe("user_in_control");
    other.close();
    await until(() => last().controller === "agent");

    // A connection that drops while its control call is still attaching leaves no viewer, and no control, behind.
    const opened: Array<string> = [];
    const quitter = connect(runtime.url, runtime.token, (state) => opened.push(state));
    await until(() => opened.includes("open"));
    void quitter.call("browser.control", { request_id: "c4", workspace_id: w.id, controller: "user" }).catch(() => undefined);
    await sleep(30);
    quitter.close();
    await sleep(3000);
    expect(last().controller).toBe("agent");
    expect(await client.call("browser.control", { request_id: "c5", workspace_id: w.id, controller: "user" })).toEqual({ controller: "user" });
    // A window without a viewer hears the tab's real controller.
    const bystander = connect(runtime.url, runtime.token);
    expect(await bystander.call("browser.control", { request_id: "c6", workspace_id: w.id, controller: "agent" })).toEqual({ controller: "user" });
    bystander.close();
    expect(await client.call("browser.control", { request_id: "c7", workspace_id: w.id, controller: "agent" })).toEqual({ controller: "agent" });

    // Frames are reported in the page's CSS pixels: stills and screencast frames share one size, so input maps 1:1.
    expect(new Set(frames.map((f) => `${f.width}x${f.height}`)).size).toBe(1);

    // Screencast off: no more frames.
    await client.call("browser.screencast", { workspace_id: w.id, enabled: false });
    const count = frames.length;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(frames.length).toBe(count);
  } finally {
    client.close();
    other.close();
    await runtime.close();
    site.close();
  }
});

test.skipIf(!haveBrowser)("archiving a workspace leaves the preview manager with no tabs for its thread", { timeout: 300_000 }, async () => {
  await ensureTestBrowser();
  const runtime = await startRuntime(await makeConfig(), await loadTranscript(), undefined, { browser: true });
  const client = connect(runtime.url, runtime.token);
  try {
    const manager = Context.get(runtime.context as unknown as Context.Context<PreviewManager.PreviewManager>, PreviewManager.PreviewManager);
    const w = await client.call("workspace.create", { request_id: "w", repo: { path: makeRepo(root, { "README.md": "hi\n" }) }, engine: "claude-agent", options: { model: MODEL } });
    const tabs = () => Effect.runPromise(manager.list({ threadId: ThreadId.make(`caveman:${w.id}`) })).then((r) => r.sessions.length);
    await client.call("browser.screencast", { workspace_id: w.id, enabled: true });
    expect(await tabs()).toBe(1);
    await client.call("workspace.archive", { request_id: "a", workspace_id: w.id });
    await until(async () => (await tabs()) === 0);
  } finally {
    client.close();
    await runtime.close();
  }
});

test.skipIf(!haveBrowser)("the agent opening a page tells every window, and windows watching another tab follow it there", { timeout: 300_000 }, async () => {
  await ensureTestBrowser();
  const site = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(request.url === "/two" ? PAGE_TWO : PAGE_ONE);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const runtime = await startRuntime(await makeConfig(), await loadTranscript(), undefined, { browser: true });
  const watcher = connect(runtime.url, runtime.token);
  const bystander = connect(runtime.url, runtime.token);
  try {
    const w = await watcher.call("workspace.create", { request_id: "w", repo: { path: makeRepo(root, { "README.md": "hi\n" }) }, engine: "claude-agent", options: { model: MODEL } });
    const watched: Array<NotificationParams<"browser.state">> = [];
    const heard: Array<NotificationParams<"browser.state">> = [];
    watcher.on("browser.state", (s) => watched.push(s));
    bystander.on("browser.state", (s) => heard.push(s));

    // The person's own tab, watched in one window.
    await watcher.call("browser.navigate", { request_id: "n1", workspace_id: w.id, url: `${origin}/` });
    await watcher.call("browser.screencast", { workspace_id: w.id, enabled: true });
    await until(() => watched.at(-1)?.title === "One" && !watched.at(-1)!.loading, 60_000);
    await watcher.call("browser.control", { request_id: "c1", workspace_id: w.id, controller: "agent" });
    // A navigation is told only to the windows watching.
    expect(heard).toEqual([]);

    // The agent's preview_open, as its MCP call reaches the broker: a tab of its own, shown.
    const broker = Context.get(runtime.context as unknown as Context.Context<PreviewAutomationBroker.PreviewAutomationBroker>, PreviewAutomationBroker.PreviewAutomationBroker);
    const environment = Context.get(runtime.context as unknown as Context.Context<ServerEnvironment.ServerEnvironment>, ServerEnvironment.ServerEnvironment);
    const scope = {
      environmentId: await Effect.runPromise(environment.getEnvironmentId),
      thread: { threadId: ThreadId.make(`caveman:${w.id}`), providerSessionId: "agent-1", providerInstanceId: ProviderInstanceId.make("claudeAgent") },
      client: undefined,
      requestNamespace: "browser-reveal-test",
      capabilities: new Set(["preview"] as const),
      issuedAt: 1,
    };
    const opened = await Effect.runPromise(broker.invoke<PreviewAutomationStatus>({ scope, operation: "open", input: { url: `${origin}/two`, reuseExistingTab: true }, timeoutMs: 120_000 }));
    expect(opened.url).toBe(`${origin}/two`);

    // A window with no view of the browser hears it once, with reveal; the watching window too, and its view moves to the agent's tab.
    await until(() => heard.some((s) => s.reveal === true), 10_000);
    expect(heard.filter((s) => s.reveal)).toHaveLength(1);
    expect(heard.find((s) => s.reveal)).toMatchObject({ workspace_id: w.id, url: `${origin}/two`, controller: "agent" });
    await until(() => watched.some((s) => s.reveal === true) && watched.at(-1)!.url === `${origin}/two`, 10_000);
    const snapshot = await watcher.call("browser.snapshot", { workspace_id: w.id });
    expect(snapshot).toMatchObject({ url: `${origin}/two`, title: "Two" });

    // Showing the same tab again is a fresh reveal; the agent's navigations in it are not.
    await Effect.runPromise(broker.invoke({ scope, operation: "open", input: { reuseExistingTab: true }, timeoutMs: 60_000 }));
    await until(() => heard.filter((s) => s.reveal).length === 2, 10_000);
    await Effect.runPromise(broker.invoke({ scope, operation: "navigate", input: { url: `${origin}/` }, timeoutMs: 60_000 }));
    await until(() => watched.at(-1)?.url === `${origin}/` && !watched.at(-1)!.loading, 10_000);
    await sleep(300);
    expect(heard.filter((s) => s.reveal)).toHaveLength(2);

    // The agent using its browser is told to every window too, at most every few seconds; a status read is not using it.
    await sleep(ACTIVE_NOTICE_MS);
    const told = heard.filter((s) => s.active).length;
    expect(told).toBeGreaterThan(0);
    await Effect.runPromise(broker.invoke({ scope, operation: "status", input: {}, timeoutMs: 60_000 }));
    await sleep(300);
    expect(heard.filter((s) => s.active)).toHaveLength(told);
    await Effect.runPromise(broker.invoke({ scope, operation: "snapshot", input: {}, timeoutMs: 60_000 }));
    await until(() => heard.filter((s) => s.active).length === told + 1, 10_000);
    expect(heard.at(-1)).toMatchObject({ workspace_id: w.id, url: `${origin}/`, active: true });
    expect(heard.at(-1)!.reveal).toBeUndefined();
    // The watching window hears it about the tab it watches.
    await until(() => watched.at(-1)?.active === true, 10_000);
    expect(watched.at(-1)).toMatchObject({ url: `${origin}/` });
  } finally {
    watcher.close();
    bystander.close();
    await runtime.close();
    site.close();
  }
});

test.skipIf(!haveBrowser)("a window watching the agent's tab hears it close, and streams the agent's next tab", { timeout: 300_000 }, async () => {
  await ensureTestBrowser();
  const site = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(request.url === "/two" ? PAGE_TWO : PAGE_ONE);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const runtime = await startRuntime(await makeConfig(), await loadTranscript(), undefined, { browser: true });
  const watcher = connect(runtime.url, runtime.token);
  try {
    const w = await watcher.call("workspace.create", { request_id: "w", repo: { path: makeRepo(root, { "README.md": "hi\n" }) }, engine: "claude-agent", options: { model: MODEL } });
    const watched: Array<NotificationParams<"browser.state">> = [];
    let frames = 0;
    watcher.on("browser.state", (s) => watched.push(s));
    watcher.on("browser.frame", () => frames++);
    const broker = Context.get(runtime.context as unknown as Context.Context<PreviewAutomationBroker.PreviewAutomationBroker>, PreviewAutomationBroker.PreviewAutomationBroker);
    const manager = Context.get(runtime.context as unknown as Context.Context<PreviewManager.PreviewManager>, PreviewManager.PreviewManager);
    const environment = Context.get(runtime.context as unknown as Context.Context<ServerEnvironment.ServerEnvironment>, ServerEnvironment.ServerEnvironment);
    const threadId = ThreadId.make(`caveman:${w.id}`);
    const scope = {
      environmentId: await Effect.runPromise(environment.getEnvironmentId),
      thread: { threadId, providerSessionId: "agent-1", providerInstanceId: ProviderInstanceId.make("claudeAgent") },
      client: undefined,
      requestNamespace: "browser-close-test",
      capabilities: new Set(["preview"] as const),
      issuedAt: 1,
    };
    const open = (url: string) => Effect.runPromise(broker.invoke<PreviewAutomationStatus>({ scope, operation: "open", input: { url }, timeoutMs: 120_000 }));

    // The agent shows a page in the window; the window's own (blank) tab stays open behind it.
    await watcher.call("browser.screencast", { workspace_id: w.id, enabled: true });
    const { tabId } = await open(`${origin}/`);
    await until(() => watched.at(-1)?.title === "One" && !watched.at(-1)!.loading && frames > 0, 60_000);

    // Done with it, the agent closes its tab (preview_close before it replies): the window follows to the tab that is
    // left and hears it, rather than keeping the closed page's last frame.
    await Effect.runPromise(broker.invoke({ scope, operation: "close", input: {}, tabId: tabId!, timeoutMs: 60_000 }));
    await until(() => watched.at(-1)?.url === "about:blank", 10_000);
    expect(watched.at(-1)).toMatchObject({ workspace_id: w.id, url: "about:blank", loading: false });

    // With no tab left at all (the idle sweep closed it), the window hears its browser is empty.
    for (const session of (await Effect.runPromise(manager.list({ threadId }))).sessions) await Effect.runPromise(manager.close({ threadId, tabId: session.tabId }));
    const told = watched.length;
    await until(() => watched.length > told, 10_000);
    expect(watched.at(-1)).toMatchObject({ workspace_id: w.id, url: "about:blank", title: "", loading: false, controller: "none" });
    expect((await Effect.runPromise(manager.list({ threadId }))).sessions).toEqual([]);

    // Its next page streams to the same window without the window asking again.
    const before = frames;
    await open(`${origin}/two`);
    await until(() => watched.at(-1)?.title === "Two" && !watched.at(-1)!.loading && frames > before, 60_000);
  } finally {
    watcher.close();
    await runtime.close();
    site.close();
  }
});

// One button over the whole page; its click asks confirm() and names the page with the answer.
const PAGE_CONFIRM = `<!doctype html><title>Rows</title>
<style>body{margin:0}button{position:fixed;inset:0;width:100vw;height:100vh;border:0}</style>
<button onclick="document.title = confirm('Delete row?') ? 'yes' : 'no'">Delete row</button>`;

/** "ok" once the call answers, "timeout" if it is still waiting after `ms`. */
const settles = (promise: Promise<unknown>, ms = 10_000) =>
  Promise.race([promise.then(() => "ok"), sleep(ms).then(() => "timeout")]);

test.skipIf(!haveBrowser)("a page's dialog goes to the person driving it, and waits for the next one without holding up any browser", { timeout: 300_000 }, async () => {
  await ensureTestBrowser();
  const site = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(PAGE_CONFIRM);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const runtime = await startRuntime(await makeConfig(), await loadTranscript(), undefined, { browser: true });
  const first = connect(runtime.url, runtime.token);
  const second = connect(runtime.url, runtime.token);
  const third = connect(runtime.url, runtime.token);
  try {
    const w = await first.call("workspace.create", { request_id: "w", repo: { path: makeRepo(root, { "README.md": "hi\n" }) }, engine: "claude-agent", options: { model: MODEL } });
    const states: Array<NotificationParams<"browser.state">> = [];
    const secondStates: Array<NotificationParams<"browser.state">> = [];
    const frames: Array<NotificationParams<"browser.frame">> = [];
    first.on("browser.state", (s) => states.push(s));
    second.on("browser.state", (s) => secondStates.push(s));
    first.on("browser.frame", (f) => frames.push(f));
    const last = () => states.at(-1)!;
    const title = async () => (await second.call("browser.snapshot", { workspace_id: w.id })).title;

    await first.call("browser.screencast", { workspace_id: w.id, enabled: true });
    await first.call("browser.navigate", { request_id: "n1", workspace_id: w.id, url: `${origin}/` });
    await until(() => last()?.title === "Rows" && !last().loading && last().controller === "user" && frames.length > 0, 60_000);
    const frame = frames.at(-1)!;
    const click = (["down", "up"] as const).map((action) => ({ type: "pointer" as const, action, button: "left" as const, x: frame.width / 2, y: frame.height / 2, modifiers: 0 }));

    // The click's call answers while the page waits on its confirm(), which the person sees in browser.state.
    expect(await settles(first.call("browser.input", { request_id: "i1", workspace_id: w.id, events: click }))).toBe("ok");
    await until(() => last().dialog !== undefined);
    expect(last().dialog).toEqual({ type: "confirm", message: "Delete row?", default_value: "" });
    // Their answer lets the page go on.
    expect(await settles(first.call("browser.input", { request_id: "i2", workspace_id: w.id, events: [{ type: "dialog", accept: true }] }))).toBe("ok");
    await until(() => last().dialog === undefined);
    await until(async () => (await title()) === "yes");

    // Asked again, they hand back and close the window without answering; neither waits on the page.
    expect(await settles(first.call("browser.input", { request_id: "i3", workspace_id: w.id, events: click }))).toBe("ok");
    await until(() => last().dialog !== undefined);
    expect(await settles(first.call("browser.control", { request_id: "c1", workspace_id: w.id, controller: "agent" }))).toBe("ok");
    first.close();

    // Another window takes the browser and gets the dialog; another workspace's browser opens meanwhile.
    expect(await settles(second.call("browser.control", { request_id: "c2", workspace_id: w.id, controller: "user" }))).toBe("ok");
    await second.call("browser.screencast", { workspace_id: w.id, enabled: true });
    await until(() => secondStates.at(-1)?.dialog?.message === "Delete row?");
    const other = await third.call("workspace.create", { request_id: "w2", repo: { path: makeRepo(root, { "README.md": "two\n" }) }, engine: "claude-agent", options: { model: MODEL } });
    expect(await settles(third.call("browser.screencast", { workspace_id: other.id, enabled: true }), 30_000)).toBe("ok");
    expect(await settles(second.call("browser.input", { request_id: "i4", workspace_id: w.id, events: [{ type: "dialog", accept: false }] }))).toBe("ok");
    await until(() => secondStates.at(-1)?.dialog === undefined);
    await until(async () => (await title()) === "no");
  } finally {
    first.close();
    second.close();
    third.close();
    await runtime.close();
    site.close();
  }
});
