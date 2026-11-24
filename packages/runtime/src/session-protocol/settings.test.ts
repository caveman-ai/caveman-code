// settings.set on the real runtime with upstream file-backed settings, wired as server.ts wires them: the web client sends
// each save at once, without waiting for the one before (SettingsSaves), and settings sync applies another computer's
// change through the same handler, so saves in flight together must each land.
import * as fs from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { connect } from "@caveman-app/session-protocol";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, expect, test } from "vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeConfig, startRuntime, tempRoot } from "./testHarness.ts";

let root: string;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;

beforeAll(async () => {
  root = tempRoot("sp-settings-");
  const config = await makeConfig();
  const fileBacked = ServerSettings.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(Layer.succeed(ServerConfig.ServerConfig, config)),
    Layer.provide(NodeServices.layer),
    Layer.orDie,
  );
  runtime = await startRuntime(config, "fake-claude", undefined, { provide: fileBacked });
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("two settings saves in flight together both land, one of them kept in T3's settings file", async () => {
  const before = await client.call("settings.get", {});
  expect(before.git_co_author).not.toBe(false);
  expect(before.review_guides).not.toBe(false);
  const [review, coAuthor] = await Promise.all([
    client.call("settings.set", { request_id: "a", settings: { review_guides: false } }),
    client.call("settings.set", { request_id: "b", settings: { git_co_author: false } }),
  ]);
  const after = await client.call("settings.get", {});
  expect({ git_co_author: after.git_co_author, review_guides: after.review_guides }).toEqual({
    git_co_author: false,
    review_guides: false,
  });
  // Whichever answered last says what the runtime holds.
  expect(
    [review, coAuthor].some((s) => s.git_co_author === false && s.review_guides === false),
  ).toBe(true);
});
