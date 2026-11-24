// The app's egress sends a Claude Platform token refresh straight to Anthropic for its Claude routes. From
// bin-v4.1.0 the packaged proxy also relays POST /v1/oauth/token itself, to its Anthropic upstream, byte for byte,
// with no credential of its own and no spend row (caveman 72712c70). Exercise the real app egress HTTP entry point +
// that exact proxy, redirecting only Node's HTTPS transport to a scripted provider.
// No real provider account, credential, external network call or inference is used. Models still cross the real proxy.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import type { AddressInfo } from "node:net";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createScrubber } from "@caveman-app/session-protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { accountVault } from "../cloudLink/accountCredentials.ts";
import * as engineKeys from "../cloudLink/engineKeys.ts";
import { ANTHROPIC_VIA_PROXY, startEgressProxy, type EgressProxy } from "../secrets/EgressScrub.ts";
import { AppProxy, appProxy, findProxyBinary } from "./proxyLauncher.ts";

vi.mock("node:https", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:https")>();
  return { ...original, request: vi.fn() };
});

const binary = findProxyBinary();
if (process.env.CAVEMAN_REQUIRE_PROXY === "1" && binary === undefined) throw new Error("Real pinned caveman-proxy is required for this wire gate");

interface Seen { url: string; method: string; headers: NodeHttp.IncomingHttpHeaders; body: string }
const tokenAnswer = '{ "access_token": "SYNTHETIC-access", "refresh_token": "SYNTHETIC-rotated", "token_type": "Bearer" }\n';
const invalidAnswer = '{ "error": "invalid_grant", "error_description": "Synthetic expired grant" }\n';
const grant = '{ "grant_type": "refresh_token", "refresh_token": "SYNTHETIC-grant" }\n';
const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01", "anthropic-workspace-id": "workspace-fixture", authorization: "Bearer SYNTHETIC-user", "x-api-key": "SYNTHETIC-caller-key", "x-cave-provider-key": "SYNTHETIC-route-key", "x-cave-upstream-base-url": "https://unrelated.invalid" };

(binary === undefined ? describe.skip : describe)("Claude refresh through packaged app egress", () => {
  let home: string;
  let upstream: NodeHttp.Server;
  let upstreamOrigin: string;
  let proxy: AppProxy;
  let egress: EgressProxy;
  const seen: Seen[] = [];
  const httpsTargets: string[] = [];

  beforeAll(async () => {
    home = NodeFS.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "claude-refresh-wire-"));
    upstream = NodeHttp.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        seen.push({ url: req.url!, method: req.method!, headers: req.headers, body });
        if (req.url!.includes("oauth/token")) {
          const invalid = body.includes("invalid-grant");
          res.writeHead(invalid ? 400 : 200, { "content-type": "application/json", "cache-control": "no-store", "x-provider-fixture": "token" });
          res.end(invalid ? invalidAnswer : tokenAnswer);
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "fixture" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 1 } }));
        }
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    // Every Node HTTPS request is intercepted: an unexpected external target fails instead of touching the network.
    vi.mocked(NodeHttps.request).mockImplementation(((target: URL, options: NodeHttps.RequestOptions) => {
      if (!(target instanceof URL) || target.origin !== "https://api.anthropic.com") throw new Error("Unexpected HTTPS destination in refresh wire fixture");
      httpsTargets.push(target.href);
      return NodeHttp.request(new URL(target.pathname + target.search, upstreamOrigin), options);
    }) as typeof NodeHttps.request);
    NodeFS.writeFileSync(NodePath.join(home, "caveman.yaml"), `providers:\n  anthropic:\n    base_url: ${upstreamOrigin}\n`);
    proxy = new AppProxy({ home, env: { HOME: home, PATH: process.env.PATH, CAVEMAN_PROXY_BIN: binary, CAVE_SSRF_ALLOWLIST: "127.0.0.1" } });
    expect(await proxy.ensure()).toBe("started");
    vi.spyOn(appProxy, "url").mockImplementation(() => proxy.url());
    egress = await startEgressProxy({ scrubber: () => createScrubber([]) });
  });
  beforeEach(() => { seen.length = 0; httpsTargets.length = 0; });
  afterAll(async () => {
    await egress?.close();
    proxy?.stop();
    vi.restoreAllMocks();
    if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve()));
    if (home) NodeFS.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const rows = () => {
    const db = new DatabaseSync(NodePath.join(home, "caveman.db"), { readOnly: true });
    try { return (db.prepare("SELECT COUNT(*) AS n FROM requests").get() as { n: number }).n; }
    finally { db.close(); }
  };
  const bases = [
    ["chosen Claude", () => ANTHROPIC_VIA_PROXY],
    ["Auto named Claude", () => `${proxy.url()!}/w/caveman-code-claude`],
    ["Auto bare Anthropic", () => proxy.url()!],
    ["direct Anthropic", () => "https://api.anthropic.com"],
  ] as const;

  it.each(bases)("%s: relays token bytes, query, workspace and provider errors without model spend", async (_name, base) => {
    const before = rows();
    const url = `${egress.route(base())}/v1/oauth/token?fixture=%2B`;
    for (const invalid of [false, true]) {
      const body = invalid ? grant.replace("SYNTHETIC-grant", "invalid-grant") : grant;
      const response = await fetch(url, { method: "POST", headers, body });
      expect(response.status).toBe(invalid ? 400 : 200);
      expect(await response.text()).toBe(invalid ? invalidAnswer : tokenAnswer);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-provider-fixture")).toBe("token");
      expect(seen.at(-1)).toMatchObject({ url: "/v1/oauth/token?fixture=%2B", method: "POST", body, headers: { authorization: headers.authorization, "x-api-key": headers["x-api-key"], "anthropic-workspace-id": headers["anthropic-workspace-id"], "anthropic-version": headers["anthropic-version"] } });
      expect(Object.keys(seen.at(-1)!.headers).filter((key) => key.startsWith("x-cave-"))).toEqual([]);
    }
    expect(httpsTargets).toEqual(Array(2).fill("https://api.anthropic.com/v1/oauth/token?fixture=%2B"));
    expect(rows()).toBe(before);
  });

  it("does not attach an unrelated vault or service-account credential to a grant", async () => {
    const key = vi.spyOn(engineKeys, "vaultKeyFor").mockReturnValue("SYNTHETIC-operator-key");
    const account = vi.spyOn(accountVault, "swap").mockReturnValue({ authorization: "Bearer SYNTHETIC-operator-account" });
    try {
      const response = await fetch(`${egress.route(ANTHROPIC_VIA_PROXY)}/v1/oauth/token`, { method: "POST", headers, body: grant });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(tokenAnswer);
      expect(seen[0]!.headers["x-api-key"]).toBe(headers["x-api-key"]);
      expect(seen[0]!.headers.authorization).toBe(headers.authorization);
      expect(account).not.toHaveBeenCalled();
    } finally { key.mockRestore(); account.mockRestore(); }
  });

  it("does not redirect user-selected custom bases or look-alike routes", async () => {
    for (const base of [upstreamOrigin, `${upstreamOrigin}/custom`]) {
      const response = await fetch(`${egress.route(base)}/v1/oauth/token`, { method: "POST", headers, body: grant });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(tokenAnswer);
      expect(seen.at(-1)?.body).toBe(grant);
    }
    expect(seen.map((request) => request.url)).toEqual(["/v1/oauth/token", "/custom/v1/oauth/token"]);
    expect(httpsTargets).toEqual([]);
  });

  it("does not redirect other methods, encoded paths or near matches", async () => {
    const before = rows();
    const cases = [
      [ANTHROPIC_VIA_PROXY, "GET", "/v1/oauth/token"],
      [ANTHROPIC_VIA_PROXY, "POST", "/v1/oauth/%74oken"],
      [ANTHROPIC_VIA_PROXY, "POST", "/v1/oauth/token/extra"],
      [`${proxy.url()!}/custom`, "POST", "/v1/oauth/token"],
    ] as const;
    for (const [base, method, suffix] of cases) {
      const response = await fetch(`${egress.route(base!)!}${suffix}`, { method, headers, ...(method === "POST" ? { body: grant } : {}) });
      expect(response.status).toBe(404);
      await response.arrayBuffer();
    }
    expect(httpsTargets).toEqual([]);
    expect(seen).toEqual([]);
    expect(rows()).toBe(before);
  });

  it("a grant on another engine's proxy route reaches the proxy's Anthropic upstream as sent, with no credential", async () => {
    const before = rows();
    const response = await fetch(`${egress.route(`${proxy.url()!}/w/caveman-code-codex`)!}/v1/oauth/token`, { method: "POST", headers, body: grant });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(tokenAnswer);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: "/v1/oauth/token", method: "POST", body: grant });
    // The grant is the whole credential: the proxy forwards it alone, with no caller key or bearer and none of its own.
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.headers["x-api-key"]).toBeUndefined();
    expect(Object.keys(seen[0]!.headers).filter((key) => key.startsWith("x-cave-"))).toEqual([]);
    expect(httpsTargets).toEqual([]);
    expect(rows()).toBe(before);
  });

  it("still sends inference through the real pinned model proxy", async () => {
    const before = rows();
    const response = await fetch(`${egress.route(ANTHROPIC_VIA_PROXY)}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "SYNTHETIC-model-key" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 32, messages: [{ role: "user", content: "Fixture only" }] }),
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { content: unknown }).content).toEqual([{ type: "text", text: "fixture" }]);
    expect(seen.map((request) => request.url)).toEqual(["/v1/messages"]);
    await expect.poll(rows).toBe(before + 1);
    expect(httpsTargets).toEqual([]);
  });
});
