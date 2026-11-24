// A stage to look at the phone app on: the stand-in Cloud with the phone's routes, a real Mac runtime and two real
// Cloud computer runtimes (the chaos World, the stand-in claude, no model and no network), held up until told to quit.
// The phone app's web build points at it, and a browser at phone size is driven by hand or by a tool. Run by hand:
//
//   CAVEMAN_PHONE_STAGE=<file> vitest run --silent=false src/cloudLink/phoneStage.test.ts
//   EXPO_PUBLIC_CAVEMAN_CLOUD_URL=<cloud url from the file> pnpm --filter @caveman-app/mobile web
//
// CAVEMAN_PHONE_STAGE_PORT=<port> keeps Cloud's port across runs, so a web build already made still points at it.
//
// The file gets `{ cloud, control }` once it is up. `control` takes what a person, Cloud's computers service and a
// Mac's lid would do, each a POST:
//
//   /allow          the Mac's person chooses Allow for every device that waits (also by itself, `allow_after_ms`)
//   /sleep?box=a    Cloud puts box-a (or b) to sleep: its runtime stops and its key ends
//   /wake?box=a     the computers service starts it, under a new runtime id (also by itself after a wake is asked
//                   for, `wake_after_ms`)
//   /mac?lid=closed the Mac's runtime stops, and Cloud last heard from it ten minutes ago; `lid=open` starts it again
//   /set            JSON: { wake_after_ms, allow_after_ms, refuse_wakes: sentence | null, outdated, disk_lost: "a" | null }
//   /plain          a chat on the Mac in a plain folder (no repository): one that cannot run in Cloud
//   /quit           everything stops
//
// GET /state says what Cloud lists and what was asked of it. Nothing here is a test of the product: the proofs are
// phoneLive.integration.test.ts and the phone's own unit tests.
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { afterEach, test } from "vitest";

import { tempRoot } from "../session-protocol/testHarness.ts";
import { sleep, Trace, World, type RuntimeProc } from "./chaos/world.ts";
import { MODEL } from "./moves.e2e.kit.ts";
import { startPhoneCloud } from "./testCloudPhone.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const OUT = process.env.CAVEMAN_PHONE_STAGE;

test.skipIf(!OUT)(
  "the phone's stage: a Mac and two Cloud computers behind the stand-in Cloud, until told to quit",
  async () => {
    const trace = new Trace();
    const world = new World({ trace });
    cleanups.push(() => world.close());
    await world.start();
    const { cloud, mac, boxA, boxB } = world;
    const front = await startPhoneCloud(cloud, {
      ...(process.env.CAVEMAN_PHONE_STAGE_PORT
        ? { port: Number(process.env.CAVEMAN_PHONE_STAGE_PORT) }
        : {}),
    });
    cleanups.push(front.close);
    // The person's projects: the repository the world's computers share, as Cloud keeps it and as the Mac has it on disk.
    cloud.state.plugins.projects.push({
      id: "project-chaos",
      name: "chaos",
      repos: ["acme/chaos"],
    });
    await mac.call("project.create", { request_id: "stage-project", path: world.macRepo });
    // Each computer has a model its new chats start on, as a real one does once its engine is set up (the stand-in
    // claude lists none of its own).
    for (const rt of [mac, boxA, boxB])
      await rt.call("settings.set", {
        request_id: `stage-model-${rt.name}`,
        settings: { engines: { "claude-agent": { model: MODEL } } },
      });

    const settings = {
      wake_after_ms: 9_000 as number | null,
      allow_after_ms: 5_000 as number | null,
    };
    const box = (name: string | null): RuntimeProc => (name === "b" ? boxB : boxA);
    const asleep = (rt: RuntimeProc) => cloud.state.runtimes.get(rt.runtimeId)?.status !== "active";

    const sleepBox = async (rt: RuntimeProc) => {
      if (asleep(rt)) return;
      await world.stopComputer(rt);
      cloud.state.runtimes.get(rt.runtimeId)!.status = "revoked";
      for (const [token, record] of cloud.state.tokens)
        if (record.runtimeId === rt.runtimeId) cloud.state.tokens.delete(token);
    };
    const waking = new Set<RuntimeProc>();
    const wakeBox = async (rt: RuntimeProc) => {
      if (!asleep(rt) || waking.has(rt)) return;
      waking.add(rt);
      try {
        await world.wakeUnderNewIdentity(rt);
      } finally {
        waking.delete(rt);
      }
    };
    const allow = async () => {
      const { requests } = await mac.call("device.list", {});
      for (const r of requests)
        await mac.call("device.allow", {
          request_id: `allow-${r.device_id}-${Date.now()}`,
          device_id: r.device_id,
          role: r.role ?? "device",
        });
      return requests.length;
    };

    let quit = false;
    // What Cloud's computers service and the Mac's person do by themselves, a few seconds after they are asked.
    const since = new Map<string, number>();
    const due = (key: string, on: boolean, after: number | null) => {
      if (!on || after === null) return void since.delete(key);
      if (!since.has(key)) since.set(key, Date.now());
      return Date.now() - since.get(key)! >= after;
    };
    const tick = async () => {
      for (const rt of [boxA, boxB]) {
        // A wake was asked for (a tap, a queued message, a workspace placed on it): Cloud says "starting".
        const asked =
          asleep(rt) && cloud.state.chats.computers.get(rt.computerId)?.state === "starting";
        if (due(`wake:${rt.name}`, asked, settings.wake_after_ms))
          await wakeBox(rt).catch((error: unknown) => trace.note(`wake failed: ${String(error)}`));
      }
      if (mac.admin) {
        const waits =
          (await mac.call("device.list", {}).catch(() => ({ requests: [] }))).requests.length > 0;
        if (due("allow", waits, settings.allow_after_ms)) await allow().catch(() => undefined);
      }
    };

    const control = http.createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://stage");
      const chunks: Array<Buffer> = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const reply = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      try {
        if (request.method === "GET" && url.pathname === "/state")
          return reply(200, {
            computers: cloud.computersOf("user-1"),
            runtimes: [mac, boxA, boxB].map((rt) => ({
              name: rt.name,
              computer_id: rt.computerId,
              runtime_id: rt.runtimeId,
              running: rt.admin !== undefined,
            })),
            chats: [...cloud.state.chats.sessions.values()].map((s) => ({
              session_id: s.session_id,
              computer_id: s.computer_id,
              epoch: s.epoch,
            })),
            wakes: front.state.wakes,
            workspaces: front.state.workspaces,
            settings,
            trace: trace.tail(30),
          });
        if (request.method !== "POST") return reply(404, { error: "unknown" });
        if (url.pathname === "/allow") return reply(200, { allowed: await allow() });
        if (url.pathname === "/sleep")
          return reply(200, { asleep: (await sleepBox(box(url.searchParams.get("box"))), true) });
        if (url.pathname === "/wake")
          return reply(200, { awake: (await wakeBox(box(url.searchParams.get("box"))), true) });
        if (url.pathname === "/mac") {
          if (url.searchParams.get("lid") === "open") {
            if (!mac.admin) await mac.start();
            return reply(200, { mac: "awake" });
          }
          if (mac.admin) await mac.term();
          // Cloud last heard from it ten minutes ago: not on line any more, and asleep for all a phone can tell.
          cloud.state.chats.lastHeartbeat.set(mac.runtimeId, Date.now() - 10 * 60_000);
          world.lapseLeases(mac);
          return reply(200, { mac: "asleep" });
        }
        if (url.pathname === "/set") {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
            wake_after_ms?: number | null;
            allow_after_ms?: number | null;
            refuse_wakes?: string | null;
            outdated?: boolean;
            disk_lost?: string | null;
          };
          if (body.wake_after_ms !== undefined) settings.wake_after_ms = body.wake_after_ms;
          if (body.allow_after_ms !== undefined) settings.allow_after_ms = body.allow_after_ms;
          if (body.refuse_wakes !== undefined)
            front.state.refuseWakes =
              body.refuse_wakes === null
                ? undefined
                : { status: 402, code: "cave_code_credits_exhausted", message: body.refuse_wakes };
          if (body.outdated !== undefined)
            cloud.state.minRuntimeVersion = body.outdated ? "999.0.0" : "";
          if (body.disk_lost !== undefined) {
            for (const rt of [boxA, boxB]) {
              const computer = cloud.state.chats.computers.get(rt.computerId)!;
              const lost = body.disk_lost !== null && rt === box(body.disk_lost);
              Object.assign(
                computer,
                lost
                  ? {
                      disk_lost_at: new Date(Date.now() - 2 * 24 * 3_600_000).toISOString(),
                      disk_lost_reason: "the volume was gone",
                    }
                  : { disk_lost_at: undefined, disk_lost_reason: undefined },
              );
            }
          }
          return reply(200, { settings });
        }
        if (url.pathname === "/plain") {
          const folder = path.join(tempRoot("phone-stage-plain-"), "notes");
          fs.mkdirSync(folder, { recursive: true });
          fs.writeFileSync(path.join(folder, "today.md"), "- ship the phone\n");
          const made = await mac.call("workspace.create", {
            request_id: `plain-${Date.now()}`,
            repo: { path: folder },
            title: "Tidy my notes",
            engine: "claude-agent",
            task: { text: "say: Your notes are tidy." },
            options: { model: MODEL },
          });
          return reply(200, { workspace_id: made.id, session_id: made.session_id });
        }
        if (url.pathname === "/quit") {
          quit = true;
          return reply(200, { quit: true });
        }
        return reply(404, { error: "unknown" });
      } catch (error) {
        return reply(500, { error: error instanceof Error ? error.message : String(error) });
      }
    });
    await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise((resolve) => control.close(resolve)));
    const address = control.address();
    const port = typeof address === "object" && address ? address.port : 0;
    fs.writeFileSync(
      OUT!,
      JSON.stringify({ cloud: front.url, control: `http://127.0.0.1:${port}`, pid: process.pid }),
    );

    while (!quit) {
      await tick().catch(() => undefined);
      await sleep(500);
    }
  },
  4 * 3_600_000,
);
