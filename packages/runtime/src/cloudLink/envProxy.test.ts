// The relay dials through the pod's egress proxy (CONNECT), and NO_PROXY keeps hosts off it.
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import * as tls from "node:tls";

import { afterEach, expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";

import { proxyFor } from "./envProxy.ts";
import { dialRelay, RELAY_SUBPROTOCOL } from "./relay.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("proxyFor: HTTPS_PROXY for wss and https, HTTP_PROXY for ws, and NO_PROXY by host, suffix or port", () => {
  const env = { HTTPS_PROXY: "http://egress.caveman.svc:3128", HTTP_PROXY: "http://plain:3128", NO_PROXY: "127.0.0.1,localhost,.internal.example,api.example.com:8443" };
  expect(proxyFor(new URL("wss://app.caveman.so/relay/v1"), env)?.host).toBe("egress.caveman.svc:3128");
  expect(proxyFor(new URL("ws://app.caveman.so/relay/v1"), env)?.host).toBe("plain:3128");
  expect(proxyFor(new URL("ws://127.0.0.1:4000/relay/v1"), env)).toBeUndefined();
  expect(proxyFor(new URL("https://db.internal.example/x"), env)).toBeUndefined();
  expect(proxyFor(new URL("https://api.example.com:8443/x"), env)).toBeUndefined();
  expect(proxyFor(new URL("https://api.example.com/x"), env)?.host).toBe("egress.caveman.svc:3128");
  expect(proxyFor(new URL("wss://app.caveman.so/relay/v1"), {})).toBeUndefined();
});

test("the relay connection goes through the egress proxy's CONNECT tunnel", async () => {
  // Cloud's relay: answers the upgrade on its own port.
  const relay = http.createServer();
  const wss = new WebSocketServer({ server: relay, handleProtocols: () => RELAY_SUBPROTOCOL });
  const opened: Array<string | undefined> = [];
  wss.on("connection", (ws, request) => {
    opened.push(request.headers.authorization);
    ws.ping();
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => (wss.close(), relay.close(() => resolve()))));
  // The pod's egress proxy: it only tunnels, and records where to.
  const tunnels: Array<string> = [];
  const proxy = http.createServer((_req, res) => res.writeHead(403).end());
  proxy.on("connect", (request: http.IncomingMessage, client: net.Socket) => {
    tunnels.push(request.url ?? "");
    const [host, port] = (request.url ?? "").split(":");
    const upstream = net.connect(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => (proxy.closeAllConnections(), proxy.close(() => resolve()))));

  const saved = { HTTP_PROXY: process.env.HTTP_PROXY, NO_PROXY: process.env.NO_PROXY };
  process.env.HTTP_PROXY = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  process.env.NO_PROXY = "";
  cleanups.push(() => {
    for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value);
  });
  const port = (relay.address() as AddressInfo).port;
  const connection = dialRelay({ url: `ws://127.0.0.1:${port}/relay/v1`, token: "ccrt_test", onOpen: () => ({ message: () => {}, closed: () => {} }), log: () => {} });
  cleanups.push(() => connection.close());
  await connection.opened;
  expect(tunnels).toEqual([`127.0.0.1:${port}`]);
  expect(opened).toEqual(["Bearer ccrt_test"]);
});

// Audit K (relay dial timeout): the relay's dial through the egress proxy had no deadline, so a proxy that took the
// connection and never answered held the dial open for good while heartbeats still showed the computer as up. One timer
// covers the CONNECT and then TLS; the test bounds itself, so the old code fails it instead of hanging.
test("a tunnel the egress proxy never answers, or answers and then goes silent on TLS, fails within the deadline", async () => {
  const { tunnelAgent } = await import("./envProxy.ts");
  const held: Array<net.Socket> = [];
  // Takes the connection and never answers the CONNECT.
  const silent = net.createServer((socket) => void held.push(socket.on("error", () => {})));
  // Answers the CONNECT, then never speaks TLS.
  const opens = net.createServer((socket) => {
    held.push(socket.on("error", () => {}));
    socket.once("data", () => socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"));
  });
  for (const server of [silent, opens]) {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => (server.close(() => resolve()), held.forEach((socket) => socket.destroy()))));
  }
  const dial = (server: net.Server, target: string) =>
    new Promise<string>((resolve) => {
      const proxy = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      const url = new URL(target);
      const started = Date.now();
      const bound = setTimeout(() => resolve("still dialling after 3 s"), 3_000);
      const request = (url.protocol === "https:" ? https : http).request({ host: url.hostname, port: url.port, path: "/", agent: tunnelAgent(proxy, url, { timeoutMs: 300 }) });
      request.on("error", (error) => {
        clearTimeout(bound);
        resolve(`${error.message} after ${Date.now() - started < 2_000 ? "<2 s" : ">2 s"}`);
      });
      request.end();
    });
  expect(await dial(silent, "http://relay.caveman.test:8080/relay/v1")).toBe("the egress proxy did not answer within 0.3 s after <2 s");
  expect(await dial(silent, "https://relay.caveman.test/relay/v1")).toBe("the egress proxy did not answer within 0.3 s after <2 s");
  expect(await dial(opens, "https://relay.caveman.test/relay/v1")).toBe("the egress proxy did not answer within 0.3 s after <2 s");
});

// A test-only self-signed certificate for 127.0.0.1 (outboundHttp.test.ts's), not a secret.
const LOOPBACK_TLS = {
  key: fs.readFileSync(new URL("./testdata/loopback-tls.key.pem", import.meta.url), "utf8"),
  cert: fs.readFileSync(new URL("./testdata/loopback-tls.cert.pem", import.meta.url), "utf8"),
};

// Audit security-3#5: the tunnel spoke plain HTTP to every proxy whatever its scheme, so HTTPS_PROXY=https://user:pw@...
// got its CONNECT and Basic credentials in the clear (on :80 when it named no port), and a TLS proxy never connected.
test("an https:// egress proxy is spoken to over TLS: the relay connects through it, and its credentials never go out in the clear", async () => {
  const defaults = tls.getCACertificates("default");
  tls.setDefaultCACertificates([...defaults, LOOPBACK_TLS.cert]);
  cleanups.push(() => tls.setDefaultCACertificates(defaults));
  // Cloud's relay, over TLS: the tunnel carries TLS inside the proxy's TLS.
  const relay = https.createServer(LOOPBACK_TLS);
  const wss = new WebSocketServer({ server: relay, handleProtocols: () => RELAY_SUBPROTOCOL });
  wss.on("connection", (ws) => ws.ping());
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => (wss.close(), relay.closeAllConnections(), relay.close(() => resolve()))));
  // The https proxy: it takes only TLS, and records each CONNECT with the credentials that came with it.
  const tunnels: Array<{ to: string; auth: string | undefined }> = [];
  const proxy = https.createServer(LOOPBACK_TLS, (_req, res) => res.writeHead(403).end());
  proxy.on("connect", (request: http.IncomingMessage, client: net.Socket) => {
    tunnels.push({ to: request.url ?? "", auth: request.headers["proxy-authorization"] });
    const [host, port] = (request.url ?? "").split(":");
    const upstream = net.connect(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(client);
      client.pipe(upstream);
    });
    // The tunnel ends with the relay's side, as a proxy's does.
    upstream.on("close", () => client.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => (proxy.closeAllConnections(), proxy.close(() => resolve()))));

  const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY };
  process.env.HTTPS_PROXY = `https://user:s3cret@127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  process.env.NO_PROXY = "";
  cleanups.push(() => {
    for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value);
  });
  const port = (relay.address() as AddressInfo).port;
  const connection = dialRelay({ url: `wss://127.0.0.1:${port}/relay/v1`, token: "ccrt_test", onOpen: () => ({ message: () => {}, closed: () => {} }), log: () => {} });
  cleanups.push(() => connection.close());
  await connection.opened;
  expect(tunnels).toEqual([{ to: `127.0.0.1:${port}`, auth: `Basic ${Buffer.from("user:s3cret").toString("base64")}` }]);
});

test("an https:// egress proxy that names no port is dialled on 443, an http:// one on 80", async () => {
  const { tunnelAgent } = await import("./envProxy.ts");
  // Where the tunnel's sockets go; the proxies' names never resolve, so nothing leaves this machine.
  const dialled: Array<string> = [];
  const connect = net.Socket.prototype.connect;
  const spy = vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: net.Socket, ...args: Array<unknown>) {
    // net.createConnection hands connect its normalized [options, callback]; tls.connect, its options.
    const options = (Array.isArray(args[0]) ? args[0][0] : args[0]) as { host?: string; port?: number } | undefined;
    if (options?.port !== undefined) dialled.push(`${options.host}:${options.port}`);
    return Reflect.apply(connect, this, args) as net.Socket;
  });
  cleanups.push(() => spy.mockRestore());
  const target = new URL("wss://relay.caveman.test/relay/v1/runtime");
  for (const proxy of ["https://proxy.corp.invalid", "http://proxy.corp.invalid"])
    await new Promise<void>((resolve) => {
      const request = https.request({ host: target.hostname, port: 443, path: "/", agent: tunnelAgent(new URL(proxy), target, { timeoutMs: 2_000 }) });
      request.on("error", () => resolve());
      request.end();
    });
  expect(dialled).toEqual(["proxy.corp.invalid:443", "proxy.corp.invalid:80"]);
});
