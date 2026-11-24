// A chat's place on a Cloud computer is Cloud's to give (CONTRACT §6.3): real Cloud computers' runtimes against the
// stand-in Cloud, with the tools container's exec channel and the stand-in Claude CLI (no model). A chat says which
// workspace Cloud placed for it (placed_workspace_id) and takes up exactly that one; a builder a lead starts here says
// nobody placed it and needs a free place by Cloud's count; a computer that turns a builder away as full tells Cloud its
// room first, and the builder is placed again elsewhere without its lead hearing a failure. Cloud's own half is
// control-api's project_computers_placement_test.go; both together on a real stack are projectComputers.e2e.test.ts.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { SessionEvent, Workspace } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import { afterEach, expect, test } from "vitest";

import { BRANCH_TRAILER, MAX_PLACED_AGAIN } from "../session-protocol/builders.ts";
import { COMPUTER_FULL } from "../session-protocol/capacity.ts";
import { createReady, makeRepo, MODEL, tempRoot, until } from "../session-protocol/testHarness.ts";
import { builderKit, refusalOf, userTexts, type TestCloud } from "./builders.kit.ts";
import { startTestCloud } from "./testCloud.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const { startTools, githubWith, checkoutOf, computerRuntime, delegate } = builderKit(cleanups);

const REPO = { url: "https://github.com/acme/widgets" };
const FULL = `invalid_state/builders: ${COMPUTER_FULL}`;

async function cloudWithGitHub() {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  await startTools();
  cleanups.push(
    () => (
      delete process.env.CAVEMAN_COMPUTER_CPUS,
      delete process.env.CAVEMAN_COMPUTER_MEMORY_GIB
    ),
  );
  cloud.state.gitBackend = githubWith(
    makeRepo(tempRoot("placement-source-"), { "README.md": "widgets\n" }),
  );
  return cloud;
}

/** A Cloud computer of `cpus` x `gib`, once Cloud has heard the chats it holds (a runtime reads its size once, when it first measures). */
async function computerOf(cloud: TestCloud, name: string, cpus: number, gib: number) {
  process.env.CAVEMAN_COMPUTER_CPUS = String(cpus);
  process.env.CAVEMAN_COMPUTER_MEMORY_GIB = String(gib);
  const computer = await computerRuntime(
    cloud,
    checkoutOf(cloud.state.gitBackend!, `placement-${name}-`),
    name,
  );
  await until(
    () => cloud.state.tree.capacityOf?.(computer.identity.computerId) !== undefined,
    30_000,
  );
  return computer;
}

const chat = (title: string, extra: { placed_workspace_id?: string } = {}) => ({
  request_id: title,
  repo: REPO,
  title,
  engine: "claude-agent" as const,
  options: { model: MODEL },
  ...extra,
});
/** What a chat's registrations said of its placement, in order. */
const asked = (cloud: TestCloud, sessionId: string) =>
  cloud.state.chats.placedAsked
    .filter((a) => a.session_id === sessionId)
    .map((a) => `${a.by}:${a.placed}`);

test.skipIf(process.platform === "win32")(
  "a chat takes up exactly the workspace Cloud placed for it: two started at the same instant each take their own, a builder started here says nobody placed it, and a chat that names none is matched as before",
  async () => {
    const cloud = await cloudWithGitHub();
    const { client, builders, identity } = await computerOf(cloud, "placed", 16, 64);
    const placements = cloud.state.chats.placements;
    // As a person's client has Cloud place them (POST workspaces): two chats of one repository, on this computer.
    const [first, second] = [randomUUID(), randomUUID()];
    for (const id of [first, second]) placements.set(id, { computer_id: identity.computerId });

    // Both start at once, each naming its own; the one placed second asks first.
    const [b, a] = await Promise.all([
      createReady(client, chat("Second", { placed_workspace_id: second })),
      createReady(client, chat("First", { placed_workspace_id: first })),
    ]);
    const session = (w: Workspace) => cloud.state.chats.sessions.get(w.session_id);
    expect([session(a)?.workspace_id, session(b)?.workspace_id]).toEqual([first, second]);
    expect([placements.get(first)?.taken, placements.get(second)?.taken]).toEqual([
      a.session_id,
      b.session_id,
    ]);
    // Asked once, before anything was made, by the registration: no summary names it again.
    expect([asked(cloud, a.session_id), asked(cloud, b.session_id)]).toEqual([
      [`register:${first}`],
      [`register:${second}`],
    ]);

    // A builder its lead starts on this computer: nobody placed it, and it says so (it must not take a waiting placement).
    const waiting = randomUUID();
    placements.set(waiting, { computer_id: identity.computerId });
    const built = await delegate(builders, b, "k1", "Part one");
    expect(built?.where).toBe("here");
    const child = (await client.call("workspace.list", { parent_workspace_id: b.id }))
      .workspaces[0]!;
    expect(asked(cloud, child.session_id)).toEqual(["register:"]);
    expect(placements.get(waiting)?.taken).toBeUndefined();

    // A workspace placed on another computer (a client's stale word): Cloud answers that it is not here (404), and the
    // chat registers as one nobody placed. Nothing of the other computer's is taken.
    const elsewhere = randomUUID();
    placements.set(elsewhere, { computer_id: randomUUID() });
    const stale = await createReady(client, chat("Stale", { placed_workspace_id: elsewhere }));
    expect(asked(cloud, stale.session_id)).toEqual([`register:${elsewhere}`, "register:"]);
    expect(session(stale)?.workspace_id).not.toBe(elsewhere);
    expect(placements.get(elsewhere)?.taken).toBeUndefined();

    // A placement taken already (the same start sent twice under another request): the second chat is one of its own.
    const twice = await createReady(client, chat("Twice", { placed_workspace_id: first }));
    expect(asked(cloud, twice.session_id)).toEqual([`register:${first}`]);
    expect(session(twice)?.workspace_id).not.toBe(first);
    expect(placements.get(first)?.taken).toBe(a.session_id);

    // A client from before the field, and one whose word is no workspace id: nothing is said, and the chat's first
    // summary registers it as before (Cloud takes the oldest placement of its repository, here the one still waiting).
    const older = await createReady(client, chat("Older"));
    const garbled = await createReady(
      client,
      chat("Garbled", { placed_workspace_id: "not-an-id" }),
    );
    await until(() => session(older) !== undefined && session(garbled) !== undefined, 30_000);
    expect([asked(cloud, older.session_id), asked(cloud, garbled.session_id)]).toEqual([
      ["summary:absent"],
      ["summary:absent"],
    ]);

    // Nothing the app sent was a body Cloud's strict decoder refuses.
    expect(cloud.state.chats.refused).toEqual([]);
  },
  300_000,
);

test.skipIf(process.platform === "win32")(
  "a computer full by Cloud's count: a chat nobody placed is refused in the computer's own words with nothing made, a placed one starts, and a lead's builder goes to another computer instead",
  async () => {
    const cloud = await cloudWithGitHub();
    const { client, builders, identity, config } = await computerOf(cloud, "counted", 16, 64);
    const lead = await createReady(client, chat("Lead", { placed_workspace_id: "" }));
    expect(asked(cloud, lead.session_id)).toEqual(["register:"]);
    // Cloud counts this computer full, though the computer itself has room: chats Cloud placed here have yet to start.
    cloud.state.chats.fullComputers.add(identity.computerId);
    const placed = randomUUID();
    cloud.state.chats.placements.set(placed, { computer_id: identity.computerId });
    const listed = async () =>
      (await client.call("workspace.list", {})).workspaces.map((w) => w.title).sort();
    const worktrees = () =>
      fs.existsSync(path.join(config.worktreesDir, "chats"))
        ? fs.readdirSync(path.join(config.worktreesDir, "chats"))
        : [];

    // A chat nobody placed (a further run of one start): refused before anything is made.
    expect(
      await refusalOf(
        client.call("workspace.create", chat("Unplaced", { placed_workspace_id: "" })),
      ),
    ).toBe(FULL);
    expect(await listed()).toEqual(["Lead"]);
    expect(worktrees()).toEqual([]);
    expect([...cloud.state.chats.sessions.values()].map((s) => s.session_id)).toEqual([
      lead.session_id,
    ]);

    // The chat Cloud placed here is one of those it counts: it starts.
    const mine = await createReady(client, chat("Placed", { placed_workspace_id: placed }));
    expect(cloud.state.chats.sessions.get(mine.session_id)?.workspace_id).toBe(placed);

    // The lead's builder: this computer has room for it, Cloud has none here. Nothing is made here, no failure is kept,
    // and Cloud places it on another computer.
    const other = randomUUID();
    cloud.state.tree.nextComputers.push(other);
    const built = await delegate(builders, lead, "k1", "Part one");
    expect(built).toMatchObject({ where: "cloud", computerId: other, title: "Part one" });
    expect(cloud.state.tree.spawns.map((s) => s.body.request_id)).toEqual(["builder:k1"]);
    expect(
      (await client.call("workspace.list", { parent_workspace_id: lead.id })).workspaces,
    ).toEqual([]);
    expect(worktrees()).toHaveLength(1);
    expect(await Effect.runPromise(builders.status(built!.workspaceId))).toMatchObject({
      where: "cloud",
      state: "running",
    });
    expect((await Effect.runPromise(builders.tree(`caveman:${lead.id}`))).running).toBe(1);
    // A retry of the delegation is that builder.
    expect((await delegate(builders, lead, "k1", "Part one"))?.workspaceId).toBe(
      built!.workspaceId,
    );
    expect(cloud.state.tree.spawns).toHaveLength(1);
    expect(cloud.state.chats.refused).toEqual([]);
  },
  300_000,
);

test.skipIf(process.platform === "win32")(
  "a Cloud from before the field: the chat starts all the same, registered without it, and the next ones do not ask",
  async () => {
    const cloud = await cloudWithGitHub();
    cloud.state.chats.placedUnknown = true;
    const { client } = await computerOf(cloud, "older-cloud", 16, 64);
    const one = await createReady(client, chat("One", { placed_workspace_id: randomUUID() }));
    await until(() => cloud.state.chats.sessions.has(one.session_id), 30_000);
    // Refused once, for the field (its strict decoder); then registered without it.
    expect(cloud.state.chats.refused.map((r) => r.route)).toEqual(["register"]);
    const two = await createReady(client, chat("Two", { placed_workspace_id: "" }));
    await until(() => cloud.state.chats.sessions.has(two.session_id), 30_000);
    expect(cloud.state.chats.refused).toHaveLength(1);
    expect(cloud.state.chats.placedAsked.map((a) => a.placed)).toEqual(["absent", "absent"]);
  },
  300_000,
);

test.skipIf(process.platform === "win32")(
  "a builder its Cloud computer turns away as full is placed again on another: the computer tells Cloud its room first, Cloud's rows for it are closed, and its lead hears only its result, with the tokens it used",
  async () => {
    const cloud = await cloudWithGitHub();
    // The lead's computer and the one Cloud places on first hold one chat each (2 vCPU x 4 GiB); the third holds three.
    const leadComputer = await computerOf(cloud, "lead", 2, 4);
    const fullComputer = await computerOf(cloud, "full", 2, 4);
    const roomy = await computerOf(cloud, "roomy", 4, 8);
    const tree = cloud.state.tree;
    // A person's chat fills the small one.
    await createReady(fullComputer.client, chat("Fills it"));
    const lead = await createReady(leadComputer.client, chat("Lead"));
    const events: Array<SessionEvent> = [];
    await leadComputer.client.attach(lead.session_id, 0, (event) => events.push(event));

    // Cloud believes the full one has room (it places there once); after that it places by what the computers report.
    tree.nextComputers.push(fullComputer.identity.computerId);
    tree.cells.push(fullComputer.identity.computerId, roomy.identity.computerId);
    const started = await delegate(leadComputer.builders, lead, "k1", "Part one");
    expect(started).toMatchObject({ where: "cloud", computerId: fullComputer.identity.computerId });

    // The full computer turns it away, and the lead's runtime asks Cloud to place it again: the same builder, a new request.
    await until(() => tree.spawns.length === 2, 60_000);
    expect(tree.spawns.map((s) => [s.body.request_id, s.computer])).toEqual([
      ["builder:k1", fullComputer.identity.computerId],
      ["builder:k1:again-1", roomy.identity.computerId],
    ]);
    expect(tree.spawns[1]!.body).toMatchObject({
      title: "Part one",
      brief: "slow 0: Part one",
      branch: tree.spawns[0]!.body.branch,
      engine: "claude-agent",
      model: MODEL,
      lead_session_id: lead.session_id,
    });
    // Cloud heard the full computer's room before it was asked again: that is why the second placement is elsewhere.
    expect(tree.capacityOf?.(fullComputer.identity.computerId)).toEqual({ chats: 1, used: 1 });
    // Cloud's rows for the one turned away: its run failed (none of the lead's builders at work), its chat archived (no place held).
    const [turnedAway, placedAgain] = [...tree.workspaces.values()].filter(
      (w) => w.parent !== null,
    );
    expect(cloud.state.sessions.runStates).toContainEqual({
      workspace: turnedAway!.id,
      run_state: "failed",
    });
    await until(
      () => cloud.state.chats.summaries.get(turnedAway!.session_id)?.archived === true,
      15_000,
    );
    expect(cloud.state.chats.summaries.get(turnedAway!.session_id)).toMatchObject({
      kind: "builder",
      status: "error",
      archived: true,
      computer_id: fullComputer.identity.computerId,
    });
    expect(
      (await fullComputer.client.call("workspace.list", { include_archived: true })).workspaces.map(
        (w) => w.title,
      ),
    ).toEqual(["Fills it"]);

    // The roomy computer runs it, and its result wakes the lead: one builder, finished, never a failure.
    await until(
      () => userTexts(events).some((text) => text.includes('Builder "Part one" finished its turn')),
      90_000,
    );
    expect(userTexts(events).filter((text) => text.includes('Builder "Part one"'))).toHaveLength(1);
    expect(userTexts(events).join("\n")).not.toMatch(/could not start|is full/);
    // The lead's agent may name it by either of its Cloud workspaces.
    await until(
      async () =>
        (await Effect.runPromise(leadComputer.builders.status(placedAgain!.id)))?.state ===
        "completed",
      15_000,
    );
    expect(
      await Effect.runPromise(leadComputer.builders.status(started!.workspaceId)),
    ).toMatchObject({
      where: "cloud",
      state: "completed",
      workspaceId: placedAgain!.id,
      computerId: roomy.identity.computerId,
    });

    // With the branch it pushed, the builder said what its turns used, in the trailer the lead's runtime strips: the
    // lead's tree counts it toward Settings > Agents' ceiling, and no chat shows it.
    const result = tree.mail.find(
      (m) => m.verb === "task" && m.from_workspace_id === placedAgain!.id,
    )!;
    const trailer = JSON.parse(result.body.split(BRANCH_TRAILER)[1]!) as {
      branch: string;
      sha: string;
      tokens: number;
    };
    expect(trailer.tokens).toBeGreaterThan(0);
    expect(await Effect.runPromise(leadComputer.builders.tree(`caveman:${lead.id}`))).toEqual({
      running: 0,
      threadIds: [],
      tokens: trailer.tokens,
    });
    expect(userTexts(events).join("\n")).not.toContain("tokens");

    // Asked MAX_PLACED_AGAIN times and turned away each time (Cloud keeps placing on the full one): the lead hears why.
    tree.nextComputers.push(
      ...Array.from({ length: MAX_PLACED_AGAIN + 1 }, () => fullComputer.identity.computerId),
    );
    const unlucky = await delegate(leadComputer.builders, lead, "k2", "Part two");
    await until(
      () => userTexts(events).some((text) => text.includes('Builder "Part two" failed')),
      90_000,
    );
    expect(tree.spawns.slice(2).map((s) => s.body.request_id)).toEqual([
      "builder:k2",
      "builder:k2:again-1",
      "builder:k2:again-2",
    ]);
    expect(userTexts(events).find((text) => text.includes('Builder "Part two" failed'))).toContain(
      `Its Cloud computer could not start it: ${COMPUTER_FULL}`,
    );
    await until(
      async () =>
        (await Effect.runPromise(leadComputer.builders.status(unlucky!.workspaceId)))?.state ===
        "failed",
      15_000,
    );
    expect(
      (await Effect.runPromise(leadComputer.builders.tree(`caveman:${lead.id}`))).running,
    ).toBe(0);

    expect(tree.refused).toEqual([]);
    expect(cloud.state.chats.refused).toEqual([]);
  },
  400_000,
);
