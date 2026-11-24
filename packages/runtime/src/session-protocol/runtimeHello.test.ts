// runtime.hello on a running runtime (session-protocol README: Versioning): every connection's first call, answered
// with this build's version, the revision it speaks, the oldest client it serves and its capabilities, so a client
// tells skew from it; the client keeps the answer per connection.
import {
  connect,
  MIN_CLIENT_REVISION,
  PROTOCOL_REVISION,
  versionSkew,
} from "@caveman-app/session-protocol";
import { afterEach, expect, test } from "vitest";

import { RUNTIME_CAPABILITIES, RUNTIME_VERSION } from "../runtimeVersion.ts";
import { makeConfig, startRuntime, until } from "./testHarness.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test(
  "the runtime answers runtime.hello with its build, its revision and the oldest client it serves",
  { timeout: 60_000 },
  async () => {
    const runtime = await startRuntime(await makeConfig(), "fake-claude");
    cleanups.push(runtime.close);
    const client = connect(runtime.url, runtime.token, undefined, { clientVersion: "0.5.0" });
    cleanups.push(() => client.close());
    const expected = {
      version: RUNTIME_VERSION,
      protocol_revision: PROTOCOL_REVISION,
      min_client_revision: MIN_CLIENT_REVISION,
      capabilities: [...RUNTIME_CAPABILITIES],
    };
    // Asked directly, and kept by the client from its own first call.
    await expect(
      client.call("runtime.hello", {
        client_version: "0.5.0",
        protocol_revision: PROTOCOL_REVISION,
      }),
    ).resolves.toEqual(expected);
    await until(() => client.hello() !== undefined);
    expect(client.hello()).toEqual(expected);
    // A client of this build and a runtime of this build always work together.
    expect(versionSkew(client.hello()!)).toBeNull();
  },
);
