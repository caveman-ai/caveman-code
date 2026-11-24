// The test runtime shuts down as the daemon's server does (server.ts gives HTTP no preemptive drain), so a test that
// stops it under a connected client (cli/code.test.ts's attach) does not wait out Effect's default 20 s first.
import { connect } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";

import { makeConfig, startRuntime } from "./testHarness.ts";

test("a test runtime stops promptly with a client still connected", async () => {
  const runtime = await startRuntime(await makeConfig(), "fake-claude");
  const client = connect(runtime.url, runtime.token);
  try {
    await client.call("engine.list", {});
    const started = Date.now();
    await runtime.close();
    expect(Date.now() - started).toBeLessThan(5_000);
  } finally {
    client.close();
  }
}, 60_000);
