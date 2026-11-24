// What a moving chat's copy carries (moveEngines.testkit.ts): messages sent during a move, a sleeping Mac's copy without
// its work in progress, session files past a segment, and work in progress as checked chunks.
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { gzipSync } from "node:zlib";

import { connect } from "@caveman-app/session-protocol";
import { expect, onTestFinished } from "vitest";

import { onLidClose } from "../../../../apps/desktop/src/lid.ts";
import { git, MODEL, until } from "../session-protocol/testHarness.ts";
import {
  type Boundary,
  box,
  cloud,
  copyIdle,
  GITHUB,
  githubRepo,
  handoffSender,
  lastBoundary,
  linked,
  namedBy,
  notified,
  personCall,
  realpath,
  recordOn,
  replies,
  runtime,
  say,
  segmentsText,
  sessionFileOn,
  sha256,
  transcript,
  treeOf,
  untilWipHeld,
  useTestCloud,
  waitNotified,
  waitReply,
  withCloudComputers,
} from "./moveEngines.testkit.ts";

useTestCloud();

withCloudComputers(
  "a message sent during a move uses Cloud's durable queue and runs once where it lands (CHAOS-18)",
  { timeout: 300_000 },
  async () => {
    const { bare, gitEnv, macRepo } = githubRepo();
    const bearer = cloud.state.chats.addPerson("user-18");
    cloud.state.chats.engineLogins.set("user-18", {
      "claude-agent": { vault_key: true, signed_in_on: [] },
    });
    const mac = await runtime("mac", {
      ...gitEnv,
      MOVES_CLOUD_URL: cloud.url,
      MOVES_BEARER: bearer,
    });
    await mac.client.call("settings.set", {
      request_id: "moves-on",
      settings: { move_to_cloud: true },
    });
    const away = await box(bare, "Box eighteen", "user-18");
    const w = await mac.client.call("workspace.create", {
      request_id: "w18",
      repo: { path: macRepo },
      title: "Late words",
      engine: "claude-agent",
      options: { model: MODEL, access: "full" },
      task: { text: "remember lambda" },
    });
    const sessionId = w.session_id;
    await waitReply(mac, sessionId, /smoke ok: remember lambda/);
    await until(() => segmentsText(sessionId).length > 0, 20_000);
    // Cloud is slow to answer the move's check: the chat is being let go, still live here, while a message comes in.
    const sender = await handoffSender(mac, sessionId, bearer);
    cloud.state.chats.delay.check = 3_000;
    const moving = mac.client.call("session.move", {
      request_id: "m18",
      session_id: sessionId,
      to: { computer_id: away.computerId },
    });
    await until(() => cloud.state.chats.moveChecksPending > 0, 20_000);
    // From another connection (a device's), as a send would come: the move's own call holds its connection's lane.
    const device = connect(mac.url, mac.token);
    const late = await sender.send(
      sessionId,
      "turn.submit",
      {
        request_id: "late-18",
        session_id: sessionId,
        kind: "followup",
        input: { text: "remember mu" },
      },
      { via: "runtime", client: device, orCloud: true },
    );
    device.close();
    expect(late.via).toBe("cloud");
    await moving;
    delete cloud.state.chats.delay.check;
    // It ran once, on the computer the chat landed on, and never here.
    await waitReply(away, sessionId, /smoke ok: [\s\S]*remember mu/, 90_000);
    const there = await transcript(away, sessionId);
    expect(
      there.filter(
        (e) =>
          e.type === "message.done" &&
          e.payload.role === "user" &&
          e.payload.text === "remember mu",
      ),
    ).toHaveLength(1);
    const here = await transcript(mac, sessionId);
    expect(
      here.some(
        (e) =>
          e.type === "message.done" &&
          e.payload.role === "user" &&
          e.payload.text === "remember mu",
      ),
    ).toBe(false);
  },
);

withCloudComputers(
  "a message sent during a move runs here from Cloud's queue when the move is refused (CHAOS-18)",
  { timeout: 300_000 },
  async () => {
    const { bare, gitEnv, macRepo } = githubRepo();
    const bearer = cloud.state.chats.addPerson("user-19");
    const mac = await runtime("mac", {
      ...gitEnv,
      MOVES_CLOUD_URL: cloud.url,
      MOVES_BEARER: bearer,
    });
    await mac.client.call("settings.set", {
      request_id: "moves-on",
      settings: { move_to_cloud: true },
    });
    const away = await box(bare, "Box nineteen", "user-19");
    const w = await mac.client.call("workspace.create", {
      request_id: "w19",
      repo: { path: macRepo },
      title: "Stays put",
      engine: "claude-agent",
      options: { model: MODEL, access: "full" },
      task: { text: "remember nu" },
    });
    const sessionId = w.session_id;
    await waitReply(mac, sessionId, /smoke ok: remember nu/);
    await until(() => segmentsText(sessionId).length > 0, 20_000);
    // No Claude login on the box: Cloud's check refuses the move, slowly, after the message came in.
    const sender = await handoffSender(mac, sessionId, bearer);
    cloud.state.chats.delay.check = 3_000;
    const moving = mac.client
      .call("session.move", {
        request_id: "m19",
        session_id: sessionId,
        to: { computer_id: away.computerId },
      })
      .catch((e: Error) => e);
    await until(() => cloud.state.chats.moveChecksPending > 0, 20_000);
    const device = connect(mac.url, mac.token);
    expect(
      (
        await sender.send(
          sessionId,
          "turn.submit",
          {
            request_id: "late-19",
            session_id: sessionId,
            kind: "followup",
            input: { text: "remember xi" },
          },
          { via: "runtime", client: device, orCloud: true },
        )
      ).via,
    ).toBe("cloud");
    device.close();
    expect(await moving).toBeInstanceOf(Error);
    delete cloud.state.chats.delay.check;
    await until(async () => {
      const response = await fetch(`${cloud.url}/api/v1/code/chats/${sessionId}/calls/late-19`, {
        headers: { authorization: `Bearer ${bearer}` },
      });
      const call = (await response.json()) as { status: string; error?: unknown };
      if (call.status === "failed")
        throw new Error(`Queued handoff message refused: ${JSON.stringify(call.error)}`);
      return call.status === "done";
    }, 45_000);
    await waitReply(mac, sessionId, /smoke ok: [\s\S]*remember xi/, 60_000);
    expect(
      (await transcript(mac, sessionId)).filter(
        (e) =>
          e.type === "message.done" &&
          e.payload.role === "user" &&
          e.payload.text === "remember xi",
      ),
    ).toHaveLength(1);
  },
);

withCloudComputers(
  "a Claude Agent chat whose session file grew past what a copy carries says, where it lands, that it continues from its transcript (D3)",
  { timeout: 300_000 },
  async () => {
    const { bare, gitEnv, macRepo } = githubRepo();
    const bearer = cloud.state.chats.addPerson("user-31");
    cloud.state.chats.engineLogins.set("user-31", {
      "claude-agent": { vault_key: true, signed_in_on: [] },
    });
    const mac = await runtime("mac", {
      ...gitEnv,
      MOVES_CLOUD_URL: cloud.url,
      MOVES_BEARER: bearer,
    });
    await mac.client.call("settings.set", {
      request_id: "moves-on",
      settings: { sync_chats: true },
    });
    const away = await box(bare, "Box thirty-one", "user-31");
    const w = await mac.client.call("workspace.create", {
      request_id: "w31",
      repo: { path: macRepo },
      title: "Long session",
      engine: "claude-agent",
      options: { model: MODEL, access: "full" },
      task: { text: "remember omicron" },
    });
    const sessionId = w.session_id;
    await waitReply(mac, sessionId, /smoke ok: remember omicron/);
    await until(() => sessionFileOn(mac.claudeDir, w.root_path!) !== undefined, 20_000);
    // 16 MiB the session holds that no segment can (under what the copy reads, 48 MiB).
    const file = sessionFileOn(mac.claudeDir, w.root_path!)!;
    fs.appendFileSync(
      file,
      `${JSON.stringify({ type: "summary", uuid: randomUUID(), summary: randomBytes(12 * 1024 * 1024).toString("base64") })}\n`,
    );
    await say(mac, sessionId, "remember pi");
    await waitReply(mac, sessionId, /smoke ok: remember pi/);
    await until(() => segmentsText(sessionId).includes('"native_dropped":true'), 30_000);
    await mac.client.call("session.move", {
      request_id: "m31",
      session_id: sessionId,
      to: { computer_id: away.computerId },
    });
    // Where it lands it says so in the chat, not only in a log, and carries on from its history.
    await until(
      async () =>
        notified(
          await transcript(away, sessionId).catch(() => []),
          /Claude Agent's own session didn't move with this chat/,
        ),
      90_000,
    );
    const there = await transcript(away, sessionId);
    expect(
      there.filter(
        (e) =>
          e.type === "notification" && /own session didn't move/.test(JSON.stringify(e.payload)),
      ),
    ).toHaveLength(1);
    await say(away, sessionId, "history?");
    expect(
      replies(await waitReply(away, sessionId, /smoke ok: [\s\S]*history\?/, 90_000)).at(-1),
    ).toContain("remember omicron");
  },
);

withCloudComputers(
  "Cloud's move of a sleeping Mac's chat whose copy went without its work in progress is refused where it lands and goes back to that Mac, its files as they were (F-5)",
  { timeout: 300_000 },
  async () => {
    // A Cloud without the copy's chunk routes (AC-08): the copy goes without the large work in progress.
    cloud.state.chats.blobsOff = true;
    onTestFinished(() => void (cloud.state.chats.blobsOff = false));
    const { bare, gitEnv, macRepo } = githubRepo();
    const bearer = cloud.state.chats.addPerson("user-32");
    cloud.state.chats.engineLogins.set("user-32", {
      "claude-agent": { vault_key: true, signed_in_on: [] },
    });
    const mac = await runtime("mac", {
      ...gitEnv,
      MOVES_CLOUD_URL: cloud.url,
      MOVES_BEARER: bearer,
    });
    await mac.client.call("settings.set", {
      request_id: "moves-on",
      settings: { sync_chats: true },
    });
    const away = await box(bare, "Box thirty-two", "user-32");
    const w = await mac.client.call("workspace.create", {
      request_id: "w32",
      repo: { path: macRepo },
      title: "Too big to move",
      engine: "claude-agent",
      options: { model: MODEL, access: "full" },
      task: { text: "remember rho" },
    });
    const sessionId = w.session_id;
    await waitReply(mac, sessionId, /smoke ok: remember rho/);
    // 12 MiB nobody can compress, uncommitted: the next copy goes without it, and says so.
    const blob = randomBytes(12 * 1024 * 1024);
    fs.writeFileSync(path.join(w.root_path!, "big.bin"), blob);
    await say(mac, sessionId, "remember sigma");
    await waitReply(mac, sessionId, /smoke ok: remember sigma/);
    await until(() => {
      const last = cloud.state.chats.sessions.get(sessionId)?.segments.at(-1);
      return (
        last?.boundary === true &&
        (last.body as { wip_dropped?: boolean }).wip_dropped === true &&
        cloud.state.chats.sessions.get(sessionId)!.lease === null
      );
    }, 30_000);
    // The Mac sleeps; the person's phone moves the chat to Cloud, which moves it from its copy.
    mac.child.kill("SIGSTOP");
    try {
      for (const r of cloud.state.chats.link?.runtimesOf(
        cloud.state.chats.sessions.get(sessionId)!.computer_id,
      ) ?? [])
        cloud.state.chats.lastHeartbeat.delete(r);
      const moved = await personCall(bearer, "POST", `chats/${sessionId}/move`, { to: "cloud" });
      expect(moved).toMatchObject({ status: 200, body: { pending: false } });
      const move = [...cloud.state.chats.moves.values()].find(
        (m) => m.session_id === sessionId && m.committed,
      )!;
      // The Cloud computer refuses the copy: it would continue on older files than the Mac has.
      await until(() => move.answers.some((a) => a.phase === "adopt" && !a.ok), 90_000);
      expect(move.answers.find((a) => a.phase === "adopt")).toMatchObject({
        ok: false,
        code: "cave_code_copy_not_movable",
      });
      // Back to its sleeping Mac (no other Cloud computer gets past that), never ownerless.
      expect(move.reassigned).toBe("source");
      expect(cloud.state.chats.sessions.get(sessionId)?.computer_id).not.toBe(away.computerId);
    } finally {
      mac.child.kill("SIGCONT");
    }
    // Awake, the Mac has its own chat as it left it (Cloud hears it has it): the work it holds, never the older copy's.
    const move = [...cloud.state.chats.moves.values()].find(
      (m) => m.session_id === sessionId && m.committed,
    )!;
    await until(() => move.answers.filter((a) => a.phase === "adopt").length === 2, 90_000);
    expect(move.answers.filter((a) => a.phase === "adopt").map((a) => a.ok)).toEqual([false, true]);
    expect(await recordOn(mac, sessionId)).toMatchObject({
      status: "idle",
      computer: { kind: "this_mac" },
    });
    expect(fs.readFileSync(path.join(w.root_path!, "big.bin")).equals(blob)).toBe(true);
    expect((await recordOn(away, sessionId))?.session_id).toBeUndefined();
    await say(mac, sessionId, "history?");
    expect(
      replies(await waitReply(mac, sessionId, /smoke ok: [\s\S]*history\?/, 60_000)).at(-1),
    ).toContain("remember sigma");
  },
);

withCloudComputers(
  "a chat Cloud moved while its Mac slept, which came straight back to that Mac, keeps what the Mac journaled after its copy and runs the next message there",
  { timeout: 300_000 },
  async () => {
    const { bare, gitEnv, macRepo } = githubRepo();
    const bearer = cloud.state.chats.addPerson("user-33");
    cloud.state.chats.engineLogins.set("user-33", {
      "claude-agent": { vault_key: true, signed_in_on: [] },
    });
    const mac = await runtime("mac", {
      ...gitEnv,
      MOVES_CLOUD_URL: cloud.url,
      MOVES_BEARER: bearer,
    });
    await mac.client.call("settings.set", {
      request_id: "moves-on",
      settings: { sync_chats: true },
    });
    const away = await box(bare, "Box thirty-three", "user-33");
    const w = await mac.client.call("workspace.create", {
      request_id: "w33",
      repo: { path: macRepo },
      title: "Straight back",
      engine: "claude-agent",
      options: { model: MODEL, access: "full" },
      task: { text: "remember tau" },
    });
    const sessionId = w.session_id;
    await waitReply(mac, sessionId, /smoke ok: remember tau/);
    await until(
      async () =>
        cloud.state.chats.sessions.get(sessionId)?.lease === null &&
        (cloud.state.chats.copyOf(sessionId).at(-1)?.cursor ?? 0) ===
          (await transcript(mac, sessionId)).at(-1)?.cursor,
      30_000,
    );
    // The Mac sleeps; the phone's move goes from the copy, and the box cannot read it: Cloud hands it straight back.
    mac.child.kill("SIGSTOP");
    cloud.state.chats.segmentReadsDownOn = away.computerId;
    try {
      for (const r of cloud.state.chats.link?.runtimesOf(
        cloud.state.chats.sessions.get(sessionId)!.computer_id,
      ) ?? [])
        cloud.state.chats.lastHeartbeat.delete(r);
      expect(
        await personCall(bearer, "POST", `chats/${sessionId}/move`, { to: "cloud" }),
      ).toMatchObject({ status: 200 });
      const move = [...cloud.state.chats.moves.values()].find(
        (m) => m.session_id === sessionId && m.committed,
      )!;
      await until(() => move.reassigned === "source", 90_000);
    } finally {
      cloud.state.chats.segmentReadsDownOn = undefined;
      mac.child.kill("SIGCONT");
    }
    const before = await transcript(mac, sessionId);
    // Awake: the chat runs here as it was, every event kept, and its next message runs (never lost to a rebuild).
    await until(async () => (await recordOn(mac, sessionId))?.status === "idle", 30_000);
    await say(mac, sessionId, "history?");
    const after = await waitReply(mac, sessionId, /smoke ok: [\s\S]*history\?/, 60_000);
    expect(replies(after).at(-1)).toContain("remember tau");
    expect(after.slice(0, before.length).map((e) => [e.cursor, e.type])).toEqual(
      before.map((e) => [e.cursor, e.type]),
    );
    await until(
      async () =>
        (cloud.state.chats.copyOf(sessionId).at(-1)?.cursor ?? 0) ===
        (await transcript(mac, sessionId)).at(-1)?.cursor,
      30_000,
    );
  },
);

withCloudComputers(
  "a chat Cloud moved from a copy its sleeping Mac never parked says where it lands which files it continues from: its last copy's, by when they were taken (item 27)",
  { timeout: 300_000 },
  async () => {
    const { bare, gitEnv, macRepo } = githubRepo();
    const bearer = cloud.state.chats.addPerson("user-35");
    cloud.state.chats.engineLogins.set("user-35", {
      "claude-agent": { vault_key: true, signed_in_on: [] },
    });
    const mac = await runtime("mac", {
      ...gitEnv,
      MOVES_CLOUD_URL: cloud.url,
      MOVES_BEARER: bearer,
    });
    await mac.client.call("settings.set", {
      request_id: "moves-on",
      settings: { sync_chats: true },
    });
    const away = await box(bare, "Box thirty-five", "user-35");
    const w = await mac.client.call("workspace.create", {
      request_id: "w35",
      repo: { path: macRepo },
      title: "Files of when",
      engine: "claude-agent",
      options: { model: MODEL, access: "full" },
      task: { text: "remember upsilon" },
    });
    const sessionId = w.session_id;
    await waitReply(mac, sessionId, /smoke ok: remember upsilon/);
    fs.writeFileSync(path.join(w.root_path!, "draft.txt"), "draft\n");
    await say(mac, sessionId, "remember phi");
    await waitReply(mac, sessionId, /smoke ok: remember phi/);
    await until(
      async () =>
        cloud.state.chats.sessions.get(sessionId)?.lease === null &&
        (cloud.state.chats.copyOf(sessionId).at(-1)?.cursor ?? 0) ===
          (await transcript(mac, sessionId)).at(-1)?.cursor,
      30_000,
    );
    // The cursor its files were taken at: the last boundary's.
    const through = (
      cloud.state.chats.sessions.get(sessionId)!.segments.findLast((x) => x.boundary)!.body as {
        through: number;
      }
    ).through;
    const takenAt = (await transcript(mac, sessionId)).find((e) => e.cursor === through)!.at;
    // The Mac sleeps without a word (never parks the chat); the phone moves it, and Cloud moves it from its copy.
    mac.child.kill("SIGSTOP");
    try {
      for (const r of cloud.state.chats.link?.runtimesOf(
        cloud.state.chats.sessions.get(sessionId)!.computer_id,
      ) ?? [])
        cloud.state.chats.lastHeartbeat.delete(r);
      expect(
        await personCall(bearer, "POST", `chats/${sessionId}/move`, { to: "cloud" }),
      ).toMatchObject({ status: 200 });
      await until(
        async () =>
          (await recordOn(away, sessionId))?.computer.id === away.computerId &&
          (await recordOn(away, sessionId))?.status === "idle",
        120_000,
      );
      // Said as the adopt finishes, a moment after the chat is idle there.
      await until(
        async () => notified(await transcript(away, sessionId), /"title":"Continued from/),
        30_000,
      );
      const there = await transcript(away, sessionId);
      // A Cloud computer's clock is not the person's: the time is said in UTC.
      const when = `${new Date(takenAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;
      const said = there.filter(
        (e) => e.type === "notification" && e.payload.title === `Continued from ${when}'s files`,
      );
      expect(said).toHaveLength(1);
      expect(said[0]!.type === "notification" && said[0]!.payload.body).toContain(
        `taken at ${when}`,
      );
      expect(
        fs.readFileSync(path.join(treeOf(away.workspaceRoot, w.branch), "draft.txt"), "utf8"),
      ).toBe("draft\n");
    } finally {
      mac.child.kill("SIGCONT");
    }
  },
);

withCloudComputers(
  "a copy that carries no work in progress is refused where Cloud moves it, and the chat goes back to its sleeping Mac with its files as they were (item 27: never a clean clone)",
  { timeout: 300_000 },
  async () => {
    const { bare, gitEnv, macRepo } = githubRepo();
    const bearer = cloud.state.chats.addPerson("user-36");
    cloud.state.chats.engineLogins.set("user-36", {
      "claude-agent": { vault_key: true, signed_in_on: [] },
    });
    const mac = await runtime("mac", {
      ...gitEnv,
      MOVES_CLOUD_URL: cloud.url,
      MOVES_BEARER: bearer,
    });
    await mac.client.call("settings.set", {
      request_id: "moves-on",
      settings: { sync_chats: true },
    });
    const away = await box(bare, "Box thirty-six", "user-36");
    const w = await mac.client.call("workspace.create", {
      request_id: "w36",
      repo: { path: macRepo },
      title: "No files copied",
      engine: "claude-agent",
      options: { model: MODEL, access: "full" },
      task: { text: "remember chi" },
    });
    const sessionId = w.session_id;
    await waitReply(mac, sessionId, /smoke ok: remember chi/);
    fs.writeFileSync(path.join(w.root_path!, "draft.txt"), "only here\n");
    await say(mac, sessionId, "remember psi");
    await waitReply(mac, sessionId, /smoke ok: remember psi/);
    await until(
      async () =>
        cloud.state.chats.sessions.get(sessionId)?.lease === null &&
        (cloud.state.chats.copyOf(sessionId).at(-1)?.cursor ?? 0) ===
          (await transcript(mac, sessionId)).at(-1)?.cursor,
      30_000,
    );
    // Its copy names no work in progress at all (as one from before any snapshot did): a move from it would be a clean clone.
    const copied = cloud.state.chats.sessions.get(sessionId)!;
    copied.segments = copied.segments.map((x) => {
      const body = { ...x.body, wip: null };
      delete (body as { wip_bundle?: string }).wip_bundle;
      const json = Buffer.from(JSON.stringify(body));
      return { ...x, body, raw: x.gzip ? gzipSync(json) : json };
    });
    mac.child.kill("SIGSTOP");
    try {
      for (const r of cloud.state.chats.link?.runtimesOf(copied.computer_id) ?? [])
        cloud.state.chats.lastHeartbeat.delete(r);
      expect(
        await personCall(bearer, "POST", `chats/${sessionId}/move`, { to: "cloud" }),
      ).toMatchObject({ status: 200 });
      const move = [...cloud.state.chats.moves.values()].find(
        (m) => m.session_id === sessionId && m.committed,
      )!;
      await until(() => move.answers.some((a) => a.phase === "adopt" && !a.ok), 90_000);
      expect(move.answers.find((a) => a.phase === "adopt")?.message).toContain(
        "has no work in progress",
      );
      expect(move.reassigned).toBe("source");
      expect((await recordOn(away, sessionId))?.session_id).toBeUndefined();
    } finally {
      mac.child.kill("SIGCONT");
    }
    await until(async () => (await recordOn(mac, sessionId))?.computer.kind === "this_mac", 90_000);
    expect(fs.readFileSync(path.join(w.root_path!, "draft.txt"), "utf8")).toBe("only here\n");
  },
);

withCloudComputers(
  "a Mac woken from a sleep too short for the clock to tell stops saying it is going to sleep within seconds, not a minute after the lid (H1)",
  { timeout: 120_000 },
  async () => {
    const bearer = cloud.state.chats.addPerson("user-35");
    const mac = await runtime("mac", { MOVES_CLOUD_URL: cloud.url, MOVES_BEARER: bearer });
    await mac.client.call("settings.set", {
      request_id: "moves-on",
      settings: { sync_chats: true, move_to_cloud: true },
    });
    await linked(mac);
    const beats = cloud.state.heartbeats;
    const from = beats.length;
    await mac.client.call("cloud.suspend", { request_id: "lid", budget_ms: 2_000 });
    const marked = beats.slice(from).find((h) => h.suspending === true)!;
    expect(marked).toBeDefined();
    const runtimeId = cloud.state.tokens.get(marked.token)!.runtimeId;
    const mine = (h: (typeof beats)[number]) =>
      cloud.state.tokens.get(h.token)?.runtimeId === runtimeId;
    // Asleep 10 s: under the 20 s gap a pass reads as a wake by itself.
    mac.child.kill("SIGSTOP");
    await new Promise((r) => setTimeout(r, 10_000));
    const at = beats.length;
    const woke = Date.now();
    mac.child.kill("SIGCONT");
    // Awake: Cloud hears so at its next pass (it no longer counts the Mac asleep, so a phone's send waits for it here).
    await until(() => beats.slice(at).some((h) => mine(h) && h.suspending !== true), 20_000);
    expect(Date.now() - woke).toBeLessThan(15_000);
  },
);

withCloudComputers(
  "a Mac whose lid opens again within seconds stops saying it is going to sleep as soon as the person sends from it, though its clock saw no sleep (H1)",
  { timeout: 180_000 },
  async () => {
    const { gitEnv, macRepo } = githubRepo();
    const bearer = cloud.state.chats.addPerson("user-36");
    const mac = await runtime("mac", {
      ...gitEnv,
      MOVES_CLOUD_URL: cloud.url,
      MOVES_BEARER: bearer,
    });
    await mac.client.call("settings.set", {
      request_id: "moves-on",
      settings: { sync_chats: true, move_to_cloud: true },
    });
    const w = await mac.client.call("workspace.create", {
      request_id: "w36",
      repo: { path: macRepo },
      title: "Back at once",
      engine: "claude-agent",
      options: { model: MODEL, access: "full" },
      task: { text: "remember chi" },
    });
    await waitReply(mac, w.session_id, /smoke ok: remember chi/);
    await linked(mac);
    const beats = cloud.state.heartbeats;
    const from = beats.length;
    await mac.client.call("cloud.suspend", { request_id: "lid", budget_ms: 2_000 });
    const marked = beats.slice(from).find((h) => h.suspending === true)!;
    expect(marked).toBeDefined();
    const runtimeId = cloud.state.tokens.get(marked.token)!.runtimeId;
    const mine = (h: (typeof beats)[number]) =>
      cloud.state.tokens.get(h.token)?.runtimeId === runtimeId;
    // Asleep 3 s (or the lid only half closed): too short for the wake watch to tell from its ticks.
    mac.child.kill("SIGSTOP");
    await new Promise((r) => setTimeout(r, 3_000));
    mac.child.kill("SIGCONT");
    // The person sends from this Mac: Cloud hears within seconds that it is awake, not a minute after the lid (until
    // then Cloud counts it asleep, and moves a chat off it for a phone's send).
    const at = beats.length;
    const sent = Date.now();
    await mac.client.call("turn.submit", {
      request_id: "back",
      session_id: w.session_id,
      kind: "followup",
      input: { text: "remember psi" },
    });
    await until(() => beats.slice(at).some((h) => mine(h) && h.suspending !== true), 15_000);
    expect(Date.now() - sent).toBeLessThan(10_000);
  },
);

withCloudComputers(
  "work in progress past what a segment holds moves as checked chunks of the copy: 30 MiB committed and never pushed lands byte for byte, Mac to Cloud and back, three times (AC-08)",
  { timeout: 420_000 },
  async () => {
    const { bare, gitEnv, macRepo } = githubRepo();
    const bearer = cloud.state.chats.addPerson("user-36");
    cloud.state.chats.engineLogins.set("user-36", {
      "claude-agent": { vault_key: true, signed_in_on: [] },
    });
    const mac = await runtime("mac", {
      ...gitEnv,
      MOVES_CLOUD_URL: cloud.url,
      MOVES_BEARER: bearer,
    });
    await mac.client.call("settings.set", {
      request_id: "moves-on",
      settings: { sync_chats: true },
    });
    const away = await box(bare, "Box thirty-six", "user-36");
    const w = await mac.client.call("workspace.create", {
      request_id: "w36",
      repo: { path: macRepo },
      title: "Large files",
      engine: "claude-agent",
      options: { model: MODEL, access: "full" },
      task: { text: "remember chi" },
    });
    const sessionId = w.session_id;
    await waitReply(mac, sessionId, /smoke ok: remember chi/);
    // A small change rides in its segment as before: no chunk calls.
    fs.writeFileSync(path.join(w.root_path!, "small.txt"), "small\n");
    await say(mac, sessionId, "remember psi");
    await waitReply(mac, sessionId, /smoke ok: [\s\S]*remember psi/);
    await untilWipHeld(sessionId);
    expect(cloud.state.chats.blobCalls.filter((c) => c.session_id === sessionId)).toEqual([]);
    // 30 MiB nobody can compress, committed on the Mac and never pushed, beside an uncommitted edit.
    const big = randomBytes(30 * 1024 * 1024);
    fs.writeFileSync(path.join(w.root_path!, "big.bin"), big);
    git(w.root_path!, "add", "big.bin");
    git(w.root_path!, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "large file");
    fs.writeFileSync(path.join(w.root_path!, "small.txt"), "small, edited\n");
    await say(mac, sessionId, "remember omega");
    await waitReply(mac, sessionId, /smoke ok: [\s\S]*remember omega/);
    // The boundary that took it names it by chunks (later ones carry only what changed since, in their segment).
    await until(() => namedBy(sessionId) !== undefined && copyIdle(sessionId), 60_000);
    const named = namedBy(sessionId)!;
    expect(named.wip_ref!.bytes).toBeGreaterThan(30 * 1024 * 1024);
    expect(named.wip_ref!.chunks).toHaveLength(Math.ceil(named.wip_ref!.bytes / (8 * 1024 * 1024)));
    expect(named.wip_bundle).toBeUndefined();
    expect(named.wip_dropped).toBeUndefined();
    const branch = w.branch;
    const there = async () =>
      until(
        async () =>
          (await recordOn(away, sessionId))?.computer.id === away.computerId &&
          (await recordOn(away, sessionId))?.status === "idle",
        120_000,
      );
    const home = async () =>
      until(
        async () =>
          (await recordOn(mac, sessionId))?.computer.kind === "this_mac" &&
          (await recordOn(mac, sessionId))?.status === "idle",
        120_000,
      );
    // The large work in progress never cost the chat its own Claude session: it went beside the chunks.
    expect(segmentsText(sessionId)).not.toContain('"native_dropped":true');
    for (const trip of [1, 2, 3]) {
      await mac.client.call("session.move", {
        request_id: `c${trip}`,
        session_id: sessionId,
        to: { computer_id: away.computerId },
      });
      await there();
      const tree = treeOf(away.workspaceRoot, branch);
      // It resumes its own session there (placed where the box's CLI looks), never only its transcript.
      if (trip === 1) {
        // The record is there a moment before the adopt places the session file (a send waits for the whole adopt).
        await until(() => sessionFileOn(away.claudeDir, tree) !== undefined, 20_000);
        expect(notified(await transcript(away, sessionId), /own session didn't move/)).toBe(false);
      }
      expect(sha256(fs.readFileSync(path.join(tree, "big.bin")))).toBe(sha256(big));
      expect(fs.readFileSync(path.join(tree, "small.txt"), "utf8")).toBe("small, edited\n");
      expect(git(tree, "log", "-1", "--format=%s").trim()).toBe("large file");
      fs.writeFileSync(path.join(tree, `cloud-${trip}.txt`), `trip ${trip}\n`);
      await mac.client.call("session.move", {
        request_id: `m${trip}`,
        session_id: sessionId,
        to: "this_mac",
      });
      await home();
      expect(sha256(fs.readFileSync(path.join(w.root_path!, "big.bin")))).toBe(sha256(big));
      expect(fs.readFileSync(path.join(w.root_path!, `cloud-${trip}.txt`), "utf8")).toBe(
        `trip ${trip}\n`,
      );
      expect(git(w.root_path!, "log", "-1", "--format=%s").trim()).toBe("large file");
    }
    // Every chunk went up once (one Cloud holds already is not sent again), and each was read back checked.
    const calls = cloud.state.chats.blobCalls.filter((c) => c.session_id === sessionId);
    const puts = calls.filter((c) => c.method === "PUT" && c.status === 204).map((c) => c.sha);
    expect(new Set(puts).size).toBe(puts.length);
    expect(calls.some((c) => c.method === "GET" && c.status === 200)).toBe(true);
    expect(calls.filter((c) => c.status >= 400 && c.method !== "HEAD")).toEqual([]);
    await say(mac, sessionId, "history?");
    expect(
      replies(await waitReply(mac, sessionId, /smoke ok: [\s\S]*history\?/, 60_000)).at(-1),
    ).toContain("remember omega");
    for (const log of [mac.log, away.log])
      expect(fs.readFileSync(log, "utf8")).not.toMatch(/a pass failed|could not be fetched/);
  },
);

withCloudComputers(
  "a chunk of a copy that is not what was copied is refused where it lands: the chat goes back to its Mac, its files as they were, and says why (AC-08)",
  { timeout: 300_000 },
  async () => {
    const { bare, gitEnv, macRepo } = githubRepo();
    const bearer = cloud.state.chats.addPerson("user-37");
    cloud.state.chats.engineLogins.set("user-37", {
      "claude-agent": { vault_key: true, signed_in_on: [] },
    });
    const mac = await runtime("mac", {
      ...gitEnv,
      MOVES_CLOUD_URL: cloud.url,
      MOVES_BEARER: bearer,
    });
    await mac.client.call("settings.set", {
      request_id: "moves-on",
      settings: { sync_chats: true },
    });
    const away = await box(bare, "Box thirty-seven", "user-37");
    const w = await mac.client.call("workspace.create", {
      request_id: "w37",
      repo: { path: macRepo },
      title: "Checked",
      engine: "claude-agent",
      options: { model: MODEL, access: "full" },
      task: { text: "remember alpha" },
    });
    const sessionId = w.session_id;
    await waitReply(mac, sessionId, /smoke ok: remember alpha/);
    const big = randomBytes(12 * 1024 * 1024);
    fs.writeFileSync(path.join(w.root_path!, "big.bin"), big);
    await say(mac, sessionId, "remember beta");
    await waitReply(mac, sessionId, /smoke ok: [\s\S]*remember beta/);
    await until(() => namedBy(sessionId) !== undefined && copyIdle(sessionId), 60_000).catch(
      (error: Error) => {
        const held = cloud.state.chats.sessions.get(sessionId);
        const segments = (held?.segments ?? []).map((s) => [
          s.boundary,
          (s.body as Boundary).wip ?? null,
          (s.body as Boundary).wip_ref?.chunks.length ?? null,
          (s.body as Boundary).wip_dropped ?? null,
          typeof (s.body as Boundary).wip_bundle,
        ]);
        const blobs = cloud.state.chats.blobCalls
          .filter((c) => c.session_id === sessionId)
          .map((c) => [c.method, c.status, c.sha.slice(0, 12)]);
        throw new Error(
          `${error.message}: lease ${JSON.stringify(held?.lease ?? null)}, segments ${JSON.stringify(segments)}, blobs ${JSON.stringify(blobs)}, log ${mac.log}`,
        );
      },
    );
    // Cloud's store hands back other bytes for one chunk.
    const ref = namedBy(sessionId)!.wip_ref!;
    cloud.state.chats.tamperBlobs.add(ref.chunks[1]!);
    onTestFinished(() => void cloud.state.chats.tamperBlobs.delete(ref.chunks[1]!));
    await mac.client.call("session.move", {
      request_id: "m37",
      session_id: sessionId,
      to: { computer_id: away.computerId },
    });
    // The box refuses it for good (no other Cloud computer gets it); back on the Mac, never ownerless, saying why.
    const move = () =>
      [...cloud.state.chats.moves.values()].find((m) => m.session_id === sessionId && m.committed);
    await until(
      () => (move()?.answers.filter((a) => a.phase === "adopt").length ?? 0) === 2,
      90_000,
    );
    expect(
      move()!
        .answers.filter((a) => a.phase === "adopt")
        .map((a) => [a.ok, a.code]),
    ).toEqual([
      [false, "cave_code_copy_not_movable"],
      [true, undefined],
    ]);
    expect(move()!.answers.find((a) => a.phase === "adopt" && !a.ok)?.message).toMatch(
      /couldn't be checked: a chunk of its work in progress is not what was copied/,
    );
    expect(move()!.reassigned).toBe("source");
    await until(
      async () =>
        (await recordOn(mac, sessionId))?.computer.kind === "this_mac" &&
        (await recordOn(mac, sessionId))?.status === "idle",
      60_000,
    );
    // The note follows Cloud hearing that the Mac has the chat again, a round trip after the chat is back and idle.
    await until(
      async () =>
        notified(
          await transcript(mac, sessionId),
          /Back on this computer[\s\S]*couldn't be checked/,
        ),
      30_000,
    );
    expect(fs.readFileSync(path.join(w.root_path!, "big.bin")).equals(big)).toBe(true);
    expect((await recordOn(away, sessionId))?.session_id).toBeUndefined();
    await say(mac, sessionId, "history?");
    expect(
      replies(await waitReply(mac, sessionId, /smoke ok: [\s\S]*history\?/, 60_000)).at(-1),
    ).toContain("remember beta");
  },
);

withCloudComputers(
  "work in progress written mid-turn goes up as chunks with the lid's last copy and lands byte for byte; a move back from Cloud with a large file made there does the same (AC-08)",
  { timeout: 360_000 },
  async () => {
    const { bare, gitEnv, macRepo } = githubRepo();
    const bearer = cloud.state.chats.addPerson("user-38");
    cloud.state.chats.engineLogins.set("user-38", {
      "claude-agent": { vault_key: true, signed_in_on: [] },
    });
    const mac = await runtime("mac", {
      ...gitEnv,
      MOVES_CLOUD_URL: cloud.url,
      MOVES_BEARER: bearer,
    });
    await mac.client.call("settings.set", {
      request_id: "moves-on",
      settings: { sync_chats: true },
    });
    const home = await box(bare, "Box thirty-eight", "user-38");
    const w = await mac.client.call("workspace.create", {
      request_id: "w38",
      repo: { path: macRepo },
      title: "Large at the lid",
      engine: "claude-agent",
      options: { model: MODEL, access: "full" },
      task: { text: "remember mu" },
    });
    const sessionId = w.session_id;
    await waitReply(mac, sessionId, /smoke ok: remember mu/);
    await until(() => segmentsText(sessionId).length > 0 && copyIdle(sessionId), 30_000);
    await say(mac, sessionId, "slow 60000: still going");
    await until(async () => (await recordOn(mac, sessionId))?.status === "working", 30_000);
    // Written mid-turn, after the last boundary: only the lid's last copy can carry it.
    const big = randomBytes(12 * 1024 * 1024);
    fs.writeFileSync(path.join(w.root_path!, "big.bin"), big);
    expect(namedBy(sessionId)).toBeUndefined();
    expect(await onLidClose(mac.client, () => `lid:${randomUUID()}`, 15_000)).toEqual({
      moving: 1,
      paused: 0,
    });
    await until(
      async () =>
        (await recordOn(home, sessionId))?.computer.id === home.computerId &&
        (await recordOn(home, sessionId))?.status === "idle",
      120_000,
    );
    const named = namedBy(sessionId)!;
    expect(named.wip_ref!.bytes).toBeGreaterThan(12 * 1024 * 1024);
    expect(named.wip_dropped).toBeUndefined();
    const tree = treeOf(home.workspaceRoot, w.branch);
    expect(sha256(fs.readFileSync(path.join(tree, "big.bin")))).toBe(sha256(big));
    expect(notified(await transcript(home, sessionId), /own session didn't move/)).toBe(false);
    // Made on Cloud after its last turn, then the Mac asks for the chat back: Cloud's last copy puts it up the same way.
    const made = randomBytes(10 * 1024 * 1024);
    fs.writeFileSync(path.join(tree, "made-on-cloud.bin"), made);
    await mac.client.call("session.move", {
      request_id: "back38",
      session_id: sessionId,
      to: "this_mac",
    });
    await until(
      async () =>
        (await recordOn(mac, sessionId))?.computer.kind === "this_mac" &&
        (await recordOn(mac, sessionId))?.status === "idle",
      120_000,
    );
    expect(namedBy(sessionId)!.wip_ref!.sha256).not.toBe(named.wip_ref!.sha256);
    expect(sha256(fs.readFileSync(path.join(w.root_path!, "made-on-cloud.bin")))).toBe(
      sha256(made),
    );
    expect(sha256(fs.readFileSync(path.join(w.root_path!, "big.bin")))).toBe(sha256(big));
    // A turn ran on Cloud: the Mac's own session carries on, told what it missed (its file is as the lid's last copy
    // read it), or the chat hands over its transcript (the stopped CLI wrote to it after): either way, its history.
    await say(mac, sessionId, "history?");
    expect(
      replies(await waitReply(mac, sessionId, /^smoke ok: history: [^\n]*remember mu/, 60_000)).at(
        -1,
      ),
    ).toContain("remember mu");
  },
);

withCloudComputers(
  "a Claude Agent chat whose session file and work in progress each fit a segment but not both, on a Cloud without chunks, moves with its work and continues from its transcript",
  { timeout: 300_000 },
  async () => {
    // A Cloud without the copy's chunk routes (AC-08): the work in progress rides in the boundary's segment or not at all.
    cloud.state.chats.blobsOff = true;
    onTestFinished(() => void (cloud.state.chats.blobsOff = false));
    const { bare, gitEnv, macRepo } = githubRepo();
    const bearer = cloud.state.chats.addPerson("user-40");
    cloud.state.chats.engineLogins.set("user-40", {
      "claude-agent": { vault_key: true, signed_in_on: [] },
    });
    const mac = await runtime("mac", {
      ...gitEnv,
      MOVES_CLOUD_URL: cloud.url,
      MOVES_BEARER: bearer,
    });
    await mac.client.call("settings.set", {
      request_id: "moves-on",
      settings: { sync_chats: true },
    });
    const away = await box(bare, "Box forty", "user-40");
    const w = await mac.client.call("workspace.create", {
      request_id: "w40",
      repo: { path: macRepo },
      title: "Both halves",
      engine: "claude-agent",
      options: { model: MODEL, access: "full" },
      task: { text: "remember tau" },
    });
    const sessionId = w.session_id;
    await waitReply(mac, sessionId, /smoke ok: remember tau/);
    // That turn's boundary has landed, so the next one carries both halves.
    await until(
      () =>
        (cloud.state.chats.sessions.get(sessionId)?.segments ?? []).some((s) => s.boundary) &&
        copyIdle(sessionId),
      30_000,
    );
    await until(() => sessionFileOn(mac.claudeDir, w.root_path!) !== undefined, 20_000);
    // Gzipped, about 4.5 MiB of new session file and 4 MiB of work in progress: each fits an 8 MiB segment, not both.
    fs.appendFileSync(
      sessionFileOn(mac.claudeDir, w.root_path!)!,
      `${JSON.stringify({ type: "summary", uuid: randomUUID(), summary: randomBytes(4.5 * 1024 * 1024).toString("base64") })}\n`,
    );
    const big = randomBytes(4 * 1024 * 1024);
    // Written once the running turn's copies have its answer and nothing more comes until it ends: a running turn's copy
    // carries the work in progress inline when it fits (decision 25), and the boundary would then hold only the session
    // file. Written here, only the boundary gets it, so both halves meet there.
    await say(mac, sessionId, "slow 20000: remember upsilon");
    await until(
      async () =>
        segmentsText(sessionId).includes("smoke ok: remember upsilon") &&
        (await recordOn(mac, sessionId))?.status === "working",
      19_000,
    );
    fs.writeFileSync(path.join(w.root_path!, "big.bin"), big);
    await waitReply(mac, sessionId, /smoke ok: [\s\S]*remember upsilon/);
    // The copy keeps the work in progress and goes without the session file, never the other way round.
    const boundaryLanded = () =>
      copyIdle(sessionId) &&
      segmentsText(sessionId).includes("smoke ok: remember upsilon") &&
      (segmentsText(sessionId).includes('"native_dropped":true') ||
        lastBoundary(sessionId)?.wip_dropped === true);
    await until(boundaryLanded, 30_000).catch((error: Error) => {
      const segments = cloud.state.chats.sessions.get(sessionId)?.segments ?? [];
      throw new Error(
        `${error.message}: idle ${copyIdle(sessionId)}, segments ${JSON.stringify(segments.map((s) => [s.boundary, s.raw.length, (s.body as Boundary).wip_dropped ?? null, typeof (s.body as Boundary).wip_bundle]))}, log ${mac.log}`,
      );
    });
    expect(lastBoundary(sessionId)?.wip_dropped).toBeUndefined();
    expect(typeof lastBoundary(sessionId)?.wip_bundle).toBe("string");
    expect(segmentsText(sessionId)).toContain('"native_dropped":true');
    // The move card says it before it goes: a handoff, its session too big to copy (decision 28).
    expect(
      (
        await mac.client.call("session.move.check", {
          session_id: sessionId,
          to: { computer_id: away.computerId },
        })
      ).preflight?.context,
    ).toEqual({ mode: "handoff", why: "over_cap" });
    await mac.client.call("session.move", {
      request_id: "m40",
      session_id: sessionId,
      to: { computer_id: away.computerId },
    });
    await until(
      async () =>
        (await recordOn(away, sessionId))?.computer.id === away.computerId &&
        (await recordOn(away, sessionId))?.status === "idle",
      120_000,
    );
    expect(
      sha256(fs.readFileSync(path.join(treeOf(away.workspaceRoot, w.branch), "big.bin"))),
    ).toBe(sha256(big));
    await waitNotified(away, sessionId, /Claude Agent's own session didn't move with this chat/);
    await say(away, sessionId, "history?");
    expect(
      replies(
        await waitReply(away, sessionId, /^smoke ok: history: [^\n]*remember upsilon/, 90_000),
      ).at(-1),
    ).toContain("remember tau");
 // What the new session there was handed: upstream budgeted selection of whole items, saying how many it left out and
    // naming thread_read for them, never items cut to a length (decision 28).
    const handed = fs
      .readFileSync(path.join(path.dirname(away.log), "claude-trace.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map(
        (l) =>
          JSON.parse(l) as {
            what: string;
            frame: { type?: string; message?: { content?: unknown } };
          },
      );
    const said = handed
      .filter((t) => t.what === "in" && t.frame.type === "user")
      .map((t) => JSON.stringify(t.frame.message?.content ?? ""));
    expect(
      said.some(
        (text) =>
          /Selected \d+ intact items; omitted \d+ items/.test(text) && text.includes("thread_read"),
      ),
    ).toBe(true);
  },
);

withCloudComputers(
  "a chat whose move off a Cloud computer failed comes back to it in a worktree of its own when another chat took the checkout meanwhile, never into that chat's checkout",
  { timeout: 360_000 },
  async () => {
    const { bare, gitEnv, macRepo } = githubRepo();
    const bearer = cloud.state.chats.addPerson("user-39");
    cloud.state.chats.engineLogins.set("user-39", {
      "claude-agent": { vault_key: true, signed_in_on: [] },
    });
    const mac = await runtime("mac", {
      ...gitEnv,
      MOVES_CLOUD_URL: cloud.url,
      MOVES_BEARER: bearer,
    });
    await mac.client.call("settings.set", {
      request_id: "moves-on",
      settings: { sync_chats: true },
    });
    const away = await box(bare, "Box thirty-nine", "user-39");
    const w = await mac.client.call("workspace.create", {
      request_id: "w39",
      repo: { path: macRepo },
      title: "Back to its box",
      engine: "claude-agent",
      options: { model: MODEL, access: "full" },
      task: { text: "remember nu" },
    });
    const sessionId = w.session_id;
    await waitReply(mac, sessionId, /smoke ok: remember nu/);
    await until(() => segmentsText(sessionId).length > 0 && copyIdle(sessionId), 30_000);
    await mac.client.call("session.move", {
      request_id: "m39",
      session_id: sessionId,
      to: { computer_id: away.computerId },
    });
    await until(
      async () =>
        (await recordOn(away, sessionId))?.computer.id === away.computerId &&
        (await recordOn(away, sessionId))?.status === "idle",
      120_000,
    );
    // Its first chat, in the box's checkout; a large file it made there goes into its copy as chunks, the box's own.
    const root = realpath(away.workspaceRoot);
    expect(realpath(treeOf(away.workspaceRoot, w.branch))).toBe(root);
    const big = randomBytes(12 * 1024 * 1024);
    fs.writeFileSync(path.join(away.workspaceRoot, "big.bin"), big);
    await say(away, sessionId, "remember xi");
    await waitReply(away, sessionId, /smoke ok: [\s\S]*remember xi/, 60_000);
    // (A Cloud computer holds its chats' leases: its copy is never idle.)
    await until(() => namedBy(sessionId) !== undefined, 60_000);
    // The Mac asks for it and cannot read it; Cloud hands it back to the box, whose reads wait until another chat holds its checkout.
    const macComputer = (await mac.client.call("cloud.status", {})).computer_id!;
    let open = () => {};
    cloud.state.chats.segmentReadsDownOn = macComputer;
    cloud.state.chats.segmentReadsHeldOn = {
      computer: away.computerId,
      until: new Promise((resolve) => (open = () => resolve(undefined))),
    };
    onTestFinished(() => {
      open();
      cloud.state.chats.segmentReadsDownOn = undefined;
      cloud.state.chats.segmentReadsHeldOn = undefined;
    });
    const pulled = mac.client
      .call("session.move", { request_id: "back39", session_id: sessionId, to: "this_mac" })
      .catch(() => undefined);
    const move = () =>
      [...cloud.state.chats.moves.values()].find(
        (m) => m.session_id === sessionId && m.committed && m.target !== away.computerId,
      );
    await until(() => move()?.reassigned === "source", 90_000);
    cloud.state.chats.segmentReadsDownOn = undefined;
    const other = await away.client.call("workspace.create", {
      request_id: "w39b",
      repo: { url: `https://github.com/${GITHUB}` },
      title: "Another chat",
      engine: "claude-agent",
      options: { model: MODEL, access: "full" },
      task: { text: "remember omicron" },
    });
    // A chat started on the box hears first that it booted without a snapshot.
    await waitReply(away, other.session_id, /smoke ok: [\s\S]*remember omicron/, 60_000);
    expect(realpath(treeOf(away.workspaceRoot, other.branch))).toBe(root);
    open();
    await pulled;
    // Back on the box in a worktree of its own, with its work; the other chat keeps the checkout.
    await until(
      async () =>
        (await recordOn(away, sessionId))?.computer.id === away.computerId &&
        (await recordOn(away, sessionId))?.status === "idle",
      120_000,
    );
    const tree = treeOf(away.workspaceRoot, w.branch);
    expect(realpath(tree)).not.toBe(root);
    expect(sha256(fs.readFileSync(path.join(tree, "big.bin")))).toBe(sha256(big));
    expect(realpath(treeOf(away.workspaceRoot, other.branch))).toBe(root);
    await say(away, sessionId, "history?");
    expect(
      replies(await waitReply(away, sessionId, /smoke ok: [\s\S]*history\?/, 60_000)).at(-1),
    ).toContain("remember xi");
    // The other chat still runs in the checkout.
    await say(away, other.session_id, "still here?");
    await waitReply(away, other.session_id, /smoke ok: [\s\S]*still here\?/, 60_000);
  },
);
