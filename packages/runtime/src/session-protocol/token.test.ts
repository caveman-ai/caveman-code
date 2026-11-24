// A runtime the desktop started still writes its 0600 token file, so
// `caveman code` (and a desktop that did not start it) can attach to it.
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { connect } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";

import * as SessionProtocol from "./index.ts";
import { makeConfig, startRuntime } from "./testHarness.ts";

const upgradeStatus = (port: number, token: string) =>
  new Promise<number | undefined>((resolve, reject) => {
    const request = http.get({
      host: "127.0.0.1",
      port,
      path: "/session/v1",
      headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", authorization: `Bearer ${token}` },
    });
    request.on("response", (response) => resolve(response.statusCode));
    request.on("upgrade", (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    request.on("error", reject);
  });

test("a desktop-started runtime accepts its bootstrap token and the token file's, nothing else", async () => {
  const config = { ...(await makeConfig()), desktopBootstrapToken: "desktop-bootstrap-token" };
  const runtime = await startRuntime(config, "fake-claude");
  try {
    const file = path.join(config.stateDir, SessionProtocol.TOKEN_FILE);
    // Skipped on Windows: no POSIX mode bits (the profile's ACL keeps the file).
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const fromFile = fs.readFileSync(file, "utf8");
    expect(fromFile).toMatch(/^[0-9a-f]{64}$/);
    for (const token of [fromFile, "desktop-bootstrap-token"]) {
      const client = connect(runtime.url, token);
      expect((await client.call("engine.list", {})).engines.map((e) => e.id)).toContain("claude-agent");
      client.close();
    }
    expect(await upgradeStatus(runtime.port, "nope")).toBe(401);
  } finally {
    await runtime.close();
  }
});
