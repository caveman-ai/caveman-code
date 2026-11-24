// The tree stand-in decodes as Cloud does (httpx.DecodeJSON, DisallowUnknownFields), so a field the app sends that
// Cloud does not take fails the app's tests instead of every real spawn.
import { expect, test } from "vitest";

import { spawnPayloadOf, type TreeMail } from "./mail.ts";
import { strictRefusal, treeRoutes, treeState } from "./testCloudMail.ts";

test("mail routes refuse what Cloud's decoder refuses: an unknown field or a value of the wrong type", () => {
  const spawn = { request_id: "r", from_workspace_id: "w", title: "t", brief: "b", engine: "codex", branch: "caveman/x", where: "cloud" };
  expect(strictRefusal("mail/spawn", spawn)).toBeUndefined();
  // Cloud's SpawnInput takes the builder's model and the lead's session (Caveman Cloud 741dca93e), nothing else.
  expect(strictRefusal("mail/spawn", { ...spawn, model: "gpt-5", lead_session_id: "s" })).toBeUndefined();
  expect(strictRefusal("mail/spawn", { ...spawn, effort: "high" })).toBe('json: unknown field "effort"');
  expect(strictRefusal("mail/spawn", { ...spawn, model: 5 })).toMatch(/^json: cannot unmarshal/);
  expect(strictRefusal("mail/task", { request_id: "r", from_workspace_id: "w", to_workspace_id: "x", body: "b", channel: "tree", reply_to: "m" })).toBeUndefined();
  expect(strictRefusal("mail/note", { request_id: "r", from_workspace_id: "w", to_workspace_id: "x", body: "b", wakes: true })).toBe('json: unknown field "wakes"');
  expect(strictRefusal("mail/claim", { request_id: "r", from_workspace_id: "w", paths: ["a"], ttl_seconds: 60 })).toBeUndefined();
  expect(strictRefusal("mail/claim", { request_id: "r", from_workspace_id: "w", paths: "a" })).toMatch(/^json: cannot unmarshal/);
  expect(strictRefusal("mail/release", { request_id: "r", from_workspace_id: "w", paths: [], ttl_seconds: 60 })).toBe('json: unknown field "ttl_seconds"');
  expect(strictRefusal("mail/deliveries", {})).toBeUndefined();
  expect(strictRefusal("mail/deliveries", { channel: "tree" })).toBe('json: unknown field "channel"');
  expect(strictRefusal("mail/deliveries/ack", { lease_token: "l", ids: ["a"] })).toBeUndefined();
});

test("the builder's side reads the spawn payload, the model and the lead's session included when Cloud names them", () => {
  const mail = (payload: unknown): TreeMail => ({ id: "m", verb: "spawn", authority: "agent", channel: "tree", from_workspace_id: "lead", to_workspace_id: "b", body: "brief", wakes: true, reply_to: null, created_at: "2026-10-21T00:00:00Z", payload });
  const today = { kind: "spawn", workspace_id: "b", session_id: "s", title: "Part", repo: "acme/widgets", base_branch: "caveman/lead", branch: "caveman/part-1", engine: "codex", lead_workspace_id: "lead" };
  expect(spawnPayloadOf(mail(today))).toEqual(today);
  expect(spawnPayloadOf(mail({ ...today, model: "gpt-5.4", lead_session_id: "lead-session" }))).toEqual({ ...today, model: "gpt-5.4", lead_session_id: "lead-session" });
  // Empty or wrong-typed extras are as absent; a payload without the builder's own rows places nothing.
  expect(spawnPayloadOf(mail({ ...today, model: "", lead_session_id: 7 }))).toEqual(today);
  expect(spawnPayloadOf(mail({ ...today, session_id: "" }))).toBeUndefined();
  expect(spawnPayloadOf({ ...mail(today), verb: "task" })).toBeUndefined();
});

test("a spawn naming a computer lands there when it is the lead's own or a Cloud computer of the tree's person: never a laptop, someone else's, or with where", async () => {
  const st = treeState();
  st.workspaces.set("lead", { id: "lead", root: "lead", parent: null, computer: "mac", status: "active", title: "Lead", repo: "acme/widgets", base_branch: "main", branch: "caveman/lead", engine: "claude-agent", session_id: "lead-session" });
  st.laptops.add("mac");
  const computers: Record<string, { laptop: boolean; person: string; deleted: boolean }> = {
    mac: { laptop: true, person: "ada", deleted: false },
    box: { laptop: false, person: "ada", deleted: false },
    "other-mac": { laptop: true, person: "ada", deleted: false },
    gone: { laptop: false, person: "ada", deleted: true },
    theirs: { laptop: false, person: "bob", deleted: false },
  };
  st.computer = (id) => computers[id];
  st.personOf = () => "ada";
  const spawn = async (key: string, extra: Record<string, unknown>) => {
    let out: { status: number; body: unknown } | undefined;
    const body = { request_id: key, from_workspace_id: "lead", title: "Part", brief: "Build it.", branch: `caveman/${key}`, engine: "codex", ...extra };
    await treeRoutes(st, { method: "POST", url: new URL("http://cloud/api/v1/code/mail/spawn"), body, computer: "mac", now: Date.now() }, (status, answer) => void (out = { status, body: answer }));
    return out!;
  };
  expect(await spawn("both", { computer_id: "box", where: "cloud" })).toMatchObject({ status: 400, body: { error: { message: "Name computer_id or where, not both." } } });
  for (const named of ["other-mac", "gone", "nobody"]) expect(await spawn(named, { computer_id: named })).toMatchObject({ status: 404, body: { error: { code: "cave_not_found" } } });
  expect(await spawn("theirs", { computer_id: "theirs" })).toMatchObject({ status: 403, body: { error: { code: "cave_code_computer_not_yours" } } });
  expect(await spawn("box", { computer_id: "box" })).toMatchObject({ status: 201, body: { workspace: { computer_id: "box" } } });
  expect(await spawn("own", { computer_id: "mac" })).toMatchObject({ status: 201, body: { workspace: { computer_id: "mac" } } });
  expect(st.spawns.map((s) => [s.computer, s.made])).toEqual([["box", false], ["mac", false]]);
  expect(st.refused).toEqual([]);
});
