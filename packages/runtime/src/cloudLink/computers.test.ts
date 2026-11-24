// Cloud computers through the runtime's own token: a live link's token when Remote control is on,
// else one minted for the call; Cloud's refusals keep their status and sentence.
import * as crypto from "node:crypto";

import { expect, test } from "vitest";

import { createCloudWorkspace, deleteCloudComputer, listCloudComputers, setCloudComputer } from "./computers.ts";
import { runtimePlugins } from "./plugins.ts";
import type { Identity } from "./identity.ts";

const identity: Identity = {
  cloudUrl: "https://cloud.test",
  runtimeId: "0190f5c4-8a3e-7000-8000-000000000001",
  organizationId: "0190f5c4-8a3e-7000-8000-000000000002",
  computerId: "0190f5c4-8a3e-7000-8000-000000000003",
  key: crypto.generateKeyPairSync("ed25519").privateKey,
};

const computer = { id: "c1", name: "Fix login", driver: "kubernetes", size: "", desired_state: "running", observed_state: "starting", observed_reason: "", updated_at: "2026-10-16T00:00:00Z", extra: "dropped" };

function cloud(answers: Record<string, () => Response>) {
  const calls: Array<{ method: string; url: string; auth: string | null; body: unknown }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ method: init?.method ?? "GET", url, auth: headers.get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
    const answer = answers[key];
    return answer ? answer() : new Response(JSON.stringify({ error: { code: "cave_not_found", message: "no route" } }), { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("uses the live link's token, and mints one for the call when Remote control is off", async () => {
  const c = cloud({
    "GET /api/v1/code/runtime/computers": json({ computers: [computer], cloud_computers: true }),
    [`POST /api/v1/code/runtimes/${identity.runtimeId}/token`]: json({ token: "ccrt_minted", expires_at: "2099-01-01T00:00:00Z" }),
  });
  const linked = await listCloudComputers(identity, { cloudUrl: identity.cloudUrl, token: "ccrt_live" }, c.fetchImpl);
  expect(linked.available).toBe(true);
  expect(linked.computers).toEqual([{ ...computer, extra: undefined }].map(({ extra: _, ...rest }) => rest));
  expect(c.calls.map((x) => x.auth)).toEqual(["Bearer ccrt_live"]);

  await listCloudComputers(identity, {}, c.fetchImpl);
  const mint = c.calls[1]!;
  expect(mint.url).toBe(`${identity.cloudUrl}/api/v1/code/runtimes/${identity.runtimeId}/token`);
  expect(mint.body).toMatchObject({ organization_id: identity.organizationId });
  expect(c.calls[2]!.auth).toBe("Bearer ccrt_minted");
});

test("creates a workspace on a new Cloud computer and wakes or sleeps one", async () => {
  const c = cloud({
    "POST /api/v1/code/runtime/workspaces": json({ id: "w1", computer_id: "c1" }, 201),
    "POST /api/v1/code/runtime/computers/c1/sleep": json({ ...computer, desired_state: "suspended" }),
    "POST /api/v1/code/runtime/computers/c1/resume": json(computer),
  });
  const state = { cloudUrl: identity.cloudUrl, token: "ccrt_live" };
  const made = await createCloudWorkspace(identity, state, { title: "x".repeat(300), repo: "acme/api", engine: "caveman" }, c.fetchImpl);
  expect(made).toEqual({ workspace_id: "w1", computer_id: "c1", open_url: "https://cloud.test/code/" });
  expect(c.calls[0]!.body).toEqual({ title: "x".repeat(200), repo: "acme/api", base_branch: "", engine: "caveman", computer: { kind: "cloud" } });
  expect((await setCloudComputer(identity, state, "c1", "suspended", c.fetchImpl)).desired_state).toBe("suspended");
  expect((await setCloudComputer(identity, state, "c1", "running", c.fetchImpl)).desired_state).toBe("running");
});

test("a chat in one repository asks Cloud for what it always did; one in several names the others", async () => {
  const c = cloud({ "POST /api/v1/code/runtime/workspaces": json({ id: "w1", computer_id: "c1" }, 201) });
  const state = { cloudUrl: identity.cloudUrl, token: "ccrt_live" };
  const one = { title: "Fix login", repo: "acme/api", base_branch: "main", engine: "caveman", computer: { kind: "cloud" } };
  // No checkouts, or an empty list: the body is byte for byte the one from before a chat could have several.
  await createCloudWorkspace(identity, state, { title: "Fix login", repo: "acme/api", base_branch: "main", engine: "caveman" }, c.fetchImpl);
  await createCloudWorkspace(identity, state, { title: "Fix login", repo: "acme/api", base_branch: "main", engine: "caveman", checkouts: [] }, c.fetchImpl);
  expect(JSON.stringify(c.calls[0]!.body)).toBe(JSON.stringify(one));
  expect(JSON.stringify(c.calls[1]!.body)).toBe(JSON.stringify(one));
  // Several: each other repository, with its base branch only where one was asked for.
  await createCloudWorkspace(identity, state, { title: "Fix login", repo: "acme/api", base_branch: "main", engine: "caveman", checkouts: [{ repo: "acme/web", base_branch: "next" }, { repo: "acme/docs" }] }, c.fetchImpl);
  expect(c.calls[2]!.body).toEqual({ ...one, checkouts: [{ repo: "acme/web", base_branch: "next" }, { repo: "acme/docs" }] });
});

test("a chat's start goes to Cloud with its placement, and the answer says whether Cloud queued it", async () => {
  const start = { request_id: "start-1", params: { repo: { url: "https://github.com/acme/api" }, engine: "caveman", task: { text: "make the build green" } } };
  const call = { id: "k1", request_id: "start-1", method: "workspace.create", status: "queued", created_at: "2026-11-13T10:00:00Z" };
  const state = { cloudUrl: identity.cloudUrl, token: "ccrt_live" };
  const ask = (fetchImpl: typeof fetch) => createCloudWorkspace(identity, state, { title: "Fix login", repo: "acme/api", engine: "caveman", start }, fetchImpl);

  // Cloud queued it: the chat's session and the call, which the client opens the chat on.
  const queued = cloud({ "POST /api/v1/code/runtime/workspaces": json({ id: "w1", computer_id: "c1", session_id: "s1", start: { ...call, waiting: null, extra: "dropped" }, sessions: [{ id: "s1" }] }, 201) });
  expect(await ask(queued.fetchImpl)).toEqual({ workspace_id: "w1", computer_id: "c1", open_url: "https://cloud.test/code/", session_id: "s1", start: call });
  expect(queued.calls[0]!.body).toEqual({ title: "Fix login", repo: "acme/api", base_branch: "", engine: "caveman", computer: { kind: "cloud" }, start });

  // A Cloud that placed the chat and said nothing of a start (it took the field and queued none): no start in the answer.
  const ignored = cloud({ "POST /api/v1/code/runtime/workspaces": json({ id: "w1", computer_id: "c1" }, 201) });
  expect(await ask(ignored.fetchImpl)).toEqual({ workspace_id: "w1", computer_id: "c1", open_url: "https://cloud.test/code/" });
  expect(ignored.calls).toHaveLength(1);

  // A Cloud from before queued starts refuses the field as its strict decoder does: asked again without it, once.
  let asked = 0;
  const older = cloud({
    "POST /api/v1/code/runtime/workspaces": () =>
      ++asked === 1
        ? new Response(JSON.stringify({ error: { code: "cave_bad_request", message: "Invalid JSON." } }), { status: 400 })
        : new Response(JSON.stringify({ id: "w2", computer_id: "c2" }), { status: 201 }),
  });
  expect(await ask(older.fetchImpl)).toEqual({ workspace_id: "w2", computer_id: "c2", open_url: "https://cloud.test/code/" });
  expect(older.calls.map((c) => "start" in (c.body as object))).toEqual([true, false]);

  // Any other refusal of a start is Cloud's own word, said as it is and never asked again without the start.
  const refused = cloud({ "POST /api/v1/code/runtime/workspaces": json({ error: { code: "cave_code_start_not_placed", message: "A start goes with a chat Cloud places on a Cloud computer." } }, 409) });
  await expect(ask(refused.fetchImpl)).rejects.toMatchObject({ status: 409, code: "cave_code_start_not_placed" });
  expect(refused.calls).toHaveLength(1);
});

test("a refusal carries Cloud's status and sentence", async () => {
  const c = cloud({
    "POST /api/v1/code/runtime/workspaces": json({ error: { code: "cave_code_cloud_computers_off", message: "This Caveman Cloud runs no Cloud computers." } }, 409),
  });
  await expect(createCloudWorkspace(identity, { cloudUrl: identity.cloudUrl, token: "t" }, { title: "x", repo: "acme/api", engine: "caveman" }, c.fetchImpl)).rejects.toMatchObject({
    status: 409,
    message: expect.stringContaining("runs no Cloud computers"),
  });
});

test("shares one minted token across polls and concurrent calls, and mints again when Cloud refuses it", async () => {
  const own = { ...identity, cloudUrl: "https://cloud-share.test" };
  let mints = 0;
  let refuse = "";
  const c = cloud({
    "GET /api/v1/code/runtime/computers": () => json({ computers: [], cloud_computers: true })(),
    [`POST /api/v1/code/runtimes/${identity.runtimeId}/token`]: () => json({ token: `ccrt_${++mints}`, expires_at: "2099-01-01T00:00:00Z" })(),
  });
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (refuse && new Headers(init?.headers).get("authorization") === `Bearer ${refuse}`) return new Response("{}", { status: 401 });
    return c.fetchImpl(url, init);
  }) as typeof fetch;
  await Promise.all([listCloudComputers(own, {}, fetchImpl), listCloudComputers(own, {}, fetchImpl), listCloudComputers(own, {}, fetchImpl)]);
  await listCloudComputers(own, {}, fetchImpl);
  expect(mints).toBe(1);
  // The link's own mint rotated it out: one more mint, and the call goes through.
  refuse = "ccrt_1";
  await listCloudComputers(own, {}, fetchImpl);
  expect(mints).toBe(2);
  expect(c.calls.at(-1)!.auth).toBe("Bearer ccrt_2");
  expect(c.calls.at(-1)!.url).toBe("https://cloud-share.test/api/v1/code/runtime/computers?mine=true");
});

test("while the link runs, a call waits for the link's token and never mints one of its own (K14)", async () => {
  let mints = 0;
  const c = cloud({
    "GET /api/v1/code/runtime/computers": json({ computers: [], cloud_computers: true }),
    [`POST /api/v1/code/runtimes/${identity.runtimeId}/token`]: () => (mints++, json({ token: "ccrt_own", expires_at: "2099-01-01T00:00:00Z" })()),
  });
  // A claim just landed: the link is on and its first mint is on the way.
  const asked: Array<string | undefined> = [];
  const state = { cloudUrl: identity.cloudUrl, fresh: (stale: string | undefined) => (asked.push(stale), new Promise<string>((r) => setTimeout(() => r("ccrt_link"), 50))) };
  await listCloudComputers(identity, state, c.fetchImpl);
  expect(mints).toBe(0);
  expect(asked).toEqual([undefined]);
  expect(c.calls.map((x) => x.auth)).toEqual(["Bearer ccrt_link"]);
});

test("a link token Cloud refuses is replaced by the link at once and the call goes again, never failing for it (K14)", async () => {
  let mints = 0;
  const c = cloud({
    "GET /api/v1/code/runtime/computers": json({ computers: [computer], cloud_computers: true }),
    [`POST /api/v1/code/runtimes/${identity.runtimeId}/token`]: () => (mints++, json({ token: "ccrt_own", expires_at: "2099-01-01T00:00:00Z" })()),
  });
  // Cloud refuses the token the link holds: a later mint cut it to its grace, which ran out.
  const fetchImpl = (async (url: string, init?: RequestInit) =>
    new Headers(init?.headers).get("authorization") === "Bearer ccrt_cut" ? new Response(JSON.stringify({ error: { code: "cave_unauthorized", message: "Runtime token refused." } }), { status: 401 }) : c.fetchImpl(url, init)) as typeof fetch;
  const asked: Array<string | undefined> = [];
  const state = { cloudUrl: identity.cloudUrl, token: "ccrt_cut", fresh: async (stale: string | undefined) => (asked.push(stale), "ccrt_new") };
  const out = await listCloudComputers(identity, state, fetchImpl);
  expect(out.computers).toHaveLength(1);
  expect(asked).toEqual(["ccrt_cut"]);
  expect(mints).toBe(0);
  expect(c.calls.map((x) => x.auth)).toEqual(["Bearer ccrt_new"]);
});

test("reads the plugins Caveman Cloud applies to a repository; a Cloud without them is none", async () => {
  const body = {
    marketplaces: [{ id: "m1", name: "team-kit", repo: "acme/team-kit", commit: "a".repeat(40), ref: "main", status: "active" }],
    installs: [{ id: "i1", scope: "team", plugin_id: "lint@team-kit", marketplace: "team-kit", source: {}, commit: null, version: null, policy: "required", connection: "personal" }],
    project: { id: "p1", name: "Web", repos: ["github.com/acme/web", "github.com/acme/api"] },
  };
  const c = cloud({ "GET /api/v1/code/runtime/plugins": json(body) });
  const out = await runtimePlugins(identity, { cloudUrl: identity.cloudUrl, token: "ccrt_live" }, "github.com/acme/web", c.fetchImpl);
  expect(out).toMatchObject({ marketplaces: [{ name: "team-kit" }], installs: [{ plugin_id: "lint@team-kit", policy: "required" }], project: { id: "p1" } });
  expect(c.calls[0]!.auth).toBe("Bearer ccrt_live");
  expect(c.calls[0]!.url).toBe("https://cloud-share.test/api/v1/code/runtime/plugins?repository=github.com%2Facme%2Fweb".replace("https://cloud-share.test", identity.cloudUrl));
  const none = cloud({});
  expect(await runtimePlugins(identity, { cloudUrl: identity.cloudUrl, token: "ccrt_live" }, undefined, none.fetchImpl)).toBeUndefined();
});

test("a Cloud that never answers fails the call instead of holding it (C7)", async () => {
  const signals: Array<AbortSignal | undefined> = [];
  // Answers only when the call gives up: without a deadline this would hang forever.
  const fetchImpl = ((_url: string, init?: RequestInit) => {
    signals.push(init?.signal ?? undefined);
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  }) as typeof fetch;
  const pending = listCloudComputers(identity, { cloudUrl: identity.cloudUrl, token: "ccrt_live" }, fetchImpl);
  await new Promise((r) => setTimeout(r, 20));
  expect(signals[0]).toBeInstanceOf(AbortSignal);
  // The deadline is the signal's: abort it as the timer would.
  (signals[0] as unknown as { dispatchEvent(e: Event): boolean }).dispatchEvent(new Event("abort"));
  await expect(pending).rejects.toThrow("aborted");
});

test("deletes a Cloud computer through the runtime route its enroller's computers answer to (C3)", async () => {
  const c = cloud({
    "DELETE /api/v1/code/runtime/computers/c1": json({ ...computer, desired_state: "deleted" }),
    "DELETE /api/v1/code/runtime/computers/c2": json({ error: { code: "cave_not_found", message: "Computer not found." } }, 404),
  });
  const state = { cloudUrl: identity.cloudUrl, token: "ccrt_live" };
  expect(await deleteCloudComputer(identity, state, "c1", c.fetchImpl)).toMatchObject({ id: "c1", desired_state: "deleted" });
  expect(c.calls.map((x) => `${x.method} ${new URL(x.url).pathname}`)).toEqual(["DELETE /api/v1/code/runtime/computers/c1"]);
  await expect(deleteCloudComputer(identity, state, "c2", c.fetchImpl)).rejects.toMatchObject({ status: 404 });
});
