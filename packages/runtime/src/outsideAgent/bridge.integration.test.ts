// The tools against the real runtime (the Session Protocol server, its gate, projector and journal; the fake `claude`
// answers every turn), as `caveman-code mcp` reaches it: what chat_read's images view says about the images a person
// attached, as workspace.digest's pages carry them.
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import { PNG as Png } from "pngjs";
import { afterAll, beforeAll, expect, test } from "vitest";

import {
  createReady,
  makeConfig,
  makeRepo,
  MODEL,
  startRuntime,
  tempRoot,
  until,
} from "../session-protocol/testHarness.ts";
import { Bridge } from "./bridge.ts";
import type { AgentLink } from "./connection.ts";

let root: string;
let repo: string;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let owner: ReturnType<typeof connect>;
let agent: ReturnType<typeof connect>;
let bridge: Bridge;

/** A real PNG of noise: it barely compresses, so its file is about 4 bytes a pixel. */
const noise = (width: number, height: number) => {
  const image = new Png({ width, height });
  image.data = randomBytes(width * height * 4);
  for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255;
  return Png.sync.write(image).toString("base64");
};

const isPng = (data: string) => {
  try {
    Png.sync.read(Buffer.from(data, "base64"));
    return true;
  } catch {
    return false;
  }
};

beforeAll(async () => {
  root = tempRoot("oa-bridge-");
  repo = makeRepo(root, { "README.md": "hello\n" });
  runtime = await startRuntime(await makeConfig(), "fake-claude");
  owner = connect(runtime.url, runtime.token);
  await owner.call("project.create", { request_id: "p1", path: repo });
  // Every socket of this client is the agent's before anything else goes out on it (the bridge's handshake).
  agent = connect(runtime.url, runtime.token, undefined, {
    handshake: async (link) =>
      void (await link.call("outside_agent.become", { agent_id: randomUUID(), name: "Grok" })),
  });
  const link: AgentLink = {
    acquire: async () => ({
      ok: true,
      session: { client: agent, agent: { name: "Grok", level: "supervised" } },
    }),
    onWorkspace: () => () => undefined,
    onReady: () => () => undefined,
    close: () => agent.close(),
  };
  bridge = new Bridge({ link, cwd: repo });
});
afterAll(async () => {
  agent.close();
  owner.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("chat_read images shows an attached screenshot whole, says one the journal keeps by name only is too large to show, and never sends one cut", async () => {
  const w = await createReady(owner, {
    request_id: "c1",
    repo: { path: repo },
    engine: "claude-agent",
    options: { model: MODEL, access: "full" },
  });
  const events: Array<SessionEvent> = [];
  const attached = await owner.attach(w.session_id, 0, (event) => events.push(event));
  const done = () => events.filter((e) => e.type === "turn.done");
  const attach = async (name: string, data: string) => {
    const turns = done().length;
    await owner.call("turn.submit", {
      request_id: `t-${name}`,
      session_id: w.session_id,
      kind: "followup",
      input: {
        text: `look at ${name}`,
        attachments: [{ type: "image", name, mime_type: "image/png", data }],
      },
    });
    await until(() => done().length > turns, 60_000);
    expect(done().at(-1)?.payload).toEqual({ status: "completed" });
  };
  const small = noise(20, 20);
  const shot = noise(256, 256);
  const images = async () => {
    const answer = await bridge.call(
      "chat_read",
      { chat: w.id, view: "images", limit: 8 },
      { clientName: "claude-code" },
    );
    const shown = (answer.images ?? []).map((image) =>
      image.data === small
        ? "small.png"
        : image.data === shot
          ? "shot.png"
          : `an image of ${image.data.length} base64 characters${image.mime === "image/png" && isPng(image.data) ? "" : ", cut"}`,
    );
    return { text: answer.text, shown };
  };

  // A small screenshot rides in the journal and on the page whole: it is shown as it was sent.
  await attach("small.png", small);
  expect((await images()).shown).toEqual(["small.png"]);

  // A 2 MB photo: the journal keeps an image over 1 MB by name only, so no page carries its bytes.
  await attach("photo.png", noise(720, 720));
  const withPhoto = await images();
  expect(withPhoto.shown).toEqual(["small.png"]);
  expect(withPhoto.text).toContain("(1 more too large to show)");

  // A 260 KB screenshot rides in the journal, and its event is over the 64 KB page: the page cuts the event's text,
  // never the image's bytes, so it is shown as it was sent.
  await attach("shot.png", shot);
  const withShot = await images();
  expect(withShot.shown).toEqual(["shot.png", "small.png"]);
  expect(withShot.text).toContain("(1 more too large to show)");
  await attached.detach();
}, 180_000);
