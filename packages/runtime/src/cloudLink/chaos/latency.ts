// Test-only: the S14 latency budgets on localhost, overhead only (DESIGN S14: the network's round trip is what this
// cannot measure, so each path is measured against the same thing seen on loopback, on the same runtime, at once):
// - an event committed on a runtime -> shown on each device (loopback, relay, direct): p50 <= 50 ms on a direct path
//   (and the desktop's loopback), relay overhead p50 <= 20 ms;
// - send -> accepted by the runtime: overhead over a paired loopback send, p50 over every device <= 20 ms (each path's
//   own numbers are printed);
// - a status change (needs you, done) -> every device's list: p50 <= 300 ms (p95 printed);
// - opening a chat from the device cache -> first content: p95 <= 100 ms.
import type { SessionEvent } from "@caveman-app/session-protocol";

import { createReady, MODEL, until } from "../../session-protocol/testHarness.ts";
import { REPO, sleep, View, type Device, type RuntimeProc, type World } from "./world.ts";

export interface LatencyReport {
  readonly lines: Array<string>;
  readonly breaches: Array<string>;
  readonly samples: Record<string, { p50: number; p95: number; n: number }>;
}

const quantile = (values: ReadonlyArray<number>, q: number) => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
};

export async function measureLatency(world: World): Promise<LatencyReport> {
  const samples = new Map<string, Array<number>>();
  const add = (path: string, ms: number) => samples.set(path, [...(samples.get(path) ?? []), ms]);
  const chats: Array<{ rt: RuntimeProc; sessionId: string; workspaceId: string }> = [];
  for (const rt of [world.mac, world.boxA]) {
    const repo = rt.role === "mac" ? { path: world.macRepo } : { url: `https://github.com/${REPO}` };
    const w = await createReady(rt.admin! as Parameters<typeof createReady>[0], { request_id: `latency-${rt.name}`, repo, title: `latency ${rt.name}`, engine: "claude-agent", options: { model: MODEL, access: "ask" } });
    chats.push({ rt, sessionId: w.session_id, workspaceId: w.id });
  }
  await until(() => world.devices.every((d) => chats.every((c) => d.hub!.list?.get().chats.has(c.sessionId))), 20_000);
  // Opened on every device, then quiet: every path has settled (the phone's direct channel is up).
  for (const d of world.devices) for (const c of chats) d.view(c.sessionId);
  await until(() => world.devices.every((d) => chats.every((c) => d.views.get(c.sessionId)!.state.kind === "live")), 30_000);
  const phone = world.devices.find((d) => d.spec.direct);
  if (phone) await until(() => phone.hub!.pool.isDirect(world.mac.runtimeId), 20_000).catch(() => undefined);
  const pathOf = (d: Device, c: { rt: RuntimeProc; sessionId: string }) => (d.spec.home === "mac" && c.rt.role === "mac" ? "loopback" : d.hub!.viaFor(c.sessionId));

  const idle = async (c: { rt: RuntimeProc; workspaceId: string }) => until(async () => (await c.rt.call("workspace.get", { workspace_id: c.workspaceId })).status === "idle", 20_000);

  // Status changes reach every device's list (S14: at once, not debounced).
  const listStatus = new Map<string, Array<{ device: string; session: string; status: string; at: number }>>();
  const offs = world.devices.map((d) =>
    d.hub!.list!.subscribe(() => {
      for (const c of chats) {
        const status = d.hub!.list!.get().chats.get(c.sessionId)?.status;
        const seen = listStatus.get(c.sessionId) ?? [];
        if (status && seen.findLast((s) => s.device === d.name)?.status !== status) seen.push({ device: d.name, session: c.sessionId, status, at: Date.now() });
        listStatus.set(c.sessionId, seen);
      }
    }),
  );

  for (let round = 0; round < 4; round++) {
    for (const c of chats) {
      // The truth, seen on loopback: when each event reached the harness's own subscription on the runtime.
      const seenAt = new Map<number, number>();
      const events: Array<SessionEvent> = [];
      const sub = await c.rt.admin!.attach(c.sessionId, (await c.rt.call("workspace.get", { workspace_id: c.workspaceId })).head ?? 0, (e) => {
        seenAt.set(e.cursor, Date.now());
        events.push(e);
      });
      const asks = round === 3;
      await c.rt.call("turn.submit", { request_id: `lat-${c.rt.name}-${round}`, session_id: c.sessionId, kind: "followup", input: { text: asks ? `ask: latency ${round}` : `slow 300: latency ${round} ${c.rt.name}` } });
      if (asks) {
        // Needs you: the ask reaches every list, then an answer from the phone.
        await until(() => events.some((e) => e.type === "ask.user"), 20_000);
        const ask = events.find((e) => e.type === "ask.user")!;
        const askAt = seenAt.get(ask.cursor)!;
        const reached = (d: Device) => (listStatus.get(c.sessionId) ?? []).find((s) => s.device === d.name && s.status === "needs_you" && s.at >= askAt - 5)?.at;
        await until(() => world.devices.every((d) => reached(d) !== undefined), 5_000).catch(() => undefined);
        for (const d of world.devices) add("status needs_you>list", (reached(d) ?? askAt + 5_000) - askAt);
        await world.devices.at(-1)!.clientFor(c.sessionId).call("ask.respond", { request_id: `lat-answer-${c.rt.name}`, session_id: c.sessionId, ask_id: ask.item_id!, response: { kind: "approval", option_id: (ask.payload as { options?: Array<{ id: string }> }).options?.[0]?.id ?? "accept" } });
      }
      await until(() => events.some((e) => e.type === "turn.done"), 30_000);
      const doneAt = seenAt.get(events.find((e) => e.type === "turn.done")!.cursor)!;
      await idle(c);
      const settled = (d: Device) => (listStatus.get(c.sessionId) ?? []).find((s) => s.device === d.name && s.status === "idle" && s.at >= doneAt - 5)?.at;
      await until(() => world.devices.every((d) => settled(d) !== undefined), 5_000).catch(() => undefined);
      for (const d of world.devices) add("status done>list", (settled(d) ?? doneAt + 5_000) - doneAt);
      // Commit -> each device, against loopback.
      await until(() => world.devices.every((d) => (d.views.get(c.sessionId)?.events.length ?? 0) >= (events.at(-1)?.cursor ?? 0)), 10_000).catch(() => undefined);
      for (const d of world.devices) {
        const view = d.views.get(c.sessionId)!;
        for (const [cursor, at] of seenAt) {
          const shown = view.arrivals.get(cursor);
          if (shown !== undefined) add(`event>device ${c.rt.role === "mac" ? "mac" : "box"} ${pathOf(d, c)}`, shown - at);
        }
      }
      await sub.detach();
    }
  }

  // Send -> accepted: each device right after a loopback send (the baseline) on the same runtime, one turn at a time;
  // the overhead is each pair's difference, so a busy machine slows both halves alike.
  for (let i = 0; i < 5; i++) {
    for (const c of chats) {
      for (const sender of world.devices) {
        const timed = async (who: Device | undefined) => {
          const params = { request_id: `lat-send-${c.rt.name}-${i}-${who?.name ?? "loopback"}-${sender.name}`, session_id: c.sessionId, kind: "followup" as const, input: { text: `slow 0: send ${i}` } };
          const started = Date.now();
          if (who) await who.clientFor(c.sessionId).call("turn.submit", params);
          else await c.rt.call("turn.submit", params);
          const ms = Date.now() - started;
          await idle(c);
          return ms;
        };
        // Which goes first alternates: the turn before leaves work behind (its checkpoint, its copy) that slows the next.
        const first = i % 2 === 0;
        const base = first ? await timed(undefined) : 0;
        const mine = await timed(sender);
        const baseline = first ? base : await timed(undefined);
        add(`send>accepted ${c.rt.role === "mac" ? "mac" : "box"} baseline`, baseline);
        add(`send>accepted ${c.rt.role === "mac" ? "mac" : "box"} ${pathOf(sender, c)}`, mine);
        add(`send overhead ${c.rt.role === "mac" ? "mac" : "box"} ${pathOf(sender, c)}`, mine - baseline);
        add(`send overhead ${c.rt.role === "mac" ? "mac" : "box"} (every device)`, mine - baseline);
      }
    }
  }
  for (const off of offs) off();

  // Open from the device cache: close a chat, open it again, time to its first event on screen.
  for (const d of world.devices) {
    for (const c of chats) {
      d.hub!.close(c.sessionId);
      await sleep(50);
      const view = new View(d.name, c.sessionId);
      d.views.set(c.sessionId, view);
      const opened = Date.now();
      view.feed = d.hub!.openFeed(c.sessionId, view.sink(), view.onState);
      await until(() => view.firstShownAt !== undefined, 5_000).catch(() => undefined);
      add("open>first content (cache)", (view.firstShownAt ?? opened + 5_000) - opened);
    }
  }
  for (const c of chats) await c.rt.call("workspace.archive", { request_id: `latency-archive-${c.workspaceId}`, workspace_id: c.workspaceId }).catch(() => undefined);
  for (const d of world.devices) for (const c of chats) (d.hub!.close(c.sessionId), d.views.delete(c.sessionId));

  const stats: LatencyReport["samples"] = {};
  for (const [path, values] of samples) stats[path] = { p50: quantile(values, 0.5), p95: quantile(values, 0.95), n: values.length };
  const lines = Object.entries(stats)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, s]) => `${path.padEnd(36)} p50 ${s.p50.toFixed(1).padStart(6)}  p95 ${s.p95.toFixed(1).padStart(6)}  n=${s.n}`);
  const breaches: Array<string> = [];
  for (const [path, s] of Object.entries(stats)) {
    if (path.startsWith("event>device") && /relay/.test(path) && s.p50 > 20) breaches.push(`${path}: relay overhead p50 ${s.p50} ms > 20 ms`);
    if (path.startsWith("event>device") && /direct|loopback/.test(path) && s.p50 > 50) breaches.push(`${path}: p50 ${s.p50} ms > 50 ms`);
    if (path.startsWith("status") && s.p50 > 300) breaches.push(`${path}: p50 ${s.p50} ms > 300 ms`);
    if (path.startsWith("open>") && s.p95 > 100) breaches.push(`${path}: p95 ${s.p95} ms > 100 ms`);
  }
  // Per path a handful of pairs is noise on a busy machine: judged over every device's pairs on a runtime (n = 20).
  for (const [path, s] of Object.entries(stats)) if (path.startsWith("send overhead") && path.endsWith("(every device)") && s.p50 > 20) breaches.push(`${path}: p50 ${s.p50} ms over a loopback send > 20 ms`);
  return { lines, breaches, samples: stats };
}
