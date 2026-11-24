// Update now (panels/live/OlderImage.tsx) through Cloud's routes from every device: the web tab Cloud serves on its
// session cookie, the desktop at Cloud's own origin on the bearer its runtime mints (DesktopCloudToken).
import type { Client } from "@caveman-app/session-protocol/client";
import { expect, test } from "vitest";
import { cloudApi, cookieAuth, CloudError } from "./cloud-api.ts";
import { DesktopCloudToken } from "./desktop-cloud.ts";

const recording = (status: number, body: unknown) => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { seen, fetchImpl };
};

test("on the desktop, Update now goes to Cloud's origin on the runtime's token, never a cookie", async () => {
  const client = {
    call: async () => ({ token: "tok-1", expires_at: new Date(Date.now() + 3_600_000).toISOString(), api_url: "https://cloud.test", relay_url: "wss://cloud.test/relay/v1/runtimes" }),
  } as unknown as Client;
  const { seen, fetchImpl } = recording(200, { id: "c 1" });
  await cloudApi(new DesktopCloudToken(() => client).auth(), fetchImpl).update("c 1");
  expect(seen).toHaveLength(1);
  expect(seen[0]!.url).toBe("https://cloud.test/api/v1/code/computers/c%201/update");
  expect(seen[0]!.init.method).toBe("POST");
  expect(seen[0]!.init.credentials).toBe("omit");
  expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
});

test("on the web Cloud serves, Update now rides the session cookie with the CSRF header, and a refusal reads as Cloud wrote it", async () => {
  const ok = recording(200, {});
  await cloudApi(cookieAuth(ok.fetchImpl), ok.fetchImpl).update("c1");
  expect(ok.seen[0]!.url).toBe("/api/v1/code/computers/c1/update");
  expect(ok.seen[0]!.init.credentials).toBe("same-origin");
  expect((ok.seen[0]!.init.headers as Record<string, string>)["x-cave-csrf"]).toBe("1");
  expect(JSON.stringify(ok.seen[0]!.init.headers)).not.toMatch(/authorization/i);
  const refused = recording(409, { error: { code: "cave_code_computer_pinned", message: "This computer is pinned to its build." } });
  const error = await cloudApi(cookieAuth(refused.fetchImpl), refused.fetchImpl).update("c1").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CloudError);
  expect((error as CloudError).message).toBe("This computer is pinned to its build.");
});
