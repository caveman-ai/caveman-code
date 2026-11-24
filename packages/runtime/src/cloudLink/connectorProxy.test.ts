// Cloud's connector proxy as the runtime addresses and reads it (connectorProxy.ts): what a server's URL adds below
// the address Cloud registered, the proxy's addresses, and which of its answers are the upstream's and which its own.
// The same code against a Cloud that runs the proxy: plugins/connectors.outside.test.ts.
import { expect, test } from "vitest";

import {
  connectorUrl,
  githubApiUrl,
  githubMcpBelow,
  githubMcpUrl,
  NO_PROXY_TEXT,
  NOT_OFFERED_TEXT,
  pathBelow,
  PROXY_OFF_TEXT,
  ProxyRefusal,
  proxyFetch,
  RECONNECT_ELSEWHERE_TEXT,
  refusalText,
} from "./connectorProxy.ts";
import { CloudError } from "./identity.ts";

const cloud = { cloudUrl: "https://cloud.example.test" };

test("pathBelow: what a URL adds under a registered address, and nothing for one that is elsewhere", () => {
  expect(pathBelow("https://mcp.linear.app/mcp", "https://mcp.linear.app/mcp")).toBe("");
  expect(pathBelow("https://mcp.linear.app/mcp/", "https://mcp.linear.app/mcp")).toBe("");
  expect(
    pathBelow("https://MCP.linear.app:443/mcp/x/y?team=1", "https://mcp.linear.app/mcp/"),
  ).toBe("/x/y?team=1");
  expect(pathBelow("https://mcp.linear.app/sse", "https://mcp.linear.app")).toBe("/sse");
  // Elsewhere: a path that only shares a prefix, another host, port or scheme, a look-alike host, not a URL.
  expect(pathBelow("https://mcp.linear.app/mcpx", "https://mcp.linear.app/mcp")).toBeUndefined();
  expect(pathBelow("https://mcp.linear.app/", "https://mcp.linear.app/mcp")).toBeUndefined();
  expect(
    pathBelow("https://mcp.linear.app.evil.net/mcp", "https://mcp.linear.app/mcp"),
  ).toBeUndefined();
  expect(
    pathBelow("https://mcp.linear.app:8443/mcp", "https://mcp.linear.app/mcp"),
  ).toBeUndefined();
  expect(pathBelow("http://mcp.linear.app/mcp", "https://mcp.linear.app/mcp")).toBeUndefined();
  expect(pathBelow("not a url", "https://mcp.linear.app/mcp")).toBeUndefined();
  // Dots are resolved before the comparison, so a path cannot climb beside the registered one.
  expect(
    pathBelow("https://mcp.linear.app/mcp/../admin", "https://mcp.linear.app/mcp"),
  ).toBeUndefined();
});

test("the proxy's addresses are Cloud's, named by the id Cloud listed; only GitHub's own MCP server is GitHub's", () => {
  expect(connectorUrl(cloud, "conn-mcp")).toBe("https://cloud.example.test/relay/v1/mcp/conn-mcp");
  expect(connectorUrl(cloud, "conn-mcp", "/x?y=1")).toBe(
    "https://cloud.example.test/relay/v1/mcp/conn-mcp/x?y=1",
  );
  // An id is one path segment, whatever it holds.
  expect(connectorUrl(cloud, "a/../github/api")).toBe(
    "https://cloud.example.test/relay/v1/mcp/a%2F..%2Fgithub%2Fapi",
  );
  expect(githubMcpUrl(cloud, githubMcpBelow("https://api.githubcopilot.com/mcp/"))).toBe(
    "https://cloud.example.test/relay/v1/mcp/github/mcp",
  );
  expect(githubMcpUrl(cloud, githubMcpBelow("https://api.githubcopilot.com/mcp/x/issues"))).toBe(
    "https://cloud.example.test/relay/v1/mcp/github/mcp/x/issues",
  );
  expect(githubMcpBelow("https://ghe.example.com/mcp")).toBeUndefined();
  expect(githubMcpBelow("https://api.githubcopilot.com.evil.net/mcp")).toBeUndefined();
  expect(githubApiUrl(cloud, "/repos/acme/widgets/issues?state=open")).toBe(
    "https://cloud.example.test/relay/v1/mcp/github/api/repos/acme/widgets/issues?state=open",
  );
});

test("refusalText: a sentence a person can act on for each of the proxy's own refusals", () => {
  expect(refusalText(new CloudError(409, "reconnect", "cave_code_connection_reconnect"))).toBe(
    RECONNECT_ELSEWHERE_TEXT,
  );
  expect(refusalText(new CloudError(403, "off", "cave_code_connection_kind_off"))).toBe(
    PROXY_OFF_TEXT,
  );
  expect(refusalText(new CloudError(404, "not found", "cave_not_found"))).toBe(NOT_OFFERED_TEXT);
  expect(refusalText(new CloudError(429, "slow down", "cave_code_engine_rate", 12_300))).toBe(
    "Too many connector requests. Try again in 13 s.",
  );
  expect(refusalText(new CloudError(429, "slow down", "cave_code_engine_rate"))).toBe(
    "Too many connector requests. Try again in a moment.",
  );
  // The route's own 404, with no body of Cloud's: a Cloud that does not run the proxy.
  expect(refusalText(new CloudError(404, "Cloud answered 404"))).toBe(NO_PROXY_TEXT);
  expect(refusalText(new CloudError(503, "Cloud answered 503"))).toBe(
    "Can't reach this connector. Try again in a moment.",
  );
  // Any other code: Cloud's own sentence.
  expect(
    refusalText(
      new CloudError(403, "This computer is shared with other work.", "cave_code_computer_shared"),
    ),
  ).toBe("This computer is shared with other work.");
});

test("proxyFetch: the upstream's answers keep their status with Cloud's words, a 401 is left to the token's renewal, and the proxy's own refusal fails the request", async () => {
  const body = (code: string, message: string) => JSON.stringify({ error: { code, message } });
  const answers: Record<string, Response> = {
    "/ok": new Response("{}", { status: 200 }),
    "/token": new Response(body("cave_unauthorized", "token"), { status: 401 }),
    "/gone": new Response(body("cave_code_upstream", "The connector answered 404."), {
      status: 404,
      headers: { "mcp-session-id": "s1" },
    }),
    "/broke": new Response(body("cave_code_upstream", "The connector answered 500."), {
      status: 500,
    }),
    "/reconnect": new Response(body("cave_code_connection_reconnect", "reconnect"), {
      status: 409,
    }),
    "/absent": new Response("404 page not found", { status: 404 }),
  };
  const fetched = proxyFetch(
    (async (input: Parameters<typeof fetch>[0]) =>
      answers[new URL(String(input)).pathname]!) as typeof fetch,
  );
  const at = (path: string) => fetched(`https://cloud.example.test${path}`, {});

  expect((await at("/ok")).status).toBe(200);
  expect((await at("/token")).status).toBe(401);
  // The upstream's: the status an MCP transport reads (a 404 ends a session), Cloud's sentence as the text, no header of the answer's.
  const gone = await at("/gone");
  expect([gone.status, await gone.text(), gone.headers.get("mcp-session-id")]).toEqual([
    404,
    "The connector answered 404.",
    null,
  ]);
  const broke = await at("/broke");
  expect([broke.status, await broke.text()]).toEqual([500, "The connector answered 500."]);
  // The proxy's own.
  const reconnect = await at("/reconnect").catch((error: unknown) => error);
  expect(reconnect).toBeInstanceOf(ProxyRefusal);
  expect(reconnect).toMatchObject({
    status: 409,
    code: "cave_code_connection_reconnect",
    message: RECONNECT_ELSEWHERE_TEXT,
  });
  expect(await at("/absent").catch((error: unknown) => error)).toMatchObject({
    status: 404,
    code: undefined,
    message: NO_PROXY_TEXT,
  });
});
