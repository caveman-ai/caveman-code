// web_fetch connects to public unicast addresses only: literal IPs are checked before each hop, names are resolved
// and pinned at connect time (so a name that changes its answer between the check and the connect still can't
// reach a private address), and a same-host redirect is checked again.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fetchPublic } from "./fetchPage.ts";
import { BlockedAddressError, isPublicUnicast, makeAddressGuard } from "./ssrf.ts";

describe("isPublicUnicast", () => {
  it.each([
    ["127.0.0.1", 4],
    ["10.1.2.3", 4],
    ["172.16.0.1", 4],
    ["192.168.1.1", 4],
    ["169.254.169.254", 4],
    ["100.64.0.1", 4],
    ["0.0.0.0", 4],
    ["224.0.0.1", 4],
    ["255.255.255.255", 4],
    ["192.0.2.10", 4],
    ["198.51.100.7", 4],
    ["::1", 6],
    ["::", 6],
    ["fd00::1", 6],
    ["fc00::5", 6],
    ["fe80::1", 6],
    ["ff02::1", 6],
    ["::ffff:127.0.0.1", 6],
    ["::ffff:169.254.169.254", 6],
    ["::ffff:0:7f00:1", 6],
    ["::ffff:0:10.0.0.1", 6],
    ["::ffff:0:5db8:d822", 6],
    ["64:ff9b::a9fe:a9fe", 6],
    ["2002:7f00:1::", 6],
    ["2001:db8::1", 6],
  ] as const)("refuses %s", (address, family) => {
    expect(isPublicUnicast(address, family)).toBe(false);
  });

  it.each([
    ["8.8.8.8", 4],
    ["1.1.1.1", 4],
    ["104.16.132.229", 4],
    ["2606:4700:4700::1111", 6],
    ["64:ff9b::808:808", 6],
  ] as const)("allows %s", (address, family) => {
    expect(isPublicUnicast(address, family)).toBe(true);
  });
});

describe("makeAddressGuard", () => {
  const blocked = (promise: Promise<unknown>) => expect(promise).rejects.toBeInstanceOf(BlockedAddressError);

  it("refuses literal private addresses, bracketed IPv6 included", async () => {
    const guard = makeAddressGuard();
    await blocked(guard.check("127.0.0.1"));
    await blocked(guard.check("169.254.169.254"));
    await blocked(guard.check("[::1]"));
    await blocked(guard.check("[fd00::1]"));
    await expect(guard.check("8.8.8.8")).resolves.toBeUndefined();
  });

  it("refuses a name that resolves to loopback through the system resolver", async () => {
    await blocked(makeAddressGuard().check("localhost"));
  });

  it("refuses a name whose answers include any private address", async () => {
    const answers: Record<string, ReadonlyArray<{ address: string; family: number }>> = {
      "metadata.test": [{ address: "169.254.169.254", family: 4 }],
      "loop.test": [{ address: "127.0.0.1", family: 4 }],
      "loop6.test": [{ address: "::1", family: 6 }],
      "ula.test": [{ address: "fd00::1", family: 6 }],
      "mixed.test": [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
      "none.test": [],
      "public.test": [{ address: "8.8.8.8", family: 4 }],
    };
    const guard = makeAddressGuard({ resolve: async (host) => answers[host] ?? [] });
    for (const host of ["metadata.test", "loop.test", "loop6.test", "ula.test", "mixed.test", "none.test"]) await blocked(guard.check(host));
    await expect(guard.check("public.test")).resolves.toBeUndefined();
  });
});

describe("fetchPublic through the guard", () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/hop") return void response.writeHead(302, { location: "/page" }).end();
      if (request.url === "/away") return void response.writeHead(301, { location: "http://169.254.169.254/latest/meta-data/" }).end();
      response.writeHead(200, { "content-type": "text/plain" }).end("hello");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());

  /** This test's server stands in for a public host: 127.0.0.1 is allowed for it and nothing else. */
  const loopbackAsPublic = (answers: () => string) =>
    makeAddressGuard({ resolve: async () => [{ address: answers(), family: 4 }], allow: (address) => address === "127.0.0.1" });

  it("pins the connection to the checked address", async () => {
    const out = await fetchPublic(new URL(`http://docs.test:${port}/page`), loopbackAsPublic(() => "127.0.0.1"), AbortSignal.timeout(5_000));
    expect(out.kind === "page" && Buffer.from(out.body).toString()).toBe("hello");
  });

  it("refuses at connect time when the name's answer changes after the check (DNS rebinding)", async () => {
    let calls = 0;
    // The check sees an allowed address; the connect's own lookup gets another.
    const guard = loopbackAsPublic(() => (calls++ === 0 ? "127.0.0.1" : "10.0.0.7"));
    await expect(fetchPublic(new URL(`http://rebind.test:${port}/page`), guard, AbortSignal.timeout(5_000))).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("checks a same-host redirect again before following it", async () => {
    let calls = 0;
    // First hop: check and connect both allowed; the redirect's check gets a private answer.
    const guard = loopbackAsPublic(() => (calls++ < 2 ? "127.0.0.1" : "192.168.0.10"));
    await expect(fetchPublic(new URL(`http://docs.test:${port}/hop`), guard, AbortSignal.timeout(5_000))).rejects.toBeInstanceOf(BlockedAddressError);
    const ok = await fetchPublic(new URL(`http://docs.test:${port}/hop`), loopbackAsPublic(() => "127.0.0.1"), AbortSignal.timeout(5_000));
    expect(ok.kind === "page" && ok.url).toBe(`http://docs.test:${port}/page`);
  });

  it("hands back a redirect to another host, never following it", async () => {
    const out = await fetchPublic(new URL(`http://docs.test:${port}/away`), loopbackAsPublic(() => "127.0.0.1"), AbortSignal.timeout(5_000));
    expect(out).toEqual({ kind: "redirect", url: `http://docs.test:${port}/away`, location: "http://169.254.169.254/latest/meta-data/" });
    // Fetching it next is refused by the address rules.
    await expect(fetchPublic(new URL(out.kind === "redirect" ? out.location : ""), loopbackAsPublic(() => "127.0.0.1"), AbortSignal.timeout(5_000))).rejects.toBeInstanceOf(BlockedAddressError);
  });
});
