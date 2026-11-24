// Secret containment where whole texts leave (.claude/skills/secret-containment): the egress scrub's request bodies
// in every content-encoding, the stored-event shortcut (mayChangeJson) that sends JSON without parsing it, and the
// swap of a stand-in for a real credential, which may happen only toward that credential's own target.
import * as NodeZlib from "node:zlib";

import { createScrubber, type Scrubber } from "@caveman-app/session-protocol";
import { sequences } from "@caveman-app/model-check";
import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import { accountVault } from "../cloudLink/accountCredentials.ts";
import {
  ALL,
  jsonEscaped,
  leakIn,
  LONG_TEXTS,
  plantedText,
  productionScrubber,
  SECRET,
  SHORT_TEXTS,
} from "./testing.ts";
import { followedEndpoint, scrubBody } from "./EgressScrub.ts";

const TEXTS = [...SHORT_TEXTS, ...LONG_TEXTS];

/** Every content-encoding decodeBody knows, alone and stacked (the header lists them in the order they were applied). */
const ENCODINGS: ReadonlyArray<
  readonly [header: string | undefined, encode: (body: Buffer) => Buffer]
> = [
  [undefined, (b) => b],
  ["identity", (b) => b],
  ["gzip", (b) => NodeZlib.gzipSync(b)],
  ["x-gzip", (b) => NodeZlib.gzipSync(b)],
  ["deflate", (b) => NodeZlib.deflateSync(b)],
  ["br", (b) => NodeZlib.brotliCompressSync(b)],
  ["zstd", (b) => NodeZlib.zstdCompressSync(b)],
  ["gzip, br", (b) => NodeZlib.brotliCompressSync(NodeZlib.gzipSync(b))],
  ["GZIP , identity", (b) => NodeZlib.gzipSync(b)],
];

/** Where a secret sits in a model request: a message's text, and a tool result that is itself JSON (escaped twice). */
const BODIES: ReadonlyArray<readonly [name: string, body: (text: string) => unknown]> = [
  ["message text", (text) => ({ model: "m", messages: [{ role: "user", content: text }] })],
  [
    "tool result holding JSON",
    (text) => ({
      model: "m",
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", content: JSON.stringify({ stdout: text }) }],
        },
      ],
    }),
  ],
];

describe("scrubBody: a request body leaves with no secret in it, whatever its encoding", () => {
  it("every planted text, in every body shape and content-encoding (exhaustive over the corpus)", () => {
    const scrubber = productionScrubber();
    let cases = 0;
    for (const planted of TEXTS) {
      for (const [shape, body] of BODIES) {
        const json = JSON.stringify(body(plantedText(planted)));
        for (const [header, encode] of ENCODINGS) {
          const sent = scrubBody(encode(Buffer.from(json, "utf8")), header, scrubber).toString(
            "utf8",
          );
          expect(
            leakIn(sent),
            `${planted.name}, ${shape}, ${header ?? "no encoding"}`,
          ).toBeUndefined();
          expect(
            () => JSON.parse(sent),
            `${planted.name}, ${shape}, ${header}: the scrubbed body is still JSON`,
          ).not.toThrow();
          if (planted.form === "")
            expect(sent, `${planted.name}: nothing to hide, nothing changed`).toBe(json);
          cases++;
        }
      }
    }
    console.log(
      `[secret-containment] scrubBody: ${cases} bodies (${TEXTS.length} texts x ${BODIES.length} shapes x ${ENCODINGS.length} encodings)`,
    );
  });

  it("fails closed: an unknown encoding, a body that is not UTF-8, a corrupt stream", () => {
    const scrubber = productionScrubber();
    const body = Buffer.from(JSON.stringify({ content: SECRET.SHORT }));
    expect(() => scrubBody(body, "compress", scrubber)).toThrow(/unsupported content-encoding/);
    expect(() =>
      scrubBody(
        Buffer.concat([Buffer.from(SECRET.SHORT!), Buffer.from([0xff, 0xfe])]),
        undefined,
        scrubber,
      ),
    ).toThrow();
    expect(() => scrubBody(body, "gzip", scrubber)).toThrow();
  });
});

/** Pieces that recombine into every secret form, JSON's escapes and wrapped base64: what a stored event's strings are made of. */
const basic = Buffer.from(`u:${SECRET.SHORT}`, "utf8").toString("base64");
const FRAGMENTS: ReadonlyArray<string> = [
  "Ab3d",
  "Ef9h",
  "Pw9x!",
  "secret",
  "pässwört-",
  "Ünï",
  jsonEscaped(SECRET.QUOTED!).slice(0, 6),
  jsonEscaped(SECRET.QUOTED!).slice(6),
  basic.slice(0, 8),
  basic.slice(8),
  "sk-ant-",
  "Zq81xWv0",
  "\n",
  "\r\n",
  "\\",
  '"',
  "\\n",
  "ok",
];

describe("mayChangeJson: a stored event sent without a parse never carries a secret", () => {
  const scrubbers: ReadonlyArray<readonly [string, Scrubber]> = [
    ["chainScrubbers(store, tokens)", productionScrubber()],
    ["createScrubber(all)", createScrubber(ALL)],
  ];
  const holds = (scrubber: Scrubber, text: string) => {
    for (const value of [{ text }, { [text]: 1 }, [text, { nested: [text] }]]) {
      const json = JSON.stringify(value);
      if (scrubber.mayChangeJson!(json)) continue;
      expect(leakIn(json), `mayChangeJson said no, and ${json} went out as it is`).toBeUndefined();
      expect(
        scrubber.scrubDeep(value),
        `mayChangeJson said no, but scrubDeep changes ${json}`,
      ).toEqual(value);
    }
  };

  for (const [name, scrubber] of scrubbers) {
    it(`${name}: every string of up to 3 fragments (exhaustive)`, () => {
      let strings = 0;
      for (const parts of sequences(FRAGMENTS, 3)) {
        holds(scrubber, parts.join(""));
        strings++;
      }
      console.log(
        `[secret-containment] mayChangeJson, ${name}: ${strings} strings x 3 JSON shapes, exhaustive to 3 fragments`,
      );
    });

    it.prop(
      `${name}: longer strings of up to 10 fragments (sampled)`,
      [
        Arbitrary.array(
          Arbitrary.schema(Schema.Literals(FRAGMENTS as [string, ...Array<string>])),
          { maxLength: 10 },
        ),
      ],
      ([parts]) => holds(scrubber, parts.join("")),
      { arbitrary: { runs: 1500, seed: 20261106 } },
    );
  }
});

describe("followedEndpoint: a followed sign-in's token goes only to its provider, on an endpoint its CLI uses", () => {
  /** The endpoints the pinned CLIs call (EgressScrub.ts FOLLOWED_ENDPOINTS' doc), as the spec of where a token may go. */
  const expected = (engine: "claude-agent" | "codex", method: string | undefined, target: URL) => {
    const provider =
      engine === "claude-agent"
        ? { host: "api.anthropic.com", root: "" }
        : { host: "chatgpt.com", root: "/backend-api/codex" };
    if (
      target.protocol !== "https:" ||
      target.hostname !== provider.host ||
      target.port !== "" ||
      target.username !== "" ||
      target.password !== ""
    )
      return false;
    if (!target.pathname.startsWith(`${provider.root}/`)) return false;
    const at = target.pathname.slice(provider.root.length);
    if (engine === "claude-agent") {
      if (method === "POST")
        return ["/v1/messages", "/v1/messages/count_tokens", "/v1/messages/cache_touch"].includes(
          at,
        );
      if (method === "GET")
        return (
          at === "/v1/models" ||
          (at.startsWith("/v1/models/") &&
            /^[A-Za-z0-9._@-]+$/.test(at.slice("/v1/models/".length)))
        );
      return false;
    }
    if (method === "POST") return at === "/responses" || at === "/responses/compact";
    return method === "GET" && at === "/models";
  };
  const ORIGINS = [
    "https://api.anthropic.com",
    "https://api.anthropic.com:443",
    "https://API.Anthropic.COM",
    "http://api.anthropic.com",
    "https://api.anthropic.com:8443",
    "https://api.anthropic.com.",
    "https://api.anthropic.com.evil.net",
    "https://evil.net",
    "https://chatgpt.com",
    "https://chatgpt.com:444",
    "https://chatgpt.com.evil.net",
    "wss://chatgpt.com",
  ];
  const PATHS = [
    "/v1/messages",
    "/v1/messages/",
    "/v1/messages?beta=true",
    "/v1/messages/count_tokens",
    "/v1/messages/cache_touch",
    "/v1/messages/batches",
    "/v1/messages/../oauth/token",
    "/v1/%2e%2e/v1/messages",
    "/v1/messages%2F..%2Foauth",
    "/v1//messages",
    "/V1/messages",
    "/v1/models",
    "/v1/models/claude-x@2026",
    "/v1/models/a/b",
    "/v1/models/%2e%2e",
    "/v1/files",
    "/backend-api/codex/responses",
    "/backend-api/codex/responses/compact",
    "/backend-api/codex/models",
    "/backend-api/codex/../codex/responses",
    "/backend-api/codex%2Fresponses",
    "/backend-api/codex/responses/../../conversation",
    "/backend-api/conversation",
    "/responses",
  ];
  const METHODS = ["POST", "GET", "PUT", "DELETE", undefined];

  it("matches the endpoint table over every origin, path and method in the corpus (exhaustive)", () => {
    let cases = 0;
    for (const engine of ["claude-agent", "codex"] as const) {
      for (const origin of ORIGINS) {
        for (const path of PATHS) {
          const target = new URL(origin + path);
          for (const method of METHODS) {
            expect(
              followedEndpoint(engine, method, target),
              `${engine} ${method} ${target.href}`,
            ).toBe(expected(engine, method, target));
            cases++;
          }
        }
      }
    }
    console.log(`[secret-containment] followedEndpoint: ${cases} (engine, method, URL) cases`);
  });
});

describe("accountVault: a stand-in becomes its real value only toward that value's own target", () => {
  const REAL = ("rk_" + "live_REALhostbound42");
  const TOKEN = "bearer-REAL-static-77";
  const HOSTS = ["api.stripe.com", "*.example.com"];
  const MATCH_URL = "https://mcp.example.com/mcp";
  const OAUTH_URL = "https://oauth.example.com/v2/";

  /** CONTRACT-CHANGES.md A1: an exact name, or `*.x.com` for subdomains of x.com; the scheme is not part of it. */
  const hostIsListed = (hostname: string) => {
    const name = hostname.toLowerCase().replace(/\.$/, "");
    return HOSTS.some((entry) =>
      entry.startsWith("*.")
        ? name.endsWith(entry.slice(1)) && name !== entry.slice(2)
        : name === entry,
    );
  };
  /** Same scheme, host and port (default ports filled in), and a path at or below match_url's by whole segments. */
  const under = (url: string, matchUrl: string) => {
    const port = (u: URL) =>
      u.port ||
      ({ "https:": "443", "http:": "80", "wss:": "443", "ws:": "80" } as Record<string, string>)[
        u.protocol
      ] ||
      "";
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return false;
    }
    const match = new URL(matchUrl);
    if (
      target.protocol !== match.protocol ||
      target.hostname !== match.hostname ||
      port(target) !== port(match)
    )
      return false;
    const want = match.pathname.split("/").filter(Boolean);
    const got = target.pathname.split("/");
    return want.every((segment, i) => got[i + 1] === segment);
  };
  const TARGETS = [
    "https://api.stripe.com/v1/charges",
    "https://API.STRIPE.COM/v1",
    "https://api.stripe.com./v1",
    "http://api.stripe.com/v1",
    "https://api.stripe.com:8443/v1",
    "https://api.stripe.com.evil.net/v1",
    "https://evilapi.stripe.com/",
    "https://x.api.stripe.com/",
    "https://stripe.com/",
    "https://example.com/",
    "https://a.example.com/",
    "https://a.b.example.com/",
    "https://aexample.com/",
    "https://example.com.evil.net/",
    "https://evil.net/?host=api.stripe.com",
    "https://api.stripe.com@evil.net/",
    "https://evil.net#@api.stripe.com",
    "https://evil.net\\@api.stripe.com",
    "https://xn--80ak6aa92e.com/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "wss://a.example.com/socket",
  ];
  const URLS = [
    "https://mcp.example.com/mcp",
    "https://mcp.example.com/mcp/",
    "https://mcp.example.com/mcp/tools",
    "https://mcp.example.com:443/mcp",
    "https://MCP.example.com/mcp",
    "https://mcp.example.com/mcpx",
    "https://mcp.example.com/mcp/../admin",
    "https://mcp.example.com/mcp/%2e%2e/admin",
    "https://mcp.example.com/mcp%2F..%2Fadmin",
    "https://mcp.example.com/MCP",
    "https://mcp.example.com/",
    "http://mcp.example.com/mcp",
    "https://mcp.example.com:8443/mcp",
    "https://mcp.example.com.evil.net/mcp",
    "https://mcp.example.com@evil.net/mcp",
    "https://evil.net/mcp?u=https://mcp.example.com/mcp",
    "wss://mcp.example.com/mcp",
    "https://oauth.example.com/v2",
    "https://oauth.example.com/v2/token",
    "https://oauth.example.com/v20",
    "not a url",
  ];

  it("swaps, bears and leases only where the contract says, over the whole corpus (exhaustive)", () => {
    try {
      const [processes] = accountVault.take(
        [{ name: "STRIPE_KEY", value: REAL, hosts: HOSTS }],
        [
          { type: "static_bearer", match_url: MATCH_URL, token: TOKEN },
          { type: "mcp_oauth", match_url: OAUTH_URL },
        ],
      );
      const standIn = processes!.value;
      expect(standIn, "processes get a stand-in, never the value").toMatch(
        /^caveman-secret-[0-9a-f]{48}$/,
      );
      const known = createScrubber(accountVault.values());
      expect(known.scrub(`${REAL} ${TOKEN}`), "every real value joins the scrubber").toBe(
        "[secret:STRIPE_KEY] [secret:SERVICE_ACCOUNT_TOKEN]",
      );

      for (const raw of TARGETS) {
        const target = new URL(raw);
        const headers = {
          authorization: `Bearer ${standIn}`,
          "x-keys": [`k=${standIn}`, "plain"],
          "x-count": 3,
        };
        const out = accountVault.swap(headers, target);
        const listed = hostIsListed(target.hostname);
        expect(out.authorization, `${raw}: authorization`).toBe(
          `Bearer ${listed ? REAL : standIn}`,
        );
        expect(out["x-keys"], `${raw}: an array header`).toEqual([
          `k=${listed ? REAL : standIn}`,
          "plain",
        ]);
        expect(out["x-count"]).toBe(3);
      }
      for (const url of URLS) {
        expect(accountVault.bearerFor(url), `${url}: static_bearer`).toBe(
          under(url, MATCH_URL) ? TOKEN : undefined,
        );
        expect(accountVault.oauthFor(url), `${url}: mcp_oauth`).toBe(
          under(url, OAUTH_URL) ? OAUTH_URL : undefined,
        );
      }

      accountVault.clear();
      expect(
        accountVault.swap(
          { authorization: `Bearer ${standIn}` },
          new URL("https://api.stripe.com/"),
        ),
        "a cleared vault swaps nothing",
      ).toEqual({ authorization: `Bearer ${standIn}` });
      expect(accountVault.bearerFor(MATCH_URL), "a cleared vault bears nothing").toBeUndefined();
      console.log(
        `[secret-containment] accountVault: ${TARGETS.length} swap targets, ${URLS.length} bearer and lease URLs`,
      );
    } finally {
      accountVault.clear();
    }
  });
});
