import type { Client } from "@caveman-app/session-protocol/client";
import { expect, test } from "vitest";
import { cloudApi } from "./cloud-api.ts";
import { DesktopCloudToken } from "./desktop-cloud.ts";

const runtimeHanding = (tokens: Array<{ token: string; expires_at: string }>) => {
  const asked: string[] = [];
  const client = {
    call: async (method: string) => {
      asked.push(method);
      const next = tokens.shift();
      if (!next) throw new Error("not signed in");
      return { ...next, api_url: "https://cloud.test", relay_url: "wss://cloud.test/relay/v1/runtimes" };
    },
  } as unknown as Client;
  return { client, asked };
};

test("the desktop asks its runtime for a Cloud token once, and again only near its expiry", async () => {
  let now = Date.parse("2026-10-21T12:00:00.000Z");
  const { client, asked } = runtimeHanding([
    { token: "t1", expires_at: "2026-10-21T12:10:00.000Z" },
    { token: "t2", expires_at: "2026-10-21T13:00:00.000Z" },
  ]);
  const tokens = new DesktopCloudToken(() => client, () => now);
  expect(tokens.endpoint("rt-1")).toBeNull(); // no relay URL before the first token
  await Promise.all([tokens.get(), tokens.get()]);
  expect(asked).toEqual(["cloud.client_token"]);
  now += 9.5 * 60_000; // within a minute of expiring
  expect((await tokens.get()).token).toBe("t2");
  const endpoint = tokens.endpoint("rt 1")!;
  expect(endpoint.url).toBe("wss://cloud.test/relay/v1/runtimes/rt%201");
  expect(await (endpoint.token as () => Promise<string>)()).toBe("t2");
});

test("Cloud's chat routes go to Cloud's origin with the bearer, never a cookie, and a 401 asks for a new token", async () => {
  const { client } = runtimeHanding([
    { token: "old", expires_at: "2026-10-21T13:00:00.000Z" },
    { token: "new", expires_at: "2026-10-21T13:00:00.000Z" },
  ]);
  const tokens = new DesktopCloudToken(() => client, () => Date.parse("2026-10-21T12:00:00.000Z"));
  const seen: Array<{ url: string; auth: string | undefined; credentials: RequestCredentials | undefined }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).authorization;
    seen.push({ url, auth, credentials: init.credentials });
    return auth === "Bearer new" ? Response.json({ chats: [], runtimes: [], seq: 3 }) : new Response("", { status: 401 });
  }) as typeof fetch;
  const api = cloudApi(tokens.auth(), fetchImpl);
  await expect(api.list()).resolves.toEqual({ chats: [], runtimes: [], seq: 3 });
  expect(seen).toEqual([
    { url: "https://cloud.test/api/v1/code/chats?archived=false", auth: "Bearer old", credentials: "omit" },
    { url: "https://cloud.test/api/v1/code/chats?archived=false", auth: "Bearer new", credentials: "omit" },
  ]);
});
