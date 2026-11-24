/**
 * The connector gate's client (connectorGate.ts) against a gate on loopback that answers the relay's exact bytes
 * (Caveman Cloud connector relay, "Exact bytes from the tests").
 */
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openConnectorGate, parseConnectorsUrl, type ConnectorEffect } from "./connectorGate.ts";

const KEY = "sk-gate-test-0123456789abcdefSECRET";

// ── a gate on loopback ────────────────────────────────────────

interface GateRequest {
  readonly method: string;
  readonly headers: IncomingHttpHeaders;
  readonly raw: string;
  readonly body: { readonly id?: number; readonly method?: string; readonly params?: unknown };
  /** Resolves when the request's connection closes (an aborted request closes it before an answer). */
  readonly closed: Promise<void>;
}

type GateAnswer =
  | { readonly status?: number; readonly body?: string; readonly headers?: Record<string, string> }
  | { readonly cut: true }
  | { readonly hold: Promise<unknown>; readonly then?: GateAnswer };

interface Gate {
  readonly url: string;
  readonly requests: Array<GateRequest>;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of closers.splice(0).reverse()) await close();
});

async function startGate(answer: (request: GateRequest) => GateAnswer): Promise<Gate> {
  const requests: Array<GateRequest> = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body: GateRequest["body"] = {};
    try {
      body = JSON.parse(raw);
    } catch {
      // kept raw
    }
    const closed = new Promise<void>((resolve) => res.on("close", () => resolve()));
    const request = { method: req.method ?? "", headers: req.headers, raw, body, closed };
    requests.push(request);
    const reply = async (given: GateAnswer, response: ServerResponse): Promise<void> => {
      if ("cut" in given) return void response.socket?.destroy();
      if ("hold" in given) {
        await given.hold;
        return given.then === undefined ? undefined : reply(given.then, response);
      }
      response.writeHead(given.status ?? 200, {
        "content-type": "application/json",
        ...given.headers,
      });
      response.end(given.body ?? "");
    };
    await reply(answer(request), res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/relay/v1/sessions/0199e2a0-3333-7000-8000-000000000001/mcp`,
    requests,
  };
}

// The relay's bytes (report-gate-relay, "Exact bytes from the tests"); a call's answer takes the request's id.
const LIST_REQUEST = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
const LIST_ANSWER =
  '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"linear__list_issues","description":"List issues, 50 a page.","inputSchema":{"type":"object","properties":{"team":{"type":"string"},"cursor":{"type":"string"}}},"annotations":{"readOnlyHint":true,"destructiveHint":false},"_meta":{"caveman/connector":"linear","caveman/tool":"list_issues","caveman/effect":"read","caveman/pinned":{}}}],"_meta":{"caveman/card":"the card","caveman/revision":5}}}';
const ran = (id: number | undefined) =>
  `{"jsonrpc":"2.0","id":${id},"result":{"content":[{"type":"text","text":"ran list_issues"}],"isError":false}}`;
const refused = (id: number | undefined) =>
  `{"jsonrpc":"2.0","id":${id},"result":{"content":[{"type":"text","text":"not_granted: canary_wipe is not one of this agent's tools."}],"isError":true}}`;

/** A card tool as the relay lists one. */
const tool = (
  connector: string,
  name: string,
  effect: string,
  extra: Record<string, unknown> = {},
) => ({
  name: `${connector}__${name}`,
  description: `${name} on ${connector}.`,
  inputSchema: { type: "object", properties: { id: { type: "string" } } },
  _meta: {
    "caveman/connector": connector,
    "caveman/tool": name,
    "caveman/effect": effect,
    "caveman/pinned": {},
  },
  ...extra,
});
const listOf = (tools: ReadonlyArray<unknown>, meta: Record<string, unknown> = {}) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { tools, _meta: { "caveman/card": "card", "caveman/revision": 1, ...meta } },
  });
const CARD = listOf([
  tool("linear", "list_issues", "read"),
  tool("linear", "create_comment", "write"),
  tool("stripe", "create_refund", "external"),
]);

/** A gate whose list is `list` and whose calls `call` answers. */
const gateOf = (
  list: string,
  call: (request: GateRequest) => GateAnswer = (request) => ({ body: ran(request.body.id) }),
) =>
  startGate((request) => (request.body.method === "tools/list" ? { body: list } : call(request)));

const calls = (gate: Gate) =>
  gate.requests.filter((request) => request.body.method === "tools/call");

async function opened(
  gate: Gate,
  options: {
    readonly beforeSend?: (call: {
      readonly qualified: string;
      readonly effect: ConnectorEffect;
    }) => void | Promise<void>;
  } = {},
) {
  const notices: Array<string> = [];
  const connectors = await openConnectorGate({
    url: gate.url,
    bearer: KEY,
    notice: (line) => void notices.push(line),
    ...options,
  });
  const handle = (flat: string) => connectors.tools.find((tool) => tool.qualified === flat)!;
  return { connectors, notices, handle };
}

const rejection = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a rejection");
};

// ── the address ───────────────────────────────────────────────

describe("CAVEMAN_CONNECTORS_URL", () => {
  it("is https, or http only on loopback, with no credentials, query or fragment", () => {
    for (const good of [
      "https://relay.caveman.so/relay/v1/sessions/0199e2a0/mcp",
      "http://127.0.0.1:8080/relay/v1/sessions/x/mcp",
      "http://localhost:8080/mcp",
      "http://[::1]:8080/mcp",
      "  https://relay.example/mcp  ",
    ]) {
      expect(parseConnectorsUrl(good), good).toBeInstanceOf(URL);
    }
    for (const [bad, why] of [
      ["", /is empty/],
      ["   ", /is empty/],
      ["relay.caveman.so/mcp", /is not a URL/],
      ["http://relay.caveman.so/mcp", /https URL \(http only on loopback/],
      ["http://10.0.0.7/mcp", /https URL/],
      ["ftp://relay.caveman.so/mcp", /https URL/],
      [`https://user:${KEY}@relay.caveman.so/mcp`, /must not carry credentials/],
      ["https://user@relay.caveman.so/mcp", /must not carry credentials/],
      ["https://relay.caveman.so/mcp?key=1", /query or a fragment/],
      ["https://relay.caveman.so/mcp?", /query or a fragment/],
      ["https://relay.caveman.so/mcp#x", /query or a fragment/],
      ["https://relay.caveman.so/mcp#", /query or a fragment/],
    ] as const) {
      const said = parseConnectorsUrl(bad);
      expect(typeof said, bad).toBe("string");
      expect(said, bad).toMatch(why);
      expect(said, bad).toMatch(/^CAVEMAN_CONNECTORS_URL /);
      expect(said).not.toContain(KEY);
    }
  });

  it("a malformed address is refused before anything is sent", async () => {
    const gate = await gateOf(CARD);
    const insecure = gate.url.replace("http://127.0.0.1", "http://relay.invalid");
    expect(await rejection(openConnectorGate({ url: insecure, bearer: KEY }))).toMatch(
      /must be an https URL/,
    );
    expect(gate.requests).toHaveLength(0);
  });
});

// ── the card ──────────────────────────────────────────────────

describe("openConnectorGate", () => {
  it("reads the card once with the bearer, as the relay answers it: each tool a harness MCP handle under its flat name", async () => {
    const gate = await gateOf(LIST_ANSWER);
    const { connectors, notices } = await opened(gate);
    expect(gate.requests).toHaveLength(1);
    const [list] = gate.requests;
    expect(list!.method).toBe("POST");
    expect(list!.raw).toBe(LIST_REQUEST);
    expect(list!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(list!.headers["content-type"]).toBe("application/json");
    expect(list!.headers.accept).toBe("application/json");
    expect(connectors.card).toBe("the card");
    expect(connectors.revision).toBe(5);
    expect([...connectors.effects]).toEqual([["linear__list_issues", "read"]]);
    expect(
      connectors.tools.map(({ server, name, qualified, description, inputSchema }) => ({
        server,
        name,
        qualified,
        description,
        inputSchema,
      })),
    ).toEqual([
      {
        server: "linear",
        name: "list_issues",
        qualified: "linear__list_issues",
        description: "List issues, 50 a page.",
        inputSchema: {
          type: "object",
          properties: { team: { type: "string" }, cursor: { type: "string" } },
        },
      },
    ]);
    expect(notices).toEqual([]);
  });

  it("keeps a tool only when its name, _meta, effect and schema fit, in the order sent; a second of one name is left out", async () => {
    const list = listOf([
      tool("stripe", "create_refund", "external"),
      tool("linear", "list_issues", "read"),
      { ...tool("linear", "list_issues", "read"), name: "linear__list issues" },
      { ...tool("linear", "x", "read"), name: `linear__${"x".repeat(60)}` },
      { ...tool("linear", "nosplit", "read"), name: "linearnosplit" },
      { ...tool("linear", "", "read"), name: "linear__" },
      {
        ...tool("linear", "create_issue", "write"),
        _meta: {
          "caveman/connector": "github",
          "caveman/tool": "create_issue",
          "caveman/effect": "write",
        },
      },
      {
        ...tool("linear", "create_issue", "write"),
        _meta: {
          "caveman/connector": "linear",
          "caveman/tool": "create",
          "caveman/effect": "write",
        },
      },
      { ...tool("linear", "no_meta", "read"), _meta: undefined },
      tool("linear", "delete_all", "delete"),
      { ...tool("linear", "no_schema", "read"), inputSchema: undefined },
      { ...tool("linear", "list_schema", "read"), inputSchema: [] },
      { description: "no name" },
      "not a tool",
      tool("github", "a__b", "write"),
      { ...tool("stripe", "create_refund", "read"), description: "the second" },
      tool("linear", "create_comment", "write"),
    ]);
    const gate = await gateOf(list);
    const { connectors, notices } = await opened(gate);
    expect(
      connectors.tools.map((handle) => [handle.qualified, handle.server, handle.name]),
    ).toEqual([
      ["stripe__create_refund", "stripe", "create_refund"],
      ["linear__list_issues", "linear", "list_issues"],
      ["github__a__b", "github", "a__b"],
      ["linear__create_comment", "linear", "create_comment"],
    ]);
    expect([...connectors.effects.values()]).toEqual(["external", "read", "write", "write"]);
    expect(connectors.tools[0]!.description).toBe("create_refund on stripe.");
    expect(notices).toEqual([
      `Cloud's connector gate listed "linear__list issues" whose name is not 1 to 64 letters, digits, _ and -; it is left out.`,
      `Cloud's connector gate listed "linear__${"x".repeat(60)}" whose name is not 1 to 64 letters, digits, _ and -; it is left out.`,
      `Cloud's connector gate listed "linearnosplit" whose name does not split at its first __ into the connector and tool its _meta names; it is left out.`,
      `Cloud's connector gate listed "linear__" whose name does not split at its first __ into the connector and tool its _meta names; it is left out.`,
      `Cloud's connector gate listed "linear__create_issue" whose name does not split at its first __ into the connector and tool its _meta names; it is left out.`,
      `Cloud's connector gate listed "linear__create_issue" whose name does not split at its first __ into the connector and tool its _meta names; it is left out.`,
      `Cloud's connector gate listed "linear__no_meta" whose name does not split at its first __ into the connector and tool its _meta names; it is left out.`,
      `Cloud's connector gate listed "linear__delete_all" whose effect is not read, write or external; it is left out.`,
      `Cloud's connector gate listed "linear__no_schema" whose inputSchema is not an object; it is left out.`,
      `Cloud's connector gate listed "linear__list_schema" whose inputSchema is not an object; it is left out.`,
      "Cloud's connector gate listed a tool with no name whose name is not 1 to 64 letters, digits, _ and -; it is left out.",
      "Cloud's connector gate listed a tool with no name whose name is not 1 to 64 letters, digits, _ and -; it is left out.",
      `Cloud's connector gate listed "stripe__create_refund" twice; the second is left out.`,
    ]);
  });

  it("a card that cannot be read rejects with one sentence, never the body: 401, another status, not a tools/list result, too large", async () => {
    const echo = `{"error":"bad key ${KEY}"}`;
    for (const [answer, said] of [
      [
        { status: 401, body: echo },
        "Cloud's connector gate refused this session's key (HTTP 401).",
      ],
      [{ status: 500, body: echo }, "Cloud's connector gate did not answer (HTTP 500)."],
      [{ status: 409, body: echo }, "Cloud's connector gate did not answer (HTTP 409)."],
      [{ status: 202, body: "" }, "Cloud's connector gate did not answer (HTTP 202)."],
      [
        { body: `not json ${KEY}` },
        "Cloud's connector gate did not answer with a tools/list result.",
      ],
      [
        { body: `{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"${KEY}"}}` },
        "Cloud's connector gate did not answer with a tools/list result.",
      ],
      [
        { body: '{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}' },
        "Cloud's connector gate did not answer with a tools/list result.",
      ],
      [
        { body: '{"jsonrpc":"2.0","id":1,"result":{}}' },
        "Cloud's connector gate did not answer with a tools/list result.",
      ],
      [
        {
          body: `{"jsonrpc":"2.0","id":1,"result":{"tools":[],"pad":"${"x".repeat(4 * 1024 * 1024)}"}}`,
        },
        "Cloud's connector gate did not answer (an answer over 4 MiB).",
      ],
      [{ cut: true }, "Cloud's connector gate did not answer (UND_ERR_SOCKET)."],
    ] as const) {
      const gate = await startGate(() => answer);
      const message = await rejection(openConnectorGate({ url: gate.url, bearer: KEY }));
      expect(message, JSON.stringify(answer).slice(0, 80)).toBe(said);
      expect(message).not.toContain(KEY);
    }
    // Nobody listening.
    const gone = await startGate(() => ({ body: CARD }));
    await closers.pop()!();
    expect(await rejection(openConnectorGate({ url: gone.url, bearer: KEY }))).toBe(
      "Cloud's connector gate did not answer (ECONNREFUSED).",
    );
  });

  it("the list is bounded to 30 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const gate = await startGate(() => ({ hold: held, then: { body: CARD } }));
    const opening = openConnectorGate({ url: gate.url, bearer: KEY });
    let settled = false;
    const outcome = opening.then(
      () => "opened",
      (error: Error) => error.message,
    );
    void outcome.finally(() => (settled = true));
    await vi.waitFor(() => expect(gate.requests).toHaveLength(1), { interval: 5 });
    vi.advanceTimersByTime(29_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(await outcome).toBe("Cloud's connector gate did not answer (no answer within 30 s).");
    release();
  });

  it("never follows a redirect: the second server receives nothing, at open or on a call", async () => {
    const elsewhere = await startGate(() => ({ body: CARD }));
    const redirect = await startGate(() => ({ status: 307, headers: { location: elsewhere.url } }));
    expect(await rejection(openConnectorGate({ url: redirect.url, bearer: KEY }))).toBe(
      "Cloud's connector gate did not answer (a redirect, which this client never follows).",
    );
    const onCall = await gateOf(CARD, () => ({
      status: 308,
      headers: { location: elsewhere.url },
    }));
    const { handle } = await opened(onCall);
    expect(await handle("linear__list_issues").call({ id: "1" })).toEqual({
      text: "failed: linear.list_issues got no answer from linear. Reading again is safe.",
      isError: true,
    });
    expect(await handle("linear__create_comment").call({ id: "1" })).toEqual({
      text: "may_have_run: linear.create_comment was sent and no answer was recorded. Check before sending it again.",
      isError: true,
    });
    expect(elsewhere.requests).toHaveLength(0);
  });
});

// ── a call ────────────────────────────────────────────────────

describe("a gate tool's call", () => {
  it("sends tools/call with the flat name and the arguments; call answers the text parts, callRaw the result as received", async () => {
    const result = {
      content: [
        { type: "text", text: "first" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "text", text: "second" },
      ],
      isError: false,
      structuredContent: { issues: 2 },
      _meta: { "caveman/call": "c1" },
    };
    const gate = await gateOf(LIST_ANSWER, (request) => ({
      body: JSON.stringify({ jsonrpc: "2.0", id: request.body.id, result }),
    }));
    const { handle } = await opened(gate);
    const list = handle("linear__list_issues");
    expect(await list.call({ team: "core" })).toEqual({ text: "first\nsecond", isError: false });
    expect(await list.callRaw({ team: "core", cursor: "c" })).toEqual(result);
    expect(calls(gate).map((request) => request.raw)).toEqual([
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"linear__list_issues","arguments":{"team":"core"}}}',
      '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"linear__list_issues","arguments":{"team":"core","cursor":"c"}}}',
    ]);
    for (const request of calls(gate)) {
      expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(request.headers["content-type"]).toBe("application/json");
      expect(request.headers.accept).toBe("application/json");
    }
  });

  it("answers the relay's own bytes, and a refusal as it is", async () => {
    const gate = await gateOf(LIST_ANSWER, (request) => ({
      body: request.body.id === 2 ? ran(2) : refused(request.body.id),
    }));
    const { handle } = await opened(gate);
    const list = handle("linear__list_issues");
    expect(await list.call({ team: "core" })).toEqual({ text: "ran list_issues", isError: false });
    expect(await list.call({ team: "core" })).toEqual({
      text: "not_granted: canary_wipe is not one of this agent's tools.",
      isError: true,
    });
    expect(await list.callRaw({ team: "core" })).toEqual({
      content: [
        { type: "text", text: "not_granted: canary_wipe is not one of this agent's tools." },
      ],
      isError: true,
    });
  });

  it("when nothing usable comes back the model reads this client's line, by the tool's effect, and the call was sent once", async () => {
    const lines: Record<ConnectorEffect, string> = {
      read: "failed: linear.list_issues got no answer from linear. Reading again is safe.",
      write:
        "may_have_run: linear.create_comment was sent and no answer was recorded. Check before sending it again.",
      external:
        "may_have_run: stripe.create_refund was sent and no answer was recorded. Check before sending it again.",
    };
    const flat: Record<ConnectorEffect, string> = {
      read: "linear__list_issues",
      write: "linear__create_comment",
      external: "stripe__create_refund",
    };
    for (const [what, answer] of [
      ["a cut connection", () => ({ cut: true })],
      ["HTTP 500", () => ({ status: 500, body: `{"echo":"${KEY}"}` })],
      ["HTTP 503", () => ({ status: 503, body: "" })],
      ["HTTP 409", () => ({ status: 409, body: "" })],
      ["not JSON", () => ({ body: `<html>${KEY}</html>` })],
      [
        "a JSON-RPC error",
        (request: GateRequest) => ({
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: request.body.id,
            error: { code: -32603, message: KEY },
          }),
        }),
      ],
      ["another id", () => ({ body: ran(99) })],
      [
        "no content",
        (request: GateRequest) => ({
          body: JSON.stringify({ jsonrpc: "2.0", id: request.body.id, result: { isError: false } }),
        }),
      ],
      [
        "content not parts",
        (request: GateRequest) => ({
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: request.body.id,
            result: { content: ["text"] },
          }),
        }),
      ],
      [
        "over 16 MiB",
        (request: GateRequest) => ({
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: request.body.id,
            result: { content: [{ type: "text", text: "x".repeat(16 * 1024 * 1024) }] },
          }),
        }),
      ],
    ] as const) {
      const gate = await gateOf(CARD, answer as (request: GateRequest) => GateAnswer);
      const { handle, notices } = await opened(gate);
      for (const effect of ["read", "write", "external"] as const) {
        expect(await handle(flat[effect]).call({ id: "1" }), `${what}, ${effect}`).toEqual({
          text: lines[effect],
          isError: true,
        });
        expect(await handle(flat[effect]).callRaw({ id: "1" }), `${what}, ${effect}`).toEqual({
          content: [{ type: "text", text: lines[effect] }],
          isError: true,
        });
      }
      // No retry, ever: each call reached the gate exactly once.
      expect(calls(gate), what).toHaveLength(6);
      expect(notices, what).toEqual([]);
    }
  });

  it("a call is bounded to 120 s, then answers its line", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const gate = await gateOf(CARD, (request) => ({
      hold: held,
      then: { body: ran(request.body.id) },
    }));
    const { handle } = await opened(gate);
    let settled = false;
    const calling = handle("linear__create_comment").call({ id: "1" });
    void calling.finally(() => (settled = true));
    await vi.waitFor(() => expect(calls(gate)).toHaveLength(1), { interval: 5 });
    vi.advanceTimersByTime(119_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(await calling).toEqual({
      text: "may_have_run: linear.create_comment was sent and no answer was recorded. Check before sending it again.",
      isError: true,
    });
    await calls(gate)[0]!.closed;
    release();
    expect(calls(gate)).toHaveLength(1);
  });

  it("HTTP 401 on a call: the model reads unreachable, and a notice says the key was refused", async () => {
    const gate = await gateOf(CARD, () => ({ status: 401, body: `{"key":"${KEY}"}` }));
    const { handle, notices } = await opened(gate);
    expect(await handle("linear__create_comment").call({ id: "1" })).toEqual({
      text: "unreachable: linear did not answer. Not run.",
      isError: true,
    });
    expect(notices).toEqual([
      "Cloud's connector gate refused this session's key (HTTP 401) on linear__create_comment; the call was not run.",
    ]);
    expect(calls(gate)).toHaveLength(1);
  });

  it("the caller's signal ends the request; a call stopped before it leaves is never sent", async () => {
    const gate = await gateOf(CARD, () => ({ hold: new Promise(() => undefined) }));
    const { handle } = await opened(gate);
    const stop = new AbortController();
    const calling = handle("linear__list_issues").call({ id: "1" }, stop.signal);
    await vi.waitFor(() => expect(calls(gate)).toHaveLength(1), { interval: 5 });
    stop.abort();
    expect(await calling).toEqual({
      text: "failed: linear.list_issues got no answer from linear. Reading again is safe.",
      isError: true,
    });
    await calls(gate)[0]!.closed;

    const before = new AbortController();
    before.abort();
    await expect(
      handle("linear__create_comment").call({ id: "1" }, before.signal),
    ).rejects.toThrow();
    // Stopped while beforeSend waited: never sent either.
    const later = new AbortController();
    const { handle: held } = await opened(gate, { beforeSend: () => void later.abort() });
    await expect(
      held("linear__create_comment").callRaw({ id: "1" }, later.signal),
    ).rejects.toThrow();
    expect(calls(gate)).toHaveLength(1);
  });

  it("beforeSend is awaited before a write or an outside call leaves, and never for a read", async () => {
    const gate = await gateOf(CARD);
    const told: Array<{
      readonly qualified: string;
      readonly effect: ConnectorEffect;
      readonly sentBefore: number;
    }> = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { handle } = await opened(gate, {
      beforeSend: async (call) => {
        told.push({ ...call, sentBefore: calls(gate).length });
        if (call.qualified === "linear__create_comment") await held;
      },
    });
    expect(await handle("linear__list_issues").call({ id: "1" })).toEqual({
      text: "ran list_issues",
      isError: false,
    });
    expect(told).toEqual([]);
    const writing = handle("linear__create_comment").call({ id: "2" });
    await vi.waitFor(() => expect(told).toHaveLength(1), { interval: 5 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Held in beforeSend: nothing left this process yet.
    expect(calls(gate)).toHaveLength(1);
    release();
    expect(await writing).toEqual({ text: "ran list_issues", isError: false });
    expect(await handle("stripe__create_refund").callRaw({ id: "3" })).toMatchObject({
      isError: false,
    });
    expect(told).toEqual([
      { qualified: "linear__create_comment", effect: "write", sentBefore: 1 },
      { qualified: "stripe__create_refund", effect: "external", sentBefore: 2 },
    ]);
    expect(calls(gate)).toHaveLength(3);
  });

  it("the key is in no notice, error or line, whatever the gate sends back", async () => {
    const said: Array<string> = [];
    const hostile = listOf([
      tool("linear", "list_issues", "read"),
      { ...tool("linear", "x", "read"), name: `bad name ${KEY}` },
      { ...tool("linear", KEY.replaceAll("-", "_"), "read"), inputSchema: KEY },
    ]);
    const gate = await gateOf(hostile, (request) =>
      request.body.id === 2
        ? { status: 500, body: KEY }
        : request.body.id === 3
          ? { status: 401, body: KEY }
          : { body: `{"jsonrpc":"2.0","id":${request.body.id},"error":{"message":"${KEY}"}}` },
    );
    const connectors = await openConnectorGate({
      url: gate.url,
      bearer: KEY,
      notice: (line) => void said.push(line),
    });
    for (let n = 0; n < 3; n++)
      said.push(JSON.stringify(await connectors.tools[0]!.callRaw({ id: KEY })));
    for (const answer of [
      { status: 401, body: KEY },
      { status: 500, body: KEY },
      { body: KEY },
      { cut: true },
    ] as const) {
      const broken = await startGate(() => answer);
      said.push(
        await rejection(
          openConnectorGate({
            url: broken.url,
            bearer: KEY,
            notice: (line) => void said.push(line),
          }),
        ),
      );
    }
    said.push(
      await rejection(
        openConnectorGate({ url: `https://user:${KEY}@relay.example/mcp`, bearer: KEY }),
      ),
    );
    expect(said.length).toBeGreaterThan(8);
    expect(said.join("\n")).not.toContain(KEY);
    expect(said.join("\n")).toContain("[redacted]");
  });
});
