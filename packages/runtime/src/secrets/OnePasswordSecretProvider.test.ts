// The 1Password driver against a fake `op`: a Node script that answers like op 2 does (values on stdout, errors on
// stderr) and records how it was called, never a token (only whether the one it got was the expected one).
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import { classifyOnePasswordError, makeDriver } from "./OnePasswordSecretProvider.ts";

interface FakeOp {
  readonly binary: string;
  readonly calls: () => ReadonlyArray<{
    readonly args: ReadonlyArray<string>;
    readonly token: string;
  }>;
}

const SERVICE_TOKEN =
  "ops_eyJzaWduSW5BZGRyZXNzIjoibXkuMXBhc3N3b3JkLmNvbSJ9.fake-service-account-token";

/** A fake `op` in a fresh directory: `secrets` by reference; `locked` answers every call as op does when signed out. */
const fakeOp = (
  options: {
    readonly secrets?: Readonly<Record<string, string>>;
    readonly locked?: boolean;
    readonly injectFails?: boolean;
  } = {},
): FakeOp => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "caveman-fake-op-"));
  const log = NodePath.join(dir, "calls.jsonl");
  const config = {
    log,
    secrets: options.secrets ?? {},
    locked: options.locked === true,
    injectFails: options.injectFails === true,
    expectToken: SERVICE_TOKEN,
  };
  const binary = NodePath.join(dir, "op");
  NodeFS.writeFileSync(
    binary,
    `#!/usr/bin/env node
const fs = require("fs");
const cfg = ${JSON.stringify(config)};
const args = process.argv.slice(2);
const token = process.env.OP_SERVICE_ACCOUNT_TOKEN;
fs.appendFileSync(cfg.log, JSON.stringify({ args, token: token === undefined ? "unset" : token === cfg.expectToken ? "expected" : "other" }) + "\\n");
if (cfg.locked) { process.stderr.write("[ERROR] 2026/11/05 10:00:00 You are not currently signed in. Please run \`op signin --help\` for instructions"); process.exit(1); }
const command = args.find((a) => !a.startsWith("-"));
if (command === "whoami") { process.stdout.write("URL: https://my.1password.com\\nUser Type: HUMAN\\n"); process.exit(0); }
if (command === "read") {
  const ref = args[args.length - 1];
  if (Object.hasOwn(cfg.secrets, ref)) { process.stdout.write(cfg.secrets[ref]); process.exit(0); }
  process.stderr.write("[ERROR] 2026/11/05 10:00:00 could not read secret '" + ref + "': \\"Nope\\" isn't an item in the \\"Dev\\" vault. Specify the item with its UUID, name, or domain.");
  process.exit(1);
}
if (command === "inject") {
  if (cfg.injectFails) { process.stderr.write("[ERROR] could not resolve item"); process.exit(1); }
  const file = args[args.indexOf("-i") + 1];
  let missing = false;
  const out = fs.readFileSync(file, "utf8").replace(/\\{\\{ (op:\\/\\/[^}]+?) \\}\\}/g, (_, ref) => {
    if (!Object.hasOwn(cfg.secrets, ref)) { missing = true; return ""; }
    return cfg.secrets[ref];
  });
  if (missing) { process.stderr.write("[ERROR] could not resolve: isn't an item"); process.exit(1); }
  process.stdout.write(out + "\\n");
  process.exit(0);
}
process.stderr.write("unknown command"); process.exit(2);
`,
    { mode: 0o755 },
  );
  return {
    binary,
    calls: () =>
      NodeFS.existsSync(log)
        ? NodeFS.readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [],
  };
};

const app = { account: "my.1password.com" } as never;
const serviceAccount = { serviceAccount: true } as never;

describe("OnePasswordSecretProvider", () => {
  it.effect(
    "reads one reference with op read, signed in through the app account, without op's daemon",
    () =>
      Effect.gen(function* () {
        const op = fakeOp({
          secrets: { "op://Dev/Cursor/credential": "crsr_live_1234567890abcdef" },
        });
        const driver = makeDriver({ binary: op.binary });
        const outcomes = yield* driver.read(app, ["op://Dev/Cursor/credential"], {});
        assert.deepStrictEqual(outcomes, [{ value: "crsr_live_1234567890abcdef" }]);
        const [call] = op.calls();
        assert.deepStrictEqual(call!.args, [
          "--cache=false",
          "read",
          "--account=my.1password.com",
          "--no-newline",
          "op://Dev/Cursor/credential",
        ]);
        assert.strictEqual(call!.token, "unset");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads several references with one op inject, so the vault unlocks once", () =>
    Effect.gen(function* () {
      const op = fakeOp({
        secrets: { "op://Dev/A/key": "value-a-0123456789", "op://Dev/B/key": "  spaced value b  " },
      });
      const driver = makeDriver({ binary: op.binary });
      const outcomes = yield* driver.read(app, ["op://Dev/A/key", "op://Dev/B/key"], {});
      // Surrounding whitespace can be part of a secret: passed on verbatim.
      assert.deepStrictEqual(outcomes, [
        { value: "value-a-0123456789" },
        { value: "  spaced value b  " },
      ]);
      assert.deepStrictEqual(
        op.calls().map((c) => c.args[1]),
        ["inject"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "falls back to one read each when inject fails, and says which reference is missing",
    () =>
      Effect.gen(function* () {
        const op = fakeOp({
          secrets: { "op://Dev/A/key": "value-a-0123456789" },
          injectFails: true,
        });
        const driver = makeDriver({ binary: op.binary });
        const outcomes = yield* driver.read(app, ["op://Dev/A/key", "op://Dev/Nope/key"], {});
        assert.deepStrictEqual(outcomes, [
          { value: "value-a-0123456789" },
          { failure: "not_found" },
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a signed-out op is locked, for every reference, without one read each", () =>
    Effect.gen(function* () {
      const op = fakeOp({ locked: true });
      const driver = makeDriver({ binary: op.binary });
      const outcomes = yield* driver.read(app, ["op://Dev/A/key", "op://Dev/B/key"], {});
      assert.deepStrictEqual(outcomes, [{ failure: "locked" }, { failure: "locked" }]);
      assert.strictEqual(op.calls().length, 1);
      assert.deepStrictEqual(yield* driver.check(app, {}), { failure: "locked" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("no op on this computer is not_installed", () =>
    Effect.gen(function* () {
      const driver = makeDriver({
        binary: NodePath.join(NodeOS.tmpdir(), "no-such-dir-caveman", "op"),
      });
      assert.deepStrictEqual(yield* driver.read(app, ["op://Dev/A/key"], {}), [
        { failure: "not_installed" },
      ]);
      assert.deepStrictEqual(yield* driver.check(app, {}), { failure: "not_installed" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "a service account's token goes to op in its environment only, never on its command line",
    () =>
      Effect.gen(function* () {
        const op = fakeOp({
          secrets: { "op://CI/GitHub/token": ("gh" + "p_0123456789abcdefghijklmnop") },
        });
        const driver = makeDriver({ binary: op.binary });
        const outcomes = yield* driver.read(serviceAccount, ["op://CI/GitHub/token"], {
          serviceAccountToken: SERVICE_TOKEN,
        });
        assert.deepStrictEqual(outcomes, [{ value: ("gh" + "p_0123456789abcdefghijklmnop") }]);
        const [call] = op.calls();
        assert.strictEqual(call!.token, "expected");
        assert.isFalse(
          call!.args.some((a) => a.includes(SERVICE_TOKEN) || a.startsWith("--account")),
        );
        assert.deepStrictEqual(
          yield* driver.check(serviceAccount, { serviceAccountToken: SERVICE_TOKEN }),
          {},
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a service account without its token never runs op", () =>
    Effect.gen(function* () {
      const op = fakeOp();
      const driver = makeDriver({ binary: op.binary });
      assert.deepStrictEqual(yield* driver.read(serviceAccount, ["op://CI/GitHub/token"], {}), [
        { failure: "no_token" },
      ]);
      assert.strictEqual(op.calls().length, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a token in the runtime's own environment never signs op in for an app account", () =>
    Effect.gen(function* () {
      const op = fakeOp({ secrets: { "op://Dev/A/key": "value-a-0123456789" } });
      const driver = makeDriver({ binary: op.binary });
      const before = process.env.OP_SERVICE_ACCOUNT_TOKEN;
      process.env.OP_SERVICE_ACCOUNT_TOKEN = SERVICE_TOKEN;
      try {
        yield* driver.read(app, ["op://Dev/A/key"], {});
      } finally {
        if (before === undefined) delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
        else process.env.OP_SERVICE_ACCOUNT_TOKEN = before;
      }
      assert.strictEqual(op.calls()[0]!.token, "unset");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("classifies op's errors without keeping them", () => {
    assert.strictEqual(
      classifyOnePasswordError("[ERROR] You are not currently signed in."),
      "locked",
    );
    assert.strictEqual(
      classifyOnePasswordError("[ERROR] authorization prompt dismissed, please try again"),
      "locked",
    );
    assert.strictEqual(classifyOnePasswordError("[ERROR] invalid service account token"), "locked");
    assert.strictEqual(
      classifyOnePasswordError(
        `[ERROR] could not read secret 'op://Dev/X/y': "X" isn't an item in the "Dev" vault.`,
      ),
      "not_found",
    );
    assert.strictEqual(classifyOnePasswordError("[ERROR] something else"), "failed");
  });
});
