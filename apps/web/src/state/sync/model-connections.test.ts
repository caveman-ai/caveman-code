// The person's connections in Caveman Cloud, written from a page that holds their own Cloud session (a Cloud
// computer's runtime may change none): which routes are asked, with what, and that no write keeps what was pasted.
import { expect, test } from "vitest";

import { CloudError } from "./cloud-api.ts";
import { cloudConnections, orderWithFirst, type CloudConnection } from "./model-connections.ts";

const auth = {
  base: "https://cloud.test",
  headers: async () => ({ authorization: "Bearer client" }),
  renew: async () => false,
  credentials: "omit" as const,
};
const plan = (id: string, position: number): CloudConnection => ({
  id,
  kind: "claude_plan",
  provider: "anthropic",
  label: "",
  position,
  status: "ready",
  serves: ["claude-agent"],
});

/** A Cloud that keeps an ordered list and records every request made of it. */
function cloud(start: ReadonlyArray<CloudConnection>) {
  let connections = [...start];
  const asked: Array<{
    method: string;
    path: string;
    body: unknown;
    headers: Record<string, string>;
  }> = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const path = url.replace("https://cloud.test", "");
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    asked.push({ method, path, body, headers: init.headers as Record<string, string> });
    const answer = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method === "POST" && path === "/api/v1/code/model-connections") {
      if (body.token === "refused")
        return answer(
          {
            error: {
              code: "cave_code_connection_refused",
              message: "Anthropic did not accept that token.",
            },
          },
          400,
        );
      connections = [...connections, plan("new", connections.length)];
      return answer({ connection: connections.at(-1) }, 201);
    }
    if (method === "PATCH" && path === "/api/v1/code/model-connections/order") {
      connections = (body.ids as string[]).map((id, position) => ({
        ...connections.find((c) => c.id === id)!,
        position,
      }));
      return answer({});
    }
    if (method === "DELETE") {
      connections = connections
        .filter((c) => `/api/v1/code/model-connections/${c.id}` !== path)
        .map((c, position) => ({ ...c, position }));
      return new Response(null, { status: 204 });
    }
    // Cloud lists in no promised order: position says it.
    return answer({ connections: [...connections].reverse(), kinds: {} });
  }) as unknown as typeof fetch;
  return { api: cloudConnections(auth, fetchImpl), asked };
}

test("the list is Cloud's model-connections route, on the person's own session", async () => {
  const { api, asked } = cloud([plan("a", 0)]);
  expect((await api.list()).connections.map((c) => c.id)).toEqual(["a"]);
  expect(asked).toEqual([
    {
      method: "GET",
      path: "/api/v1/code/model-connections",
      body: undefined,
      headers: { accept: "application/json", authorization: "Bearer client" },
    },
  ]);
});

test("a Claude plan is added by the token its CLI printed, sent once, and the answer is the list", async () => {
  const { api, asked } = cloud([plan("a", 0)]);
  const list = await api.addClaudePlan("the-pasted-token");
  expect(asked[0]).toMatchObject({
    method: "POST",
    path: "/api/v1/code/model-connections",
    body: { kind: "claude_plan", token: "the-pasted-token" },
  });
  expect(asked[0]!.headers).toMatchObject({
    "content-type": "application/json",
    "x-cave-csrf": "1",
  });
  // Nothing after the one POST carries the token again.
  expect(JSON.stringify(asked.slice(1))).not.toContain("the-pasted-token");
  expect(list.connections.map((c) => c.id).sort()).toEqual(["a", "new"]);
  expect(JSON.stringify(list)).not.toContain("the-pasted-token");
});

test("a token Cloud refuses fails in Cloud's own words", async () => {
  const { api } = cloud([]);
  const error = await api.addClaudePlan("refused").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CloudError);
  expect((error as CloudError).message).toBe("Anthropic did not accept that token.");
});

test("use first sends the whole order, read from Cloud first, with every id once", async () => {
  const { api, asked } = cloud([plan("a", 0), plan("b", 1), plan("c", 2)]);
  const list = await api.moveToTop("c");
  expect(asked.map((r) => `${r.method} ${r.path}`)).toEqual([
    "GET /api/v1/code/model-connections",
    "PATCH /api/v1/code/model-connections/order",
    "GET /api/v1/code/model-connections",
  ]);
  expect(asked[1]!.body).toEqual({ ids: ["c", "a", "b"] });
  expect([...list.connections].sort((x, y) => x.position - y.position).map((c) => c.id)).toEqual([
    "c",
    "a",
    "b",
  ]);
});

test("the order with one id first keeps every other id once, in place", () => {
  expect(orderWithFirst(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
  expect(orderWithFirst(["a", "b", "c"], "a")).toEqual(["a", "b", "c"]);
  // An id Cloud does not list changes nothing.
  expect(orderWithFirst(["a", "b"], "z")).toEqual(["a", "b"]);
});

test("remove deletes the connection by its id and answers what is left", async () => {
  const { api, asked } = cloud([plan("a", 0), plan("b/2", 1)]);
  const list = await api.remove("a");
  expect(asked[0]).toMatchObject({ method: "DELETE", path: "/api/v1/code/model-connections/a" });
  expect(list.connections.map((c) => c.id)).toEqual(["b/2"]);
  // An id is one path segment, whatever it holds.
  await api.remove("b/2");
  expect(asked.at(-2)).toMatchObject({
    method: "DELETE",
    path: "/api/v1/code/model-connections/b%2F2",
  });
});

/** Cloud's 404 for a path it has no route for, and for a connection that is not there: the same code, two sentences. */
const NO_ROUTE = { code: "cave_not_found", message: "No route matches this path." };
const NO_CONNECTION = { code: "cave_not_found", message: "Connection not found." };
const answering = (
  error: { code: string; message: string },
  list?: ReadonlyArray<CloudConnection>,
) =>
  (async (_url: string, init: RequestInit = {}) =>
    (init.method ?? "GET") === "GET" && list !== undefined
      ? new Response(JSON.stringify({ connections: list }), { status: 200 })
      : new Response(JSON.stringify({ error: { type: "cave_gateway_error", ...error } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;
const refusal = (asked: Promise<unknown>) =>
  asked.then(
    () => undefined,
    (e: unknown) => e,
  );

test("a Cloud from before connections: the list and adding to it say it needs an update, never 'No route matches this path.'", async () => {
  const older = cloudConnections(auth, answering(NO_ROUTE));
  for (const asked of [older.list(), older.addClaudePlan(("sk-" + "ant-oat01-pasted"))]) {
    const error = await refusal(asked);
    expect(error).toBeInstanceOf(CloudError);
    expect(error).toMatchObject({
      status: 404,
      code: "cave_not_found",
      message: "Your Caveman Cloud needs an update before it can connect plans.",
    });
  }
});

test("a 404 on a route that names a connection is that connection, not an older Cloud: 'Connection not found.'", async () => {
  // Cloud master's answer for a connection that is gone (registry.go notFound), and an older Cloud's for the route.
  for (const error of [NO_CONNECTION, NO_ROUTE]) {
    const cloud = cloudConnections(auth, answering(error, [plan("a", 0), plan("b", 1)]));
    for (const asked of [cloud.remove("gone"), cloud.moveToTop("b")])
      expect(await refusal(asked)).toMatchObject({
        status: 404,
        code: "cave_not_found",
        message: "Connection not found.",
      });
  }
});
