// A real runtime process dies during a move's preflight. The actual web sender
// must leave the person's message in Cloud's durable queue, not in an old
// computer's volatile `lettingGo` array. No paid provider or real Cloud is used.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import { afterEach, expect, test } from "vitest";
import { allowedStream, testDevice } from "../session-protocol/devices.testkit.ts";
import { createReady, makeRepo, MODEL, tempRoot, until } from "../session-protocol/testHarness.ts";
import { startTestCloud } from "./testCloud.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const web = (p: string) => import(/* @vite-ignore */ new URL(`../../../../apps/web/src/state/${p}`, import.meta.url).href);

test("a send during handoff stays in the real sender's Cloud queue across SIGKILL and runs once after restart", { timeout: 240_000 }, async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  cloud.state.environments.computers = true;
  const base = tempRoot("move-input-crash-");
  const children: Array<ChildProcess> = [];
  cleanups.push(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
    }
  });
  const start = async () => {
    const output = path.join(base, "runtime.json");
    fs.rmSync(output, { force: true });
    const log = fs.openSync(path.join(base, "runtime.log"), "a");
    const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("./chaos/chaos.runtime.ts", import.meta.url))], {
      env: { ...process.env, CHAOS_BASE: path.join(base, "state"), CHAOS_OUT: output, CHAOS_PARENT: String(process.pid), CHAOS_ROLE: "mac", CHAOS_CLOUD_URL: cloud.url, CHAOS_BEARER: cloud.state.personToken, CLAUDE_CONFIG_DIR: path.join(base, "claude") },
      stdio: ["ignore", log, log],
    });
    fs.closeSync(log);
    children.push(child);
    await until(() => fs.existsSync(output) || child.exitCode !== null, 120_000);
    const info = JSON.parse(fs.readFileSync(output, "utf8")) as { url: string; token: string };
    const client = connect(info.url, info.token);
    cleanups.push(() => client.close());
    const kill = async () => {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
      client.close();
    };
    return { client, kill, ...info };
  };
  let mac = await start();
  await mac.client.call("settings.set", { request_id: "sync-on", settings: { sync_chats: true, move_to_cloud: true } });
  const repo = makeRepo(tempRoot("move-input-repo-"), { "README.md": "crash during preflight\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/move-input-crash.git"], { cwd: repo });
  const w = await createReady(mac.client, { request_id: "w", repo: { path: repo }, title: "A send while checking a move", engine: "claude-agent", options: { model: MODEL } });
  await mac.client.call("turn.submit", { request_id: "first", session_id: w.session_id, kind: "followup", input: { text: "remember before the move" } });
  await until(() => cloud.state.chats.copyOf(w.session_id).some((e) => e.type === "turn.done"), 30_000);
  await until(() => cloud.state.relays.length > 0, 20_000);
  const phone = await testDevice("Crash-test phone");
  await allowedStream(cloud.state.relays[0]!, mac.client, phone);
  const [{ ChatSender }, { cloudApi }, { kvOutbox }, { memoryKv }, { installDeviceHooks }, { deviceHooks }, { onlyPage }] = await Promise.all([
    web("sync/sender.ts"), web("sync/cloud-api.ts"), web("sync/outbox.ts"), web("sync/kv.ts"), web("device-approval.ts"), web("sync/device-hooks.ts"),
    web("sync/pages.ts"),
  ]);
  installDeviceHooks({ kindOf: () => "laptop", device: async () => phone });
  const sender = new ChatSender({
    api: cloudApi({ base: cloud.url, headers: async () => ({ authorization: `Bearer ${cloud.state.personToken}` }), renew: async () => false, credentials: "omit" }),
    outbox: kvOutbox(memoryKv(), "cloud", onlyPage()),
    callFields: (call: unknown) => deviceHooks().callFields(call),
    retryMs: () => 10,
  });
  // No login on the target: after this deliberately slow preflight, the move
  // cannot happen and the restarted Mac remains the legitimate owner.
  const target = cloud.enrollRuntime({ kind: "cloud" });
  cloud.state.chats.delay.check = 30_000;
  const moving = mac.client.call("session.move", { request_id: "move", session_id: w.session_id, to: { computer_id: target.computerId } }).catch(() => undefined);
  await until(() => cloud.state.chats.moveChecksPending > 0, 20_000);
  const device = connect(mac.url, mac.token);
  cleanups.push(() => device.close());
  const lateText = "remember the message during preflight";
  const sent = await sender.send(w.session_id, "turn.submit", { request_id: "late", session_id: w.session_id, kind: "followup", input: { text: lateText } }, { via: "runtime", client: device, orCloud: true });
  await mac.kill();
  await moving;
  delete cloud.state.chats.delay.check;
  mac = await start();
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (event) => events.push(event));
  const state = async () => {
    const response = await fetch(`${cloud.url}/api/v1/code/chats/${w.session_id}/calls/late`, { headers: { authorization: `Bearer ${cloud.state.personToken}` } });
    return response.ok ? await response.json() as { status: string; error?: { code: string; message: string } } : undefined;
  };
  await until(async () => {
    const call = await state();
    if (call?.status === "failed") throw new Error(`Cloud refused the persisted call after restart: ${JSON.stringify(call.error)}`);
    return call?.status === "done";
  }, 45_000);
  await until(() => events.some((e) => e.type === "message.done" && e.payload.role === "assistant" && e.payload.text.includes(lateText)), 30_000);
  expect(sent.via).toBe("cloud");
  expect(events.filter((e) => e.type === "message.done" && e.payload.role === "user" && e.payload.text === lateText)).toHaveLength(1);
  await mac.kill();
});
