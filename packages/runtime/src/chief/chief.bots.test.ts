// Chiefs apart from projects (docs/chief.md "What it is", "Its profile"), on a real runtime with no engine key:
// nothing here thinks, so every assertion is routing, the profiles, the board and the prefix a Chief's session opens
// with (the Chief's host, as the engine reads it).
import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { ThreadId } from "@caveman-app/protocol";
import { connect } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { makeConfig, makeRepo, startRuntime, tempRoot } from "../session-protocol/testHarness.ts";
import { ChiefHost } from "./host.ts";
import { PROJECTS_IN_FULL } from "./prompt.ts";

const root = tempRoot("chief-bots-");
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let config: Awaited<ReturnType<typeof makeConfig>>;
let client: ReturnType<typeof connect>;
let requests = 0;
const rid = () => `b${++requests}`;
/** The projects made here, in the order they were added. */
const made: Array<string> = [];
const project = async (name: string) => {
  const { id } = await client.call("project.create", {
    request_id: rid(),
    path: makeRepo(root, { "README.md": `${name}\n` }),
    name,
  });
  made.push(id);
  return id;
};
const note = async (chiefId: string, text: string) =>
  (
    await client.call("chief.capture", {
      request_id: rid(),
      chief_id: chiefId,
      text,
      mode: "queue",
    })
  ).item;
/** What a Chief's session opens with: its system text and the sections after it. */
const prefixOf = (chiefId: string) =>
  Effect.runPromise(
    Context.get(runtime.context as unknown as Context.Context<ChiefHost>, ChiefHost).profile(
      ThreadId.make(`caveman:${chiefId}`),
    ),
  ).then((profile) => profile!);

beforeAll(async () => {
  config = await makeConfig();
  runtime = await startRuntime(config, "fake-claude");
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Chiefs stand apart from projects", () => {
  test("the person sets and clears a mission's proof and check-in pace through the wire", async () => {
    const chief = (await client.call("chief.get", {})).chief!;
    const mission = await note(chief.id, "Keep CI green");
    const updated = await client.call("chief.items.update", {
      request_id: rid(),
      item_id: mission.id,
      done_when: "  CI green for a week  ",
      check_in: "day",
    });
    expect(updated).toMatchObject({ done_when: "CI green for a week", check_in: "day" });
    expect(updated).not.toHaveProperty("checked_at");
    expect(updated).not.toHaveProperty("started_at");
    expect(
      (await client.call("chief.items.list", {})).items.find((i) => i.id === mission.id),
    ).toMatchObject({ done_when: "CI green for a week", check_in: "day" });
    await expect(
      client.call("chief.items.update", {
        request_id: rid(),
        item_id: mission.id,
        done_when: "x".repeat(281),
      }),
    ).rejects.toMatchObject({ error: { data: { reason: "invalid_params" } } });
    await expect(
      client.call("chief.items.update", {
        request_id: rid(),
        item_id: mission.id,
        check_in: "hour" as "day",
      }),
    ).rejects.toMatchObject({ error: { data: { reason: "invalid_params" } } });
    const weekly = await client.call("chief.items.update", {
      request_id: rid(),
      item_id: mission.id,
      done_when: "x".repeat(280),
      check_in: "week",
    });
    expect(weekly).toMatchObject({ done_when: "x".repeat(280), check_in: "week" });
    await client.call("chief.items.update", {
      request_id: rid(),
      item_id: mission.id,
      done_when: " \n ",
      check_in: null,
      state: "dropped",
    });
    const cleared = (await client.call("chief.items.list", {})).items.find(
      (i) => i.id === mission.id,
    )!;
    expect(cleared).not.toHaveProperty("done_when");
    expect(cleared).not.toHaveProperty("check_in");
    await client.call("chief.remove", { request_id: rid(), chief_id: chief.id });
  });

  test("a call that names a project no Chief works in reaches the Chief with the latest activity; any Chief can be removed, the last too once it has nothing open", async () => {
    const alpha = await project("alpha");
    const beta = await project("beta");
    const gamma = await project("gamma");
    const a = (
      await client.call("chief.create", { request_id: rid(), name: "A", project_ids: [alpha] })
    ).chief;
    const b = (
      await client.call("chief.create", { request_id: rid(), name: "B", project_ids: [beta] })
    ).chief;
    expect((await client.call("chief.get", { project_id: alpha })).workspace.id).toBe(a.id);
    expect((await client.call("chief.get", { project_id: beta })).workspace.id).toBe(b.id);
    // No Chief works in gamma: the one that did something last.
    const bNote = await note(b.id, "b: someday the docs");
    expect((await client.call("chief.get", { project_id: gamma })).workspace.id).toBe(b.id);
    const aNote = await note(a.id, "a: someday the tests");
    expect((await client.call("chief.get", { project_id: gamma })).workspace.id).toBe(a.id);
    expect((await client.call("chief.get", {})).workspace.id).toBe(a.id);
    await expect(
      client.call("chief.get", { project_id: "caveman-repo:0000000000000000" }),
    ).rejects.toMatchObject({ error: { data: { reason: "not_found" } } });
    // A goes: its note about no project goes to the other Chief, the one with the latest activity.
    await client.call("chief.remove", { request_id: rid(), chief_id: a.id });
    const moved = (await client.call("chief.items.list", {})).items.find((i) => i.id === aNote.id)!;
    expect(moved).toMatchObject({
      chief_id: b.id,
      detail: "Moved here from A when it was removed.",
    });
    // B is the last: refused while it has open items, gone once it has none.
    await expect(
      client.call("chief.remove", { request_id: rid(), chief_id: b.id }),
    ).rejects.toMatchObject({
      error: {
        data: { reason: "invalid_state" },
        message: "Make another Chief first: its missions need somewhere to go.",
      },
    });
    for (const id of [aNote.id, bNote.id])
      await client.call("chief.items.update", { request_id: rid(), item_id: id, state: "dropped" });
    await client.call("chief.remove", { request_id: rid(), chief_id: b.id });
    expect((await client.call("chief.list", {})).chiefs).toEqual([]);
    // With none left, the next call makes the first again, in every project.
    expect((await client.call("chief.get", { project_id: alpha })).chief).toMatchObject({
      name: "Chief",
      project_ids: [],
    });
  }, 120_000);

  test("chief.create takes a role, a soul and a project list; its prefix opens with its role, names its id, and lists its projects: past 8, the rest by name and path", async () => {
    const before = (await client.call("project.list", {})).projects.length;
    for (let i = before; i < PROJECTS_IN_FULL + 1; i++) await project(`p${i}`);
    const all = (await client.call("project.list", {})).projects;
    expect(all.length).toBe(PROJECTS_IN_FULL + 1);
    await expect(
      client.call("chief.create", { request_id: rid(), name: "Long", role: "r".repeat(141) }),
    ).rejects.toMatchObject({ error: { data: { reason: "invalid_params" } } });
    const carl = (
      await client.call("chief.create", {
        request_id: rid(),
        name: "Carl",
        role: "Keep CI green in every project",
        soul: "# Soul\n\nShip small.",
      })
    ).chief;
    expect(carl).toMatchObject({
      name: "Carl",
      role: "Keep CI green in every project",
      soul: "# Soul\n\nShip small.",
      project_ids: [],
    });
    const prefix = await prefixOf(carl.id);
    expect(
      prefix.instructions.startsWith(
        "You are Carl. Your job: Keep CI green in every project.\n\nYou are a Chief in Caveman Code",
      ),
    ).toBe(true);
    const section = (title: string) => prefix.sections.find((s) => s.title === title)?.text ?? "";
    expect(section("Your id")).toBe(carl.id);
    expect(section("Soul")).toBe("Ship small.");
    const projects = section("Projects").split("\n");
    expect(projects[0]).toBe("Every project, new ones too:");
    const cut = projects.indexOf("Also, by name and path:");
    const full = projects.slice(1, cut).filter((l) => l.startsWith("- "));
    const rest = projects.slice(cut + 1).filter((l) => l.startsWith("- "));
    expect(full).toHaveLength(PROJECTS_IN_FULL);
    for (const line of full) expect(line).toMatch(/^- \S+ \(caveman-repo:[0-9a-f]+\): path \S+\./);
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatch(/^- \S+ \(caveman-repo:[0-9a-f]+\): path \S+$/);
    // Every project is named once, in the order they were added.
    const named = [...section("Projects").matchAll(/\((caveman-repo:[0-9a-f]+)\)/g)].map(
      (m) => m[1],
    );
    expect(new Set(named)).toEqual(new Set(all.map((p) => p.id)));
    // A Chief without a role opens with the text every Chief reads; one kept to two projects lists those two.
    const pair = (
      await client.call("chief.create", {
        request_id: rid(),
        name: "Pair",
        project_ids: [made[1]!, made[0]!],
      })
    ).chief;
    const narrow = await prefixOf(pair.id);
    expect(narrow.instructions.startsWith("You are a Chief in Caveman Code")).toBe(true);
    const lines = (narrow.sections.find((s) => s.title === "Projects")?.text ?? "")
      .split("\n")
      .filter((l) => l.startsWith("- "));
    expect(lines.map((l) => /\((caveman-repo:[0-9a-f]+)\)/.exec(l)?.[1])).toEqual([
      made[0],
      made[1],
    ]);
  }, 120_000);

  test("a note sent in a project is that project's, on a Chief in several; a Chief in one project names it for older clients", async () => {
    const ops = await project("ops");
    const duo = (
      await client.call("chief.create", {
        request_id: rid(),
        name: "Duo",
        project_ids: [ops, made[0]!],
      })
    ).chief;
    // Duo works in ops and the first project; a note sent in either (routed, or to Duo by name) is that one's, so Duo
    // knows where it goes.
    for (const [id, named] of [
      [ops, undefined],
      [made[0]!, duo.id],
    ] as const) {
      const { item } = await client.call("chief.capture", {
        request_id: rid(),
        project_id: id,
        ...(named === undefined ? {} : { chief_id: named }),
        text: "someday tidy the docs",
        mode: "queue",
      });
      expect(item).toMatchObject({ chief_id: duo.id, project_ids: [id] });
    }
    // A Chief in one project names it as project_id, for older clients; one in two names none.
    const solo = (
      await client.call("chief.create", { request_id: rid(), name: "Solo", project_ids: [ops] })
    ).chief;
    expect([solo.project_id, duo.project_id]).toEqual([ops, undefined]);
  }, 120_000);

  test("the person's corrections teach only their item's Chief, and its next prefix reads the lessons without an engine", async () => {
    const app = await project("lesson-app");
    const site = await project("lesson-site");
    const chief = (
      await client.call("chief.create", {
        request_id: rid(),
        name: "Learner",
        project_ids: [app, site],
      })
    ).chief;
    const other = (await client.call("chief.create", { request_id: rid(), name: "Other learner" }))
      .chief;
    const suggested = await note(chief.id, "Upgrade lodash");
    const removed = await note(chief.id, "Weekly report");
    const rewritten = await note(chief.id, "fix login");
    const moved = await note(chief.id, "Docs pass");
    const first = await note(chief.id, "Fix CI");
    const ordinary = await note(chief.id, "Plain note");
    expect((await prefixOf(chief.id)).sections.some((s) => s.title === "Lessons")).toBe(false);
    // As in chief.migration.test.ts, put real drafts on disk while the runtime is down.
    client.close();
    await runtime.close();
    const db = new DatabaseSync(config.dbPath);
    try {
      for (const item of [suggested, rewritten])
        db.prepare("UPDATE chief_items SET state = 'proposed', proposal = ? WHERE id = ?").run(
          JSON.stringify({
            project_ids: [app],
            brief: item.text,
            title: item.text,
            quotes: [item.text],
          }),
          item.id,
        );
      db.prepare("UPDATE chief_items SET projects = ? WHERE id = ?").run(
        JSON.stringify([app]),
        moved.id,
      );
    } finally {
      db.close();
    }
    runtime = await startRuntime(config, "fake-claude");
    client = connect(runtime.url, runtime.token);
    await client.call("chief.items.update", {
      request_id: rid(),
      item_id: suggested.id,
      state: "dropped",
    });
    await client.call("chief.items.remove", { request_id: rid(), item_id: removed.id });
    const afterTwo = (await prefixOf(chief.id)).sections.find((s) => s.title === "Lessons")?.text;
    expect(afterTwo?.split("\n")).toEqual([
      "- They removed 'Weekly report' from my board.",
      "- They dropped my suggestion 'Upgrade lodash'.",
    ]);
    await client.call("chief.items.update", {
      request_id: rid(),
      item_id: rewritten.id,
      text: "fix login on Safari only",
    });
    await client.call("chief.items.update", {
      request_id: rid(),
      item_id: moved.id,
      project_ids: [site],
    });
    await client.call("chief.items.reorder", {
      request_id: rid(),
      item_id: first.id,
      before_item_id: rewritten.id,
    });
    // Same project membership and a repeated drop do not manufacture another correction.
    await client.call("chief.items.update", {
      request_id: rid(),
      item_id: moved.id,
      project_ids: [site, site],
    });
    await client.call("chief.items.update", {
      request_id: rid(),
      item_id: suggested.id,
      state: "dropped",
    });
    await client.call("chief.items.update", {
      request_id: rid(),
      item_id: ordinary.id,
      text: "A plain rewrite without a draft",
      state: "dropped",
    });
    const learned = (await prefixOf(chief.id)).sections
      .find((s) => s.title === "Lessons")
      ?.text.split("\n");
    expect(learned).toEqual([
      "- They put 'Fix CI' first.",
      "- They moved 'Docs pass' from lesson-app to lesson-site.",
      "- They rewrote 'fix login' after I drafted it: 'fix login on Safari only'.",
      "- They removed 'Weekly report' from my board.",
      "- They dropped my suggestion 'Upgrade lodash'.",
    ]);
    expect((await prefixOf(other.id)).sections.some((s) => s.title === "Lessons")).toBe(false);
    // Lessons survive a relaunch, including the removed item's words.
    client.close();
    await runtime.close();
    runtime = await startRuntime(config, "fake-claude");
    client = connect(runtime.url, runtime.token);
    expect(
      (await prefixOf(chief.id)).sections.find((s) => s.title === "Lessons")?.text.split("\n"),
    ).toEqual(learned);
  }, 120_000);
});
