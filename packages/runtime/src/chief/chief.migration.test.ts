// Chiefs from older builds, at startup on a real runtime: a database shaped as an older build left it (a home Chief, a
// Chief with several projects or none, a runtime from before profiles, a Chief whose workspace or project is gone),
// then a relaunch. No engine key: nothing here thinks, so every assertion is the board and the profiles. The startup
// pass runs once the runtime takes commands; a Chief call waits for it, so each test reads after one.
import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { ThreadId } from "@caveman-app/protocol";
import { connect } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { afterAll, describe, expect, test } from "vitest";

import { makeCommandGate, ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import {
  makeConfig,
  makeRepo,
  orchestratorOf,
  startRuntime,
  tempRoot,
  until,
} from "../session-protocol/testHarness.ts";

const root = tempRoot("chief-migration-");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** One runtime on one state dir, which a test quits and starts again (a relaunch) to run the startup pass. */
const life = async () => {
  const config = await makeConfig();
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  let client: ReturnType<typeof connect> | undefined;
  let requests = 0;
  const it = {
    config,
    rid: () => `m${++requests}`,
    get client() {
      return client!;
    },
    /** `provide`: services the route sees first (serverRuntimeStartup's command gate). */
    boot: async (provide?: Layer.Layer<any, never, any>) => {
      runtime = await startRuntime(
        config,
        "fake-claude",
        undefined,
        provide === undefined ? {} : { provide },
      );
      client = connect(runtime.url, runtime.token);
    },
    /** Whether T3 has this thread (a Chief's: `caveman:<its id>`, unless a test moved it). */
    hasThread: (threadId: string) =>
      Effect.runPromise(orchestratorOf(runtime!).getThreadShell(ThreadId.make(threadId))).then(
        (shell) => shell !== null,
      ),
    quit: async () => {
      client?.close();
      await runtime?.close();
      runtime = undefined;
    },
    /** Runs `fn` on the runtime's database, written to (the runtime is down) or read. */
    db: <A>(fn: (db: DatabaseSync) => A, readOnly = false) => {
      const db = new DatabaseSync(config.dbPath, { readOnly, timeout: 5_000 });
      try {
        return fn(db);
      } finally {
        db.close();
      }
    },
    project: async (name: string) =>
      (
        await client!.call("project.create", {
          request_id: it.rid(),
          path: makeRepo(root, { "README.md": `${name}\n` }),
          name,
        })
      ).id,
    note: async (chiefId: string, text: string) =>
      (
        await client!.call("chief.capture", {
          request_id: it.rid(),
          chief_id: chiefId,
          text,
          mode: "queue",
        })
      ).item,
    items: async () =>
      new Map((await client!.call("chief.items.list", {})).items.map((i) => [i.id, i] as const)),
    /** A Chief as a build from before 2026-11-15 kept it: no one project of its own, its list as given. */
    unproject: (
      chiefId: string,
      projectIds: ReadonlyArray<string>,
      extra: { readonly home?: boolean } = {},
    ) =>
      it.db((db) =>
        db
          .prepare(
            "UPDATE chief_profiles SET project_id = NULL, project_default = 0, project_ids = ?, home = ? WHERE id = ?",
          )
          .run(JSON.stringify(projectIds), extra.home ? 1 : 0, chiefId),
      ),
  };
  return it;
};

describe("Chiefs from older builds, at startup", () => {
  test("a Chief from before 2026-11-15 (the home Chief, one with several projects, one with none) is a Chief as it is: it stays, with its list and its items, and routing reads its list", async () => {
    const m = await life();
    await m.boot();
    const alpha = await m.project("alpha");
    const beta = await m.project("beta");
    const home = (await m.client.call("chief.create", { request_id: m.rid(), name: "Chief" }))
      .chief;
    const multi = (await m.client.call("chief.create", { request_id: m.rid(), name: "Multi" }))
      .chief;
    const none = (await m.client.call("chief.create", { request_id: m.rid(), name: "None" })).chief;
    // One from 2026-11-15 to 17: its one project, marked so for older clients.
    const single = (
      await m.client.call("chief.create", {
        request_id: m.rid(),
        name: "Single",
        project_ids: [alpha],
      })
    ).chief;
    const homeNote = await m.note(home.id, "home: someday tidy the docs");
    const multiNote = await m.note(multi.id, "multi: beta work");
    const noneNote = await m.note(none.id, "none: a note with no project");
    await m.quit();
    m.unproject(home.id, [], { home: true });
    m.unproject(multi.id, [alpha, beta]);
    m.unproject(none.id, []);
    m.db((db) =>
      db
        .prepare("UPDATE chief_profiles SET project_id = ?, project_default = 1 WHERE id = ?")
        .run(alpha, single.id),
    );
    // An older build marked a flag once it had moved every Chief to a project; nothing reads it now.
    m.db((db) =>
      db
        .prepare(
          "INSERT OR REPLACE INTO caveman_sp_kv (key, value) VALUES ('chief.per_project', ?)",
        )
        .run(new Date().toISOString()),
    );

    await m.boot();
    const { chiefs } = await m.client.call("chief.list", {});
    // project_default is never sent: a client of those days offers no Remove on a Chief that carries it.
    expect(
      chiefs.map((c) => [c.name, c.project_ids, c.home, c.project_id, c.project_default]),
    ).toEqual([
      ["Chief", [], true, undefined, undefined],
      ["Multi", [alpha, beta], false, undefined, undefined],
      ["None", [], false, undefined, undefined],
      ["Single", [alpha], false, alpha, undefined],
    ]);
    const items = await m.items();
    expect([
      items.get(homeNote.id)?.chief_id,
      items.get(multiNote.id)?.chief_id,
      items.get(noneNote.id)?.chief_id,
    ]).toEqual([home.id, multi.id, none.id]);
    for (const c of [home, multi, none, single])
      expect((await m.client.call("workspace.get", { workspace_id: c.id })).status).not.toBe(
        "archived",
      );
    // Routing reads the lists, never project_default: in alpha the one with the fewest projects; in beta the one with two.
    expect((await m.client.call("chief.get", { project_id: alpha })).workspace.id).toBe(single.id);
    expect((await m.client.call("chief.get", { project_id: beta })).workspace.id).toBe(multi.id);
    // Widened, the 11-15 Chief loses what older clients read as its one project.
    expect(
      (
        await m.client.call("chief.update", {
          request_id: m.rid(),
          chief_id: single.id,
          project_ids: [alpha, beta],
        })
      ).chief,
    ).toMatchObject({ project_ids: [alpha, beta] });
    const widened = (await m.client.call("chief.list", {})).chiefs.find((c) => c.id === single.id)!;
    expect(widened.project_id).toBeUndefined();
    await m.quit();
  }, 120_000);

  test("a runtime from before profiles: its one Chief gets its profile as the home Chief, in every project, Settings' rules as its soul; no project needed", async () => {
    const m = await life();
    await m.boot();
    const first = await m.client.call("chief.get", {});
    expect(first.chief).toMatchObject({ name: "Chief", project_ids: [] });
    const note = await m.note(first.workspace.id, "a note from before Chiefs had profiles");
    await m.client.call("settings.set", {
      request_id: m.rid(),
      settings: { chief_rules: "Legacy rules.\n\n## Crew rules\nLegacy crew." },
    });
    await m.quit();
    // A runtime from before Chiefs had profiles: one Chief, and a note no Chief owns.
    m.db((db) => {
      db.prepare("DELETE FROM chief_profiles").run();
      db.prepare(
        "UPDATE chief_items SET chief_id = NULL, state = 'unsorted', detail = NULL WHERE id = ?",
      ).run(note.id);
    });

    await m.boot();
    expect((await m.client.call("chief.list", {})).chiefs).toMatchObject([
      {
        id: first.workspace.id,
        home: true,
        project_ids: [],
        soul: "Legacy rules.\n\n## Crew rules\nLegacy crew.",
      },
    ]);
    expect((await m.items()).get(note.id)).toMatchObject({
      chief_id: first.workspace.id,
      state: "unsorted",
    });
    expect((await m.client.call("chief.get", {})).workspace.id).toBe(first.workspace.id);
    // Its rules are its own soul; the soul every Chief shares stays empty.
    expect((await m.client.call("settings.get", {})).chief_soul ?? "").toBe("");
    await m.quit();
  }, 120_000);

  test("behind T3's command gate: the runtime starts, a Chief call waits for the startup pass, and a Chief left without its thread gets it when a call reaches it", async () => {
    const m = await life();
    await m.boot();
    const alpha = await m.project("alpha");
    const home = (
      await m.client.call("chief.create", {
        request_id: m.rid(),
        name: "Chief",
        project_ids: [alpha],
      })
    ).chief;
    const note = await m.note(home.id, "home: alpha work, behind the gate");
    await m.quit();

    // As server.ts starts it: T3 takes commands only after the routes are built, and the startup pass waits for that.
    const scope = await Effect.runPromise(Scope.make());
    const gate = await Effect.runPromise(Scope.provide(makeCommandGate, scope));
    const startup = Layer.succeed(ServerRuntimeStartup, {
      awaitCommandReady: gate.awaitCommandReady,
      markHttpListening: Effect.void,
      enqueueCommand: gate.enqueueCommand,
    });
    try {
      await Promise.race([
        m.boot(startup),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("the runtime never finished starting")), 30_000),
        ),
      ]);
      // Every chief.* call waits for the startup pass.
      let answered = 0;
      const list = m.client.call("chief.list", {}).then((r) => (answered++, r));
      const board = m.items().then((r) => (answered++, r));
      await new Promise((r) => setTimeout(r, 1_000));
      expect(answered).toBe(0);
      await Effect.runPromise(gate.signalCommandReady);
      expect((await list).chiefs.map((c) => [c.id, c.project_ids])).toEqual([[home.id, [alpha]]]);
      expect((await board).get(note.id)?.chief_id).toBe(home.id);
      expect(await m.hasThread(`caveman:${home.id}`)).toBe(true);
      await m.quit();
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }

    // A Chief made before its thread was (a quit in between): its thread is sent again when a call reaches it.
    const fresh = `caveman:healed-${Date.now()}`;
    m.db((db) =>
      db
        .prepare(
          "UPDATE caveman_sp_workspaces SET thread_id = ?, internal = json_set(internal, '$.threadId', ?) WHERE id = ?",
        )
        .run(fresh, fresh, home.id),
    );
    await m.boot();
    expect(await m.hasThread(fresh)).toBe(false);
    expect((await m.client.call("chief.get", { project_id: alpha })).workspace.id).toBe(home.id);
    expect(await m.hasThread(fresh)).toBe(true);
    await m.quit();

    // The same when it is opened by its own id (the Chief's page).
    const byId = `caveman:healed-by-id-${Date.now()}`;
    m.db((db) =>
      db
        .prepare(
          "UPDATE caveman_sp_workspaces SET thread_id = ?, internal = json_set(internal, '$.threadId', ?) WHERE id = ?",
        )
        .run(byId, byId, home.id),
    );
    await m.boot();
    expect(await m.hasThread(byId)).toBe(false);
    expect((await m.client.call("chief.get", { chief_id: home.id })).workspace.id).toBe(home.id);
    expect(await m.hasThread(byId)).toBe(true);
    await m.quit();
  }, 120_000);

  test("a Chief whose workspace is gone: its open items go to another Chief that works in their project; with none left, one made in its place takes them", async () => {
    const m = await life();
    await m.boot();
    const alpha = await m.project("alpha");
    const first = (
      await m.client.call("chief.create", {
        request_id: m.rid(),
        name: "First",
        project_ids: [alpha],
        role: "keep alpha green",
      })
    ).chief;
    const second = (
      await m.client.call("chief.create", {
        request_id: m.rid(),
        name: "Second",
        project_ids: [alpha],
      })
    ).chief;
    const queued = await m.note(first.id, "first: queued before its workspace went");
    await m.client.call("chief.items.update", {
      request_id: m.rid(),
      item_id: queued.id,
      project_ids: [alpha],
    });
    await m.quit();
    m.db((db) => db.prepare("DELETE FROM caveman_sp_workspaces WHERE id = ?").run(first.id));

    await m.boot();
    expect((await m.items()).get(queued.id)).toMatchObject({
      chief_id: second.id,
      state: "queued",
      detail: "Moved here from First when it was removed.",
    });
    expect((await m.client.call("chief.list", {})).chiefs.map((c) => c.id)).toEqual([second.id]);
    const later = await m.note(second.id, "second: queued before its workspace went");
    await m.quit();
    m.db((db) => db.prepare("DELETE FROM caveman_sp_workspaces WHERE id = ?").run(second.id));

    // The last one: a Chief made in its place, with its name, projects and soul, takes its work.
    await m.boot();
    const { chiefs } = await m.client.call("chief.list", {});
    expect(chiefs).toHaveLength(1);
    expect(chiefs[0]).toMatchObject({ name: "Second", project_ids: [alpha] });
    expect(chiefs[0]!.id).not.toBe(second.id);
    expect(await m.hasThread(`caveman:${chiefs[0]!.id}`)).toBe(true);
    const items = await m.items();
    for (const id of [queued.id, later.id])
      expect(items.get(id)).toMatchObject({ chief_id: chiefs[0]!.id, state: "queued" });
    await m.quit();
  }, 120_000);

  test("the home Chief whose workspace is gone is replaced as any Chief is: its open items go on, never left on a removed Chief", async () => {
    const m = await life();
    await m.boot();
    const home = (await m.client.call("chief.create", { request_id: m.rid(), name: "Chief" }))
      .chief;
    const queued = await m.note(home.id, "home: queued before its workspace went");
    await m.quit();
    m.unproject(home.id, [], { home: true });
    m.db((db) => db.prepare("DELETE FROM caveman_sp_workspaces WHERE id = ?").run(home.id));

    await m.boot();
    const { chiefs } = await m.client.call("chief.list", {});
    expect(chiefs).toHaveLength(1);
    expect(chiefs[0]).toMatchObject({ name: "Chief", project_ids: [] });
    expect(chiefs[0]!.id).not.toBe(home.id);
    expect((await m.items()).get(queued.id)).toMatchObject({
      chief_id: chiefs[0]!.id,
      state: "queued",
      detail: "Moved here from Chief when it was removed.",
    });
    await m.quit();
  }, 120_000);

  test("a quit between a project's removal and its Chiefs': the next start takes it off their lists; one left with none retires, its open items dropped saying why", async () => {
    const m = await life();
    await m.boot();
    const alpha = await m.project("alpha");
    const beta = await m.project("beta");
    const alphaOnly = (
      await m.client.call("chief.create", {
        request_id: m.rid(),
        name: "Alpha",
        project_ids: [alpha],
      })
    ).chief;
    const both = (
      await m.client.call("chief.create", {
        request_id: m.rid(),
        name: "Both",
        project_ids: [alpha, beta],
      })
    ).chief;
    const dropped = await m.note(alphaOnly.id, "alpha: someday tidy the docs");
    const kept = await m.note(both.id, "both: someday tidy the docs");
    // The disk fails as the Chiefs go: the project is removed, its Chiefs are not.
    m.db((db) =>
      db.exec(
        `CREATE TRIGGER crash BEFORE UPDATE OF removed_at ON chief_profiles WHEN NEW.removed_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'the disk said no'); END`,
      ),
    );
    await m.client
      .call("project.remove", { request_id: m.rid(), project_id: alpha })
      .catch(() => undefined);
    expect((await m.client.call("project.list", {})).projects.map((p) => p.id)).toEqual([beta]);
    expect(
      (await m.client.call("chief.list", {})).chiefs.map((c) => [c.id, c.project_ids]),
    ).toEqual([
      [alphaOnly.id, [alpha]],
      [both.id, [alpha, beta]],
    ]);
    await m.quit();
    m.db((db) => db.exec("DROP TRIGGER crash"));

    await m.boot();
    expect(
      (await m.client.call("chief.list", {})).chiefs.map((c) => [c.id, c.project_ids]),
    ).toEqual([[both.id, [beta]]]);
    const items = await m.items();
    expect(items.get(dropped.id)).toMatchObject({
      chief_id: alphaOnly.id,
      state: "dropped",
      detail: "Dropped: alpha was removed.",
    });
    expect(items.get(kept.id)).toMatchObject({ chief_id: both.id, state: "queued" });
    await until(
      async () =>
        (await m.client.call("workspace.get", { workspace_id: alphaOnly.id })).status ===
        "archived",
      10_000,
    );
    await m.quit();
  }, 120_000);

  test("the same quit with only a Chief in every project: the next start finds the project its items name, drops those there, and a draft naming it goes", async () => {
    const m = await life();
    await m.boot();
    const alpha = await m.project("alpha");
    const beta = await m.project("beta");
    const every = (await m.client.call("chief.create", { request_id: m.rid(), name: "Every" }))
      .chief;
    expect(every.project_ids).toEqual([]);
    // A note sent in alpha, with no Chief named, is alpha's on the Chief that works there.
    const there = (
      await m.client.call("chief.capture", {
        request_id: m.rid(),
        project_id: alpha,
        text: "alpha: someday tidy the docs",
        mode: "queue",
      })
    ).item;
    expect(there).toMatchObject({ chief_id: every.id, project_ids: [alpha] });
    // A Suggested mission drafted for alpha first, then beta.
    const drafted = await m.note(every.id, "both: split the suites");
    await m.quit();
    m.db((db) =>
      db
        .prepare(
          "UPDATE chief_items SET state = 'proposed', projects = ?, proposal = ? WHERE id = ?",
        )
        .run(
          JSON.stringify([alpha, beta]),
          JSON.stringify({
            project_ids: [alpha, beta],
            brief: "B",
            title: "Split the suites",
            quotes: [],
          }),
          drafted.id,
        ),
    );
    await m.boot();
    // The disk fails as the items change: the project is removed, its items are not.
    m.db((db) =>
      db.exec(
        `CREATE TRIGGER crash BEFORE UPDATE ON chief_items BEGIN SELECT RAISE(ABORT, 'the disk said no'); END`,
      ),
    );
    await m.client
      .call("project.remove", { request_id: m.rid(), project_id: alpha })
      .catch(() => undefined);
    expect((await m.client.call("project.list", {})).projects.map((p) => p.id)).toEqual([beta]);
    expect((await m.items()).get(there.id)).toMatchObject({ state: "queued" });
    await m.quit();
    m.db((db) => db.exec("DROP TRIGGER crash"));

    await m.boot();
    const items = await m.items();
    expect(items.get(there.id)).toMatchObject({
      state: "dropped",
      detail: "Dropped: alpha was removed.",
    });
    // Its draft would try alpha first and start nothing: it goes, and the item waits to be drafted again, in beta.
    expect(items.get(drafted.id)).toMatchObject({
      state: "queued",
      project_ids: [beta],
      detail: "alpha was removed, so this is drafted again.",
    });
    expect(items.get(drafted.id)).not.toHaveProperty("proposal");
    await m.quit();
  }, 120_000);
});
