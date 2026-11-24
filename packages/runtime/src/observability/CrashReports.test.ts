import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { parseEnvelope } from "@sentry/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  crashReportsMode,
  drainOwnSpool,
  resetCrashReportsForTest,
  SPOOL_MAX_FILES,
  SPOOL_SUFFIX,
  spoolRequest,
  startCrashReports,
} from "./CrashReports.ts";
import { reportCrash } from "./crashSink.ts";

const DSN = "https://public@o1.ingest.de.sentry.io/2";
const spool = () => fs.mkdtempSync(path.join(os.tmpdir(), "crash-spool-"));
const reports = (dir: string) => fs.readdirSync(dir).filter((name) => name.endsWith(SPOOL_SUFFIX));
const eventOf = (file: string) => {
  const [, items] = parseEnvelope(fs.readFileSync(file));
  return items.find(([header]) => header.type === "event")![1] as Record<string, any>;
};

afterEach(() => resetCrashReportsForTest());

describe("crashReportsMode", () => {
  it("starts nowhere without a DSN, and never when the environment turns telemetry off", () => {
    expect(crashReportsMode({})).toBeUndefined();
    expect(crashReportsMode({ CAVEMAN_CRASH_SPOOL: "/tmp/x" })).toBeUndefined();
    expect(crashReportsMode({ CAVEMAN_CRASH_DSN: "not a dsn" })).toBeUndefined();
    expect(crashReportsMode({ CAVEMAN_CRASH_DSN: DSN, DO_NOT_TRACK: "1" })).toBeUndefined();
    expect(crashReportsMode({ CAVEMAN_CRASH_DSN: DSN, CAVEMAN_TELEMETRY: "0" })).toBeUndefined();
  });

  it("spools under the desktop and sends itself on a Cloud computer", () => {
    expect(crashReportsMode({ CAVEMAN_CRASH_DSN: DSN, CAVEMAN_CRASH_SPOOL: "/tmp/x" })).toEqual({
      kind: "desktop",
      dir: "/tmp/x",
      dsn: DSN,
    });
    expect(crashReportsMode({ CAVEMAN_CRASH_DSN: DSN, CAVEMAN_CODE_HOME: "/data/home" })).toEqual({
      kind: "direct",
      dir: "/data/home/crash-reports",
      dsn: DSN,
    });
  });
});

describe("the spool", () => {
  it("holds a report, scrubbed, as one envelope file", async () => {
    const dir = spool();
    expect(
      startCrashReports({
        CAVEMAN_CRASH_DSN: DSN,
        CAVEMAN_CRASH_SPOOL: dir,
        CAVEMAN_APP_VERSION: "0.1.6",
        CAVEMAN_BUILD_CHANNEL: "stable",
      }),
    ).toBe(true);
    reportCrash(
      new Error(`could not open ${os.homedir()}/secret/.env for ada@example.com`),
      "rpc_defect",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [file] = reports(dir);
    const event = eventOf(path.join(dir, file!));
    expect(event.release).toBe("caveman-code@0.1.6");
    expect(event.environment).toBe("stable");
    expect(event.tags).toMatchObject({ "event.process": "runtime", host: "desktop" });
    expect(event.exception.values[0].value).toBe(
      "could not open ~/secret/.env for [REDACTED:email]",
    );
    expect(event.exception.values[0].mechanism).toMatchObject({
      type: "rpc_defect",
      handled: true,
    });
    expect(event.server_name).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain(os.homedir());
  });

  it("stops writing once full", async () => {
    const dir = spool();
    for (let i = 0; i < SPOOL_MAX_FILES; i++)
      fs.writeFileSync(path.join(dir, `${i}${SPOOL_SUFFIX}`), "x");
    await spoolRequest(dir)({ body: "envelope" });
    expect(reports(dir)).toHaveLength(SPOOL_MAX_FILES);
  });

  it("has an uncaught exception's report on disk before the process exits", () => {
    const dir = spool();
    const module = fileURLToPath(new URL("./CrashReports.ts", import.meta.url));
    const script = `const { startCrashReports } = await import(${JSON.stringify(module)}); startCrashReports(); setTimeout(() => { throw new TypeError("boom"); }, 0);`;
    const child = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
      {
        env: {
          PATH: process.env.PATH,
          HOME: os.homedir(),
          CAVEMAN_CRASH_DSN: DSN,
          CAVEMAN_CRASH_SPOOL: dir,
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    // Node still ends the process as it would have: the monitor changes nothing.
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("TypeError: boom");
    const [file] = reports(dir);
    expect(file).toBeDefined();
    const event = eventOf(path.join(dir, file!));
    expect(event.level).toBe("fatal");
    expect(event.exception.values[0]).toMatchObject({
      type: "TypeError",
      value: "boom",
      mechanism: { type: "uncaught_exception", handled: false },
    });
  });
});

describe("a Cloud computer's own spool", () => {
  /** A stand-in for Sentry's ingest that answers each post with the next status in `statuses`. */
  const ingest = async (statuses: number[]) => {
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        bodies.push(Buffer.concat(chunks).toString());
        res.writeHead(statuses.shift() ?? 200).end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/2/envelope/`;
    return { url, bodies, close: () => new Promise((resolve) => server.close(resolve)) };
  };

  it("sends each report oldest first and deletes what Sentry took or refused for good", async () => {
    const dir = spool();
    for (const name of ["1-a", "2-b", "3-c"])
      fs.writeFileSync(path.join(dir, `${name}${SPOOL_SUFFIX}`), name);
    const sentry = await ingest([200, 400, 200]);
    expect(await drainOwnSpool(dir, sentry.url)).toBe(2);
    expect(sentry.bodies).toEqual(["1-a", "2-b", "3-c"]);
    expect(reports(dir)).toEqual([]);
    await sentry.close();
  });

  it("keeps what a rate limit, a server error or no network stopped, for the next round", async () => {
    const dir = spool();
    for (const name of ["1-a", "2-b"])
      fs.writeFileSync(path.join(dir, `${name}${SPOOL_SUFFIX}`), name);
    const sentry = await ingest([200, 429]);
    expect(await drainOwnSpool(dir, sentry.url)).toBe(1);
    expect(reports(dir)).toEqual(["2-b.envelope"]);
    await sentry.close();
    expect(await drainOwnSpool(dir, sentry.url)).toBe(0);
    expect(reports(dir)).toEqual(["2-b.envelope"]);
  });
});
