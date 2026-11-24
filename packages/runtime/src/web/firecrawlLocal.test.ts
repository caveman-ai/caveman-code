// Firecrawl Local as the runtime runs it: found in the right places, started once on a loopback port with a token,
// given a bare environment and Firecrawl Cloud only on the person's key, restarted when that key changes or the
// process stops, and stopped on close. A stand-in `firecrawl-local` (a Node script) answers as `serve` does.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FirecrawlPageRefused } from "./firecrawl.ts";
import { findFirecrawlLocal, firecrawlLocalEnv, makeFirecrawlLocal } from "./firecrawlLocal.ts";
import { WebProviderError } from "./providers.ts";

let dir: string;
let fake: string;

/**
 * `serve --port P --token T`: /health and /v2/scrape behind the token. A scrape answers with what the process saw
 * (its pid and environment) as markdown; `/missing` answers as a page that said 404, `/crash` ends the process.
 */
const FAKE = `#!/usr/bin/env node
const http = require("node:http");
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const token = arg("--token");
http.createServer((req, res) => {
  if (req.headers.authorization !== "Bearer " + token) return res.writeHead(401).end();
  if (req.url === "/health") return res.writeHead(200).end("ok");
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const { url } = JSON.parse(body);
    if (url.endsWith("/crash")) process.exit(1);
    const statusCode = url.endsWith("/missing") ? 404 : 200;
    const seen = { pid: process.pid, cloud: process.env.FIRECRAWL_CLOUD, key: process.env.FIRECRAWL_API_KEY ?? null, secret: process.env.SOME_RUNTIME_SECRET ?? null, home: process.env.FIRECRAWL_LOCAL_HOME };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ success: true, data: { markdown: "# Read\\n\\n" + JSON.stringify(seen), metadata: { title: "Read", url, statusCode } } }));
  });
}).listen(Number(arg("--port")), arg("--host"));
`;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "firecrawl-local-test-"));
  fake = path.join(dir, "firecrawl-local");
  fs.writeFileSync(fake, FAKE, { mode: 0o755 });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const seen = (markdown: string) =>
  JSON.parse(markdown.split("\n").at(-1)!) as {
    pid: number;
    cloud: string;
    key: string | null;
    secret: string | null;
    home: string;
  };
const signal = () => AbortSignal.timeout(10_000);

describe("findFirecrawlLocal", () => {
  it("takes the override alone when set, then the bundled copy, then PATH, then ~/.cargo/bin", () => {
    const bundled = path.join(dir, "bundled");
    const onPath = path.join(dir, "path");
    const home = path.join(dir, "home");
    for (const d of [bundled, onPath, path.join(home, ".cargo", "bin")])
      fs.mkdirSync(d, { recursive: true });
    const cargo = path.join(home, ".cargo", "bin", "firecrawl-local");
    fs.copyFileSync(fake, cargo);
    fs.chmodSync(cargo, 0o755);
    expect(findFirecrawlLocal({ PATH: onPath, HOME: home }, bundled)).toBe(cargo);
    fs.copyFileSync(fake, path.join(onPath, "firecrawl-local"));
    fs.chmodSync(path.join(onPath, "firecrawl-local"), 0o755);
    expect(findFirecrawlLocal({ PATH: onPath, HOME: home }, bundled)).toBe(
      path.join(onPath, "firecrawl-local"),
    );
    fs.copyFileSync(fake, path.join(bundled, "firecrawl-local"));
    fs.chmodSync(path.join(bundled, "firecrawl-local"), 0o755);
    expect(findFirecrawlLocal({ PATH: onPath, HOME: home }, bundled)).toBe(
      path.join(bundled, "firecrawl-local"),
    );
    expect(
      findFirecrawlLocal({ PATH: onPath, HOME: home, CAVEMAN_FIRECRAWL_LOCAL_BIN: fake }, bundled),
    ).toBe(fake);
    // Set to nothing or to a missing file: none, whatever else is installed.
    expect(
      findFirecrawlLocal({ PATH: onPath, HOME: home, CAVEMAN_FIRECRAWL_LOCAL_BIN: "" }, bundled),
    ).toBeUndefined();
    expect(
      findFirecrawlLocal(
        { PATH: onPath, HOME: home, CAVEMAN_FIRECRAWL_LOCAL_BIN: path.join(dir, "missing") },
        bundled,
      ),
    ).toBeUndefined();
    // A file that is not executable is not one.
    const plain = path.join(dir, "plain");
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, "firecrawl-local"), "");
    expect(
      findFirecrawlLocal({ PATH: plain, HOME: path.join(dir, "nobody") }, path.join(dir, "none")),
    ).toBeUndefined();
  });
});

describe("firecrawlLocalEnv", () => {
  it("passes what finding Chrome needs and nothing of the runtime's own, with Firecrawl Cloud only on a key", () => {
    const env = {
      PATH: "/bin",
      HOME: "/Users/me",
      ANTHROPIC_API_KEY: "sk-ant-x",
      CAVEMAN_CODE_TOKEN: "t",
      FIRECRAWL_API_KEY: "fc-ambient",
      AWS_SECRET_ACCESS_KEY: "a",
    };
    expect(firecrawlLocalEnv("/state/firecrawl-local", undefined, env)).toEqual({
      PATH: "/bin",
      HOME: "/Users/me",
      FIRECRAWL_LOCAL_HOME: "/state/firecrawl-local",
      FIRECRAWL_CLI_CREDENTIALS: path.join("/state/firecrawl-local", "no-login.json"),
      FIRECRAWL_CLOUD: "off",
    });
    expect(firecrawlLocalEnv("/state/firecrawl-local", "fc-from-settings", env)).toMatchObject({
      FIRECRAWL_CLOUD: "auto",
      FIRECRAWL_API_KEY: "fc-from-settings",
    });
  });
});

describe("makeFirecrawlLocal", () => {
  it("starts once, reads through the token, restarts for a new key or a stopped process, and stops on close", async () => {
    process.env.SOME_RUNTIME_SECRET = "must-not-leak";
    const home = path.join(dir, "state");
    const local = makeFirecrawlLocal({ find: () => fake, home });
    try {
      expect(local.installed()).toBe(true);
      const first = await local.scrape("https://docs.example.com/a", undefined, signal());
      expect(first.title).toBe("Read");
      const a = seen(first.markdown);
      expect(a).toMatchObject({ cloud: "off", key: null, secret: null, home });
      expect((fs.statSync(home).mode & 0o777).toString(8)).toBe("700");
      // The same process for the next read.
      expect(
        seen((await local.scrape("https://docs.example.com/b", undefined, signal())).markdown).pid,
      ).toBe(a.pid);
      // A key from Settings: a fresh process that may ask Firecrawl Cloud on it.
      const keyed = seen(
        (await local.scrape("https://docs.example.com/c", "fc-key-0123456789", signal())).markdown,
      );
      expect(keyed.pid).not.toBe(a.pid);
      expect(keyed).toMatchObject({ cloud: "auto", key: "fc-key-0123456789" });
      // The page's own error is the answer about the page.
      const missing = await local
        .scrape("https://docs.example.com/missing", "fc-key-0123456789", signal())
        .catch((e: unknown) => e);
      expect(missing).toBeInstanceOf(FirecrawlPageRefused);
      expect((missing as FirecrawlPageRefused).status).toBe(404);
      // It stops mid-read: unavailable, and the next read starts it again.
      const crashed = await local
        .scrape("https://docs.example.com/crash", "fc-key-0123456789", signal())
        .catch((e: unknown) => e);
      expect(crashed).toBeInstanceOf(WebProviderError);
      expect((crashed as WebProviderError).kind).toBe("unavailable");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const again = seen(
        (await local.scrape("https://docs.example.com/d", "fc-key-0123456789", signal())).markdown,
      );
      expect(again.pid).not.toBe(keyed.pid);
      local.close();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(() => process.kill(again.pid, 0)).toThrow();
    } finally {
      local.close();
      delete process.env.SOME_RUNTIME_SECRET;
    }
  });

  it("stops the whole process tree, its Chrome included: without waiting on a key change, waiting on close", async () => {
    const kills: Array<[number | undefined, boolean]> = [];
    const local = makeFirecrawlLocal({
      find: () => fake,
      home: path.join(dir, "tree-home"),
      kill: (pid, wait) => {
        kills.push([pid, wait]);
        if (pid !== undefined) process.kill(pid);
      },
    });
    const first = seen(
      (await local.scrape("https://docs.example.com/a", undefined, signal())).markdown,
    ).pid;
    const second = seen(
      (await local.scrape("https://docs.example.com/b", "fc-key-0123456789", signal())).markdown,
    ).pid;
    local.close();
    expect(kills).toEqual([
      [first, false],
      [second, true],
    ]);
  });

  it("says it is not installed, and waits a minute before trying again a copy that would not start", async () => {
    let clock = 1_000_000;
    const none = makeFirecrawlLocal({
      find: () => undefined,
      home: path.join(dir, "none-home"),
      now: () => clock,
    });
    expect(none.installed()).toBe(false);
    await expect(
      none.scrape("https://docs.example.com/a", undefined, signal()),
    ).rejects.toMatchObject({ kind: "unavailable", message: "Firecrawl Local is not installed" });

    const broken = path.join(dir, "broken");
    fs.writeFileSync(broken, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    const local = makeFirecrawlLocal({
      find: () => broken,
      home: path.join(dir, "broken-home"),
      now: () => clock,
    });
    await expect(
      local.scrape("https://docs.example.com/a", undefined, signal()),
    ).rejects.toMatchObject({ kind: "unavailable" });
    await expect(
      local.scrape("https://docs.example.com/a", undefined, signal()),
    ).rejects.toMatchObject({ message: "Firecrawl Local did not start a moment ago" });
    clock += 61_000;
    await expect(
      local.scrape("https://docs.example.com/a", undefined, signal()),
    ).rejects.toMatchObject({
      kind: "unavailable",
      message: "Firecrawl Local stopped as it started",
    });
    local.close();
  });
});
