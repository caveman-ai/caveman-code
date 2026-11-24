// Which reader web_fetch reads pages with (docs/ "Reading through Firecrawl"). Reads a fixed set
// of real pages (docs, JavaScript apps, sites that block bots, a PDF) with each arm and checks for a phrase from the
// page's own content. Arms:
//   direct     the runtime's own request and reader (fetchPublic + toPage), what web_fetch does without Firecrawl
//   local      Firecrawl Local through the runtime's own manager (makeFirecrawlLocal), Firecrawl Cloud off
//   chromium   the runtime's headless Chromium (Playwright), the page rendered, then the runtime's reader; only with --chrome
//
//   node scripts/web-eval/readers.ts [--runs 2] [--arms direct,local,chromium] [--chrome <chrome-headless-shell>]
//
// Firecrawl Local is found as the runtime finds it (CAVEMAN_FIRECRAWL_LOCAL_BIN, PATH, ~/.cargo/bin). Prints a
// markdown table and writes every read to ~/.cache/caveman-web-eval/readers-<timestamp>.json.
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";

import { fetchPublic } from "../../src/web/fetchPage.ts";
import { findFirecrawlLocal, makeFirecrawlLocal } from "../../src/web/firecrawlLocal.ts";
import { toPage } from "../../src/web/pageText.ts";
import { makeAddressGuard } from "../../src/web/ssrf.ts";

type Kind = "docs" | "js-app" | "bot-wall" | "pdf";

/** Each page with a phrase from its main content (not a sidebar the readers drop on purpose). */
const PAGES: ReadonlyArray<{ readonly url: string; readonly kind: Kind; readonly phrase: string }> =
  [
    { kind: "docs", url: "https://nodejs.org/api/path.html", phrase: "path.join(" },
    { kind: "docs", url: "https://docs.python.org/3/library/functools.html", phrase: "lru_cache" },
    {
      kind: "docs",
      url: "https://developer.mozilla.org/en-US/docs/Web/API/AbortController",
      phrase: "abort()",
    },
    { kind: "docs", url: "https://react.dev/reference/react/useEffect", phrase: "dependencies" },
    { kind: "docs", url: "https://github.com/microsoft/playwright", phrase: "Chromium, Firefox" },
    {
      kind: "docs",
      url: "https://pkg.go.dev/net/http",
      phrase: "Package http provides HTTP client and server implementations",
    },
    { kind: "js-app", url: "https://crates.io/crates/serde", phrase: "serialization" },
    {
      kind: "js-app",
      url: "https://hub.docker.com/_/node",
      phrase: "Node.js is a JavaScript-based platform",
    },
    {
      kind: "js-app",
      url: "https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode",
      phrase: "opinionated code formatter",
    },
    {
      kind: "js-app",
      url: "https://chromewebstore.google.com/detail/react-developer-tools/fmkadmapgofadopljbjfkapdkoienihi",
      phrase: "React debugging tools",
    },
    {
      kind: "bot-wall",
      url: "https://www.npmjs.com/package/react",
      phrase: "library for building user interfaces",
    },
    { kind: "bot-wall", url: "https://pypi.org/project/requests/", phrase: "HTTP library" },
    {
      kind: "bot-wall",
      url: "https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array",
      phrase: "branch predict",
    },
    { kind: "bot-wall", url: "https://www.reddit.com/r/rust/", phrase: "rust" },
    { kind: "bot-wall", url: "https://www.producthunt.com/products/cursor", phrase: "Cursor" },
    {
      kind: "bot-wall",
      url: "https://medium.com/@karpathy/software-2-0-a64152b37c35",
      phrase: "neural network",
    },
    { kind: "pdf", url: "https://arxiv.org/pdf/1706.03762", phrase: "Transformer" },
  ];

interface Read {
  readonly arm: string;
  readonly run: number;
  readonly url: string;
  readonly kind: Kind;
  readonly ok: boolean;
  readonly ms: number;
  readonly chars: number;
  readonly error?: string;
}

const norm = (text: string) => text.replace(/\s+/g, " ").toLowerCase();

async function main() {
  const { values } = parseArgs({
    options: {
      runs: { type: "string", default: "2" },
      arms: { type: "string", default: "direct,local,chromium" },
      chrome: { type: "string" },
    },
  });
  const runs = Number(values.runs);
  const wanted = new Set(values.arms.split(","));
  const arms: Array<[string, (url: string) => Promise<string>]> = [];
  const cleanup: Array<() => Promise<void> | void> = [];

  if (wanted.has("direct")) {
    const guard = makeAddressGuard();
    cleanup.push(() => guard.dispatcher.destroy());
    arms.push([
      "direct",
      async (url) => {
        let target = new URL(url);
        // A cross-host redirect is a link web_fetch hands back; the model would read it next.
        for (let hop = 0; hop < 2; hop++) {
          const out = await fetchPublic(target, guard, AbortSignal.timeout(30_000));
          if (out.kind === "redirect") {
            target = new URL(out.location);
            continue;
          }
          return (
            await toPage({
              url: out.url,
              bodyKind: out.bodyKind,
              charset: out.charset,
              body: out.body,
            })
          ).markdown;
        }
        throw new Error("redirected twice");
      },
    ]);
  }

  if (wanted.has("local")) {
    const binary = findFirecrawlLocal();
    if (binary === undefined)
      console.error(
        "local: skipped, Firecrawl Local is not installed (cargo install firecrawl-local)",
      );
    else {
      const local = makeFirecrawlLocal({
        find: () => binary,
        home: fs.mkdtempSync(path.join(os.tmpdir(), "firecrawl-local-eval-")),
      });
      cleanup.push(() => local.close());
      arms.push([
        "local",
        async (url) => (await local.scrape(url, undefined, AbortSignal.timeout(35_000))).markdown,
      ]);
    }
  }

  if (wanted.has("chromium") && values.chrome !== undefined) {
    const { chromium } = createRequire(import.meta.url)(
      "playwright-core",
    ) as typeof import("playwright-core");
    const browser = await chromium.launch({
      executablePath: values.chrome,
      headless: true,
      args: ["--disable-gpu", "--disable-blink-features=AutomationControlled"],
      ignoreDefaultArgs: ["--enable-automation"],
    });
    cleanup.push(() => browser.close());
    // As the runtime's own headless tabs present themselves (ServerBrowserContexts.ts): plain Chrome, not HeadlessChrome.
    const probe = await browser.newPage();
    const userAgent = (await probe.evaluate(() => navigator.userAgent)).replace(
      /HeadlessChrome\/(\d+)[\d.]*/,
      (_m, major: string) => `Chrome/${major}.0.0.0`,
    );
    await probe.close();
    arms.push([
      "chromium",
      async (url) => {
        const context = await browser.newContext({
          userAgent,
          viewport: { width: 1280, height: 800 },
          locale: "en-US",
        });
        try {
          await context.route("**/*", (route) =>
            ["image", "font", "media"].includes(route.request().resourceType())
              ? route.abort()
              : route.continue(),
          );
          const page = await context.newPage();
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
          await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
          return (
            await toPage({
              url: page.url(),
              bodyKind: "html",
              charset: "utf-8",
              body: new TextEncoder().encode(await page.content()),
            })
          ).markdown;
        } finally {
          await context.close();
        }
      },
    ]);
  } else if (wanted.has("chromium"))
    console.error("chromium: skipped, pass --chrome <chrome-headless-shell>");

  const reads: Array<Read> = [];
  for (let run = 1; run <= runs; run++) {
    for (const page of PAGES) {
      for (const [arm, read] of arms) {
        const started = performance.now();
        const markdown = await read(page.url).catch((error: unknown) => error as Error);
        const ms = Math.round(performance.now() - started);
        const text = markdown instanceof Error ? "" : markdown;
        reads.push({
          arm,
          run,
          url: page.url,
          kind: page.kind,
          ok: norm(text).includes(norm(page.phrase)),
          ms,
          chars: text.length,
          ...(markdown instanceof Error ? { error: markdown.message.slice(0, 200) } : {}),
        });
        console.error(
          `${run} ${arm.padEnd(8)} ${reads.at(-1)!.ok ? "ok  " : "MISS"} ${String(ms).padStart(6)} ms ${page.url}`,
        );
      }
    }
  }
  for (const done of cleanup) await done();

  const pct = (values: ReadonlyArray<number>, q: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1)))] ?? 0;
  };
  const kinds: ReadonlyArray<Kind> = ["docs", "js-app", "bot-wall", "pdf"];
  console.log("| Reader | Read | " + kinds.join(" | ") + " | p50 ms | p90 ms |");
  console.log("|---|---|" + kinds.map(() => "---").join("|") + "|---|---|");
  for (const [arm] of arms) {
    const mine = reads.filter((r) => r.arm === arm);
    const cell = (rs: ReadonlyArray<Read>) => `${rs.filter((r) => r.ok).length}/${rs.length}`;
    console.log(
      `| ${arm} | ${cell(mine)} | ${kinds.map((k) => cell(mine.filter((r) => r.kind === k))).join(" | ")} | ${pct(
        mine.map((r) => r.ms),
        0.5,
      )} | ${pct(
        mine.map((r) => r.ms),
        0.9,
      )} |`,
    );
  }
  const out = path.join(os.homedir(), ".cache", "caveman-web-eval");
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `readers-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify({ runs, pages: PAGES, reads }, null, 2));
  console.error(`wrote ${file}`);
}

await main();
