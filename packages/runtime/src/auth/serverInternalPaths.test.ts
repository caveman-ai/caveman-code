import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { symlinksSupported } from "@caveman-app/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import { afterAll, describe, expect, test } from "vitest";

import * as ServerConfig from "../config.ts";
import { makeIsServerInternalPath, makeServerInternalPathCheck } from "./serverInternalPaths.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "server-internal-paths-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const stateDir = path.join(root, "userdata");
const config = { stateDir, secretsDir: path.join(stateDir, "secrets") };
const write = (file: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x");
  return file;
};

const refused = [
  path.join(config.secretsDir, "server-signing-key.bin"),
  path.join(config.secretsDir, "not-written-yet.bin"),
  path.join(stateDir, "statev2.sqlite"),
  path.join(stateDir, "statev2.sqlite-wal"),
  path.join(stateDir, "server-owner.sqlite"),
  path.join(stateDir, "session-protocol.token"),
  path.join(stateDir, "proxy", "credentials.json"),
  path.join(stateDir, "cloud-link", "identity.json"),
  path.join(stateDir, "claude-env", "env"),
  path.join(stateDir, "plugin-credentials", "github.json"),
];
const served = [
  path.join(stateDir, "attachments", "shot.png"),
  path.join(stateDir, "browser-artifacts", "page.png"),
  path.join(stateDir, "settings.json"),
  path.join(stateDir, "logs", "statev2.sqlite.txt"),
  path.join(root, "project", "data.sqlite"),
];
for (const file of [...refused, ...served]) if (!file.includes("not-written-yet")) write(file);

describe("server internal paths", () => {
  test("refuses the secrets, databases and credential files in the state dir, nothing else", () => {
    const internal = makeServerInternalPathCheck(config);
    for (const file of refused) expect(internal(file), file).toBe(true);
    for (const file of served) expect(internal(file), file).toBe(false);
    // `..` resolves first.
    expect(internal(path.join(config.secretsDir, "..", "secrets", "server-signing-key.bin"))).toBe(
      true,
    );
    expect(internal(path.join(config.secretsDir, "..", "attachments", "shot.png"))).toBe(false);
  });

  test.skipIf(!symlinksSupported)("follows symlinks to what they name", () => {
    const internal = makeServerInternalPathCheck(config);
    const link = path.join(root, "project", "shot.png");
    fs.symlinkSync(path.join(config.secretsDir, "server-signing-key.bin"), link);
    expect(internal(link)).toBe(true);
    const dbLink = path.join(root, "project", "db");
    fs.symlinkSync(stateDir, dbLink);
    expect(internal(path.join(dbLink, "statev2.sqlite"))).toBe(true);
    expect(internal(path.join(dbLink, "attachments", "shot.png"))).toBe(false);
  });

  test.skipIf(process.platform === "win32")("refuses another way into an open file", () => {
    const internal = makeServerInternalPathCheck(config);
    expect(internal("/dev/fd/987")).toBe(true);
    expect(internal("/proc/self/environ")).toBe(true);
  });

  test("the Effect check answers the same", async () => {
    const answers = await Effect.runPromise(
      Effect.gen(function* () {
        const isServerInternalPath = yield* makeIsServerInternalPath;
        return yield* Effect.forEach([...refused, ...served], isServerInternalPath);
      }).pipe(
        Effect.provide(
          ServerConfig.layer(config as unknown as ServerConfig.ServerConfig["Service"]),
        ),
        Effect.provide(NodeServices.layer),
      ),
    );
    expect(answers).toEqual([...refused.map(() => true), ...served.map(() => false)]);
  });
});
