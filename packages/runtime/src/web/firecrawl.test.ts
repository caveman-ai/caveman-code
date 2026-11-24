// Firecrawl on the wire: what a read asks for (markdown, kept out of its cache, PDFs capped), what it makes of the
// answer, and how its refusals read: a 401 is the key, a 403 the page, a 402 credits, and a page that answered
// Firecrawl with an error is no page.
import { describe, expect, it } from "vitest";

import {
  checkFirecrawlKey,
  firecrawlCloud,
  looksUnrendered,
  MAX_PDF_PAGES,
  runFirecrawlScrape,
} from "./firecrawl.ts";
import { WebProviderError } from "./providers.ts";

const KEY = "fc-0123456789abcdef0123";

/** A fetch that answers `body` with `status`, noting each request. */
const answering = (status: number, body: unknown) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, impl };
};

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(WebProviderError);
      return error as WebProviderError;
    },
  );

describe("runFirecrawlScrape", () => {
  it("asks for the page as markdown, kept out of Firecrawl's cache, PDFs capped, and reads the answer", async () => {
    const { calls, impl } = answering(200, {
      success: true,
      data: {
        markdown: "# Docs\n\nText.",
        metadata: {
          title: ["Docs", "Other"],
          url: "https://docs.example.com/final#top",
          statusCode: 200,
        },
      },
    });
    const page = await runFirecrawlScrape(
      firecrawlCloud(KEY),
      "https://docs.example.com/start",
      undefined,
      impl,
    );
    expect(page).toEqual({
      url: "https://docs.example.com/final",
      title: "Docs",
      markdown: "# Docs\n\nText.",
    });
    expect(calls[0]!.url).toBe("https://api.firecrawl.dev/v2/scrape");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toMatchObject({
      url: "https://docs.example.com/start",
      formats: ["markdown"],
      onlyMainContent: true,
      storeInCache: false,
    });
    expect(body.parsers).toEqual([{ type: "pdf", mode: "fast", maxPages: MAX_PDF_PAGES }]);
  });

  it("keeps the address asked for when Firecrawl names no usable final one", async () => {
    const { impl } = answering(200, {
      data: { markdown: "Text.", metadata: { url: "javascript:alert(1)" } },
    });
    expect(
      (await runFirecrawlScrape(firecrawlCloud(KEY), "https://docs.example.com/a", undefined, impl))
        .url,
    ).toBe("https://docs.example.com/a");
  });

  it("says a page that answered Firecrawl with an error, or held no text, is no page", async () => {
    const blocked = await failure(
      runFirecrawlScrape(
        firecrawlCloud(KEY),
        "https://x.example.com",
        undefined,
        answering(200, { data: { markdown: "Denied", metadata: { statusCode: 403 } } }).impl,
      ),
    );
    expect([blocked.kind, blocked.status]).toEqual(["invalid", 403]);
    expect(
      (
        await failure(
          runFirecrawlScrape(
            firecrawlCloud(KEY),
            "https://x.example.com",
            undefined,
            answering(200, { data: { markdown: "  " } }).impl,
          ),
        )
      ).kind,
    ).toBe("invalid");
  });

  it("reads its refusals: 401 the key, 403 the page, 402 and 429 a limit, 5xx an outage", async () => {
    const kind = async (status: number) =>
      (
        await failure(
          runFirecrawlScrape(
            firecrawlCloud(KEY),
            "https://x.example.com",
            undefined,
            answering(status, { success: false, error: "No." }).impl,
          ),
        )
      ).kind;
    expect(await kind(401)).toBe("auth");
    expect(await kind(403)).toBe("invalid");
    expect(await kind(402)).toBe("limit");
    expect(await kind(429)).toBe("limit");
    expect(await kind(502)).toBe("unavailable");
    const unreachable = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(
      (
        await failure(
          runFirecrawlScrape(firecrawlCloud(KEY), "https://x.example.com", undefined, unreachable),
        )
      ).kind,
    ).toBe("unavailable");
  });
});

describe("checkFirecrawlKey", () => {
  it("asks for the credit balance, which costs nothing, and fails on a refused key", async () => {
    const { calls, impl } = answering(200, { success: true, data: { remainingCredits: 1000 } });
    await checkFirecrawlKey(KEY, impl);
    expect(calls[0]!.url).toBe("https://api.firecrawl.dev/v2/team/credit-usage");
    const refused = await failure(
      checkFirecrawlKey(KEY, answering(401, { error: "Unauthorized: Invalid token" }).impl),
    );
    expect([refused.kind, refused.message]).toEqual(["auth", "401: Unauthorized: Invalid token"]);
  });
});

describe("looksUnrendered", () => {
  const page = (markdown: string) => ({ url: "https://x.example.com", title: "x", markdown });

  it("takes a near-empty page or a script or bot-check notice for a page a browser must render", () => {
    expect(looksUnrendered(page(""))).toBe(true);
    expect(
      looksUnrendered(page("[Home](https://x.example.com/) [Docs](https://x.example.com/docs)")),
    ).toBe(true);
    expect(
      looksUnrendered(
        page(`You need to enable JavaScript to run this app. ${"Footer words. ".repeat(30)}`),
      ),
    ).toBe(true);
    expect(
      looksUnrendered(
        page(`# Guide\n\n${"The guide explains the options in plain words. ".repeat(10)}`),
      ),
    ).toBe(false);
    // A long page that mentions JavaScript is just a page.
    expect(
      looksUnrendered(
        page(
          `Enable JavaScript in your bundler config. ${"More words on the topic. ".repeat(100)}`,
        ),
      ),
    ).toBe(false);
  });
});
