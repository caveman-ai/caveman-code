import { expect, test } from "vitest";

import { closeLid, LID_BUDGET_MS, lidReport, onLidClose, type LidOutcome } from "../src/lid.ts";

const chat = (id: string, engine: string, status: string, kind = "this_mac") => ({ id, session_id: `s-${id}`, engine, status, computer: { kind } });

test("the lid asks the runtime once to hand off every chat working on this Mac (cloud.suspend), with its budget, and moves none itself", async () => {
  const calls: Array<[string, unknown]> = [];
  const client = {
    call: async (method: string, params: unknown) => {
      calls.push([method, params]);
      if (method === "workspace.list")
        return { workspaces: [chat("a", "caveman", "working"), chat("b", "claude-agent", "working"), chat("c", "codex", "needs_input"), chat("d", "caveman", "idle"), chat("e", "caveman", "working", "caveman_cloud")] };
      if (method === "cloud.suspend") return { handed_off: ["s-a", "s-b", "s-c"], paused: [], flushed: 4 };
      return {};
    },
  };
  let n = 0;
  expect(await closeLid(client as never, () => `r${++n}`)).toMatchObject({ moving: 3, paused: 0, chats: [] });
  expect(calls.filter(([method]) => method === "cloud.suspend")).toEqual([["cloud.suspend", { request_id: "r1", budget_ms: LID_BUDGET_MS - 250 }]]);
  // Nothing else acts on the chats: no move chat by chat, no turn stopped on a chat that was handed off.
  expect(calls.map(([method]) => method).sort()).toEqual(["cloud.suspend", "workspace.list"]);
});

test("a chat the runtime keeps here (no Cloud login, the setting off, moves off) is stopped by the runtime; the others still go", async () => {
  const calls: Array<[string, unknown]> = [];
  const client = {
    call: async (method: string, params: unknown) => {
      calls.push([method, params]);
      if (method === "workspace.list") return { workspaces: [chat("a", "claude-agent", "working"), chat("b", "codex", "working"), chat("c", "caveman", "working")] };
      if (method === "cloud.suspend") return { handed_off: ["s-b", "s-c"], paused: ["s-a"], flushed: 0 };
      return {};
    },
  };
  let n = 0;
  // The chat the runtime paused is named, with when the lid closed: the page marks its stop as a sleep stop.
  const outcome = await closeLid(client as never, () => `r${++n}`);
  expect(outcome).toMatchObject({ moving: 2, paused: 1, chats: ["s-a"] });
  expect(outcome.at).toBeGreaterThan(0);
  // The runtime stopped its turn already (and said how to make it go next time): the lid does not ask again.
  expect(calls.filter(([method]) => method === "turn.interrupt")).toEqual([]);
});

test("a working chat the runtime answered nothing for (signed out of Caveman Cloud, or the call failed) stops its turn here", async () => {
  for (const suspend of [async () => ({ handed_off: [], paused: [], flushed: 0 }), async () => Promise.reject(new Error("internal"))]) {
    const calls: Array<[string, unknown]> = [];
    const client = {
      call: async (method: string, params: unknown) => {
        calls.push([method, params]);
        if (method === "workspace.list") return { workspaces: [chat("a", "caveman", "working"), chat("b", "caveman", "needs_input"), chat("c", "caveman", "idle")] };
        if (method === "cloud.suspend") return suspend();
        return {};
      },
    };
    let n = 0;
    expect(await closeLid(client as never, () => `r${++n}`)).toMatchObject({ moving: 0, paused: 2, chats: ["s-a", "s-b"] });
    expect(calls.filter(([method]) => method === "turn.interrupt").map(([, p]) => (p as { session_id: string }).session_id)).toEqual(["s-a", "s-b"]);
  }
});

test("the lid waits no longer than its budget, and stops nothing the runtime is still handing off", async () => {
  const calls: Array<string> = [];
  const client = { call: async (method: string) => (calls.push(method), method === "workspace.list" ? { workspaces: [chat("a", "caveman", "working")] } : new Promise(() => {})) };
  const started = Date.now();
  expect(await onLidClose(client as never, () => "r", 50)).toEqual({ moving: 1, paused: 0 });
  // onLidClose keeps the counts-only shape Cloud's lid tests compare with toEqual.
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(calls).not.toContain("turn.interrupt");
  const silent = { call: () => new Promise(() => {}) };
  expect(await onLidClose(silent as never, () => "r", 50)).toEqual({ moving: 0, paused: 0 });
});

test("the page hears what the lid did once the Mac wakes, once, and only when a chat moved or stopped", () => {
  const sent: unknown[] = [];
  const lid = lidReport((outcome) => sent.push(outcome));

  // Answered before the Mac slept: kept until it wakes, then sent once.
  lid.sleeping()({ moving: 2, paused: 1 });
  expect(sent).toEqual([]);
  lid.woke();
  lid.woke();
  expect(sent).toEqual([{ moving: 2, paused: 1 }]);

  // Nothing moved or stopped: nothing to say.
  lid.sleeping()({ moving: 0, paused: 0 });
  lid.woke();
  expect(sent).toHaveLength(1);

  // Paused only still counts.
  lid.sleeping()({ moving: 0, paused: 3 });
  lid.woke();
  expect(sent.at(-1)).toEqual({ moving: 0, paused: 3 });

  // Waking without a sleep (or after a sleep the runtime never answered) sends nothing.
  lid.woke();
  lid.sleeping();
  lid.woke();
  expect(sent).toEqual([{ moving: 2, paused: 1 }, { moving: 0, paused: 3 }]);
});

test("a handoff still answering as the Mac wakes is sent when it arrives; a newer sleep replaces an older one's outcome", () => {
  const sent: unknown[] = [];
  const lid = lidReport((outcome) => sent.push(outcome));

  const late = lid.sleeping();
  lid.woke();
  expect(sent).toEqual([]);
  late({ moving: 1, paused: 0 });
  expect(sent).toEqual([{ moving: 1, paused: 0 }]);

  // The lid closes twice before the first answer lands: only the second sleep's outcome goes out.
  const first = lid.sleeping();
  const second = lid.sleeping();
  first({ moving: 5, paused: 5 });
  second({ moving: 0, paused: 2 });
  lid.woke();
  expect(sent).toEqual([{ moving: 1, paused: 0 }, { moving: 0, paused: 2 }]);
});

test("lidReport sends the stopped chats and when the lid closed along with the counts", () => {
  const sent: LidOutcome[] = [];
  const lid = lidReport((o) => sent.push(o));
  lid.sleeping()({ moving: 1, paused: 2, chats: ["s-a", "s-b"], at: 1234 });
  lid.woke();
  expect(sent).toEqual([{ moving: 1, paused: 2, chats: ["s-a", "s-b"], at: 1234 }]);
});
