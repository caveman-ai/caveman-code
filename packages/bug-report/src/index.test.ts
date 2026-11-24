import { describe, expect, it } from "vitest";

import {
  BUG_REPORT_LIMITS,
  redact,
  REDACTION_RULES,
  REDACTION_VERSION,
  rulesOf,
  templateDraft,
} from "./index.ts";

const ctx = { homeDir: "/Users/ada", userName: "ada" };
const clean = (text: string, extra: Parameters<typeof redact>[1] = {}) =>
  redact(text, { ...ctx, ...extra }).text;

describe("redaction rules", () => {
  it("is versioned and names every rule it runs", () => {
    expect(REDACTION_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(redact("x", ctx).rules).toEqual(REDACTION_RULES);
    expect(redact("x", { ...ctx, keepCode: true }).rules).not.toContain("code_block");
  });

  it.each([
    ["anthropic_key", ("key sk-" + "ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abc")],
    ["openai_key", ("using sk-" + "proj-AbCdEfGhIjKlMnOpQrStUvWx0123456789")],
    ["openai_key", "using sk-AbCdEfGhIjKlMnOpQrStUvWx0123456789"],
    ["github_token", ("push with gh" + "p_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")],
    ["github_token", ("token github_" + "pat_11AAAAAAA0abcdefghijklmnopqrstuv")],
    ["aws_access_key", ("id AK" + "IAIOSFODNN7EXAMPLE here")],
    ["google_api_key", ("AI" + "zaSyA-1234567890abcdefghijklmnopqrstu")],
    ["slack_token", ("xox" + "b-1234567890-abcdefghij")],
    ["stripe_key", ("sk_" + "live_4eC39HqLyjWDarjtT1zdp7dc")],
    [
      "jwt",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ],
    ["caveman_key", "cave_live_abcdefghijklmnop1234"],
  ])("removes a %s", (rule, text) => {
    const out = redact(text, ctx);
    expect(out.counts[rule]).toBeGreaterThan(0);
    expect(out.text).toContain(`[REDACTED:${rule}]`);
  });

  it("removes bearer and authorization headers, keeping the scheme", () => {
    expect(clean("GET / Bearer abcDEF123456789.xyz")).toBe("GET / Bearer [REDACTED:bearer]");
    expect(clean('{"authorization":"Bearer abc123def456ghi"}')).toBe(
      '{"authorization":"[REDACTED:auth_header]"}',
    );
    expect(clean("x-api-key: 0123456789abcdef")).toBe("x-api-key: [REDACTED:auth_header]");
    expect(clean("Cookie: session=abc; other=def")).toBe("Cookie: [REDACTED:auth_header]");
    // Prose with the word "Token" and no secret stays.
    expect(clean("Token budget exceeded for this model")).toBe(
      "Token budget exceeded for this model",
    );
  });

  it("removes every .env value and values under secret names, not token counts", () => {
    expect(clean("OPENAI_API_KEY=abc\nexport DATABASE_URL=postgres://u:p@h/db\nPORT=3000")).toBe(
      "OPENAI_API_KEY=[REDACTED:env_value]\nexport DATABASE_URL=[REDACTED:env_value]\nPORT=[REDACTED:env_value]",
    );
    expect(
      clean('{"refresh_token": "r-abc-123-xyz", "input_tokens": 523, "has_token": true}'),
    ).toBe(
      '{"refresh_token": "[REDACTED:secret_assignment]", "input_tokens": 523, "has_token": true}',
    );
    expect(clean("login --password hunter2hunter -v")).toBe(
      "login --password [REDACTED:secret_flag] -v",
    );
    expect(clean("password=hunter2hunter")).toBe("password=[REDACTED:secret_assignment]");
    expect(clean("client_secret: 'abc def ghi'")).toBe(
      "client_secret: '[REDACTED:secret_assignment]'",
    );
  });

  it("removes credentials in URLs and secret query parameters", () => {
    expect(clean("clone https://bob:pa55@github.com/acme/x.git")).toBe(
      "clone https://[REDACTED:url_credentials]@github.com/acme/x.git",
    );
    expect(clean("GET https://api.x.com/cb?code=abc123&state=ok&access_token=zz9")).toBe(
      "GET https://api.x.com/cb?code=[REDACTED:secret_query]&state=ok&access_token=[REDACTED:secret_query]",
    );
  });

  it("removes private keys whole", () => {
    const key =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAA\n-----END OPENSSH PRIVATE KEY-----";
    expect(clean(`before\n${key}\nafter`)).toBe("before\n[REDACTED:private_key]\nafter");
  });

  it("removes emails", () => {
    expect(clean("signed in as ada.lovelace+x@example.co.uk ok")).toBe(
      "signed in as [REDACTED:email] ok",
    );
  });

  it("removes the home directory and any user name in paths", () => {
    expect(clean("open /Users/ada/code/app/src/main.ts")).toBe("open ~/code/app/src/main.ts");
    expect(clean("open /home/grace/x and /Users/Shared/y")).toBe(
      "open /home/<user>/x and /Users/Shared/y",
    );
    expect(clean(String.raw`at C:\Users\linus\proj\a.js`)).toBe(
      String.raw`at C:\Users\<user>\proj\a.js`,
    );
    expect(clean(String.raw`"cwd":"C:\\Users\\linus\\proj"`)).toBe(
      String.raw`"cwd":"C:\\Users\\<user>\\proj"`,
    );
    expect(clean("/Volumes/data/ada/projects", {})).toBe("/Volumes/data/<user>/projects");
    // A user name that is not a path segment is left alone.
    expect(clean("adapter started")).toBe("adapter started");
  });

  it("removes code and diffs unless the person opts in", () => {
    const text =
      "the agent wrote:\n```ts\nconst secretSauce = 1;\nexport {}\n```\ndone\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\nnext line";
    const out = redact(text, ctx);
    expect(out.text).toBe(
      "the agent wrote:\n[code removed: 4 lines]\ndone\n[diff removed: 6 lines]\nnext line",
    );
    expect(out.counts.code_block).toBe(2);
    expect(redact(text, { ...ctx, keepCode: true }).text).toBe(text);
  });

  it("cuts long lines", () => {
    const out = clean("a".repeat(BUG_REPORT_LIMITS.lineChars + 50));
    expect(out).toHaveLength(
      BUG_REPORT_LIMITS.lineChars + " [line cut: 50 more characters]".length,
    );
  });

  it("is idempotent", () => {
    const text =
      ("Bearer abcdef123456 sk-" + "ant-xxxxxxxxxxxxxxx ada@x.io /Users/ada/a TOKEN=1 ```\ncode\n```");
    const once = clean(text);
    expect(clean(once)).toBe(once);
  });

  it("collects the rules that ran over several texts", () => {
    expect(
      rulesOf([redact("a", { keepCode: true }), redact("b", { keepCode: true })]),
    ).not.toContain("code_block");
    expect(rulesOf([redact("a", { keepCode: true }), redact("b")])).toContain("code_block");
  });
});

describe("templateDraft", () => {
  it("drafts from the error, redacted and within the title limit", () => {
    const draft = templateDraft(
      {
        surface: "onboarding",
        error: { name: "TypeError", message: `fetch failed for ada@x.io ${"x".repeat(200)}` },
      },
      ctx,
    );
    expect(draft.title.startsWith("Onboarding: TypeError: fetch failed for [REDACTED:email]")).toBe(
      true,
    );
    expect(draft.title.length).toBeLessThanOrEqual(BUG_REPORT_LIMITS.titleChars);
    expect(draft.summary).toContain("Steps to reproduce");
  });

  it("drafts without an error", () => {
    expect(templateDraft({ surface: "other" }).title).toBe("App: a problem to report");
  });
});
