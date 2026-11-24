// The voice's pure parts: Deepgram's wire both ways, and what the voice says. The whole call runs on a real
// runtime in chief.test.ts ("calls").
import * as Effect from "effect/Effect";
import { describe, expect, test } from "vitest";

import { OPEN_TURN_MS, QUIET_MS, quietAt, ringMuted, SETTLE_MS, UNFINISHED_SETTLE_MS } from "./Call.ts";
import { decodeDeepgram, deepgramSettings, encodeDeepgram, FUNCTIONS, makeDeepgram, TURN_TAKING, USD_PER_MINUTE } from "./deepgram.ts";
import { CREDITS_NOT_OFFERED } from "./engine.ts";
import { voicePayment } from "./keys.ts";
import { alsoLine, boardText, callBlock, greeting, projectSaid, readyText, resultLine, resultStub, shownChat, said, spoken, unfinished, updateLine, VOICE_INSTRUCTIONS, WORKING_LINES, workingLine } from "./prompt.ts";

const setup = { prompt: "You are the voice.", greeting: "Hey.", voice: "flux-cliff-en", keyterms: ["caveman-code"], patience: "normal" as const };

describe("Deepgram", () => {
  test("settings: Flux listens, the managed model talks with a fallback, both functions wait for the turn to end", () => {
    const s = deepgramSettings(setup);
    expect(s.audio).toEqual({ input: { encoding: "linear16", sample_rate: 16_000 }, output: { encoding: "linear16", sample_rate: 24_000, container: "none" } });
    expect(s.mip_opt_out).toBe(true);
    expect(s.agent.listen.provider).toMatchObject({ type: "deepgram", version: "v2", model: "flux-general-en", keyterms: ["caveman-code"], eot_threshold: 0.8, eot_timeout_ms: 7_000, eager_eot_threshold: 0.5 });
    expect(s.agent.think).toHaveLength(2);
    for (const t of s.agent.think) expect(t).toMatchObject({ prompt: "You are the voice.", functions: FUNCTIONS });
    // A handoff and a goodbye wait for the turn to be confirmed; what is on screen moves with the voice, at once.
    expect(FUNCTIONS.map((f) => [f.name, f.defer_until_eot])).toEqual([
      ["hand_to_chief", true],
      ["end_call", true],
      ["show", false],
    ]);
    expect(s.agent.speak.provider).toEqual({ type: "deepgram", version: "v2", model: "flux-cliff-en" });
    expect(s.agent.greeting).toBe("Hey.");
  });

  test("turn-taking by patience: each level inside Flux's ranges, eager under the end-of-turn bar, and patient waits longer than quick", () => {
    // Deepgram's ranges (docs/flux/configuration, 2026-10-20): eot_threshold 0.5-1.0, eager 0.3-0.9 and at most eot, timeout 500-60000.
    for (const level of ["quick", "normal", "patient"] as const) {
      const t = TURN_TAKING[level];
      expect(t.eot_threshold).toBeGreaterThanOrEqual(0.5);
      expect(t.eot_threshold).toBeLessThanOrEqual(1);
      expect(t.eager_eot_threshold).toBeGreaterThanOrEqual(0.3);
      expect(t.eager_eot_threshold).toBeLessThanOrEqual(t.eot_threshold);
      expect(t.eot_timeout_ms).toBeGreaterThanOrEqual(500);
      expect(t.eot_timeout_ms).toBeLessThanOrEqual(60_000);
      expect(deepgramSettings({ ...setup, patience: level }).agent.listen.provider).toMatchObject(t);
      expect(UNFINISHED_SETTLE_MS[level]).toBeGreaterThan(SETTLE_MS[level]);
    }
    expect(TURN_TAKING.patient.eot_threshold).toBeGreaterThan(TURN_TAKING.quick.eot_threshold);
    expect(TURN_TAKING.patient.eot_timeout_ms).toBeGreaterThan(TURN_TAKING.quick.eot_timeout_ms);
    expect(SETTLE_MS.patient).toBeGreaterThan(SETTLE_MS.quick);
  });

  test("decode: what a call needs, nothing else", () => {
    expect(decodeDeepgram({ type: "Welcome", request_id: "r" })).toEqual([]);
    expect(decodeDeepgram({ type: "SettingsApplied" })).toEqual([{ type: "ready" }]);
    expect(decodeDeepgram({ type: "ConversationText", role: "user", content: " add dark mode " })).toEqual([{ type: "turn", role: "person", text: "add dark mode" }]);
    expect(decodeDeepgram({ type: "ConversationText", role: "assistant", content: "On it." })).toEqual([{ type: "turn", role: "voice", text: "On it." }]);
    expect(decodeDeepgram({ type: "UserStartedSpeaking" })).toEqual([{ type: "person_speaking" }]);
    expect(decodeDeepgram({ type: "AgentAudioDone" })).toEqual([{ type: "voice_done" }]);
    expect(
      decodeDeepgram({
        type: "FunctionCallRequest",
        functions: [
          { id: "fc1", name: "hand_to_chief", arguments: "{}", client_side: true },
          { id: "fc2", name: "end_call", arguments: "{}", client_side: true },
          { id: "fc3", name: "server_thing", arguments: "{}", client_side: false },
        ],
      }),
    ).toEqual([
      { type: "handoff", id: "fc1", name: "hand_to_chief" },
      { type: "goodbye", id: "fc2", name: "end_call" },
    ]);
    expect(decodeDeepgram({ type: "FunctionCallRequest", functions: [{ id: "fc4", name: "show", arguments: JSON.stringify({ what: "files", file: "apps/web/src/Runs.tsx" }), client_side: true }] })).toEqual([
      { type: "show", id: "fc4", name: "show", what: "files", file: "apps/web/src/Runs.tsx" },
    ]);
    expect(decodeDeepgram({ type: "FunctionCallRequest", functions: [{ id: "fc5", name: "show", arguments: "not json", client_side: true }] })).toEqual([{ type: "show", id: "fc5", name: "show", what: "work" }]);
    expect(decodeDeepgram({ type: "FunctionCallCancelled", functions: [{ id: "fc1", name: "hand_to_chief" }] })).toEqual([{ type: "cancelled", ids: ["fc1"] }]);
    expect(decodeDeepgram({ type: "InjectionRefused", message: "busy" })).toEqual([{ type: "refused" }]);
    expect(decodeDeepgram({ type: "Warning", code: "INJECT_AGENT_MESSAGE_DURING_USER_SPEECH", description: "" })).toEqual([{ type: "refused" }]);
    expect(decodeDeepgram({ type: "Warning", code: "SLOW_THINK_REQUEST", description: "" })).toEqual([]);
    expect(decodeDeepgram({ type: "Error", code: "SERVER_GOING_AWAY", description: "bye" })).toEqual([{ type: "error", message: "bye", fatal: true }]);
    expect(decodeDeepgram({ type: "Error", code: "FAILED_TO_THINK", description: "no" })).toEqual([{ type: "error", message: "no", fatal: false }]);
    expect(decodeDeepgram("not json")).toEqual([]);
  });

  test("encode: answers, spoken lines that never cut anyone off, appended context, a renewed prompt", () => {
    expect(encodeDeepgram({ type: "answer", id: "fc1", name: "hand_to_chief", text: "ok" })).toEqual([{ type: "FunctionCallResponse", id: "fc1", name: "hand_to_chief", content: "ok" }]);
    expect(encodeDeepgram({ type: "say", text: "Started it." })).toEqual([{ type: "InjectAgentMessage", message: "Started it.", behavior: "queue" }]);
    expect(encodeDeepgram({ type: "know", text: "Update: x" })).toEqual([{ type: "UpdatePrompt", prompt: "\n\nUpdate: x" }]);
    const renew = encodeDeepgram({ type: "renew", prompt: "fresh" })[0] as { type: string; think: Array<{ prompt: string }> };
    expect(renew.type).toBe("UpdateThink");
    expect(renew.think.map((t) => t.prompt)).toEqual(["fresh", "fresh"]);
  });

  test("connect mints a token for the socket and never hands out the key", async () => {
    const calls: Array<{ url: string; auth: string; body: string }> = [];
    const engine = makeDeepgram({
      fetch: async (url, init) => {
        calls.push({ url, auth: init.headers.Authorization!, body: init.body });
        return { status: 200, json: async () => ({ access_token: "jwt-for-one-call", expires_in: 60 }), text: async () => "" };
      },
    });
    const { connect, usdPerMinute } = await Effect.runPromise(engine.connect({ kind: "key", key: "dg-secret-key-0123456789" }, setup));
    expect(calls).toEqual([{ url: "https://api.deepgram.com/v1/auth/grant", auth: "Token dg-secret-key-0123456789", body: JSON.stringify({ ttl_seconds: 60 }) }]);
    expect(connect).toMatchObject({ transport: "websocket", url: "wss://agent.deepgram.com/v1/agent/converse", protocols: ["bearer", "jwt-for-one-call"], input_rate: 16_000, output_rate: 24_000 });
    expect(JSON.stringify(connect)).not.toContain("dg-secret-key");
    expect(usdPerMinute).toBe(USD_PER_MINUTE);
  });

  test("on Caveman credits: Cloud's gateway answers a one-time ticket for its own socket, the settings are the same, and neither key is handed out", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const engine = makeDeepgram({
      fetch: async (url, init) => {
        calls.push({ url, headers: init.headers, body: init.body });
        return { status: 200, json: async () => ({ ticket: "cvt_one-call", expires_in: 60, usd_per_minute: 0.08 }) };
      },
    });
    const { connect, usdPerMinute } = await Effect.runPromise(engine.connect({ kind: "credits", key: "cave_secret_credits_key", gateway: "https://gateway.example/" }, setup));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://gateway.example/v1/code/voice", body: JSON.stringify({ kind: "agent" }) });
    expect(calls[0]!.headers).toMatchObject({ Authorization: "Bearer cave_secret_credits_key", "Content-Type": "application/json" });
    expect(calls[0]!.headers["x-caveman-client"]).toMatch(/^caveman-code\//);
    expect(connect).toMatchObject({ transport: "websocket", url: "wss://gateway.example/v1/code/voice/socket", protocols: ["bearer", "cvt_one-call"], input_rate: 16_000, output_rate: 24_000 });
    // Cloud relays Deepgram's wire as it is: the settings a key's call sends.
    expect(connect.settings).toEqual(deepgramSettings(setup));
    expect(JSON.stringify(connect)).not.toContain("cave_secret");
    // What Cloud bills a minute at.
    expect(usdPerMinute).toBe(0.08);
    // A gateway on plain http (a local Cloud) gets a plain socket.
    const local = await Effect.runPromise(engine.connect({ kind: "credits", key: "cave_k", gateway: "http://127.0.0.1:8787" }, setup));
    expect(local.connect.url).toBe("ws://127.0.0.1:8787/v1/code/voice/socket");
  });

  test("on Caveman credits, Cloud's refusals are said in words a person acts on", async () => {
    const answering = (status: number, error: Record<string, unknown>) =>
      makeDeepgram({ fetch: async () => ({ status, json: async () => ({ error }) }) }).connect({ kind: "credits", key: "cave_k", gateway: "https://gateway.example" }, setup);
    const failure = (status: number, error: Record<string, unknown> = {}) => Effect.runPromise(Effect.flip(answering(status, error)));
    const said = async (status: number, error: Record<string, unknown> = {}) => (await failure(status, error)).message;
    // Voice not sold on this Cloud, or a gateway from before it: not_offered, and the way out is a key of their own.
    expect(await failure(503, { code: "cave_code_voice_not_configured", message: "Voice on credits is not configured on this installation." })).toMatchObject({ kind: "not_offered", message: CREDITS_NOT_OFFERED });
    expect(await failure(404, { code: "cave_route_not_found", message: "Gateway path is not recognized." })).toMatchObject({ kind: "not_offered" });
    expect((await failure(402, { code: "cave_code_credits_exhausted" })).kind).toBe("unavailable");
    expect(await said(401, { code: "cave_invalid_api_key" })).toMatch(/Sign in again/);
    // Cloud's own words otherwise: credits used up, a guardrailed project, a rate limit.
    expect(await said(402, { code: "cave_code_credits_exhausted", message: "Caveman Code credits are used up until 1 December." })).toBe("Caveman Code credits are used up until 1 December.");
    expect(await said(500)).toBe("Caveman Cloud answered 500.");
    const away = makeDeepgram({ fetch: async () => Promise.reject(new Error("ENOTFOUND")) }).connect({ kind: "credits", key: "cave_k", gateway: "https://gateway.example" }, setup);
    expect((await Effect.runPromise(Effect.flip(away))).message).toMatch(/Couldn't reach Caveman Cloud/);
    const ticketless = makeDeepgram({ fetch: async () => ({ status: 200, json: async () => ({}) }) }).connect({ kind: "credits", key: "cave_k", gateway: "https://gateway.example" }, setup);
    expect((await Effect.runPromise(Effect.flip(ticketless))).message).toMatch(/without a ticket/);
  });

  test("what pays: a key of the person's own first, else Caveman credits, else nothing", async () => {
    const credits = async () => ({ key: "cave_k", gateway: "https://gateway.example" });
    expect(await Effect.runPromise(voicePayment("dg-own", credits)!)).toEqual({ kind: "key", key: "dg-own" });
    expect(await Effect.runPromise(voicePayment(undefined, credits)!)).toEqual({ kind: "credits", key: "cave_k", gateway: "https://gateway.example" });
    expect(voicePayment(undefined, undefined)).toBeUndefined();
    // Credits Cloud doesn't offer voice on: a start says why, never tries.
    expect(await Effect.runPromise(Effect.flip(voicePayment(undefined, "unavailable")!))).toMatchObject({ kind: "not_offered", message: CREDITS_NOT_OFFERED });
    expect(await Effect.runPromise(voicePayment("dg-own", "unavailable")!)).toEqual({ kind: "key", key: "dg-own" });
    // A Cloud computer Cloud gave no credits key right now.
    expect((await Effect.runPromise(Effect.flip(voicePayment(undefined, async () => undefined)!))).message).toMatch(/no Caveman credits key right now/);
  });

  test("a refused key is told apart from Deepgram being away", async () => {
    const answering = (status: number) => makeDeepgram({ fetch: async () => ({ status, json: async () => ({ err_msg: "nope" }), text: async () => "" }) });
    const failure = (status: number) => Effect.runPromise(Effect.flip(answering(status).check("dg-key-0123456789abcdef")));
    expect((await failure(401)).kind).toBe("refused");
    expect((await failure(403)).message).toMatch(/Member permission/);
    expect((await failure(503)).kind).toBe("unavailable");
    const away = makeDeepgram({ fetch: async () => Promise.reject(new Error("ENOTFOUND")) });
    expect((await Effect.runPromise(Effect.flip(away.check("dg-key-0123456789abcdef")))).kind).toBe("unavailable");
  });
});

describe("calls on Caveman credits", () => {
  const credits = { kind: "credits", key: "cave_live_credits_0123456789", gateway: "https://gateway.test/", session: "ws-chief" } as const;
  const answer = (status: number, body: unknown) => ({ status, json: async () => body, text: async () => JSON.stringify(body) });

  test("connect asks Cloud for a one-time ticket for the chat and opens its relay: no Deepgram key, no credits key, in the client's hands", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const engine = makeDeepgram({
      fetch: async (url, init) => {
        calls.push({ url, headers: init.headers, body: init.body });
        return answer(200, { ticket: "cvt_one-time", expires_in: 60, usd_per_minute: 0.075 });
      },
    });
    const { connect } = await Effect.runPromise(engine.connect(credits, setup));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://gateway.test/v1/code/voice");
    // The minutes are the chat's: Cloud bills them to it.
    expect(calls[0]!.headers).toMatchObject({ Authorization: "Bearer cave_live_credits_0123456789", "x-caveman-session": "ws-chief" });
    expect(calls[0]!.headers["x-caveman-client"]).toMatch(/^caveman-code\//);
    expect(JSON.parse(calls[0]!.body)).toEqual({ kind: "agent" });
    expect(connect).toMatchObject({ transport: "websocket", url: "wss://gateway.test/v1/code/voice/socket", protocols: ["bearer", "cvt_one-time"], input_rate: 16_000, output_rate: 24_000 });
    // The same settings as on a key: Cloud checks them on the way through.
    expect(connect.settings).toEqual(deepgramSettings(setup));
    expect(JSON.stringify(connect)).not.toContain("cave_live_credits");
  });
});

describe("what the voice says", () => {
  const names = { chat: (id: string) => (id === "ws1" ? "Flaky tab test" : undefined), project: (id: string) => (id === "p1" ? "app" : id === "p2" ? "Cloud" : undefined) };

  test("spoken: plain words only, two sentences", () => {
    expect(spoken("**Done.** I changed `apps/web/src/Runs.tsx` and ran `pnpm test`. See https://x.dev/pr/1. Also more. And more.")).toBe("Done. I changed and ran pnpm test.");
    expect(spoken("- one\n- two\n## Next\nthree")).toBe("one two Next three");
    expect(spoken("Item ci-0a1b2c3d is queued.")).toBe("Item is queued.");
  });

  test("result lines name what happened, never ids", () => {
    const started = resultLine({ name: "chat_start", input: { title: "Dark mode for runs", project_ids: ["p1"] }, result: { state: "started", chats: [{ workspace_id: "ws9", title: "Dark mode for runs", project_id: "p1" }] }, failed: false }, names);
    expect(started).toMatch(/dark mode for runs/i);
    expect(started).toMatch(/app/);
    expect(started).not.toMatch(/ws9|p1/);
    expect(resultLine({ name: "chat_start", input: { title: "Board API", project_ids: ["p1", "p2"] }, result: { state: "proposed", item_id: "ci-1" }, failed: false }, names)).toBe("Board API touches app and Cloud, so I've put it on the board for your okay first.");
    expect(resultLine({ name: "chat_send", input: { workspace_id: "ws1", text: "keep the cap" }, result: {}, failed: false }, names)).toMatch(/flaky tab test/);
    expect(resultLine({ name: "chat_stop", input: { workspace_id: "ws1" }, result: {}, failed: false }, names)).toMatch(/^(Okay, I've stopped flaky tab test\.|Flaky tab test is stopped, it won't go further\.)$/);
    expect(resultLine({ name: "chat_answer", input: { workspace_id: "ws1", ask_id: "a1", answers: [] }, result: {}, failed: false }, names)).toMatch(/^(Flaky tab test had a question, I've answered it\.|Okay, I answered flaky tab test's question, it's carrying on\.)$/);
    expect(resultLine({ name: "ask", input: { question: "Keep the $100 cap?", recommended: "Yes, keep it." }, result: "Asked.", failed: false }, names)).toBe("Quick one from the Chief: Keep the $100 cap? It'd go with yes, keep it.");
    expect(resultLine({ name: "chat_digest", input: { workspace_id: "ws1" }, result: {}, failed: false }, names)).toBeUndefined();
    expect(resultLine({ name: "memory_sql", input: {}, result: {}, failed: false }, names)).toBeUndefined();
  });

  test("they sound like a person: an acknowledgement, contractions, a title and a repo said in plain words", () => {
    // 2026-10-20, as said on a call: "Started a chat on chief context management + UI, in caveman-code." and
    // "A chat's on rethink the memory UI now, in caveman-code." Read like a log; the repo id was read out.
    const repo = { chat: () => undefined, project: (id: string) => (id === "p1" ? projectSaid("github.com/caveman-ai/caveman-code") : undefined) };
    const lines = [
      resultLine({ name: "chat_start", input: { title: "chief context management + UI", project_ids: ["p1"] }, result: { state: "started", chats: [{ workspace_id: "ws-a1b2c3d4", project_id: "p1" }] }, failed: false }, repo),
      resultLine({ name: "chat_start", input: { title: "rethink-the-memory-ui", project_ids: ["p1"] }, result: { state: "started", chats: [{ workspace_id: "ws-a1b2c3d5", project_id: "p1" }] }, failed: false }, repo),
      resultLine({ name: "chat_start", input: { title: "Should we open source the harness", project_ids: ["p1"] }, result: { state: "proposed", item_id: "ci-0a1b2c3d" }, failed: false }, repo),
      resultLine({ name: "chat_start", input: { title: "Make Chief voice feel human", project_ids: ["p1"] }, result: { state: "blocked", item_id: "ci-0a1b2c3e" }, failed: false }, repo),
      resultLine({ name: "queue_add", input: { title: "fix_the_login_bug" }, result: { item_id: "ci-0a1b2c3f" }, failed: false }, repo),
      resultLine({ name: "chat_send", input: { workspace_id: "ws-x" }, result: {}, failed: false }, repo),
    ].map((l) => l ?? "");
    expect(lines[0]).toMatch(/chief context management and UI/i);
    expect(lines[0]).toMatch(/caveman code app/);
    expect(lines[1]).toMatch(/rethink the memory ui/i);
    expect(lines[2]).toMatch(/your okay|once you say so/);
    expect(lines[3]).toMatch(/room|slot/);
    expect(lines[4]).toMatch(/fix the login bug/i);
    for (const line of lines) {
      expect(line).toMatch(/^[A-Z]/);
      expect(line).toMatch(/'/); // a contraction
      // Nothing raw: no ids, no dashed or underscored names, no "+", no path.
      expect(line).not.toMatch(/\b(?:ci|ws|vc|item)-[0-9a-f]+|caveman-code|\w[-_]\w|\+|\//);
    }
    // The same title never says the same line twice in a row, and a different title can say it another way.
    expect(new Set([lines[0], lines[1]]).size).toBe(2);
    expect(said("rethink-the-memory-ui")).toBe("rethink the memory ui");
    expect(said("Chief UI: context + memory.")).toBe("chief UI: context and memory");
    expect(projectSaid("caveman_code.app")).toBe("caveman code app");
    expect(WORKING_LINES).toContain(workingLine("turn-1"));
  });

  test("a turn that sounds unfinished waits longer: a filler, a connector, a trailing comma, or no end at all", () => {
    expect(unfinished("Yeah. I don't know.")).toBe(true);
    expect(unfinished("But maybe there's a smart way where we can do thi")).toBe(true);
    expect(unfinished("and then, um,")).toBe(true);
    expect(unfinished("We should fix the login bug and")).toBe(true);
    expect(unfinished("")).toBe(true);
    expect(unfinished("go for some smart ways to do that.")).toBe(false);
    expect(unfinished("Add dark mode to the runs page.")).toBe(false);
    expect(unfinished("Can you stop the test chat?")).toBe(false);
  });

  test("the greeting leads with what is ready, then what needs you", () => {
    const ready = { item_id: "ci-1", title: "Dark mode for runs", state: "review" as const, report: "" };
    expect(greeting({ ready: [ready], needsYou: 2, hour: 9, seed: "a" })).toBe("Hey. Dark mode for runs is ready. Want the walkthrough?");
    expect(greeting({ ready: [], needsYou: 1, hour: 9, seed: "a" })).toBe("Hey. One thing on the board needs you. Want to hear it?");
    expect(greeting({ ready: [], needsYou: 0, hour: 9, seed: "a" }).length).toBeLessThan(40);
    expect(updateLine("Dark mode for runs", "review")).toMatch(/^Dark mode for runs is ready for you to look at\. Want (me to walk you through it|the walkthrough)\?$/);
    expect(updateLine("Dark mode for runs", "done")).toMatch(/ready for you to look at/);
  });

  test("only what matters: results after the first fold into one line, a question never does, and a report is the only facts", () => {
    // 2026-10-20: three result lines in a row, then "It changed a lot of files…", "The three-day replay test is still running…".
    const p1 = { chat: names.chat };
    expect(resultStub({ name: "chat_start", input: { title: "Rethink the memory UI" }, result: { state: "started", chats: [{}] }, failed: false }, p1)).toBe("someone's on rethink the memory UI");
    expect(resultStub({ name: "chat_start", input: { title: "Should we open source the harness" }, result: { state: "proposed" }, failed: false }, p1)).toBe("should we open source the harness needs your okay");
    expect(resultStub({ name: "queue_add", input: { title: "Memory UI research", text: "look at it" }, result: {}, failed: false }, p1)).toBe("queued memory UI research");
    expect(resultStub({ name: "chat_send", input: { workspace_id: "ws1" }, result: {}, failed: false }, p1)).toBe("told flaky tab test");
    expect(resultStub({ name: "remember", input: { text: "x" }, result: {}, failed: false }, p1)).toBe("noted that");
    expect(resultStub({ name: "ask", input: { question: "Which one?" }, result: {}, failed: false }, p1)).toBeUndefined();
    expect(resultStub({ name: "chat_digest", input: {}, result: {}, failed: false }, p1)).toBeUndefined();
    expect(alsoLine(["someone's on rethink the memory UI", "should we open source the harness needs your okay"])).toBe("Also, someone's on rethink the memory UI and should we open source the harness needs your okay.");
    const ready = { item_id: "ci-1", title: "Chief context management", project: "app", state: "review" as const, report: "Added a Compact button to the Chief page.\nChanged 14 files; the replay test is still running." };
    const text = readyText(ready);
    expect(text).toContain("the only facts you may state");
    expect(text).toContain("Added a Compact button");
    expect(text).not.toMatch(/It changed \d+ files/);
    expect(readyText({ ...ready, report: "" })).toContain("no report yet");
    expect(VOICE_INSTRUCTIONS).toMatch(/Never mention files changed, tests running or passing/);
    expect(VOICE_INSTRUCTIONS).toMatch(/Never describe a screen, a button or a feature the report doesn't name/);
  });

  test("the board reads as plain lines; a note's call block marks who spoke", () => {
    const at = new Date().toISOString();
    const item = (id: string, state: string, title: string, extra = {}) => ({ id, text: title, title, state, rank: 1, pinned: false, project_ids: ["p1"], source: "voice", workspace_ids: [], created_at: at, updated_at: at, ...extra }) as never;
    const text = boardText([item("a", "needs_you", "Bench arm", { detail: "Keep the cap?" }), item("b", "started", "Dark mode"), item("c", "queued", "Reply to LEGO")], [], names.project);
    expect(text).toContain("Needs them:\n- Bench arm (app): Keep the cap?");
    expect(text).toContain("Working:\n- Dark mode (app)");
    expect(text).toContain("Queued, in order:\n- Reply to LEGO");
    expect(text).not.toMatch(/\bci-|ws\d/);
    expect(callBlock([{ role: "voice", text: "Which project?" }, { role: "person", text: "the app" }])).toBe("<call>\nvoice: Which project?\nyou: the app\n</call>");
    // What was on screen leads the block, so "that" has a chat.
    expect(callBlock([{ role: "person", text: "make that bigger" }], { title: "Dark mode for runs", item_id: "ci-1", workspace_id: "ws-9" })).toBe(
      '<call>\nshowing: "Dark mode for runs" (item ci-1, chat ws-9): what was on their screen; "that" and "this" mean it\nyou: make that bigger\n</call>',
    );
    // Chief.ts reads the chat back out of the block, even past a title that looks like the line's own tail.
    expect(shownChat(callBlock([], { title: "Fix (item x, chat y)", item_id: "ci-1", workspace_id: "ws-9" }))).toBe("ws-9");
    expect(shownChat(callBlock([{ role: "person", text: "hi" }]))).toBeUndefined();
    expect(shownChat(undefined)).toBeUndefined();
  });
});

describe("muted rings", () => {
  test("off until further notice, or muted until a time still ahead; a past time, null or nothing set rings", () => {
    const t = Date.parse("2026-10-25T09:00:00Z");
    expect(ringMuted({}, t)).toBe(false);
    expect(ringMuted({ chief_voice_ring_back: true, chief_voice_ring_muted_until: null }, t)).toBe(false);
    expect(ringMuted({ chief_voice_ring_back: false }, t)).toBe(true);
    expect(ringMuted({ chief_voice_ring_muted_until: "2026-10-25T09:15:00Z" }, t)).toBe(true);
    expect(ringMuted({ chief_voice_ring_muted_until: "2026-10-25T08:59:59Z" }, t)).toBe(false);
    expect(ringMuted({ chief_voice_ring_muted_until: "not a time" }, t)).toBe(false);
  });
});

describe("the quiet goodbye", () => {
  test("a ramble longer than QUIET_MS is not silence; quiet counts from its words, and a cough holds it off only so long", () => {
    // 2026-10-20: 48 s of talk sent one UserStartedSpeaking and its words only at the end; the call hung up mid-sentence.
    const started = { lastActivityMs: 0, personOpen: true, personMs: 0 };
    expect(quietAt(started, 48_000)).toBe(false);
    const said = { lastActivityMs: 48_000, personOpen: false, personMs: 48_000 };
    expect(quietAt(said, 48_000 + QUIET_MS)).toBe(false);
    expect(quietAt(said, 48_001 + QUIET_MS)).toBe(true);
    expect(quietAt(started, OPEN_TURN_MS)).toBe(true);
  });
});
