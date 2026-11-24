import { describe, expect, it } from "vitest";

import type { AccountSession, AccountStore } from "./account.ts";
import { DESKTOP_TOKEN_ROUTE, desktopTokenOf, relayUrlOf } from "./clientToken.ts";

const jwtish = (exp: number) => `${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.sig`;

describe("cloud.client_token: the desktop's narrowed token (security review L4, C1's mint)", () => {
  const session = { cloud_url: "https://cloud.test", access_token: jwtish(Date.now() / 1000 + 900), refresh_token: "refresh-secret" };
  const store = (): AccountStore => {
    let kept: AccountSession | undefined = session;
    return { load: async () => kept, save: async (next) => void (kept = next) };
  };
  const answering = (status: number, body: unknown, seen: Array<{ url: string; method: string | undefined; auth: string | null; body: unknown }>) =>
    (async (url: string, init: RequestInit) => {
      seen.push({ url, method: init.method, auth: new Headers(init.headers).get("authorization"), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

  it("asks Cloud's mint with the sign-in's bearer and hands out the minted token, never the sign-in's own", async () => {
    const seen: Array<{ url: string; method: string | undefined; auth: string | null; body: unknown }> = [];
    const now = Date.now();
    const out = await desktopTokenOf(store(), session, now, answering(200, { token: "cvdt_narrow", expires_at: new Date(now + 3_600_000).toISOString() }, seen));
    expect(out).toEqual({ token: "cvdt_narrow", expires_at: new Date(now + 3_600_000).toISOString(), api_url: "https://cloud.test", relay_url: "wss://cloud.test/relay/v1/runtimes" });
    expect(JSON.stringify(out)).not.toContain(session.access_token);
    expect(JSON.stringify(out)).not.toContain("refresh-secret");
    expect(seen).toEqual([{ url: `https://cloud.test${DESKTOP_TOKEN_ROUTE}`, method: "POST", auth: `Bearer ${session.access_token}`, body: {} }]);
    expect(DESKTOP_TOKEN_ROUTE).toBe("/api/v1/code/desktop-token");
    // A longer expiry than an hour is cut to one.
    const long = await desktopTokenOf(store(), session, now, answering(200, { token: "cvdt_long", expires_at: new Date(now + 5 * 3_600_000).toISOString() }, []));
    expect(Date.parse(long.expires_at)).toBe(now + 3_600_000);
  });

  it("never falls back to the sign-in's access token: a missing route, a refusal or no token fails", async () => {
    await expect(desktopTokenOf(store(), session, Date.now(), answering(404, { error: { code: "cave_not_found", message: "no route" } }, []))).rejects.toThrow();
    await expect(desktopTokenOf(store(), session, Date.now(), answering(503, { error: { code: "cave_unavailable", message: "down" } }, []))).rejects.toThrow();
    await expect(desktopTokenOf(store(), session, Date.now(), answering(200, { nothing: true }, []))).rejects.toThrow();
    await expect(desktopTokenOf(store(), session, Date.now(), answering(200, { token: "cvdt_x", expires_at: "soon" }, []))).rejects.toThrow();
    expect(relayUrlOf("http://127.0.0.1:8080")).toBe("ws://127.0.0.1:8080/relay/v1/runtimes");
  });
});
