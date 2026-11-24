// Where a chat can run, as every device reads it from Caveman Cloud (CONTRACT §11): This Mac's runtime against the
// test Cloud, with the stand-in Claude CLI (no model). The runtime says of each chat whether it can run somewhere else
// and the code of why not, in the chat's summary; the list a device reads carries it. A Cloud from before the fields
// refuses them once, takes the same summary without them, and is not asked again. Cloud's own half (its narrowing,
// its moves, the stream) is control-api's place_facts_test.go.
import { execFileSync } from "node:child_process";

import { connect } from "@caveman-app/session-protocol";
import { afterEach, expect, test } from "vitest";

import {
  createReady,
  makeConfig,
  makeRepo,
  MODEL,
  startRuntime,
  tempRoot,
  until,
} from "../session-protocol/testHarness.ts";
import { STAYS_CODE_FORM } from "./stays.ts";
import { startTestCloud } from "./testCloud.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** This Mac, signed in to the test Cloud, its chats saved there. */
async function syncedMac(cloud: Awaited<ReturnType<typeof startTestCloud>>) {
  const runtime = await startRuntime(await makeConfig(), "fake-claude");
  const client = connect(runtime.url, runtime.token);
  cleanups.push(async () => (client.close(), await runtime.close()));
  await client.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  await client.call("settings.set", { request_id: "s1", settings: { sync_chats: true } });
  return client;
}

/** A repository on this Mac; `github`: its origin is on GitHub, so its chats can run in Cloud. */
const repoOf = (name: string, github: boolean) => {
  const repo = makeRepo(tempRoot(`place-${name}-`), { "README.md": `${name}\n` });
  if (github)
    execFileSync("git", ["remote", "add", "origin", `https://github.com/acme/${name}.git`], {
      cwd: repo,
    });
  return repo;
};

/** The person's chat list, as a phone or a browser reads it. */
const listed = async (cloud: Awaited<ReturnType<typeof startTestCloud>>, sessionId: string) => {
  const response = await fetch(`${cloud.url}/api/v1/code/chats`, {
    headers: { authorization: `Bearer ${cloud.state.personToken}` },
  });
  expect(response.status).toBe(200);
  const list = (await response.json()) as {
    chats: ReadonlyArray<{
      session_id: string;
      movable?: boolean;
      stays?: { code: string };
      moving?: unknown;
    }>;
  };
  return list.chats.find((chat) => chat.session_id === sessionId);
};

test("a Mac's runtime says of each chat whether it can run somewhere else, and why not as a code; a device reads it from Cloud's list", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  // This Caveman runs Cloud (GET runtime/computers says so).
  cloud.state.environments.computers = true;
  const client = await syncedMac(cloud);
  const chats = cloud.state.chats;
  const said = (sessionId: string) => chats.summaryPuts.filter((p) => p.session_id === sessionId);

  // On GitHub, saved to Caveman: it can run in Cloud, once its first save landed (before that it is not saved yet).
  const free = await createReady(client, {
    request_id: "w1",
    repo: { path: repoOf("widgets", true) },
    title: "Can move",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  await until(() => said(free.session_id).at(-1)?.movable === true, 60_000);
  expect(said(free.session_id).at(-1)).not.toHaveProperty("stays");
  expect(await listed(cloud, free.session_id)).toMatchObject({ movable: true });
  expect(await listed(cloud, free.session_id)).not.toHaveProperty("stays");

  // Not on GitHub: it stays, and its summary says so with a code, never a sentence.
  const local = await createReady(client, {
    request_id: "w2",
    repo: { path: repoOf("notes", false) },
    title: "Stays here",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  await until(() => said(local.session_id).length > 0, 60_000);
  for (const put of said(local.session_id)) {
    expect(put.movable).toBe(false);
    expect(put.stays).toMatch(STAYS_CODE_FORM);
  }
  const row = await listed(cloud, local.session_id);
  expect(row).toMatchObject({ movable: false });
  expect(row?.stays?.code).toMatch(STAYS_CODE_FORM);
  // Every summary said whether its chat can move, and none named a move: nothing is on its way.
  expect(chats.summaryPuts.every((p) => p.movable !== undefined && p.moving === undefined)).toBe(
    true,
  );
  expect(chats.refused).toEqual([]);

  // What decides it changes on this Mac (it learns that nothing is connected for Claude in Cloud): the chat that
  // could move says it stays now, by itself, with no change of its own.
  const before = said(free.session_id).length;
  chats.engineLogins.set(chats.sessions.get(free.session_id)!.person, {});
  await client.call("cloud.lid.summary", {}); // this Mac reads what Cloud holds for its person
  await until(
    () => said(free.session_id).length > before && said(free.session_id).at(-1)?.movable === false,
    60_000,
  );
  expect(said(free.session_id).at(-1)?.stays).toMatch(STAYS_CODE_FORM);
  expect(await listed(cloud, free.session_id)).toMatchObject({ movable: false });
}, 360_000);

test("a Cloud from before the fields: refused once for them, the same summary lands without, and the next ones do not ask", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  cloud.state.chats.placeFactsUnknown = true;
  const client = await syncedMac(cloud);
  const chats = cloud.state.chats;

  const one = await createReady(client, {
    request_id: "w1",
    repo: { path: repoOf("older", true) },
    title: "One",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  await until(() => chats.summaries.has(one.session_id), 60_000);
  // Its strict decoder refused the summary that named them, once; the chat is listed all the same, as it was before.
  expect(
    chats.refused
      .map((r) => r.route)
      .every((route) => route === "summary" || route === "summaries"),
  ).toBe(true);
  expect(chats.refused).toHaveLength(1);
  expect(chats.summaries.get(one.session_id)).toMatchObject({
    title: "One",
    status: expect.any(String),
  });
  const row = await listed(cloud, one.session_id);
  expect(row).toBeDefined();
  expect(row).not.toHaveProperty("movable");
  expect(row).not.toHaveProperty("stays");
  expect(row).not.toHaveProperty("moving");

  // The next chat, and the first one's later summaries: none names them, so none is refused.
  const two = await createReady(client, {
    request_id: "w2",
    repo: { path: repoOf("older-two", true) },
    title: "Two",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  await until(
    () => chats.summaries.has(two.session_id) && chats.copyOf(two.session_id).length > 0,
    60_000,
  );
  expect(chats.refused).toHaveLength(1);
  expect(
    chats.summaryPuts.every(
      (p) => p.movable === undefined && p.stays === undefined && p.moving === undefined,
    ),
  ).toBe(true);
}, 240_000);
