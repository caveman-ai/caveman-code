import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as NodeZlib from "node:zlib";

import { createScrubber } from "@caveman-app/session-protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as Effect from "effect/Effect";

import { accountVault } from "../cloudLink/accountCredentials.ts";
import { CODEX_VAULT_KEY_STAND_IN, EngineCloudKeys, VAULT_KEY_STAND_IN, withEngineKey } from "../cloudLink/engineKeys.ts";
import { appProxy, codexProxy } from "../router/proxyLauncher.ts";
import { ANTHROPIC_VIA_PROXY, CODEX_VIA_PROXY, encodeForUpstream, OPENAI_VIA_PROXY, startEgressProxy, type EgressProxy } from "./EgressScrub.ts";

vi.mock("node:https", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:https")>();
  return { ...actual, request: vi.fn(actual.request) };
});

// Long enough to be hideable, with characters JSON, URL and base64 each encode differently.
const CANARY = 'cvs-canary_7Hq"x/y+z=Q9w8e7r6t5';
const scrubber = createScrubber([{ name: "CANARY_SECRET", value: CANARY }]);
const b64 = (s: string) => Buffer.from(s).toString("base64");
const FORMS = [
  CANARY,
  JSON.stringify(CANARY).slice(1, -1),
  encodeURIComponent(CANARY),
  b64(CANARY).replace(/=+$/, ""),
  Buffer.from(CANARY).toString("base64url"),
];

interface Captured {
  readonly url: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

let upstream: NodeHttp.Server;
let upstreamUrl = "";
const captured: Captured[] = [];
let releaseSecondEvent: () => void = () => {};
let releaseTail: () => void = () => {};
const tails: Array<{ aborted: boolean; ended: boolean }> = [];

let proxy: EgressProxy;
let failScrub = false;

beforeAll(async () => {
  upstream = NodeHttp.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      captured.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      const first = {
        answered: 'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        unanswered: "data: partial\n\n",
        // A model writing about SSE: every marker, inside its JSON text (newlines escaped), none of them the end.
        mentioned: `data: ${JSON.stringify({ type: "response.output_text.delta", delta: 'on event: response.completed\ndata: {"type":"response.completed"} or data: [DONE] or event: message_stop' })}\n\n`,
        // The last event, then a stream that never ends.
        endless: 'event: response.completed\ndata: {"type":"response.completed"}\n\n',
      }[req.url?.split("/").pop() ?? ""];
      if (first !== undefined) {
        // An answer whose last event is out (or not yet), with a little more to come.
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(first);
        const tail = { aborted: false, ended: false };
        tails.push(tail);
        res.on("close", () => void (tail.aborted = !res.writableEnded));
        if (!req.url!.endsWith("/endless")) new Promise<void>((resolve) => (releaseTail = resolve)).then(() => res.end("\n", () => void (tail.ended = true)));
        return;
      }
      if (req.url?.endsWith("/stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
        new Promise<void>((resolve) => (releaseSecondEvent = resolve)).then(() => res.end("data: second\n\n"));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "x-upstream": "yes" });
      res.end('{"ok":true}');
    });
  });
  // As real upstreams idle (caveman-proxy 2 min): Node's 5 s default equals the scrub's free-socket timeout, so a
  // request after a slow test (the PEM key's) could go out on a socket the stub is closing.
  upstream.keepAliveTimeout = 60_000;
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as NodeNet.AddressInfo).port}/base`;
  proxy = await startEgressProxy({
    scrubber: () => {
      if (failScrub) throw new Error("scrubber exploded");
      return scrubber;
    },
  });
});

afterAll(async () => {
  await proxy.close();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

const leaked = (text: string) => FORMS.filter((form) => text.includes(form));

describe("egress scrub proxy", () => {
  it("never forwards the canary in raw, JSON, URL or base64 form", async () => {
    captured.length = 0;
    const body = JSON.stringify({
      messages: [
        { role: "user", content: `cat .env\nCANARY_SECRET=${CANARY}` },
        { role: "tool", content: `url ${encodeURIComponent(CANARY)} and basic ${b64(`user:${CANARY}`)}` },
        { role: "tool", content: `b64 ${b64(CANARY)} b64url ${Buffer.from(CANARY).toString("base64url")}` },
      ],
    });
    // The body really carries every form before the proxy sees it.
    expect(leaked(body).length).toBeGreaterThanOrEqual(4);
    const res = await fetch(`${proxy.route(upstreamUrl)}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer engine-own-token", "x-cave-session": "caveman:thread-1", "x-personal": "kept" },
      body,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-upstream")).toBe("yes");
    expect(await res.json()).toEqual({ ok: true });
    expect(captured).toHaveLength(1);
    const seen = captured[0]!;
    expect(seen.url).toBe("/base/v1/messages?beta=true");
    expect(seen.headers.authorization).toBe("Bearer engine-own-token");
    expect(seen.headers["x-cave-session"]).toBeUndefined();
    expect(seen.headers["x-personal"]).toBe("kept");
    expect(leaked(seen.body)).toEqual([]);
    expect(seen.body).toContain("[secret:CANARY_SECRET]");
    expect(Number(seen.headers["content-length"])).toBe(Buffer.byteLength(seen.body));
    // Still JSON: the replacement never breaks the document.
    expect(() => JSON.parse(seen.body)).not.toThrow();
  });

  it("never forwards a PEM key the agent read from a dotenv file (escaped newlines), in a JSON body", async () => {
    const pem = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 1024 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    // Stored with real newlines (imported or pasted); the .env holds it dotenv-escaped.
    const pemScrubber = createScrubber([{ name: "FIREBASE_PRIVATE_KEY", value: pem }]);
    const pemProxy = await startEgressProxy({ scrubber: () => pemScrubber });
    try {
      captured.length = 0;
      const dotenvLine = `FIREBASE_PRIVATE_KEY="${pem.replace(/\n/g, "\\n")}"`;
      const body = JSON.stringify({ messages: [{ role: "tool", content: `cat .env\n${dotenvLine}\n` }, { role: "tool", content: pem }] });
      const res = await fetch(`${pemProxy.route(upstreamUrl)}/v1/messages`, { method: "POST", body });
      expect(res.status).toBe(200);
      const seen = captured[0]!.body;
      // No line of the key body survives in any form.
      const keyLines = pem.split("\n").filter((line) => line.length > 20 && !line.startsWith("-----"));
      expect(keyLines.length).toBeGreaterThan(3);
      for (const line of keyLines) expect(seen).not.toContain(line);
      expect(seen).toContain("[secret:FIREBASE_PRIVATE_KEY]");
    } finally {
      await pemProxy.close();
    }
  });

  it("a kept-alive socket cut under a request: a GET goes out again on a fresh one, a POST the upstream read is never sent twice", async () => {
    // Answers the first request on each connection; a second one on the same socket is read, then cut. No answer
    // does not mean the upstream never got it: a model call sent again would be paid for twice.
    const received: Array<string> = [];
    const flaky = NodeHttp.createServer((req, res) => {
      received.push(`${req.method} ${req.url}`);
      const socket = req.socket as NodeNet.Socket & { served?: boolean };
      if (socket.served) return void socket.destroy();
      socket.served = true;
      req.resume();
      req.on("end", () => res.end('{"ok":true}'));
    });
    await new Promise<void>((resolve) => flaky.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(flaky.address() as NodeNet.AddressInfo).port}`;
    try {
      const statuses: Array<number> = [];
      for (const [method, n] of [["GET", 1], ["GET", 2], ["POST", 3], ["POST", 4]] as const) {
        const res = await fetch(`${proxy.route(base)}/call-${n}`, { method, ...(method === "POST" ? { body: "{}" } : {}) });
        statuses.push(res.status);
        await res.text();
      }
      expect(statuses).toEqual([200, 200, 502, 200]);
      expect(received).toEqual(["GET /call-1", "GET /call-2", "GET /call-2", "POST /call-3", "POST /call-4"]);
    } finally {
      flaky.close();
      flaky.closeAllConnections();
    }
  });

  it("scrubs gzip, br and zstd bodies and forwards them uncompressed", async () => {
    const body = JSON.stringify({ input: `secret ${CANARY}` });
    const encodings: Array<[string, Buffer]> = [
      ["gzip", NodeZlib.gzipSync(body)],
      ["br", NodeZlib.brotliCompressSync(body)],
      ["zstd", NodeZlib.zstdCompressSync(body)],
    ];
    for (const [encoding, compressed] of encodings) {
      captured.length = 0;
      const res = await fetch(`${proxy.route(upstreamUrl)}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-encoding": encoding },
        body: compressed,
      });
      expect(res.status, encoding).toBe(200);
      const seen = captured[0]!;
      expect(seen.headers["content-encoding"], encoding).toBeUndefined();
      expect(leaked(seen.body), encoding).toEqual([]);
      expect(JSON.parse(seen.body), encoding).toEqual({ input: "secret [secret:CANARY_SECRET]" });
    }
  });

  it("Codex goes to its own app proxy, and its ChatGPT route names the app's Codex as /w/ would", async () => {
    const origin = new URL(upstreamUrl).origin;
    const codex = vi.spyOn(codexProxy, "url").mockReturnValue(`${origin}/codex-proxy`);
    const app = vi.spyOn(appProxy, "url").mockReturnValue(`${origin}/app-proxy`);
    try {
      const send = (upstream: string, headers: Record<string, string>) =>
        fetch(`${proxy.route(upstream)}/responses`, { method: "POST", headers: { "content-type": "application/json", "x-cave-session": "thread-1", "x-cave-probe": "kept", ...headers }, body: "{}" });
      captured.length = 0;
      expect((await send(CODEX_VIA_PROXY, { "chatgpt-account-id": "acct-1" })).status).toBe(200);
      expect((await send(CODEX_VIA_PROXY, { authorization: "Bearer sk-key" })).status).toBe(200);
      expect((await send(OPENAI_VIA_PROXY, { "chatgpt-account-id": "acct-1" })).status).toBe(200);
      expect(captured.map((c) => [c.url, c.headers["x-cave-agent"]])).toEqual([
        ["/codex-proxy/chatgpt/responses", "caveman-code-codex"],
        // The slug is in the path there: nothing added.
        ["/codex-proxy/w/caveman-code-codex/v1/responses", undefined],
        // OpenCode's OpenAI traffic: the proxy that compresses only what carries caveman_retrieve.
        ["/app-proxy/chatgpt/responses", "caveman-code-codex"],
      ]);
      expect(captured.every((c) => c.headers["x-cave-session"] === "thread-1" && c.headers["x-cave-probe"] === "kept")).toBe(true);
    } finally {
      codex.mockRestore();
      app.mockRestore();
    }
  });

  it("drops every x-cave header on provider fallbacks when the app proxies are down", async () => {
    const app = vi.spyOn(appProxy, "url").mockReturnValue(undefined);
    const codex = vi.spyOn(codexProxy, "url").mockReturnValue(undefined);
    const targets: Array<string> = [];
    const request = vi.mocked(NodeHttps.request).mockImplementation(((target: URL, options: NodeHttp.RequestOptions) => {
      targets.push(target.origin);
      return NodeHttp.request(new URL(upstreamUrl), options);
    }) as typeof NodeHttps.request);
    try {
      captured.length = 0;
      for (const [route, chatgpt] of [[ANTHROPIC_VIA_PROXY, false], [CODEX_VIA_PROXY, false], [CODEX_VIA_PROXY, true], [OPENAI_VIA_PROXY, true]] as const) {
        const response = await fetch(`${proxy.route(route)}/request`, {
          method: "POST", body: "{}",
          headers: { "x-cave-session": "private-thread", "x-cave-agent": "private-agent", "X-Cave-Other": "private", "x-personal": "kept", ...(chatgpt ? { "chatgpt-account-id": "account" } : {}) },
        });
        expect(response.status).toBe(200);
        await response.text();
      }
      expect(targets).toEqual(["https://api.anthropic.com", "https://api.openai.com", "https://chatgpt.com", "https://chatgpt.com"]);
      expect(captured).toHaveLength(4);
      for (const request of captured) {
        expect(Object.keys(request.headers).filter((name) => name.startsWith("x-cave-"))).toEqual([]);
        expect(request.headers["x-personal"]).toBe("kept");
      }
    } finally {
      request.mockRestore(); app.mockRestore(); codex.mockRestore();
    }
  });

  it("Claude Agent's vault key goes in here, only on the way to Anthropic through the app's proxy; claude holds a stand-in", async () => {
    const origin = new URL(upstreamUrl).origin;
    const app = vi.spyOn(appProxy, "url").mockReturnValue(`${origin}/app-proxy`);
    try {
      const env = await Effect.runPromise(
        withEngineKey("claude-agent", { KEEP: "1" }).pipe(Effect.provideService(EngineCloudKeys, { get: () => Effect.succeed(("sk-" + "ant-vault-canary")), set: () => Effect.void })),
      );
      // What the agent can read (claude's environment) is the stand-in, never the key.
      expect(env).toEqual({ KEEP: "1", ANTHROPIC_API_KEY: VAULT_KEY_STAND_IN });
      const send = (upstream: string, key: string) =>
        fetch(`${proxy.route(upstream)}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key }, body: "{}" });
      captured.length = 0;
      expect((await send(ANTHROPIC_VIA_PROXY, VAULT_KEY_STAND_IN)).status).toBe(200);
      // Anywhere else (a base URL the repo's .claude/settings.json names) gets the stand-in as it came.
      expect((await send(upstreamUrl, VAULT_KEY_STAND_IN)).status).toBe(200);
      // A key that is not the stand-in passes through untouched.
      expect((await send(ANTHROPIC_VIA_PROXY, "sk-ant-own-key")).status).toBe(200);
      expect(captured.map((c) => [c.url, c.headers["x-api-key"]])).toEqual([
        ["/app-proxy/w/caveman-code-claude/v1/messages", ("sk-" + "ant-vault-canary")],
        ["/base/v1/messages", VAULT_KEY_STAND_IN],
        ["/app-proxy/w/caveman-code-claude/v1/messages", "sk-ant-own-key"],
      ]);
    } finally {
      app.mockRestore();
    }
  });

  it("Codex's vault key goes in here as its bearer, only on the way to OpenAI through the app's proxy; codex holds a stand-in", async () => {
    const origin = new URL(upstreamUrl).origin;
    const codex = vi.spyOn(codexProxy, "url").mockReturnValue(`${origin}/codex-proxy`);
    try {
      const env = await Effect.runPromise(
        withEngineKey("codex", { KEEP: "1" }).pipe(Effect.provideService(EngineCloudKeys, { get: (engine) => Effect.succeed(engine === "codex" ? "sk-proj-vault-canary" : undefined), set: () => Effect.void })),
      );
      // What the agent can read (codex's environment) is the stand-in, never the key.
      expect(env).toEqual({ KEEP: "1", OPENAI_API_KEY: CODEX_VAULT_KEY_STAND_IN, CODEX_API_KEY: CODEX_VAULT_KEY_STAND_IN });
      const send = (upstream: string, key: string) =>
        fetch(`${proxy.route(upstream)}/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: "{}" });
      captured.length = 0;
      expect((await send(CODEX_VIA_PROXY, CODEX_VAULT_KEY_STAND_IN)).status).toBe(200);
      // Elsewhere it stays a stand-in, and Claude Agent's stand-in never opens Codex's key.
      expect((await send(upstreamUrl, CODEX_VAULT_KEY_STAND_IN)).status).toBe(200);
      expect((await send(CODEX_VIA_PROXY, VAULT_KEY_STAND_IN)).status).toBe(200);
      expect(captured.map((c) => [c.url, c.headers.authorization])).toEqual([
        ["/codex-proxy/w/caveman-code-codex/v1/responses", ("Bearer sk-" + "proj-vault-canary")],
        ["/base/responses", `Bearer ${CODEX_VAULT_KEY_STAND_IN}`],
        ["/codex-proxy/w/caveman-code-codex/v1/responses", `Bearer ${VAULT_KEY_STAND_IN}`],
      ]);
    } finally {
      codex.mockRestore();
    }
  });

  it("Codex text generation on a vault key reaches OpenAI through the app proxy with the key, not the stand-in", async () => {
    const origin = new URL(upstreamUrl).origin;
    const app = vi.spyOn(appProxy, "url").mockReturnValue(`${origin}/app-proxy`);
    const codex = vi.spyOn(codexProxy, "url").mockReturnValue(`${origin}/codex-proxy`);
    try {
      await Effect.runPromise(
        withEngineKey("codex", {}).pipe(Effect.provideService(EngineCloudKeys, { get: (engine) => Effect.succeed(engine === "codex" ? "sk-proj-vault-canary" : undefined), set: () => Effect.void })),
      );
      const send = (upstream: string, key: string) =>
        fetch(`${proxy.route(upstream)}/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: "{}" });
      captured.length = 0;
      // routeCodexTextGeneration's route (EngineEgress.ts): the app proxy's Codex route, not the Codex proxy's.
      expect((await send(OPENAI_VIA_PROXY, CODEX_VAULT_KEY_STAND_IN)).status).toBe(200);
      // Claude Agent's stand-in never opens Codex's key there either.
      expect((await send(OPENAI_VIA_PROXY, VAULT_KEY_STAND_IN)).status).toBe(200);
      // The app proxy's Claude route is not OpenAI's.
      expect((await send(ANTHROPIC_VIA_PROXY, CODEX_VAULT_KEY_STAND_IN)).status).toBe(200);
      expect(captured.map((c) => [c.url, c.headers.authorization])).toEqual([
        ["/app-proxy/w/caveman-code-codex/v1/responses", ("Bearer sk-" + "proj-vault-canary")],
        ["/app-proxy/w/caveman-code-codex/v1/responses", `Bearer ${VAULT_KEY_STAND_IN}`],
        ["/app-proxy/w/caveman-code-claude/responses", `Bearer ${CODEX_VAULT_KEY_STAND_IN}`],
      ]);
    } finally {
      app.mockRestore();
      codex.mockRestore();
    }
  });

  it("a service account's host-bound variable goes in here only toward one of its hosts; anywhere else it stays a stand-in", async () => {
    const [local, stripe] = accountVault.take(
      [{ name: "LOCAL_KEY", value: "local-bound-value-0123456789", hosts: ["127.0.0.1"] }, { name: "STRIPE_KEY", value: ("sk_" + "live_bound_value_0123456789"), hosts: ["api.stripe.com"] }],
      [],
    );
    try {
      captured.length = 0;
      const response = await fetch(`${proxy.route(upstreamUrl)}/v1/charges`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${local!.value}`, "x-stripe": stripe!.value },
        body: "{}",
      });
      expect(response.status).toBe(200);
      await response.text();
      // 127.0.0.1 is LOCAL_KEY's host: its value goes; STRIPE_KEY's host is not, so its stand-in goes as it came.
      expect(captured.map((c) => [c.headers.authorization, c.headers["x-stripe"]])).toEqual([["Bearer local-bound-value-0123456789", stripe!.value]]);
      expect(JSON.stringify(captured)).not.toContain(("sk_" + "live_bound_value_0123456789"));
      // Withdrawn (a disabled account, a shared computer): the stand-in goes as it came, toward its own host too.
      accountVault.clear();
      captured.length = 0;
      await (await fetch(`${proxy.route(upstreamUrl)}/v1/charges`, { method: "POST", headers: { authorization: `Bearer ${local!.value}` }, body: "{}" })).text();
      expect(captured.map((c) => c.headers.authorization)).toEqual([`Bearer ${local!.value}`]);
    } finally {
      accountVault.clear();
    }
  });

  it("gzips the scrubbed body for Anthropic's Messages API only", async () => {
    const body = Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "x".repeat(4096) }] }));
    const anthropic = await encodeForUpstream(body, new URL("https://api.anthropic.com/v1/messages?beta=true"));
    expect(anthropic.encoding).toBe("gzip");
    expect(anthropic.body.length).toBeLessThan(body.length);
    expect(NodeZlib.gunzipSync(anthropic.body).equals(body)).toBe(true);
    for (const other of [
      "https://api.openai.com/v1/responses",
      "https://chatgpt.com/backend-api/codex/responses",
      "http://api.anthropic.com/v1/messages",
      "https://api.anthropic.com/v1/files",
      "https://api.anthropic.com/v1/messages/count_tokens",
      `${upstreamUrl}/v1/messages`,
    ]) {
      const plain = await encodeForUpstream(body, new URL(other));
      expect(plain.encoding, other).toBeUndefined();
      expect(plain.body, other).toBe(body);
    }
    expect((await encodeForUpstream(Buffer.alloc(0), new URL("https://api.anthropic.com/v1/messages"))).encoding).toBeUndefined();
  });

  it("streams SSE through incrementally", async () => {
    captured.length = 0;
    const res = await fetch(`${proxy.route(upstreamUrl)}/stream`, { method: "POST", body: "{}" });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    // The upstream holds its second event until the client has the first:
    // a buffering proxy would hang here.
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe("data: first\n\n");
    releaseSecondEvent();
    let rest = "";
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += decoder.decode(chunk.value);
    expect(rest).toBe("data: second\n\n");
  });

  it("an engine that stops reading at its answer's last event lets the upstream finish; one that hangs up mid-answer stops it", async () => {
    // "mentioned": the model's own text names every end marker; only the stream's own last event counts.
    for (const [path, finishes] of [["answered", true], ["unanswered", false], ["mentioned", false]] as const) {
      const abort = new AbortController();
      const res = await fetch(`${proxy.route(upstreamUrl)}/${path}`, { method: "POST", body: "{}", signal: abort.signal });
      await res.body!.getReader().read();
      abort.abort();
      await new Promise((r) => setTimeout(r, 100));
      releaseTail();
      await new Promise((r) => setTimeout(r, 100));
      expect(tails.at(-1), path).toEqual(finishes ? { aborted: false, ended: true } : { aborted: true, ended: false });
    }
  });

  it("a finished answer the engine stopped reading drains for a bounded time, never forever", async () => {
    const short = await startEgressProxy({ scrubber: () => scrubber, drainMs: 200 });
    try {
      const abort = new AbortController();
      const res = await fetch(`${short.route(upstreamUrl)}/endless`, { method: "POST", body: "{}", signal: abort.signal });
      await res.body!.getReader().read();
      abort.abort();
      await new Promise((r) => setTimeout(r, 100));
      expect(tails.at(-1)).toEqual({ aborted: false, ended: false });
      await new Promise((r) => setTimeout(r, 400));
      expect(tails.at(-1)).toEqual({ aborted: true, ended: false });
    } finally {
      await short.close();
    }
  });

  it("fails closed: nothing is forwarded when a body cannot be scrubbed", async () => {
    captured.length = 0;
    const route = proxy.route(upstreamUrl);
    failScrub = true;
    const broken = await fetch(`${route}/v1/messages`, { method: "POST", body: `{"x":"${CANARY}"}` });
    failScrub = false;
    expect(broken.status).toBe(502);
    expect(await broken.text()).not.toContain(CANARY);
    const unknownEncoding = await fetch(`${route}/v1/messages`, {
      method: "POST",
      headers: { "content-encoding": "compress" },
      body: `{"x":"${CANARY}"}`,
    });
    expect(unknownEncoding.status).toBe(502);
    const notUtf8 = await fetch(`${route}/v1/messages`, {
      method: "POST",
      body: Buffer.concat([Buffer.from(CANARY), Buffer.from([0xff, 0xfe])]),
    });
    expect(notUtf8.status).toBe(502);
    expect(captured).toHaveLength(0);
  });

  it("is not an open relay: a wrong token or route forwards nothing", async () => {
    captured.length = 0;
    const route = proxy.route(upstreamUrl);
    const port = new URL(route).port;
    const wrongToken = await fetch(`http://127.0.0.1:${port}/${"0".repeat(64)}/${route.split("/").pop()}/v1/messages`, {
      method: "POST",
      body: "{}",
    });
    expect(wrongToken.status).toBe(403);
    const noToken = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", body: "{}" });
    expect(noToken.status).toBe(403);
    const unknownRoute = await fetch(`${route.slice(0, route.lastIndexOf("/"))}/0123456789abcdef/v1/messages`, {
      method: "POST",
      body: "{}",
    });
    expect(unknownRoute.status).toBe(404);
    expect(captured).toHaveLength(0);
    expect(proxy.owns(route)).toBe(true);
    expect(proxy.owns(upstreamUrl)).toBe(false);
  });

  it("refuses WebSocket upgrades", async () => {
    const route = new URL(proxy.route(upstreamUrl));
    const status = await new Promise<string>((resolve, reject) => {
      const socket = NodeNet.connect(Number(route.port), "127.0.0.1", () =>
        socket.write(
          `GET ${route.pathname}/responses HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: upgrade\r\nupgrade: websocket\r\n` +
            "sec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        ),
      );
      socket.once("data", (data) => {
        resolve(data.toString().split("\r\n")[0]!);
        socket.destroy();
      });
      socket.once("error", reject);
    });
    expect(status).toBe("HTTP/1.1 501 Not Implemented");
  });
});
