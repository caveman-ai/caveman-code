// A Cloud computer's resolve (H1): a refusal (revoked runtime, shared or sleeping computer) forgets the
// values at once and never falls back to them; only an unreachable Cloud keeps the last ones, for minutes.
// And its secrets store: a value the person stores is hidden at once, as on This Mac.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import { afterEach, expect, test, vi } from "vitest";

import { CONNECTORS_REPOSITORY } from "../plugins/connectors.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import { ACCOUNT_SECRETS } from "../session-protocol/account.ts";
import { rejectSecretInput } from "../session-protocol/secrets.ts";
import { CloudValues, keptOnMacOnly, makeProjectSecrets, resolver } from "./computerSecrets.ts";
import { CloudError, enroll } from "./identity.ts";
import { CloudComputer, CloudLinkState } from "./index.ts";
import { startTestCloud } from "./testCloud.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const setup = () => {
  const answers: Array<() => Effect.Effect<ReadonlyArray<{ name: string; value: string }>, unknown>> = [];
  let calls = 0;
  const dropped: string[] = [];
  const r = resolver(
    () => {
      calls++;
      return answers.shift()!();
    },
    (k) => k,
    (k) => dropped.push(k),
  );
  const run = () => Effect.runPromise(r.resolve("github.com/acme/app"));
  return { answers, run, dropped, calls: () => calls };
};
const ok = (value: string) => () => Effect.succeed([{ name: "API_TOKEN", value }]);
const fail = (status: number, code?: string) => () => Effect.fail(new CloudError(status, "no", code));

test("a 403 (another person's work on this computer) or a 401 (revoked) drops the values; nothing falls back", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  for (const status of [401, 403]) {
    const s = setup();
    s.answers.push(ok("A-value"), fail(status, "cave_code_computer_shared"), ok("B-value"));
    expect(await s.run()).toEqual([{ name: "API_TOKEN", value: "A-value" }]);
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect(await s.run()).toEqual([]);
    expect(s.dropped).toEqual(["github.com/acme/app"]);
    // Refused just now: none, without asking Cloud again for a minute.
    expect(await s.run()).toEqual([]);
    expect(s.calls()).toBe(2);
    vi.setSystemTime(Date.now() + 61_000);
    expect(await s.run()).toEqual([{ name: "API_TOKEN", value: "B-value" }]);
  }
});

test("a 409 for a disabled service account fails closed like a refusal, never as an unreachable Cloud", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const s = setup();
  s.answers.push(ok("A-value"), fail(409, "cave_code_service_account_inactive"));
  expect(await s.run()).toHaveLength(1);
  vi.setSystemTime(Date.now() + 6 * 60_000);
  // Within the stale window an unreachable Cloud would keep A-value; a disabled account keeps nothing.
  expect(await s.run()).toEqual([]);
  expect(s.dropped).toEqual(["github.com/acme/app"]);
  expect(await s.run()).toEqual([]);
  expect(s.calls()).toBe(2);
});

test("Cloud unreachable (network, 5xx): the last values for a few minutes, then none", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const s = setup();
  s.answers.push(ok("A-value"), fail(503), fail(503));
  expect(await s.run()).toHaveLength(1);
  // Fresh for five minutes: one resolve (one access-log row), not one per spawn.
  expect(await s.run()).toHaveLength(1);
  expect(s.calls()).toBe(1);
  vi.setSystemTime(Date.now() + 6 * 60_000);
  expect(await s.run()).toEqual([{ name: "API_TOKEN", value: "A-value" }]);
  vi.setSystemTime(Date.now() + 5 * 60_000);
  expect(await s.run()).toEqual([]);
});

test("a 400 (Cloud refuses the request itself as malformed) is asked once: none, and never asked again", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const s = setup();
  s.answers.push(fail(400, "cave_bad_request"), ok("never"));
  expect(await s.run()).toEqual([]);
  // A refusal waits a minute and an unreachable Cloud is asked at every resolve; the same request gets the same 400.
  for (const later of [0, 10_000, 61_000, 11 * 60_000, 60 * 60_000]) {
    vi.setSystemTime(Date.now() + later);
    expect(await s.run()).toEqual([]);
  }
  expect(s.calls()).toBe(1);
});

test("keptOnMacOnly: This Mac's own slots, never a repository or the servers' keys", () => {
  for (const slot of [ACCOUNT_SECRETS, CONNECTORS_REPOSITORY, "local:/work/app"]) expect(keptOnMacOnly(slot)).toBe(true);
  for (const key of ["github.com/acme/app", "acme/app", "gitlab.example.com:8443/acme/app", "https://github.com/acme/app", "caveman:servers"]) expect(keptOnMacOnly(key)).toBe(false);
});

// What a claimed computer did: the connectors' sign-ins (caveman:connectors) were asked of Cloud's resolve route on every
// read, and Cloud answered 400 each time (it keeps secrets only per repository and for caveman:servers).
test("on a Cloud computer This Mac's own slots are empty and never asked of Cloud; a repository still is", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const linkDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "computer-secrets-link-")), "link");
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "computer-secrets-ws-"));
  const identity = await enroll({ dir: linkDir, cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "computer" });
  cloud.state.parity.computers.add(identity.runtimeId);
  const scope = await Effect.runPromise(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const context = await Effect.runPromise(
    Layer.buildWithScope(
      Layer.effect(ProjectSecrets, makeProjectSecrets).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(CloudComputer, { linkDir, computerId: identity.computerId, workspaceRoot }),
            Layer.succeed(CloudLinkState, {}),
            Layer.succeed(CloudValues, { seen: new Map(), version: 0 }),
          ),
        ),
      ),
      scope,
    ),
  );
  const secrets = Context.get(context, ProjectSecrets);
  for (const slot of [ACCOUNT_SECRETS, CONNECTORS_REPOSITORY, "local:/work/app"]) {
    expect(await Effect.runPromise(secrets.resolve(slot))).toEqual([]);
    expect(await Effect.runPromise(secrets.has(slot))).toBe(false);
    expect(await Effect.runPromise(secrets.list(slot))).toEqual([]);
    await Effect.runPromise(secrets.remove(slot, "TOKEN"));
  }
  // Saving one here fails without a request, as Cloud's 400 did.
  await expect(Effect.runPromise(secrets.set(CONNECTORS_REPOSITORY, [{ name: "TOKEN", value: Redacted.make("v") }]))).rejects.toThrow(/keeps no caveman:connectors/);
  expect(cloud.state.parity.requests).toEqual([]);
  // A repository's secrets are still Cloud's to answer.
  expect(await Effect.runPromise(secrets.resolve("github.com/acme/app"))).toEqual([]);
  expect(cloud.state.parity.requests.map((r) => r.path)).toEqual(["/api/v1/code/runtime/secrets/resolve?repository=github.com%2Facme%2Fapp"]);
}, 60_000);

test("a secret stored on a Cloud computer is hidden at once: tool output is scrubbed and chat refuses it, before anything resolves", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const linkDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "computer-secrets-link-")), "link");
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "computer-secrets-ws-"));
  const identity = await enroll({ dir: linkDir, cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "computer" });
  cloud.state.parity.computers.add(identity.runtimeId);
  const scope = await Effect.runPromise(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const context = await Effect.runPromise(
    Layer.buildWithScope(
      Layer.effect(ProjectSecrets, makeProjectSecrets).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(CloudComputer, { linkDir, computerId: identity.computerId, workspaceRoot }),
            Layer.succeed(CloudLinkState, {}),
            Layer.succeed(CloudValues, { seen: new Map(), version: 0 }),
          ),
        ),
      ),
      scope,
    ),
  );
  const secrets = Context.get(context, ProjectSecrets);
  // No known token shape: only the stored value itself can tell it is a secret (a database password).
  const value = "Vq7pX2rTm9LwZk4bN8yC3sHdStoredNow";
  const stored = await Effect.runPromise(secrets.set("github.com/acme/widgets", [{ name: "DATABASE_PASSWORD", value: Redacted.make(value) }]));
  expect(stored.map((s) => s.name)).toEqual(["DATABASE_PASSWORD"]);
  expect(cloud.state.parity.secrets.get("github.com/acme/widgets")?.get("DATABASE_PASSWORD")).toBe(value);
  // The running agent prints the .env it was just written to, and the person pastes the value into chat.
  const scrubbed = (await Effect.runPromise(secrets.scrubber)).scrub(`$ cat .env\nDATABASE_PASSWORD=${value}\n`);
  const pasted = await Effect.runPromise(Effect.exit(rejectSecretInput(secrets, `here it is: ${value}`)));
  expect({ scrubbed, refused: Exit.isFailure(pasted) }).toEqual({ scrubbed: "$ cat .env\nDATABASE_PASSWORD=[secret:DATABASE_PASSWORD]\n", refused: true });
}, 60_000);
