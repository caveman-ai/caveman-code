// A chat whose copy a newer Caveman Code wrote (a nightly's, at a protocol revision this runtime does not speak) is
// refused when this runtime is asked to adopt it, in words naming both builds, before anything is taken or written:
// no lease on Cloud's journal, no workspace here, so Cloud can hand it back to where it came from whole. Against the
// test Cloud, the runtime in-process.
import { gzipSync } from "node:zlib";

import { connect, PROTOCOL_REVISION, SessionProtocolError } from "@caveman-app/session-protocol";
import { afterEach, expect, test } from "vitest";

import { RUNTIME_VERSION } from "../runtimeVersion.ts";
import { makeConfig, startRuntime } from "../session-protocol/testHarness.ts";
import { startTestCloud } from "./testCloud.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test(
  "a chat copied by a newer runtime is refused with both versions, and nothing is taken or written",
  { timeout: 120_000 },
  async () => {
    const cloud = await startTestCloud();
    cleanups.push(cloud.close);
    const runtime = await startRuntime(await makeConfig(), "fake-claude");
    cleanups.push(runtime.close);
    const mac = connect(runtime.url, runtime.token);
    cleanups.push(() => mac.close());
    await mac.call("cloud.enroll", {
      request_id: "e1",
      cloud_url: cloud.url,
      token: cloud.state.personToken,
      name: "Test Mac",
    });
    const [macRuntimeId, macRuntime] = [...cloud.state.runtimes].at(-1)!;

    // A newer build on the same computer (the nightly this Mac ran before going back to stable) copied a chat.
    const newer = cloud.enrollRuntime({ computerId: macRuntime.computerId });
    const call = (
      method: string,
      route: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      fetch(`${cloud.url}/api/v1/code/${route}`, {
        method,
        headers: {
          authorization: `Bearer ${newer.token}`,
          ...(body instanceof Uint8Array
            ? { "content-type": "application/octet-stream" }
            : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined
          ? {}
          : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
      }).then(async (r) => ({
        status: r.status,
        body: (r.status === 204 ? undefined : await r.json()) as Record<string, any> | undefined,
      }));
    const sessionId = "s-newer";
    expect(
      (
        await call("PUT", `runtime/sessions/${sessionId}`, {
          title: "From the nightly",
          repo: "acme/web",
          base_branch: "main",
          branch: "caveman/from-nightly",
          engine: "caveman",
          follow: true,
        })
      ).status,
    ).toBe(200);
    const lease = (
      await call("PUT", `runtime/sessions/${sessionId}/journal`, {
        cursor_seq: 0,
        segments: 0,
        size_bytes: 0,
      })
    ).body!;
    const at = new Date().toISOString();
    const event = {
      session_id: sessionId,
      cursor: 1,
      at,
      type: "message.done",
      payload: { role: "assistant", text: "written by the nightly" },
    };
    const segment = gzipSync(
      JSON.stringify({
        v: 2,
        revision: PROTOCOL_REVISION + 1,
        runtime_version: "9.9.0-nightly.20261201.1",
        epoch: 1,
        from: 1,
        through: 1,
        boundary: true,
        runtime_id: newer.runtimeId,
        after: 0,
        repo: "acme/web",
        record: {
          workspace: { id: "w-newer", title: "From the nightly" },
          session: { id: sessionId, head: 1 },
          internal: { threadId: "caveman:w-newer" },
        },
        events: [{ cursor: 1, type: event.type, at, event }],
        display: [],
        engine: null,
        wip: null,
      }),
    );
    expect(
      (
        await call("PUT", `runtime/sessions/${sessionId}/journal/segments/0`, segment, {
          "x-caveman-lease": lease.lease_token,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await call("PUT", `runtime/sessions/${sessionId}/journal`, {
          lease_token: lease.lease_token,
          cursor_seq: 1,
          segments: 1,
          size_bytes: segment.length,
          release: true,
        })
      ).status,
    ).toBe(200);
    const before = structuredClone(cloud.state.chats.sessions.get(sessionId)!.lease ?? null);

    const refused = await mac
      .call("session.adopt", { request_id: "adopt-1", session_id: sessionId })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(refused).toBeInstanceOf(SessionProtocolError);
    expect((refused as SessionProtocolError).error.data?.reason).toBe("invalid_state");
    expect((refused as SessionProtocolError).message).toBe(
      `Caveman Code ${RUNTIME_VERSION} can't read this chat's copy, which Caveman Code 9.9.0-nightly.20261201.1 made (copy format 2, protocol revision ${PROTOCOL_REVISION + 1}; it reads formats 1 and 2 up to revision ${PROTOCOL_REVISION}), so it needs updating before it takes the chat`,
    );
    // Nothing taken: Cloud's lease as the newer runtime left it, never this one's; no workspace for it here.
    expect(cloud.state.chats.sessions.get(sessionId)!.lease ?? null).toEqual(before);
    expect(cloud.state.chats.sessions.get(sessionId)!.lease?.runtime_id).not.toBe(macRuntimeId);
    const listed = await mac.call("workspace.list", { include_archived: true });
    expect(listed.workspaces.some((w) => w.session_id === sessionId)).toBe(false);
  },
);
