// ), packages/shared/src/htmlRender.test.ts @ ab3a3cd1.
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  HTML_RENDER_DECK_TOKENS,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_TOKEN_NAMES,
  htmlRenderFrameHeight,
  htmlRenderReferencesEqual,
  htmlRenderTheme,
  htmlRenderThemeFragment,
  injectHtmlRenderBootstrap,
  htmlRenderThemeMessage,
  readHtmlRenderContentHeight,
  readHtmlRenderKeyDown,
  readHtmlRenderLinkRequest,
  readHtmlRenderReference,
} from "./htmlRender.ts";
import { htmlRenderFromToolItem } from "./toolOutput.ts";

const reference = { attachmentId: "thread-abc-123.html", title: "Chart", height: 420 };

describe("injectHtmlRenderBootstrap", () => {
  it("puts the theme ahead of the page's own head content", () => {
    const html =
      "<!doctype html><html><head><style>:root{--background:red}</style></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    const themeAt = injected.indexOf('<style id="t3-theme">');
    expect(themeAt).toBeGreaterThan(injected.indexOf("<head>"));
    expect(themeAt).toBeLessThan(injected.indexOf(":root{--background:red}"));
    expect(injected).toContain('<meta charset="utf-8">');
    expect(injected).toContain('name="viewport"');
  });

  it("wraps fragments without a head and keeps existing meta tags", () => {
    const fragment =
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><p>hi</p>';
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.match(/charset/g)).toHaveLength(1);
    expect(injected.match(/name="viewport"/g)).toHaveLength(1);
    expect(injected.endsWith("<p>hi</p>")).toBe(true);
  });

  it.each(["textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext"])(
    "keeps the bootstrap outside %s content",
    (tag) => {
      const fragment = `<${tag}><head><meta name="viewport"></head></${tag}>`;
      const injected = injectHtmlRenderBootstrap(fragment);
      expect(injected.startsWith("<!doctype html><head>")).toBe(true);
      expect(injected.indexOf('<style id="t3-theme">')).toBeLessThan(injected.indexOf(`<${tag}>`));
      expect(injected).toContain('<meta name="viewport" content="width=device-width');
      expect(injected.endsWith(fragment)).toBe(true);
    },
  );

  it.each([
    '<template><head><meta name="viewport"></head></template>',
    '<template><template>inner</template><head><meta name="viewport"></head></template>',
  ])("keeps the bootstrap outside inert template content: %s", (fragment) => {
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.indexOf('<style id="t3-theme">')).toBeLessThan(injected.indexOf("<template>"));
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
    expect(injected.endsWith(fragment)).toBe(true);
  });

  it("ignores tags written inside comments and scripts", () => {
    const html =
      '<!-- copy <head> and <meta name="viewport"> here --><html><head>' +
      "<script>const tag = '<meta name=\"viewport\">';</script></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    expect(injected.indexOf('<style id="t3-theme">')).toBeGreaterThan(
      injected.indexOf("<html><head>"),
    );
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
  });
});

describe("readHtmlRenderLinkRequest", () => {
  it("accepts only http(s) URLs in an MCP Apps ui/open-link request", () => {
    const link = (url: unknown, modifiers = {}) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/open-link",
      params: { url, ...modifiers },
    });
    expect(readHtmlRenderLinkRequest(link("https://example.com/a"))).toEqual({
      id: 1,
      url: "https://example.com/a",
      metaKey: false,
      ctrlKey: false,
    });
    expect(
      readHtmlRenderLinkRequest(link("https://example.com/a", { metaKey: true, ctrlKey: "yes" })),
    ).toEqual({ id: 1, url: "https://example.com/a", metaKey: true, ctrlKey: false });
    expect(readHtmlRenderLinkRequest(link("javascript:alert(1)"))).toBeUndefined();
    expect(readHtmlRenderLinkRequest(link("file:///etc/passwd"))).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest({
        jsonrpc: "2.0",
        method: "ui/open-link",
        params: { url: "https://example.com" },
      }),
    ).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest({ type: "t3-html-render-link", url: "https://example.com" }),
    ).toBeUndefined();
  });
});

describe("readHtmlRenderKeyDown", () => {
  it("reads the key of a keydown notification and nothing else", () => {
    const notification = (params: unknown) => ({
      jsonrpc: "2.0",
      method: "t3/notifications/keydown",
      params,
    });
    expect(readHtmlRenderKeyDown(notification({ key: "k", code: "KeyK", metaKey: true }))).toEqual({
      key: "k",
      code: "KeyK",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      repeat: false,
    });
    expect(readHtmlRenderKeyDown(notification({ key: 1, code: "KeyK" }))).toBeUndefined();
    expect(
      readHtmlRenderKeyDown({ jsonrpc: "2.0", method: "ui/open-link", params: { key: "k" } }),
    ).toBeUndefined();
  });
});

describe("readHtmlRenderContentHeight", () => {
  it("reads only the height of an MCP Apps size-changed notification", () => {
    const notification = (params: unknown) => ({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params,
    });
    expect(readHtmlRenderContentHeight(notification({ height: 412 }))).toBe(412);
    expect(readHtmlRenderContentHeight(notification({ height: "412" }))).toBe(undefined);
    expect(readHtmlRenderContentHeight(notification({ height: 0 }))).toBe(undefined);
    expect(readHtmlRenderContentHeight({ ...notification({ height: 412 }), method: "x" })).toBe(
      undefined,
    );
  });
});

describe("htmlRenderThemeMessage", () => {
  it("is an MCP Apps host-context-changed notification carrying the theme variables", () => {
    const theme = htmlRenderTheme(HTML_RENDER_DECK_TOKENS.dark, "dark");
    expect(htmlRenderThemeMessage(theme)).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { theme: "dark", styles: { variables: theme.variables } },
    });
  });
});

describe("htmlRenderTheme", () => {
  it("exposes the brand as --accent, the app's chart series, and a decodable fragment", () => {
    const theme = htmlRenderTheme({ primary: "1 2% 3%", "chart-2": "4 5% 6%" }, "light");
    expect(theme.variables["--accent"]).toBe("hsl(1 2% 3%)");
    expect(theme.variables["--chart-2"]).toBe("hsl(4 5% 6%)");
    expect(theme.variables["--chart-6"]).toBe(
      `hsl(${HTML_RENDER_DECK_TOKENS.light["chart-other"]})`,
    );
    expect(theme.variables["--destructive-surface"]).toBe(
      `hsl(${HTML_RENDER_DECK_TOKENS.light.destructive} / 0.12)`,
    );
    const fragment = htmlRenderThemeFragment(theme);
    expect(JSON.parse(decodeURIComponent(fragment.slice("#t3-theme=".length)))).toEqual(theme);
    expect(fragment).not.toContain("&");
  });

  it("keeps a state colour's -foreground as text in that colour, as stored pages expect", () => {
    const { variables } = htmlRenderTheme(HTML_RENDER_DECK_TOKENS.light, "light");
    for (const state of ["destructive", "warning", "success", "info"]) {
      expect(variables[`--${state}-foreground`]).toBe(variables[`--${state}`]);
    }
  });

  it("falls back to the deck for a token the theme leaves unset", () => {
    expect(htmlRenderTheme({ background: "  " }, "dark").variables["--background"]).toBe(
      `hsl(${HTML_RENDER_DECK_TOKENS.dark.background})`,
    );
  });

  it("keeps the deck's tokens as packages/ui globals.css writes them", () => {
    const css = readFileSync(new URL("../../ui/src/styles/globals.css", import.meta.url), "utf8");
    const block = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      const body = css.slice(start, css.indexOf("\n  }", start));
      return Object.fromEntries(
        [...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
      );
    };
    const light = block('html[data-surface="deck"]');
    const dark = { ...light, ...block('html.dark[data-surface="deck"]') };
    for (const name of HTML_RENDER_TOKEN_NAMES) {
      expect([name, HTML_RENDER_DECK_TOKENS.light[name]]).toEqual([name, light[name]]);
      expect([name, HTML_RENDER_DECK_TOKENS.dark[name]]).toEqual([name, dark[name]]);
    }
  });
});

describe("readHtmlRenderReference", () => {
  it("clamps height and rejects malformed references", () => {
    expect(readHtmlRenderReference({ ...reference, height: 99_999 })?.height).toBe(2000);
    expect(readHtmlRenderReference({ ...reference, title: "  " })?.title).toBe("HTML");
    expect(readHtmlRenderReference({ ...reference, attachmentId: 4 })).toBeUndefined();
    expect(readHtmlRenderReference({ ...reference, height: Number.NaN })).toBeUndefined();
  });
});

describe("htmlRenderFromToolItem", () => {
  const result = { htmlRender: reference, message: "Rendered above your reply." };

  it("reads the reference from each provider's result envelope", () => {
    for (const [toolName, output] of [
      ["mcp__caveman-code__html_render", [{ type: "text", text: JSON.stringify(result) }]],
      ["caveman-code.html_render", { structuredContent: result, content: [] }],
      ["caveman-code-thread_1_html_render", JSON.stringify(result)],
      ["html_render", result],
      ["mcp__t3-code__html_render", [{ type: "text", text: JSON.stringify(result) }]],
      ["t3-code.html_render", { structuredContent: result, content: [] }],
      ["t3-code-thread_1_html_render", JSON.stringify(result)],
    ] as const) {
      expect(htmlRenderFromToolItem({ toolName, output })).toEqual(reference);
    }
  });

  it("ignores other tools and failed calls", () => {
    expect(
      htmlRenderFromToolItem({ toolName: "mcp__caveman-code__html_preview", output: result }),
    ).toBe(undefined);
    expect(htmlRenderFromToolItem({ toolName: "mcp__other__html_render", output: result })).toBe(
      undefined,
    );
    expect(
      htmlRenderFromToolItem({ toolName: "html_render", output: { ...result, isError: true } }),
    ).toBeUndefined();
  });
});

describe("htmlRenderFrameHeight", () => {
  const measured = readHtmlRenderReference({
    ...reference,
    height: 1500,
    heights: [
      [728, 1403],
      [390, 1290],
      [1000, 1660],
    ],
  })!;

  it("takes the taller neighbor between measured widths and holds the ends", () => {
    expect(measured.heights?.map(([width]) => width)).toEqual([390, 728, 1000]);
    expect(htmlRenderFrameHeight(measured, 728)).toBe(1403);
    expect(htmlRenderFrameHeight(measured, 559)).toBe(1403);
    expect(htmlRenderFrameHeight(measured, 320)).toBe(1290);
  });

  it("takes the taller layout when a breakpoint falls between measured widths", () => {
    // 900px tall below a 600px media query, 450px above it.
    const responsive = readHtmlRenderReference({
      ...reference,
      height: 2000,
      heights: [
        [520, 900],
        [640, 450],
      ],
    })!;
    expect(htmlRenderFrameHeight(responsive, 590)).toBe(900);
    expect(htmlRenderFrameHeight(responsive, 640)).toBe(450);
  });

  it("fits a page the client lays out taller than the server measured", () => {
    // The agent passed contentHeight at the column width, so the page should never scroll.
    const fitted = { ...measured, height: 1403 };
    expect(htmlRenderFrameHeight(fitted, 728, 1415)).toBe(1415);
    expect(htmlRenderFrameHeight(fitted, 1400)).toBe(1660);
    expect(htmlRenderFrameHeight(fitted, 728, 5000)).toBe(HTML_RENDER_MAX_HEIGHT);
  });

  it("keeps the agent's height when it asked for a scrolling frame or the page is unmeasured", () => {
    const scrolling = { ...measured, height: 600 };
    expect(htmlRenderFrameHeight(scrolling, 728, 1415)).toBe(600);
    expect(htmlRenderFrameHeight(scrolling, 1400)).toBe(600);
    expect(htmlRenderFrameHeight(reference, 728)).toBe(reference.height);
    expect(htmlRenderFrameHeight(reference, 728, 900)).toBe(reference.height);
    expect(htmlRenderFrameHeight(reference, 728, 300)).toBe(300);
  });

  it("drops a malformed table and compares tables by value", () => {
    expect(readHtmlRenderReference({ ...reference, heights: [[728, "x"]] })?.heights).toBe(
      undefined,
    );
    const copy = readHtmlRenderReference(JSON.parse(JSON.stringify(measured)))!;
    expect(htmlRenderReferencesEqual(measured, copy)).toBe(true);
    expect(htmlRenderReferencesEqual(measured, { ...copy, heights: [[390, 1290]] })).toBe(false);
  });
});
