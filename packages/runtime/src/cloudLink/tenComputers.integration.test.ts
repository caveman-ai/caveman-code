// Protocol-scale proof, NOT a Kubernetes/provider-fleet test: ten real logical Cloud runtime processes,
// This Mac, ten real web/desktop/phone sync states, test Cloud and no-model Claude Agent CLI.
import { expect, test } from "vitest";

import { createReady, MODEL, until } from "../session-protocol/testHarness.ts";
import { eventKey, journalOf, logErrors, Trace, World } from "./chaos/world.ts";

// Skipped on Windows: a Cloud computer is Linux, and runs git in its checkout only where owner uid and mode bits show
// the agent cannot write it (gitTrusts); ten of them on this host would refuse every chat.
test.skipIf(process.platform === "win32")("ten clients converge on ten Cloud computers and This Mac across duplicate sends and crashes", async () => {
  const trace = new Trace();
  const world = new World({ trace, cloudComputers: 10 });
  try {
    await world.start();
    expect(world.runtimes.filter((r) => r.role === "cloud")).toHaveLength(10);
    const chats = await Promise.all(world.runtimes.map(async (runtime, i) => ({
      runtime,
      text: `scale turn ${i}`,
      workspace: await createReady(runtime.admin! as Parameters<typeof createReady>[0], {
        request_id: `scale-workspace-${i}`,
        repo: runtime.role === "mac" ? { path: world.macRepo } : { url: "https://github.com/acme/chaos" },
        title: `Scale ${i}`,
        engine: "claude-agent",
        options: { model: MODEL },
      }),
    })));
    await until(() => chats.every(({ workspace }) => world.cloud.state.chats.copyOf(workspace.session_id).length > 0), 60_000);
    await world.addDevices([
      { name: "desktop", kind: "desktop", home: "mac" },
      ...Array.from({ length: 7 }, (_, i) => ({ name: `web-${i}`, kind: "web" as const, home: null })),
      { name: "phone-1", kind: "phone", home: null, direct: true },
      { name: "phone-2", kind: "phone", home: null },
    ]);
    expect(world.devices).toHaveLength(10);
    for (const device of world.devices) {
      await until(() => chats.every(({ workspace }) => device.hub!.list?.get().chats.has(workspace.session_id)), 30_000);
      for (const { workspace } of chats) device.view(workspace.session_id);
    }
    let journals = await Promise.all(chats.map(({ runtime, workspace }) => journalOf(runtime, workspace.session_id)));
    const converge = async () => {
      await until(async () => {
        journals = await Promise.all(chats.map(({ runtime, workspace }) => journalOf(runtime, workspace.session_id)));
        return world.devices.every((device) => chats.every(({ workspace }, i) => {
          const view = device.views.get(workspace.session_id)!;
          const journal = journals[i]!;
          return view.epoch() === journal.epoch && view.events.length === journal.events.length &&
            view.events.every((event, n) => eventKey(event) === eventKey(journal.events[n]!)) &&
            (view.state.kind === "live" || view.state.kind === "copy");
        }));
      }, 60_000);
      for (const device of world.devices) for (const [i, { workspace }] of chats.entries()) {
        const view = device.views.get(workspace.session_id)!;
        expect(view.misorders, `${device.name}/${i}`).toEqual([]);
        expect(view.events, `${device.name}/${i}`).toEqual(journals[i]!.events);
      }
    };
    await converge();
    // Same person/request on two distinct connections, including loopback vs relay for This Mac.
    await Promise.all(chats.map(async ({ workspace, text }, i) => {
      const device = world.devices[i % 10]!;
      const other = world.devices[(i + 1) % 10]!;
      const params = { request_id: `${device.name}-scale-send-${i}`, session_id: workspace.session_id, kind: "followup" as const, input: { text: `slow 100: ${text}` } };
      await Promise.all([device.clientFor(workspace.session_id).call("turn.submit", params), other.clientFor(workspace.session_id).call("turn.submit", params)]);
    }));
    await until(async () => (await Promise.all(chats.map(({ runtime, workspace }) => journalOf(runtime, workspace.session_id)))).every((j) => j.events.some((e) => e.type === "turn.done")), 60_000);
    await converge();
    const epochsBefore = journals.map((j) => j.epoch);
    // SIGKILL/restart on the same databases while the other nine logical computers keep serving.
    await Promise.all([world.mac.kill(), world.boxA.kill()]);
    await Promise.all([world.mac.start(), world.boxA.start()]);
    await until(async () => (await journalOf(world.mac, chats[0]!.workspace.session_id)).epoch > epochsBefore[0]! &&
      (await journalOf(world.boxA, chats[1]!.workspace.session_id)).epoch > epochsBefore[1]!, 30_000);
    await converge();
    for (const [i, { text }] of chats.entries()) {
      expect(journals[i]!.events.filter((e) => e.type === "message.done" && e.payload.role === "user" && e.payload.text === `slow 100: ${text}`), `one accepted message for chat ${i}`).toHaveLength(1);
    }
    // No identity shown anywhere may mean two different events, including views preceding a reset.
    const shown = new Map<string, string>();
    for (const device of world.devices) for (const view of device.views.values()) for (const segment of view.segments) {
      for (const [cursor, event] of segment.shown) {
        const key = `${view.sessionId}/${segment.epoch}/${cursor}`;
        if (shown.has(key)) expect(event, `immutable ${key}`).toBe(shown.get(key));
        else shown.set(key, event);
      }
    }
    console.log(`PASS: ${world.runtimes.length} real runtime processes, ${world.devices.length} client states, ${world.devices.length * chats.length} converged views, 22 concurrent duplicate sends, two SIGKILL/restarts; one user message per chat`);
  } catch (error) {
    console.error(trace.tail(80));
    for (const runtime of world.runtimes) console.error(`${runtime.name}: ${logErrors(runtime)}`);
    throw error;
  } finally {
    await world.close();
  }
}, 240_000);
