// ), apps/server/src/auth/utils.test.ts @ ab3a3cd1.
import { describe, expect, it } from "vitest";

import {
  deriveAuthClientMetadata,
  isRemoteReachableHost,
  resolveSessionCookieName,
  signPayload,
  timingSafeEqualBase64Url,
} from "./utils.ts";

describe("deriveAuthClientMetadata", () => {
  it("labels Electron user agents as Electron instead of Chrome", () => {
    const metadata = deriveAuthClientMetadata({
      request: {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) t3code/0.0.15 Chrome/136.0.7103.93 Electron/36.3.2 Safari/537.36",
        },
        source: {
          remoteAddress: "::ffff:127.0.0.1",
        },
      } as never,
    });

    expect(metadata).toMatchObject({
      browser: "Electron",
      deviceType: "desktop",
      ipAddress: "127.0.0.1",
      os: "macOS",
    });
  });

  it("applies client-presented display identity without replacing transport metadata", () => {
    const metadata = deriveAuthClientMetadata({
      request: {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136.0.7103.93 Electron/36.3.2 Safari/537.36",
        },
        source: {
          remoteAddress: "::ffff:192.168.213.72",
        },
      } as never,
      presented: {
        label: "Caveman Code Mobile",
        deviceType: "mobile",
        os: "iOS",
      },
    });

    expect(metadata).toMatchObject({
      label: "Caveman Code Mobile",
      browser: "Electron",
      deviceType: "mobile",
      ipAddress: "192.168.213.72",
      os: "iOS",
    });
    expect(metadata.userAgent).toContain("Electron/36.3.2");
  });
});

describe("session cookie isolation", () => {
  it("isolates loopback web servers by port and server state", () => {
    const first = resolveSessionCookieName({
      mode: "web",
      port: 5775,
      host: "127.0.0.1",
      instanceKey: "/tmp/t3-agent-one",
      environmentId: "environment-one",
      development: true,
    });
    const second = resolveSessionCookieName({
      mode: "web",
      port: 5775,
      host: "127.0.0.1",
      instanceKey: "/tmp/t3-agent-two",
      environmentId: "environment-two",
      development: true,
    });

    expect(first).toMatch(/^t3_session_5775_[a-f0-9]{12}$/);
    expect(second).toMatch(/^t3_session_5775_[a-f0-9]{12}$/);
    expect(first).not.toBe(second);
  });

  it("isolates remote web servers by server state", () => {
    const first = resolveSessionCookieName({
      mode: "web",
      port: 3773,
      host: "192.168.1.50",
      instanceKey: "/srv/t3-one",
      environmentId: "environment-one",
      development: false,
    });
    const second = resolveSessionCookieName({
      mode: "web",
      port: 5775,
      host: "192.168.1.50",
      instanceKey: "/srv/t3-two",
      environmentId: "environment-two",
      development: false,
    });

    expect(first).toMatch(/^t3_session_[a-f0-9]{12}$/);
    expect(second).toMatch(/^t3_session_[a-f0-9]{12}$/);
    expect(first).not.toBe(second);
  });

  it("keeps a remote web server cookie stable across port changes", () => {
    const first = resolveSessionCookieName({
      mode: "web",
      port: 8080,
      host: "0.0.0.0",
      instanceKey: "/srv/t3",
      environmentId: "environment-one",
      development: false,
    });
    const second = resolveSessionCookieName({
      mode: "web",
      port: 9090,
      host: "app.example.com",
      instanceKey: "/srv/t3",
      environmentId: "environment-one",
      development: false,
    });

    expect(first).toBe(second);
  });

  it("retains desktop port scoping", () => {
    expect(
      resolveSessionCookieName({
        mode: "desktop",
        port: 3773,
        host: "127.0.0.1",
        instanceKey: "/tmp/desktop",
        environmentId: "environment-one",
        development: true,
      }),
    ).toBe("t3_session_3773");
  });

  it("isolates development servers even when they bind a wildcard host", () => {
    expect(
      resolveSessionCookieName({
        mode: "web",
        port: 5775,
        host: "0.0.0.0",
        instanceKey: "/tmp/t3-wildcard-dev",
        environmentId: "environment-one",
        development: true,
      }),
    ).toMatch(/^t3_session_5775_[a-f0-9]{12}$/);
  });

  it("classifies loopback aliases separately from remotely reachable hosts", () => {
    expect(isRemoteReachableHost(undefined)).toBe(false);
    expect(isRemoteReachableHost("localhost")).toBe(false);
    expect(isRemoteReachableHost("127.12.0.1")).toBe(false);
    expect(isRemoteReachableHost("[::1]")).toBe(false);
    expect(isRemoteReachableHost("0.0.0.0")).toBe(true);
    expect(isRemoteReachableHost("192.168.1.50")).toBe(true);
  });
});

describe("timingSafeEqualBase64Url", () => {
  it("matches a signature only in the exact spelling it was issued in", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const signature = signPayload("payload", new Uint8Array(32).fill(7));
    const respellings = {
      padding: `${signature}=`,
      "junk after it": `${signature}!!`,
      "leading space": ` ${signature}`,
      "junk inside it": `${signature.slice(0, 10)}*${signature.slice(10)}`,
      // 32 bytes leave the last of 43 characters two bits that decoding drops.
      "a flipped spare bit": `${signature.slice(0, -1)}${
        alphabet[alphabet.indexOf(signature.at(-1)!) ^ 1]
      }`,
    };

    expect(timingSafeEqualBase64Url(signature, signature)).toBe(true);
    expect(
      Object.entries(respellings)
        .filter(([, respelled]) => timingSafeEqualBase64Url(respelled, signature))
        .map(([spelling]) => spelling),
    ).toEqual([]);
  });
});
