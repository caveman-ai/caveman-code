// The tools against a fake runtime: chat_wait reports each change once, times out without an error and says what to
// pass on an empty set; chat_start's 2-minute duplicate guard; access resolved from the agent's level; a fresh
// request_id per mutating call; errors that say what to do next; person-only asks refused as instructions; chat_read's
// images paged to the oldest one.
import { crc32, deflateSync } from "node:zlib";

import type { SessionEvent } from "@caveman-app/session-protocol";
import * as jpeg from "jpeg-js";
import { PNG as Png } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { COMMIT_TIMEOUT_MS } from "../git/commitTimeout.ts";
import { Bridge } from "./bridge.ts";
import { FakeWorld, NOW, engine, minutesAgo, rpcError, workspace } from "./fixtures.testkit.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");

/** A real, decodable 8-bit grayscale PNG of this size, all black. */
const png = (width: number, height: number): Buffer => {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const framed = Buffer.alloc(body.length + 8);
    framed.writeUInt32BE(data.length, 0);
    body.copy(framed, 4);
    framed.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
    return framed;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((width + 1) * height))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};
/** A PNG block's width, which the image tests use to tell their images apart. */
const widthOf = (data: string) => Buffer.from(data, "base64").readUInt32BE(16);

const setup = (over: { readonly clock?: { now: number } } = {}) => {
  const world = new FakeWorld();
  const clock = over.clock ?? { now: NOW };
  let n = 0;
  const bridge = new Bridge({ link: world, cwd: "/code/app/src", now: () => clock.now, requestId: () => `req-${++n}` });
  const run = (tool: string, params: Record<string, unknown> = {}, clientName = "claude-code") => bridge.call(tool, params, { clientName });
  return { world, bridge, run, clock };
};

afterEach(() => vi.useRealTimers());

describe("chat_wait", () => {
  it("says what to pass when this process has no chats to wait on", async () => {
    const { run } = setup();
    const answer = await run("chat_wait");
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("Nothing to wait for");
    expect(answer.text).toContain('chat_wait {"chats":["<id or title>"]}');
  });

  it("reports a chat it started finishing once, then times out without an error", async () => {
    const { world, run } = setup();
    const started = await run("chat_start", { task: "Fix the login test" });
    expect(started.isError).toBeFalsy();
    world.digests.set("ws1", { latest: "Fixed it: the clock was stubbed wrong." });
    world.change("ws1", { status: "working", updated_at: minutesAgo(1) });
    world.change("ws1", { status: "idle", activity: { last_outcome: "completed" }, updated_at: new Date(NOW).toISOString() });
    const first = await run("chat_wait");
    expect(first.isError).toBeFalsy();
    expect(first.text).toContain("[ws1]");
    expect(first.text).toContain("finished.");
    expect(first.text).toContain("Latest: Fixed it");
    const second = await run("chat_wait", { timeout_s: 1 });
    expect(second.isError).toBeFalsy();
    expect(second.text).toMatch(/^No change in 1 s\./);
    expect(second.text).toContain("Call chat_wait {} again.");
  });

  it("returns at once with a change made while nothing listened, and waits for the next one otherwise", async () => {
    const { world, run } = setup();
    world.add(workspace({ id: "a", status: "working", title: "Build it" }));
    const waiting = run("chat_wait", { chats: ["a"], timeout_s: 30 });
    await new Promise((r) => setTimeout(r, 50));
    world.change("a", { status: "failed", updated_at: new Date(NOW).toISOString() });
    world.digests.set("a", { error: "the build broke" });
    const failed = await waiting;
    expect(failed.text).toContain("[a] Build it (app) · failed: the build broke");
    world.change("a", { status: "working" });
    world.change("a", { status: "idle", activity: { last_outcome: "completed" }, updated_at: new Date(NOW + 1000).toISOString() });
    const again = await run("chat_wait", { chats: ["Build it"], timeout_s: 1 });
    expect(again.text).toContain("finished");
  });

  it("lists what is still working on a timeout, and clamps a timeout above 55 s for Codex", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { world, run } = setup();
    world.add(workspace({ id: "w", status: "working", title: "Long job", activity: { turn_started_at: minutesAgo(3) } }));
    const pending = run("chat_wait", { chats: ["w"], timeout_s: 100 }, "codex-mcp-client");
    await vi.advanceTimersByTimeAsync(55_000);
    const answer = await pending;
    expect(answer.isError).toBeFalsy();
    expect(answer.text).toContain("No change in 55 s (timeout_s 100 is outside 1–55 s; waited 55 s).");
    expect(answer.text).toContain("Still working: [w] Long job · working for 3m.");
  });

  it("says when the person answered, and when a chat waits on the person, what to tell the user", async () => {
    const { world, run } = setup();
    world.add(workspace({ id: "q", status: "working", title: "Migrate" }));
    await run("chat_wait", { chats: ["q"], timeout_s: 1 });
    world.digests.set("q", { ask: { ask_id: "a1", ask: { kind: "approval", title: "pnpm i", options: [] } } });
    world.change("q", { status: "needs_input", activity: { ask: { kind: "approval", prompt: "pnpm i" } } });
    const asking = await run("chat_wait", { chats: ["q"], timeout_s: 1 });
    expect(asking.text).toContain("waits for the person in Caveman Code: approve `pnpm i`.");
    expect(asking.text).toContain('Tell your user: "Migrate waits for you in Caveman Code". Then chat_wait {"chats":["q"]}.');
    world.digests.delete("q");
    world.change("q", { status: "working", activity: {} });
    const answered = await run("chat_wait", { chats: ["q"], timeout_s: 1 });
    expect(answered.text).toContain("the person answered what it asked");
  });
});

describe("chat_start", () => {
  it("returns the chat it already started for the same arguments within 2 minutes, and starts anew after", async () => {
    const clock = { now: NOW };
    const { world, run } = setup({ clock });
    const first = await run("chat_start", { task: "Add a dark mode", title: "Dark mode" });
    expect(first.text).toContain("Started [ws1]");
    clock.now += 60_000;
    const again = await run("chat_start", { task: "Add a dark mode", title: "Dark mode" });
    expect(again.isError).toBeFalsy();
    expect(again.text).toContain("same arguments, so this is that chat, not a new one");
    expect(again.text).toContain("[ws1]");
    expect(world.callsOf("workspace.create")).toHaveLength(1);
    const other = await run("chat_start", { task: "Add a light mode" });
    expect(other.text).toContain("Started [ws2]");
    clock.now += 2 * 60_000;
    await run("chat_start", { task: "Add a dark mode", title: "Dark mode" });
    expect(world.callsOf("workspace.create")).toHaveLength(3);
  });

  it("starts once for two identical calls in flight together", async () => {
    const { world, run } = setup();
    const [a, b] = await Promise.all([run("chat_start", { task: "Same" }), run("chat_start", { task: "Same" })]);
    expect(world.callsOf("workspace.create")).toHaveLength(1);
    expect([a.text, b.text].filter((t) => t.includes("not a new one"))).toHaveLength(1);
  });

  it("runs a Supervised agent's chats at ask, refuses an access above it, and leaves a Full agent's to the default", async () => {
    const { world, run } = setup();
    await run("chat_start", { task: "One" });
    const create = world.callsOf("workspace.create")[0]!;
    expect(create.options).toEqual({ access: "ask" });
    expect(create.repo).toEqual({ path: "/code/app" });
    const refused = await run("chat_start", { task: "Two", access: "full" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('access "full" (Full access) is above your level, Supervised');
    expect(refused.text).toContain("its chats can read any file your user can and run commands they already allowed; other commands and every edit wait for them");
    expect(world.callsOf("workspace.create")).toHaveLength(1);
    world.level = "full";
    await run("chat_start", { task: "Three" });
    expect(world.callsOf("workspace.create")[1]!.options).toBeUndefined();
    world.level = "read";
    const read = await run("chat_start", { task: "Four" });
    expect(read.isError).toBe(true);
    expect(read.text).toContain("Read only");
  });

  it("takes the first engine that honours ask when the default doesn't, and refuses one that can't run Supervised", async () => {
    const { world, run } = setup();
    world.engines = [engine({ id: "grok", label: "Grok", access_modes: ["full"] }), engine({ id: "codex", label: "Codex" })];
    await run("chat_start", { task: "Pick for me" });
    expect(world.callsOf("workspace.create")[0]!.engine).toBe("codex");
    const grok = await run("chat_start", { task: "On grok", engine: "GROK" });
    expect(grok.isError).toBe(true);
    expect(grok.text).toContain("Grok doesn't honour \"ask\"");
    expect(grok.text).toContain("Codex [codex]");
  });

  it("names the project holding the working folder, and says what to pass when none does", async () => {
    const { world, bridge } = setup();
    world.projects = [];
    const answer = await bridge.call("chat_start", { task: "x" }, {});
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('project_add {"path":"/code/app/src"}');
  });

  it("takes images as base64 below Full, and refuses a file path there", async () => {
    const { world, run } = setup();
    await run("chat_start", { task: "Look", images: [`data:image/png;base64,${PNG}`] });
    const task = world.callsOf("workspace.create")[0]!.task as { attachments: Array<{ mime_type: string; name: string }> };
    expect(task.attachments[0]).toMatchObject({ mime_type: "image/png", name: "image-1.png" });
    const path = await run("chat_start", { task: "Look again", images: ["/Users/me/secret.png"] });
    expect(path.isError).toBe(true);
    expect(path.text).toContain("never reads your user's files");
  });
});

describe("every other call", () => {
  it("gets a fresh request_id, so a second chat_stop stops again", async () => {
    const { world, run } = setup();
    world.add(workspace({ id: "s", status: "working" }));
    await run("chat_stop", { chat: "s" });
    await run("chat_stop", { chat: "s" });
    const ids = world.callsOf("turn.interrupt").map((p) => p.request_id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("waits on a commit as long as the runtime lets the repository's commit hooks run", async () => {
    const { world, run } = setup();
    world.add(workspace({ id: "s", status: "idle" }));
    world.handlers.set("git.commit", () => ({ sha: "0123456789abcdef" }));
    expect((await run("chat_ship", { chat: "s", commit: "feat: agent work" })).text).toContain("Committed 0123456");
    expect(world.calls.find((c) => c.method === "git.commit")?.timeoutMs).toBe(COMMIT_TIMEOUT_MS);
  });

  it("queues a message to a chat that waits on the person, even a steer", async () => {
    const { world, run } = setup();
    world.add(workspace({ id: "p", status: "needs_input", activity: { ask: { kind: "approval", prompt: "rm -rf build" } } }));
    world.handlers.set("turn.submit", () => ({ turn_id: "t", disposition: "queued" }));
    const answer = await run("chat_send", { chat: "p", text: "also update the docs", mode: "steer" });
    expect(world.callsOf("turn.submit")[0]!.kind).toBe("queue");
    expect(answer.text).toContain("doesn't cancel it");
    world.add(workspace({ id: "i", status: "idle" }));
    await run("chat_send", { chat: "i", text: "go on" });
    expect(world.callsOf("turn.submit")[1]!.kind).toBe("followup");
  });
});

describe("errors", () => {
  it("lists chat.search's top 3 on a chat it can't find", async () => {
    const { world, run } = setup();
    world.add(workspace({ id: "zzz1", title: "Stripe webhooks", status: "working" }));
    world.handlers.set("chat.search", () => ({
      chats: [{ workspace: world.chats.get("zzz1")!, passages: [], more: 0 }],
      indexing: false,
      meaning: "unavailable",
    }));
    const answer = await run("chat_read", { chat: "payments" });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('No chat named "payments". Closest:');
    expect(answer.text).toContain("[zzz1] Stripe webhooks · app · working · 5m");
    expect(answer.text).toContain("Call again with one of these ids.");
  });

  it("refuses an approval as an instruction to tell the user", async () => {
    const { world, run } = setup();
    world.add(workspace({ id: "x", title: "Deploy", status: "needs_input" }));
    world.digests.set("x", { ask: { ask_id: "a9", ask: { kind: "approval", title: "pnpm i", options: [] } } });
    const answer = await run("chat_answer", { chat: "x", recommended: true });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("Only the person can approve this");
    expect(answer.text).toContain('Tell your user: "Deploy waits for you in Caveman Code". Then chat_wait {"chats":["x"]}.');
    expect(world.callsOf("ask.respond")).toHaveLength(0);
  });

  it("answers a question card with its recommended picks, and a stale ask_id as already answered", async () => {
    const { world, run } = setup();
    world.add(workspace({ id: "c", title: "Store", status: "needs_input" }));
    const ask = {
      kind: "question" as const,
      questions: [{ id: "q1", prompt: "Which store?", options: [{ id: "pg", label: "Postgres" }, { id: "sqlite", label: "SQLite" }], recommended: "pg", multi_select: false, allow_text: true }],
    };
    world.digests.set("c", { ask: { ask_id: "a1", ask } });
    const stale = await run("chat_answer", { chat: "c", ask_id: "a0", recommended: true });
    expect(stale.text).toContain("Ask a0 was already answered");
    const answer = await run("chat_answer", { chat: "c", answers: [{ pick: ["sqlite"] }] });
    expect(answer.isError).toBeFalsy();
    expect(world.callsOf("ask.respond")[0]).toMatchObject({ ask_id: "a1", response: { kind: "question", answers: [{ question_id: "q1", option_ids: ["sqlite"] }] } });
    world.handlers.set("ask.respond", () => {
      throw rpcError("invalid_state", "the ask is no longer open");
    });
    const late = await run("chat_answer", { chat: "c", recommended: true });
    expect(late.text).toContain("Ask a1 was already answered (or ended)");
  });

  it("answers invalid arguments with a valid call, and a link that can't connect with its text", async () => {
    const { world, run } = setup();
    const invalid = await run("chat_send", { chat: "x" });
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toContain("Invalid arguments for chat_send");
    expect(invalid.text).toContain('Example: chat_send {"chat":"<id or title>","text":"…"}');
    world.refusal = "Disconnected in Caveman Code > Settings > Caveman MCP. Tell your user; they can allow Claude Code there.";
    const blocked = await run("chats");
    expect(blocked).toEqual({ text: world.refusal, isError: true });
  });

  it("explains a refusal from the gate with the agent's level", async () => {
    const { world, run } = setup();
    world.add(workspace({ id: "m", title: "Mine" }));
    world.handlers.set("workspace.archive", () => {
      throw rpcError("forbidden", "Outside agents below Full access can only change chats they started", -32007);
    });
    const answer = await run("chat_organize", { chat: "m", action: "archive" });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("Caveman Code refused this: Outside agents below Full access");
    expect(answer.text).toContain("Your level is Supervised");
  });
});

describe("chat_read", () => {
  const event = (cursor: number, type: string, payload: unknown, extra: Record<string, unknown> = {}) =>
    ({ session_id: "s-t", cursor, at: minutesAgo(1), type, payload, ...extra }) as unknown as SessionEvent;

  it("pages the transcript without usage, naming an outside agent's messages", async () => {
    const { world, run } = setup();
    world.add(workspace({ id: "t", title: "Docs", head: 9 }));
    world.digests.set("t", {
      transcript: {
        from: 4,
        more: true,
        events: [
          event(4, "message.done", { role: "user", text: "Write the docs", from: { title: "Grok", agent: true } }),
          event(5, "tool.started", { name: "Bash", title: "pnpm docs", kind: "command", input: {} }, { item_id: "i1" }),
          event(6, "usage", { model: "opus", input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, cost: { usd: 0.42, basis: "billed" } }),
          event(7, "message.done", { role: "assistant", text: "Done." }),
          event(8, "turn.done", { status: "completed" }),
        ],
      },
    });
    const answer = await run("chat_read", { chat: "t", view: "transcript" });
    expect(answer.text).toContain("From Grok · outside agent: Write the docs");
    expect(answer.text).toContain("  · pnpm docs");
    expect(answer.text).toContain("Agent: Done.");
    expect(answer.text).not.toMatch(/usage|0\.42|tokens/);
    expect(answer.text).toContain('(earlier: chat_read {"chat":"t","view":"transcript","before":4})');
    expect(world.callsOf("workspace.digest").at(-1)).toMatchObject({ workspace_id: "t", transcript: { max_bytes: 65536 } });
  });

  it("returns the chat's images as base64 image blocks, newest first", async () => {
    const { world, run } = setup();
    world.add(workspace({ id: "im", title: "UI" }));
    const attached = png(40, 30).toString("base64");
    const shot = png(1568, 900).toString("base64");
    world.digests.set("im", {
      transcript: {
        from: 1,
        more: false,
        events: [
          event(1, "message.done", { role: "user", text: "like this", attachments: [{ type: "image", name: "ref.png", mime_type: "image/png", data: attached }] }),
          event(2, "tool.started", { name: "screenshot", title: "localhost:3000", kind: "browser", input: {} }, { item_id: "b1" }),
          event(3, "tool.done", { status: "completed", result: { content: [{ type: "image", data: shot, mimeType: "image/png" }] } }, { item_id: "b1" }),
          event(4, "message.done", { role: "assistant", text: "![shot](/tmp/shot.png)" }),
        ],
      },
    });
    const answer = await run("chat_read", { chat: "im", view: "images" });
    // Images that fit go as they are.
    expect(answer.images).toEqual([
      { mime: "image/png", data: shot },
      { mime: "image/png", data: attached },
    ]);
    expect(answer.text).toContain("1. localhost:3000 (cursor 3)");
    expect(world.callsOf("media.read")).toHaveLength(0);
  });

  it("says an image the page doesn't carry whole is too large to show, never that the chat has none, and never sends it cut", async () => {
    const { world, run } = setup();
    world.add(workspace({ id: "im", title: "UI" }));
    // The journal keeps an attached image over 1 MB by name only (bridge.integration.test.ts, on the real runtime). A page
    // cuts each long string of an event too large for it on its own but an image's bytes: here, image bytes cut all the same.
    const photo = { type: "image", name: "photo.png", mime_type: "image/png", data: "" };
    const cut = (data: string) => `${data.slice(0, 16_384)}… (${data.length - 16_384} more characters)`;
    const large = (fill: number) => Buffer.concat([png(400, 300), Buffer.alloc(100 * 1024, fill)]).toString("base64");
    const small = png(20, 20).toString("base64");

    world.digests.set("im", { transcript: { from: 1, more: false, events: [event(1, "message.done", { role: "user", text: "this one", attachments: [photo] })] } });
    const alone = await run("chat_read", { chat: "im", view: "images" });
    expect(alone.images ?? []).toEqual([]);
    expect(alone.text).toBe("[im] UI has no screenshots or attached images in its recent transcript (1 too large to show).");

    world.digests.set("im", {
      transcript: {
        from: 1,
        more: false,
        events: [
          event(1, "message.done", { role: "user", text: "like these", attachments: [{ type: "image", name: "small.png", mime_type: "image/png", data: small }, photo] }),
          event(2, "message.done", { role: "user", text: "and this", attachments: [{ type: "image", name: "shot.png", mime_type: "image/png", data: cut(large(1)) }] }),
          event(3, "tool.started", { name: "screenshot", title: "localhost:3000", kind: "browser", input: {} }, { item_id: "b1" }),
          event(4, "tool.done", { status: "completed", result: { content: [{ type: "image", data: cut(large(2)), mimeType: "image/png" }] } }, { item_id: "b1" }),
        ],
      },
    });
    const beside = await run("chat_read", { chat: "im", view: "images", limit: 8 });
    expect(beside.images).toEqual([{ mime: "image/png", data: small }]);
    expect(beside.text).toContain("(3 more too large to show)");
  });

  describe("images, at most 1568 px a side", () => {
    const sizeOf = (image: { readonly mime: string; readonly data: string }) => {
      const bytes = Buffer.from(image.data, "base64");
      if (image.mime === "image/png") return [image.mime, bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
      const decoded = jpeg.decode(bytes, { useTArray: true });
      return [image.mime, decoded.width, decoded.height];
    };
    /** An RGBA image white on its left half and black on its right. */
    const halves = (width: number, height: number) => {
      const data = Buffer.alloc(width * height * 4, 255);
      for (let i = 0; i < width * height; i++) if (i % width >= width / 2) data.fill(0, i * 4, i * 4 + 3);
      return { width, height, data };
    };
    /** A JPEG with an Exif block saying how to turn it upright. */
    const withOrientation = (bytes: Buffer, orientation: number) => {
      const tiff = Buffer.from([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0, 0, 0]);
      const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([0, tiff.length + 8]), Buffer.from("Exif\0\0", "latin1"), tiff]);
      return Buffer.concat([bytes.subarray(0, 2), app1, bytes.subarray(2)]);
    };
    const pixel = (rgba: { readonly width: number; readonly data: Uint8Array }, x: number, y: number) => rgba.data[(y * rgba.width + x) * 4]!;

    it("shrinks a larger PNG or JPEG to fit, a person's Retina screenshot and a full-page capture included", async () => {
      const { world, run } = setup();
      world.add(workspace({ id: "im", title: "UI" }));
      const retina = png(2880, 1800).toString("base64");
      const fullPage = png(1440, 12000);
      const wide = jpeg.encode(halves(3200, 200), 90).data.toString("base64");
      world.digests.set("im", {
        transcript: {
          from: 1,
          more: false,
          events: [
            event(1, "message.done", { role: "user", text: "like this", attachments: [{ type: "image", name: "ref.png", mime_type: "image/png", data: retina }] }),
            event(2, "tool.started", { name: "screenshot", title: "localhost:3000 full page", kind: "browser", input: {} }, { item_id: "b1" }),
            event(3, "tool.done", { status: "completed", result: { saved_path: "/tmp/full.png" } }, { item_id: "b1" }),
            event(4, "tool.started", { name: "screenshot", title: "banner", kind: "browser", input: {} }, { item_id: "b2" }),
            event(5, "tool.done", { status: "completed", result: { content: [{ type: "image", data: wide, mimeType: "image/jpeg" }] } }, { item_id: "b2" }),
          ],
        },
      });
      world.handlers.set("media.read", () => ({ path: "/tmp/full.png", mime_type: "image/png", data: fullPage.toString("base64"), size: fullPage.length }));
      const answer = await run("chat_read", { chat: "im", view: "images" });
      expect(answer.isError).toBeFalsy();
      expect(answer.images!.map(sizeOf)).toEqual([
        ["image/jpeg", 1568, 98],
        ["image/png", 188, 1568],
        ["image/png", 1568, 980],
      ]);
    });

    it("keeps what a shrunk image shows, a photo turned upright as its Exif says", async () => {
      const { world, run } = setup();
      world.add(workspace({ id: "im", title: "UI" }));
      const flat = Png.sync.write(Object.assign(new Png({ width: 3136, height: 100 }), { data: halves(3136, 100).data })).toString("base64");
      // Stored sideways, white on the left: upright (turned 90° clockwise) it is white on top.
      const photo = withOrientation(jpeg.encode(halves(3200, 100), 90).data, 6).toString("base64");
      world.digests.set("im", {
        transcript: {
          from: 1,
          more: false,
          events: [
            event(1, "message.done", { role: "user", text: "like these", attachments: [{ type: "image", name: "flat.png", mime_type: "image/png", data: flat }, { type: "image", name: "photo.jpg", mime_type: "image/jpeg", data: photo }] }),
          ],
        },
      });
      const answer = await run("chat_read", { chat: "im", view: "images" });
      const [upright, shrunk] = answer.images!;
      const turned = jpeg.decode(Buffer.from(upright!.data, "base64"), { useTArray: true });
      expect([turned.width, turned.height]).toEqual([49, 1568]);
      expect([pixel(turned, 24, 100), pixel(turned, 24, 1500)]).toEqual([expect.closeTo(255, -1), expect.closeTo(0, -1)]);
      const flatShrunk = Png.sync.read(Buffer.from(shrunk!.data, "base64"));
      expect([flatShrunk.width, flatShrunk.height]).toEqual([1568, 50]);
      expect([pixel(flatShrunk, 100, 25), pixel(flatShrunk, 1400, 25)]).toEqual([255, 0]);
    });

    it("leaves out a larger GIF it can't shrink, and says so", async () => {
      const { world, run } = setup();
      world.add(workspace({ id: "im", title: "UI" }));
      const gif = Buffer.from([...Buffer.from("GIF89a", "latin1"), 0xd0, 0x07, 0x64, 0x00, 0, 0, 0, 0x3b]).toString("base64");
      const small = png(20, 20).toString("base64");
      world.digests.set("im", {
        transcript: {
          from: 1,
          more: false,
          events: [
            event(1, "message.done", { role: "user", text: "both", attachments: [{ type: "image", name: "small.png", mime_type: "image/png", data: small }, { type: "image", name: "wide.gif", mime_type: "image/gif", data: gif }] }),
          ],
        },
      });
      const answer = await run("chat_read", { chat: "im", view: "images" });
      expect(answer.images).toEqual([{ mime: "image/png", data: small }]);
      expect(answer.text).toContain("(1 more too large to show)");
    });
  });

  describe("images, paged as each answer says", () => {
    /** A screenshot step whose result holds one image per width given, at cursors 2n-1 (started) and 2n (done). */
    const shots = (n: number, ...widths: Array<number>) => [
      event(2 * n - 1, "tool.started", { name: "screenshot", title: `step ${n}`, kind: "browser", input: {} }, { item_id: `b${n}` }),
      event(2 * n, "tool.done", { status: "completed", result: { content: widths.map((width) => ({ type: "image", data: png(width, 4).toString("base64"), mimeType: "image/png" })) } }, { item_id: `b${n}` }),
    ];
    /** The runtime's paging: a page of at most `size` events ending just before `before`, oldest first. */
    const paged = (world: FakeWorld, events: ReadonlyArray<SessionEvent>, size: number) =>
      world.handlers.set("workspace.digest", (p) => {
        const before = (p.transcript as { readonly before?: number } | undefined)?.before;
        const upTo = events.filter((e) => before === undefined || e.cursor < before);
        const page = upTo.slice(-size);
        const from = page[0]?.cursor ?? before ?? events.length + 1;
        return { workspace: world.chats.get(String(p.workspace_id))!, messages: 2, queued: 0, transcript: { events: page, from, more: from > 1 } };
      });
    /** Every image an agent sees following each answer's Earlier call, and the answers. */
    const pageThrough = async (run: ReturnType<typeof setup>["run"], first: Record<string, unknown>) => {
      const seen: Array<number> = [];
      const texts: Array<string> = [];
      let params: Record<string, unknown> | undefined = first;
      while (params && texts.length < 10) {
        const answer = await run("chat_read", params);
        texts.push(answer.text);
        seen.push(...(answer.images ?? []).map((image) => widthOf(image.data)));
        const next = /Earlier: chat_read (\{.*\})/.exec(answer.text);
        params = next ? (JSON.parse(next[1]!) as Record<string, unknown>) : undefined;
      }
      return { seen, texts };
    };

    it("reaches every image, those past the limit on the last page read included", async () => {
      const { world, run } = setup();
      world.add(workspace({ id: "im", title: "UI" }));
      // The newest page (10 events) holds steps 2 to 6, the page before it step 1.
      paged(world, [1, 2, 3, 4, 5, 6].flatMap((n) => shots(n, 10 + n)), 10);
      const { seen } = await pageThrough(run, { chat: "im", view: "images" });
      expect(seen).toEqual([16, 15, 14, 13, 12, 11]);
    });

    it("reaches every image of a chat that fits on one page", async () => {
      const { world, run } = setup();
      world.add(workspace({ id: "im", title: "UI" }));
      paged(world, [1, 2, 3, 4, 5].flatMap((n) => shots(n, 10 + n)), 100);
      const { seen } = await pageThrough(run, { chat: "im", view: "images" });
      expect(seen).toEqual([15, 14, 13, 12, 11]);
    });

    it("keeps a step's images together, and says how to see a step with more than the limit", async () => {
      const { world, run } = setup();
      world.add(workspace({ id: "im", title: "UI" }));
      // Step 3 holds one image, step 2 three, step 1 five.
      paged(world, [...shots(1, 11, 12, 13, 14, 15), ...shots(2, 21, 22, 23), ...shots(3, 31)], 100);
      const { seen, texts } = await pageThrough(run, { chat: "im", view: "images" });
      // Newest first, a step's own images too; the first answer leaves step 2 whole for the next.
      expect(seen).toEqual([31, 23, 22, 21, 15, 14, 13]);
      expect(texts[2]).toContain('(2 more images at cursor 2 not shown: chat_read {"chat":"im","view":"images","before":3,"limit":8})');
      const all = await pageThrough(run, { chat: "im", view: "images", before: 3, limit: 8 });
      expect(all.seen).toEqual([15, 14, 13, 12, 11]);
    });
  });
});
