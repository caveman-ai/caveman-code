// The person's settings loop (Caveman Cloud the spec) against a small Cloud that numbers changes, keeps the newer value
// for a writer that was behind, and holds a read until something changes, as control-api's settings.go does. Two
// computers of one person converge; a new computer takes the person's choices and never seeds Cloud with its
// defaults; an offline edit loses to a later one; a refused value is not sent again; an engine keeps its account here.
// A Cloud computer whose person's credentials stay outside it only reads: it sends Cloud no write at all.
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import type { Settings } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterEach, expect, test } from "vitest";

import { ruleOf } from "./credentialRule.ts";
import type { Identity } from "./identity.ts";
import type { LinkState } from "./index.ts";
import { fromCloud, makeSettingsSync, toCloud } from "./personSettings.ts";

type Row = { key: string; value: unknown; seq: number };

/** handlers.ts's DEFAULT_SETTINGS. */
const DEFAULT_SETTINGS = {
  default_engine: "claude-agent",
  default_computer_id: "this-mac",
  engines: {},
  theme: "system",
  notifications: { needs_input: true, turn_done: true },
  git_co_author: true,
} as Settings;

/** settings.go's semantics for one person, in memory. */
function fakeCloud() {
  const rows = new Map<string, Row>();
  let seq = 0;
  let waiters: Array<() => void> = [];
  const refuse = new Set<string>();
  /** `outside`: Cloud takes no setting from inside this computer (CONTRACT §2), as a Cloud under the credential rule answers. */
  const state = { person: "person-1", slowPatchMs: 0, outside: false, patches: 0 };
  const writes: Array<{ key: string; value: unknown; base_seq?: number }> = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname !== "/api/v1/code/runtime/settings") return reply(404, { error: { code: "cave_not_found", message: "no" } });
    if (req.method === "PATCH") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      state.patches++;
      if (state.outside) return reply(403, { error: { code: "cave_code_outside_computer", message: "A person's settings are changed from their own devices" } });
      const { changes } = JSON.parse(raw) as { changes: Array<{ key: string; value: unknown; base_seq?: number }> };
      if (state.slowPatchMs > 0) await new Promise((resolve) => setTimeout(resolve, state.slowPatchMs));
      const out: Row[] = [];
      const conflicts: string[] = [];
      if (changes.some((c) => refuse.has(c.key))) {
        writes.push(...changes.filter((c) => changes.length === 1));
        return reply(400, { error: { code: "cave_code_setting_credential", message: "looks like a credential" } });
      }
      for (const c of changes) {
        writes.push(c);
        const row = rows.get(c.key);
        const same = row !== undefined && JSON.stringify(row.value) === JSON.stringify(c.value);
        if (!same && (row === undefined || c.base_seq === undefined || row.seq <= c.base_seq)) rows.set(c.key, { key: c.key, value: c.value, seq: ++seq });
        else if (!same) conflicts.push(c.key);
        out.push(rows.get(c.key)!);
      }
      for (const w of waiters.splice(0)) w();
      return reply(200, { settings: out, conflicts });
    }
    const after = Number(url.searchParams.get("after") ?? 0);
    const wait = Number(url.searchParams.get("wait_ms") ?? 0);
    const page = () => [...rows.values()].filter((r) => r.seq > after).sort((a, b) => a.seq - b.seq);
    if (page().length === 0 && wait > 0) await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, wait);
      waiters.push(() => (clearTimeout(timer), resolve()));
      req.on("close", () => (clearTimeout(timer), resolve()));
    });
    const settings = page();
    reply(200, { settings, seq: settings.at(-1)?.seq ?? after, person: state.person });
  });
  return {
    rows,
    refuse,
    state,
    writes,
    /** Another device's write, as PATCH /code/settings would make it. */
    write: (key: string, value: unknown) => {
      rows.set(key, { key, value, seq: ++seq });
      for (const w of waiters.splice(0)) w();
    },
    start: () => new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
    stop: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}

/** One computer: its settings, saved or not, kept as settings.set keeps them. */
function computer(url: string, runtimeId: string, start?: Partial<Settings>, kv = new Map<string, string>(), link: LinkState = { cloudUrl: url, token: "token" }) {
  let settings: Settings = { ...DEFAULT_SETTINGS, ...start } as Settings;
  const sets: Array<Partial<Settings>> = [];
  const sync = makeSettingsSync({
    identity: () => ({ cloudUrl: url, runtimeId, organizationId: "org-1", computerId: runtimeId }) as Identity,
    link,
    get: Effect.sync(() => settings),
    defaults: Effect.succeed(DEFAULT_SETTINGS),
    set: (patch) =>
      Effect.sync(() => {
        sets.push(patch);
        settings = { ...settings, ...patch } as Settings;
        sync.changed();
      }),
    unset: (keys) =>
      Effect.sync(() => {
        const next = { ...settings } as Record<string, unknown>;
        for (const key of keys) next[key] = (DEFAULT_SETTINGS as Record<string, unknown>)[key];
        settings = next as Settings;
        sync.changed();
      }),
    load: Effect.sync(() => kv.get("settings_sync")),
    save: (value) => Effect.sync(() => void kv.set("settings_sync", value)),
  });
  const fiber = Effect.runFork(sync.run);
  return {
    get settings() {
      return settings;
    },
    sets,
    /** The person changes a setting here (settings.set). */
    change: (patch: Partial<Settings>) => {
      settings = { ...settings, ...patch } as Settings;
      sync.changed();
    },
    kv,
    stop: () => Effect.runPromise(Fiber.interrupt(fiber)),
  };
}

const until = async (check: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const cloud = fakeCloud();
  const url = await cloud.start();
  cleanups.push(cloud.stop);
  const on = (runtimeId: string, start?: Partial<Settings>, kv?: Map<string, string>, link?: LinkState) => {
    const c = computer(url, runtimeId, start, kv, link);
    cleanups.push(c.stop);
    return c;
  };
  /** A Cloud computer's link, its credential rule answered as Cloud's `GET runtime` would (credentialRule.ts). */
  const hosted = (credentialsOutside: boolean): LinkState => {
    const link: LinkState = { cloudUrl: url, token: "token" };
    ruleOf(link).join(() => Promise.resolve(credentialsOutside));
    return link;
  };
  return { cloud, on, hosted };
}

test("a choice made on one computer reaches the other at once, and nothing echoes back", async () => {
  const { cloud, on } = await setup();
  const mac = on("mac", { theme: "dark", send_shortcut: "mod_enter" } as Partial<Settings>);
  await until(() => cloud.rows.get("theme")?.value === "dark");
  const box = on("cloud-box");
  await until(() => box.settings.theme === "dark" && (box.settings as Settings).send_shortcut === ("mod_enter" as never));
  const writes = cloud.writes.length;
  box.change({ theme: "light" } as Partial<Settings>);
  await until(() => mac.settings.theme === "light", 3_000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  // The box wrote theme once; the Mac only took it.
  expect(cloud.writes.slice(writes).map((w) => [w.key, w.value])).toEqual([["theme", "light"]]);
});

test("a new computer takes the person's choices and never pushes its defaults over them", async () => {
  const { cloud, on } = await setup();
  cloud.write("theme", "dark");
  cloud.write("density", "compact");
  const box = on("fresh-box");
  await until(() => box.settings.theme === "dark" && box.settings.density === ("compact" as never));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(cloud.writes).toEqual([]);
});

test("first contact: Cloud wins where it holds a value; what only this computer chose seeds Cloud", async () => {
  const { cloud, on } = await setup();
  cloud.write("theme", "dark");
  const mac = on("mac", { theme: "light", density: "compact" } as Partial<Settings>);
  await until(() => cloud.rows.get("density")?.value === "compact");
  expect(mac.settings.theme).toBe("dark");
  expect(cloud.rows.get("theme")?.value).toBe("dark");
});

test("an edit made while Cloud had a later one loses to it; the next edit here wins", async () => {
  const { cloud, on } = await setup();
  const mac = on("mac", { theme: "dark" } as Partial<Settings>);
  await until(() => cloud.rows.get("theme")?.value === "dark");
  await mac.stop();
  // Offline: the phone changes it, then the Mac does; the Mac comes back with its place (its kv) and its own edit.
  cloud.write("theme", "light");
  const again = on("mac", { theme: "system" } as Partial<Settings>, mac.kv);
  await until(() => again.settings.theme === "light");
  expect(cloud.writes.filter((w) => w.key === "theme").at(-1)).toMatchObject({ value: "system", base_seq: 1 });
  expect(cloud.rows.get("theme")?.value).toBe("light");
  again.change({ theme: "dark" } as Partial<Settings>);
  await until(() => cloud.rows.get("theme")?.value === "dark");
});

test("a value Cloud refuses is not sent again until it changes, and the others still go", async () => {
  const { cloud, on } = await setup();
  cloud.refuse.add("favorite_models");
  on("mac", { theme: "dark", favorite_models: [("caveman/sk-" + "ant-api03-xxxxxxxxxxxxxxxxxxxx")] } as Partial<Settings>);
  await until(() => cloud.rows.get("theme")?.value === "dark");
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(cloud.writes.filter((w) => w.key === "favorite_models")).toHaveLength(1);
});

test("a second edit made while the first was on its way is never undone by the first coming back", async () => {
  const { cloud, on } = await setup();
  const mac = on("mac", { theme: "dark" } as Partial<Settings>);
  await until(() => cloud.rows.get("theme")?.value === "dark");
  cloud.state.slowPatchMs = 150;
  mac.change({ theme: "light" } as Partial<Settings>);
  await new Promise((resolve) => setTimeout(resolve, 40));
  mac.change({ theme: "system" } as Partial<Settings>);
  await until(() => cloud.rows.get("theme")?.value === "system");
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(mac.settings.theme).toBe("system");
  expect(cloud.rows.get("theme")?.value).toBe("system");
});

test("a computer that starts acting for another person drops the last one's choices and pushes none of them", async () => {
  const { cloud, on } = await setup();
  const box = on("box", { theme: "dark", review_instructions: "Be terse." } as Partial<Settings>);
  await until(() => cloud.rows.get("review_instructions")?.value === "Be terse.");
  const writes = cloud.writes.length;
  // Cloud now binds the box to another person, whose settings Cloud does not hold yet.
  cloud.rows.clear();
  cloud.state.person = "person-2";
  cloud.write("density", "compact");
  await until(() => box.settings.density === ("compact" as never));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(box.settings.theme).toBe("system");
  expect(box.settings.review_instructions).toBeUndefined();
  expect(cloud.writes.slice(writes)).toEqual([]);
});

test("setting one back to its default reaches every computer, and stays", async () => {
  const { cloud, on } = await setup();
  const mac = on("mac", { theme: "dark" } as Partial<Settings>);
  await until(() => cloud.rows.get("theme")?.value === "dark");
  const box = on("box");
  await until(() => box.settings.theme === "dark");
  // The phone sets it back to the default (null).
  cloud.write("theme", null);
  await until(() => mac.settings.theme === "system" && box.settings.theme === "system");
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(cloud.rows.get("theme")?.value).toBeNull();
});

test("a value this computer cannot hold (a newer app's) is refused alone; the rest is taken and nothing is pushed back", async () => {
  const { cloud, on } = await setup();
  cloud.write("theme", "neon-from-a-newer-app");
  cloud.write("density", "compact");
  const box = on("box");
  await until(() => box.settings.density === ("compact" as never));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(box.settings.theme).toBe("system");
  expect(cloud.writes).toEqual([]);
});

test("a Cloud computer whose person's credentials stay outside it only reads: its change holds there, Cloud is sent no write, and the person's own device wins", async () => {
  const { cloud, on, hosted } = await setup();
  cloud.state.outside = true;
  cloud.write("theme", "dark");
  const box = on("cloud-box", undefined, undefined, hosted(true));
  await until(() => box.settings.theme === "dark");
  // Changed in a chat's settings on the computer: it holds there, and no other computer hears of it.
  box.change({ theme: "light", density: "compact" } as Partial<Settings>);
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(box.settings.theme).toBe("light");
  expect(cloud.rows.get("theme")?.value).toBe("dark");
  expect(cloud.rows.has("density")).toBe(false);
  // The person changes it on their Mac: theirs is taken here, over the computer's own.
  cloud.write("theme", "system");
  await until(() => box.settings.theme === "system");
  expect(box.settings.density).toBe("compact" as never);
  await new Promise((resolve) => setTimeout(resolve, 300));
  // Not one write reached Cloud, refused or not.
  expect(cloud.state.patches).toBe(0);
  expect(cloud.writes).toEqual([]);
});

test("the rule coming on while a Cloud computer ran: Cloud refuses one write, and the computer sends no other", async () => {
  const { cloud, on, hosted } = await setup();
  const box = on("cloud-box", { theme: "dark" } as Partial<Settings>, undefined, hosted(false));
  // Before the rule this computer wrote like any other.
  await until(() => cloud.rows.get("theme")?.value === "dark");
  cloud.state.outside = true;
  const before = cloud.state.patches;
  box.change({ theme: "light" } as Partial<Settings>);
  await until(() => cloud.state.patches === before + 1);
  box.change({ density: "compact" } as Partial<Settings>);
  // Each change wakes a round, and every round is a chance to write.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(cloud.state.patches).toBe(before + 1);
  expect(cloud.rows.get("theme")?.value).toBe("dark");
  expect(box.settings.theme).toBe("light");
  // Reads go on at once (a refusal is not waited out and the write tried again): the person's own device reaches it.
  cloud.write("density", "comfortable");
  await until(() => box.settings.density === ("comfortable" as never));
  expect(cloud.state.patches).toBe(before + 1);
});

test("a role's pin follows the person: its agent, model and effort sync; the account it runs on is each computer's own", () => {
  const mac = { ...DEFAULT_SETTINGS, subagent_role_pins: { implementation: { engine: "codex", instance_id: "codex-work", model: "gpt-5.5", effort: "high" }, research: null } } as Settings;
  // What Cloud keeps names no account of this Mac's, and a cleared role is not a pin.
  expect(toCloud(mac).subagent_role_pins).toEqual({ implementation: { engine: "codex", model: "gpt-5.5", effort: "high" } });
  expect(toCloud(DEFAULT_SETTINGS).subagent_role_pins).toBeUndefined();
  // A Cloud computer that never pinned anything: the role runs on the agent's own account there.
  expect((fromCloud("subagent_role_pins", { implementation: { engine: "codex", model: "gpt-5.5", effort: "high" } }, DEFAULT_SETTINGS, DEFAULT_SETTINGS) as Partial<Settings>).subagent_role_pins).toEqual({
    implementation: { engine: "codex", instance_id: "codex", model: "gpt-5.5", effort: "high" },
  });
  // A computer that pinned the same agent on an account of its own keeps that account and takes the model.
  expect((fromCloud("subagent_role_pins", { implementation: { engine: "codex", model: "gpt-5.6" } }, mac, DEFAULT_SETTINGS) as Partial<Settings>).subagent_role_pins).toEqual({
    implementation: { engine: "codex", instance_id: "codex-work", model: "gpt-5.6" },
    research: null,
  });
  // Pinned to another agent elsewhere: that agent's own account here. Unpinned elsewhere: cleared here.
  expect((fromCloud("subagent_role_pins", { implementation: { engine: "claude-agent", model: "sonnet" } }, mac, DEFAULT_SETTINGS) as Partial<Settings>).subagent_role_pins).toMatchObject({ implementation: { engine: "claude-agent", instance_id: "claudeAgent", model: "sonnet" } });
  expect((fromCloud("subagent_role_pins", null, mac, DEFAULT_SETTINGS) as Partial<Settings>).subagent_role_pins).toEqual({ implementation: null, research: null });
});

test("a task kind's pin syncs as a role's does, Always with it", () => {
  const mac = { ...DEFAULT_SETTINGS, subagent_task_pins: { frontend_ui: { engine: "claude-agent", instance_id: "work", model: "claude-opus-5-5", always: true }, backend_fix: null } } as Settings;
  expect(toCloud(mac).subagent_task_pins).toEqual({ frontend_ui: { engine: "claude-agent", model: "claude-opus-5-5", always: true } });
  expect(toCloud(DEFAULT_SETTINGS).subagent_task_pins).toBeUndefined();
  expect((fromCloud("subagent_task_pins", { frontend_ui: { engine: "claude-agent", model: "claude-sonnet-5-5" } }, mac, DEFAULT_SETTINGS) as Partial<Settings>).subagent_task_pins).toEqual({
    frontend_ui: { engine: "claude-agent", instance_id: "work", model: "claude-sonnet-5-5" },
    backend_fix: null,
  });
});

test("an engine's model syncs; the account it runs on stays with each computer", () => {
  const here = { ...DEFAULT_SETTINGS, engines: { caveman: { model: "sonnet", account_id: "acct-mac" } }, default_engine_chosen: true, default_engine: "codex" } as Settings;
  expect(toCloud(here).engines).toEqual({ caveman: { model: "sonnet" } });
  expect(toCloud(here).default_engine).toBe("codex");
  expect(toCloud({ ...here, default_engine_chosen: false }).default_engine).toBeUndefined();
  const box = { ...DEFAULT_SETTINGS, engines: { caveman: { account_id: "acct-box" }, codex: { model: "gpt-6" } } } as Settings;
  expect((fromCloud("engines", { caveman: { model: "opus" } }, box, DEFAULT_SETTINGS) as Partial<Settings>).engines).toEqual({ caveman: { model: "opus", account_id: "acct-box" }, codex: {} });
  // A null is the app's default; an engine's account stays.
  expect(fromCloud("theme", null, box, DEFAULT_SETTINGS)).toEqual({ theme: "system" });
  // A default that is no value at all (an optional key) is removed rather than replaced.
  expect(fromCloud("density", null, box, DEFAULT_SETTINGS)).toBe("unset");
  expect((fromCloud("engines", null, box, DEFAULT_SETTINGS) as Partial<Settings>).engines).toEqual({ caveman: { account_id: "acct-box" }, codex: {} });
  expect(fromCloud("default_engine", null, box, DEFAULT_SETTINGS)).toBeUndefined();
});
