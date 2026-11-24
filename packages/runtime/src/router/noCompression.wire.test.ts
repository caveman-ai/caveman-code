import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { expect, test } from "vitest";
import { AppProxy, findProxyBinary } from "./proxyLauncher.ts";

const binary = findProxyBinary();
test.skipIf(!binary)("real app proxy preserves large Claude and Codex requests byte for byte", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "app-no-compression-"));
  const seen: Buffer[] = [];
  const upstream = http.createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    seen.push(Buffer.concat(parts));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "test", model: "test", usage: { input_tokens: 10, output_tokens: 1 } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const stub = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  fs.writeFileSync(path.join(home, "caveman.yaml"), `providers:\n  anthropic:\n    base_url: ${stub}\n  openai:\n    base_url: ${stub}\n`);
  const proxy = new AppProxy({ home, env: { HOME: home, PATH: process.env.PATH, CAVEMAN_PROXY_BIN: binary, CAVEMAN_MODE: "compress", CAVE_SSRF_ALLOWLIST: "127.0.0.1" }, recovery: true });
  try {
    expect(await proxy.ensure(), proxy.why()).toBe("started");
    const log = "original build log line, keep every byte\n".repeat(80_000);
    for (const [endpoint, body] of [
      ["/v1/messages", { model: "claude-sonnet-5-5", max_tokens: 10, messages: [{ role: "user", content: log }] }],
      ["/v1/responses", { model: "gpt-6.1-sol", input: [{ role: "user", content: log }] }],
    ] as const) {
      const raw = JSON.stringify(body);
      const response = await fetch(`${proxy.url()}${endpoint}`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "test-key", authorization: "Bearer test-key", "anthropic-version": "2023-06-01" }, body: raw });
      expect(response.status, await response.text()).toBe(200);
      expect(seen.at(-1)?.equals(Buffer.from(raw))).toBe(true);
    }
    expect(seen).toHaveLength(2);
  } finally {
    proxy.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30_000);
