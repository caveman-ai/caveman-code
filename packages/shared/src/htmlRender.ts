// ), packages/shared/src/htmlRender.ts @ ab3a3cd1.
import type { ThemeAppearance } from "./themePalettes.ts";
import { EVENT_CODE_SHORTCUT_KEYS } from "./keybindings.ts";

/**
 * Agent-authored HTML pages ("HTML renders") are self-contained documents an
 * agent publishes into a thread with upstream `html_render` MCP tool. The server
 * stores each one as a thread attachment with a small bootstrap injected into
 * its head; clients show it in a sandboxed iframe (web, desktop) or WebView
 * (mobile) and hand it the active theme as CSS custom properties.
 */

export const HTML_RENDER_TOOL_NAME = "html_render";
export const HTML_RENDER_MIN_HEIGHT = 80;
export const HTML_RENDER_MAX_HEIGHT = 2000;
export const HTML_RENDER_MAX_TITLE_LENGTH = 200;

/** What the `html_render` tool result carries so clients can show the page. */
export interface HtmlRenderReference {
  readonly attachmentId: string;
  readonly title: string;
  /** The agent's frame height in CSS pixels, and the cap on any measured height. */
  readonly height: number;
  /**
   * `[width, contentHeight]` pairs the server measured at publish, ascending by
   * width. Absent when the preview browser was not installed yet.
   */
  readonly heights?: ReadonlyArray<readonly [width: number, height: number]>;
}

/** Frame widths the server measures a page at, from phones to the wide chat setting. */
export const HTML_RENDER_MEASURE_WIDTHS = [320, 375, 430, 520, 640, 728, 860, 1000, 1144] as const;

/**
 * The reply column's frame width at the default chat width. Agents preview at
 * it, and it picks the measured height when a client cannot know its width.
 */
export const HTML_RENDER_COLUMN_WIDTH = 728;

const MAX_MEASURED_HEIGHTS = 24;

function readMeasuredHeights(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MEASURED_HEIGHTS) {
    return undefined;
  }
  const heights = value.flatMap((entry) =>
    Array.isArray(entry) &&
    entry.length === 2 &&
    Number.isInteger(entry[0]) &&
    entry[0] >= 1 &&
    entry[0] <= 10_000 &&
    typeof entry[1] === "number" &&
    Number.isFinite(entry[1])
      ? [[entry[0] as number, clampHtmlRenderHeight(entry[1])] as const]
      : [],
  );
  return heights.length === value.length
    ? [...heights].sort((left, right) => left[0] - right[0])
    : undefined;
}

export function readHtmlRenderReference(value: unknown): HtmlRenderReference | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { attachmentId, title, height, heights } = value as Record<string, unknown>;
  if (
    typeof attachmentId !== "string" ||
    attachmentId.length === 0 ||
    attachmentId.length > 256 ||
    typeof title !== "string" ||
    typeof height !== "number" ||
    !Number.isFinite(height)
  ) {
    return undefined;
  }
  const measured = readMeasuredHeights(heights);
  return {
    attachmentId,
    title: title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) || "HTML",
    height: clampHtmlRenderHeight(height),
    ...(measured === undefined ? {} : { heights: measured }),
  };
}

/** Whether two references show the same page at the same sizes. */
export function htmlRenderReferencesEqual(left: HtmlRenderReference, right: HtmlRenderReference) {
  return (
    left.attachmentId === right.attachmentId &&
    left.title === right.title &&
    left.height === right.height &&
    (left.heights ?? []).length === (right.heights ?? []).length &&
    (left.heights ?? []).every(
      ([width, height], index) =>
        right.heights?.[index]?.[0] === width && right.heights[index][1] === height,
    )
  );
}

// The taller of the heights measured at the nearest widths on each side. A
// breakpoint between two measured widths can make the page as tall as either.
function measuredHeight(heights: NonNullable<HtmlRenderReference["heights"]>, width: number) {
  const above = heights.findIndex(([measuredWidth]) => measuredWidth >= width);
  const high = above === -1 ? heights.length - 1 : above;
  const low = heights[high]![0] === width ? high : Math.max(0, high - 1);
  return Math.max(heights[low]![1], heights[high]![1]);
}

/**
 * The frame height for a page at a frame width. It is the page's own reported
 * `contentHeight` when the client has one, else the server's measurement for
 * that width. A page even a few pixels taller than its frame scrolls inside it
 * and takes the reader's scroll, so the frame fits the page. The agent's height
 * caps it only when it is below the page's height at the column width (the
 * agent asked for a scrolling frame) or when the page was never measured.
 */
export function htmlRenderFrameHeight(
  reference: HtmlRenderReference,
  width: number,
  contentHeight?: number,
) {
  const heights = reference.heights;
  if (heights === undefined || heights.length === 0) {
    return clampHtmlRenderHeight(Math.min(reference.height, contentHeight ?? reference.height));
  }
  const cap =
    measuredHeight(heights, HTML_RENDER_COLUMN_WIDTH) > reference.height
      ? reference.height
      : HTML_RENDER_MAX_HEIGHT;
  return clampHtmlRenderHeight(Math.min(cap, contentHeight ?? measuredHeight(heights, width)));
}

/** A readable download name: the title without characters file systems reject. */
export function htmlRenderFileName(title: string) {
  const name = title
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
  return `${name || "Page"}.html`;
}

export function clampHtmlRenderHeight(height: number): number {
  return Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(height)));
}

export interface HtmlRenderFonts {
  readonly sans: string;
  readonly mono: string;
}

export const HTML_RENDER_DEFAULT_FONTS: HtmlRenderFonts = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  // Concrete names only: some engines alias `ui-monospace` to the proportional UI font.
  mono: '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
};

/**
 * Fonts the server's headless browser lays pages out with. Arial-metric faces
 * stand in for the system UI fonts readers see, so measured heights and
 * preview screenshots wrap text close to how a client will.
 */
export const HTML_RENDER_MEASURE_FONTS: HtmlRenderFonts = {
  sans: '"Liberation Sans", Arimo, Arial, Helvetica, sans-serif',
  mono: '"Liberation Mono", Cousine, Menlo, Consolas, monospace',
};

/** The resolved theme a client hands an HTML render. */
export interface HtmlRenderTheme {
  readonly appearance: ThemeAppearance;
  readonly variables: Readonly<Record<string, string>>;
}

/** The app's theme tokens a render's variables come from. */
export const HTML_RENDER_TOKEN_NAMES = [
  "background",
  "foreground",
  "card",
  "popover",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "success",
  "info",
  "warning",
  "border",
  "input",
  "ring",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "chart-other",
] as const;

export type HtmlRenderTokenName = (typeof HTML_RENDER_TOKEN_NAMES)[number];

/** Token values as the app's CSS writes them: HSL triplets such as `240 2.7% 7.3%`. */
export type HtmlRenderTokens = Readonly<Record<HtmlRenderTokenName, string>>;

/**
 * The default theme's tokens, the deck in packages/ui globals.css
 * (`html[data-surface="deck"]` and its dark half; htmlRender.test.ts keeps
 * them in step). Pages laid out away from a client wear them: the server's
 * previews and measurements, and a downloaded page.
 */
export const HTML_RENDER_DECK_TOKENS: Readonly<Record<ThemeAppearance, HtmlRenderTokens>> = {
  light: {
    background: "0 0% 100%",
    foreground: "240 3.1% 12.5%",
    card: "0 0% 100%",
    popover: "0 0% 100%",
    primary: "240 3.1% 12.5%",
    "primary-foreground": "0 0% 100%",
    secondary: "0 0% 94.1%",
    "secondary-foreground": "240 2.4% 24%",
    muted: "0 0% 96.1%",
    "muted-foreground": "240 1.1% 36.5%",
    accent: "0 0% 95.3%",
    "accent-foreground": "240 3.1% 12.5%",
    destructive: "358 65% 48%",
    success: "145 60% 32%",
    info: "212.41 63.13% 42.55%",
    warning: "32.24 77.91% 33.73%",
    border: "0 0% 90.6%",
    input: "222.00 4.10% 52.16%",
    ring: "240 2.3% 42.9%",
    "chart-1": "210 100% 45%",
    "chart-2": "40 100% 38%",
    "chart-3": "155 67% 37%",
    "chart-4": "257 71% 70%",
    "chart-5": "332 59% 60%",
    "chart-other": "0 0% 54%",
  },
  dark: {
    background: "240 2.7% 7.3%",
    foreground: "220 5.7% 89.6%",
    card: "240 1.9% 10.4%",
    popover: "210 3.6% 11%",
    primary: "220 5.7% 89.6%",
    "primary-foreground": "240 2.7% 7.3%",
    secondary: "240 2.8% 14.1%",
    "secondary-foreground": "240 2% 80%",
    muted: "240 4% 9.8%",
    "muted-foreground": "240 1% 58.8%",
    accent: "240 2.9% 13.7%",
    "accent-foreground": "220 5.7% 89.6%",
    destructive: "357 70% 64%",
    success: "145 60% 53%",
    info: "217 80% 40%",
    warning: "34 87% 56%",
    border: "220 4.1% 14.3%",
    input: "240 3.2% 18.6%",
    ring: "240 1.8% 56.5%",
    "chart-1": "211 95% 55%",
    "chart-2": "40 100% 45%",
    "chart-3": "155 67% 42%",
    "chart-4": "257 71% 70%",
    "chart-5": "332 59% 62%",
    "chart-other": "0 0% 54%",
  },
};

const STATE_TOKENS = ["destructive", "warning", "success", "info"] as const;

/**
 * Maps the app's theme tokens to the variables a render styles against, with
 * shadcn's names. `-foreground` is text on that colour, except for the
 * state colours (destructive, warning, success, info), whose `-foreground` is
 * text in that colour, as stored pages were written against; `-surface` is a
 * faint tint behind such text. The
 * one exception is `--accent`, the brand colour (our primary), as in T3; the
 * neutral hover surface is `--accent-surface`. A token a theme leaves unset
 * falls back to the deck's.
 */
export function htmlRenderTheme(
  tokens: Partial<Record<HtmlRenderTokenName, string>>,
  appearance: ThemeAppearance,
  fonts: HtmlRenderFonts = HTML_RENDER_DEFAULT_FONTS,
): HtmlRenderTheme {
  const deck = HTML_RENDER_DECK_TOKENS[appearance];
  const color = (name: HtmlRenderTokenName, alpha?: number) =>
    `hsl(${tokens[name]?.trim() || deck[name]}${alpha === undefined ? "" : ` / ${alpha}`})`;
  return {
    appearance,
    variables: {
      "--background": color("background"),
      "--foreground": color("foreground"),
      "--muted": color("muted"),
      "--muted-foreground": color("muted-foreground"),
      "--card": color("card"),
      "--card-foreground": color("foreground"),
      "--popover": color("popover"),
      "--popover-foreground": color("foreground"),
      "--secondary": color("secondary"),
      "--secondary-foreground": color("secondary-foreground"),
      "--border": color("border"),
      "--input": color("input"),
      "--ring": color("ring"),
      "--primary": color("primary"),
      "--primary-foreground": color("primary-foreground"),
      "--accent": color("primary"),
      "--accent-foreground": color("primary-foreground"),
      "--accent-surface": color("accent"),
      "--accent-surface-foreground": color("accent-foreground"),
      ...Object.fromEntries(
        STATE_TOKENS.flatMap((state) => [
          [`--${state}`, color(state)],
          [`--${state}-foreground`, color(state)],
          [`--${state}-surface`, color(state, 0.12)],
        ]),
      ),
      "--code-background": color("foreground", 0.05),
      "--code-foreground": color("foreground"),
      "--chart-1": color("chart-1"),
      "--chart-2": color("chart-2"),
      "--chart-3": color("chart-3"),
      "--chart-4": color("chart-4"),
      "--chart-5": color("chart-5"),
      "--chart-6": color("chart-other"),
      "--radius": "12px",
      "--font-sans": fonts.sans,
      "--font-mono": fonts.mono,
    },
  };
}

/** Agent-facing reference for the injected variables, used in tool descriptions. */
export const HTML_RENDER_THEME_GUIDE = [
  "Use theme CSS variables on :root, not fixed colors; they follow the user's theme and light/dark mode live:",
  "--background, --foreground, --muted-foreground, --card, --secondary, --border, --input, --primary, --accent, --destructive, --warning, --success, --info, --code-background",
  "(most have -foreground; accent and the four states have -surface), --chart-1 to --chart-6, --radius, --font-sans, --font-mono.",
  "The base sheet styles plain HTML like the chat (type, links, lists, tables, code, buttons, inputs): write semantic HTML; add only layout and charts.",
].join(" ");

/** Agent-facing layout rules for a page that sits inside a reply. */
export const HTML_RENDER_LAYOUT_GUIDE = [
  `Frame width is reply width (${HTML_RENDER_COLUMN_WIDTH}px desktop, about 360px phones), on the thread background.`,
  "Leave html, body, and the outer element with no background color, no outer card, border, banner title, or side padding. This wins over any rule that sets a page background.",
  "A box that needs its own background gets 16px padding and var(--radius) corners. Give charts fixed pixel heights.",
  "Let content set the height. Do not use vh units or height:100% on html or body: the frame grows to fit the page, so they make it grow again and again.",
].join(" ");

// The bridge between a render and its client speaks the MCP Apps protocol
// (JSON-RPC over postMessage), so the same host code can later drive upstream
// MCP apps: https://github.com/modelcontextprotocol/ext-apps
const HOST_CONTEXT_CHANGED_METHOD = "ui/notifications/host-context-changed";
const OPEN_LINK_METHOD = "ui/open-link";
const SIZE_CHANGED_METHOD = "ui/notifications/size-changed";
// Not part of MCP Apps: a focused frame keeps its keys from the app, so the
// client tells the page which chords are app shortcuts and the page passes
// those on.
const SHORTCUTS_METHOD = "t3/notifications/shortcuts";
const KEY_DOWN_METHOD = "t3/notifications/keydown";

/** The content height in a framed render's `ui/notifications/size-changed` notification. */
export function readHtmlRenderContentHeight(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0" || method !== SIZE_CHANGED_METHOD) return undefined;
  const height =
    typeof params === "object" && params !== null
      ? (params as { height?: unknown }).height
      : undefined;
  return typeof height === "number" && Number.isFinite(height) && height > 0 ? height : undefined;
}

/**
 * A render's `ui/open-link` request, if `data` is one with an http(s) URL. The
 * bootstrap adds the click's Cmd/Ctrl state, so a modifier click can leave the
 * app the way it does from a chat link.
 */
export function readHtmlRenderLinkRequest(data: unknown):
  | {
      readonly id: string | number;
      readonly url: string;
      readonly metaKey: boolean;
      readonly ctrlKey: boolean;
    }
  | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, id, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0" || method !== OPEN_LINK_METHOD) return undefined;
  if (typeof id !== "string" && typeof id !== "number") return undefined;
  if (typeof params !== "object" || params === null) return undefined;
  const { url, metaKey, ctrlKey } = params as Record<string, unknown>;
  return typeof url === "string" && /^https?:\/\//i.test(url)
    ? { id, url, metaKey: metaKey === true, ctrlKey: ctrlKey === true }
    : undefined;
}

/** The key a framed render passed on in a `t3/notifications/keydown` notification. */
export function readHtmlRenderKeyDown(data: unknown):
  | {
      readonly key: string;
      readonly code: string;
      readonly metaKey: boolean;
      readonly ctrlKey: boolean;
      readonly shiftKey: boolean;
      readonly altKey: boolean;
      readonly repeat: boolean;
    }
  | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0" || method !== KEY_DOWN_METHOD) return undefined;
  if (typeof params !== "object" || params === null) return undefined;
  const { key, code, metaKey, ctrlKey, shiftKey, altKey, repeat } = params as Record<
    string,
    unknown
  >;
  if (typeof key !== "string" || typeof code !== "string") return undefined;
  return {
    key,
    code,
    metaKey: metaKey === true,
    ctrlKey: ctrlKey === true,
    shiftKey: shiftKey === true,
    altKey: altKey === true,
    repeat: repeat === true,
  };
}

/** A chord as the page sees it: `mod` already resolved to Meta or Control. */
export interface HtmlRenderShortcut {
  /** Lowercase key name, as in a keybinding: `k`, `[`, `enter`. */
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/**
 * The `t3/notifications/shortcuts` notification a client posts into a render:
 * the chords it may pass on, and chords of other commands that the page keeps
 * even when one also matches an allowed chord.
 */
export function htmlRenderShortcutsMessage(
  shortcuts: ReadonlyArray<HtmlRenderShortcut>,
  blocked: ReadonlyArray<HtmlRenderShortcut>,
) {
  return { jsonrpc: "2.0", method: SHORTCUTS_METHOD, params: { shortcuts, blocked } } as const;
}

/** The empty result a client sends back for a render's request. */
export function htmlRenderResult(id: string | number) {
  return { jsonrpc: "2.0", id, result: {} } as const;
}

const THEME_FRAGMENT_KEY = "t3-theme";

/** URL fragment that hands a render its theme before first paint. */
export function htmlRenderThemeFragment(theme: HtmlRenderTheme): string {
  return `#${THEME_FRAGMENT_KEY}=${encodeURIComponent(JSON.stringify(theme))}`;
}

/** The `host-context-changed` notification a client posts into a mounted render when the theme changes. */
export function htmlRenderThemeMessage(theme: HtmlRenderTheme) {
  return {
    jsonrpc: "2.0",
    method: HOST_CONTEXT_CHANGED_METHOD,
    params: { theme: theme.appearance, styles: { variables: theme.variables } },
  } as const;
}

// The frame scrolls a page taller than itself, but a scrollbar inside the
// reply reads as a box within the thread, so it stays hidden.
const ROOT_CSS =
  "html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.7;accent-color:var(--accent);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}" +
  "html::-webkit-scrollbar{display:none}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}" +
  // Focus outlines paint inside the element, so the frame edge never clips them.
  ":where(:focus-visible){outline:2px solid var(--ring)}:focus-visible{outline-width:2px!important;outline-offset:-2px!important}";

const hairline = (percent: number) =>
  `color-mix(in srgb,var(--foreground) ${percent}%,transparent)`;

// The first and last element that renders: a page's <script> or <style> in the body doesn't count.
const RENDERED = ":not(script,style,template,link)";
const FIRST = `:nth-child(1 of ${RENDERED})`;
const LAST = `:nth-last-child(1 of ${RENDERED})`;
const BOXES = ":is(li,td,th,blockquote,figure,details,dd)";

// Plain HTML styled as the chat styles a reply (packages/ui ai/response.tsx):
// its type scale, links, lists, flat tables, code and the secondary button.
// Every rule sits in :where(), so any selector a page writes wins over it.
const ELEMENT_CSS = [
  ":where(h1,h2,h3,h4,h5,h6){margin:28px 0 8px;font-weight:600;color:var(--foreground);text-wrap:balance}",
  ":where(h1){font-size:22px;line-height:28px;letter-spacing:-0.015em}",
  ":where(h2){font-size:18px;line-height:26px;letter-spacing:-0.01em}",
  ":where(h3){margin-top:24px;font-size:15px;line-height:24px}",
  ":where(h4,h5,h6){margin-top:20px;font-size:14px;line-height:24px}",
  ":where(p,ul,ol,dl,blockquote,pre,table,figure,details){margin:16px 0}",
  ":where(p){text-wrap:pretty}:where(b,strong){font-weight:600}:where(small){font-size:12px}",
  ":where(ul,ol){padding-inline-start:24px}:where(li){margin:4px 0;padding-inline-start:4px}",
  ":where(li)::marker{color:var(--muted-foreground);font-variant-numeric:tabular-nums}:where(li) :where(ul,ol){margin:4px 0}",
  `:where(a){color:inherit;text-decoration:underline;text-decoration-color:color-mix(in srgb,var(--muted-foreground) 50%,transparent);text-underline-offset:3px;transition:text-decoration-color 75ms}:where(a:hover){text-decoration-color:currentColor}`,
  `:where(blockquote){padding-inline-start:16px;border-inline-start:3px solid ${hairline(15)};color:var(--muted-foreground)}`,
  ":where(hr){margin:24px 0;border:0;border-top:1px solid var(--border)}",
  `:where(:not(pre)>code,kbd){padding:1px 5px;border-radius:5px;background:${hairline(8)};font-size:0.86em}`,
  ":where(pre){overflow:auto;padding:12px 16px;border-radius:var(--radius);background:var(--code-background);color:var(--code-foreground);font-size:12.5px;line-height:20px;scrollbar-width:none}",
  ":where(table){width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}",
  `:where(th){padding:8px 12px;border-bottom:1px solid ${hairline(10)};text-align:start;vertical-align:bottom;white-space:nowrap;font-size:12px;font-weight:600;line-height:20px}`,
  `:where(td){padding:8px 12px;border-bottom:1px solid ${hairline(6)};vertical-align:top;font-size:12.5px;line-height:20px}`,
  ":where(th:first-child,td:first-child){padding-inline-start:0}:where(th:last-child,td:last-child){padding-inline-end:0}:where(tbody tr:last-child td){border-bottom:0}",
  ":where(caption,figcaption){caption-side:bottom;padding-top:8px;text-align:start;color:var(--muted-foreground);font-size:12px}",
  ":where(summary){cursor:pointer}",
  `:where(button,input:is([type=button],[type=submit],[type=reset])){height:28px;padding:0 10px;border:0;border-radius:6px;background:${hairline(8)};color:var(--foreground);font:inherit;font-size:12.5px;font-weight:500;cursor:pointer;transition:background-color 100ms,transform 100ms}`,
  `:where(button:hover,input:is([type=button],[type=submit],[type=reset]):hover){background:${hairline(11)}}`,
  ":where(button:active,input:is([type=button],[type=submit],[type=reset]):active){transform:scale(0.98)}:where(button:disabled,input:disabled,select:disabled,textarea:disabled){opacity:0.5;pointer-events:none}",
  ":where(input:not([type=button],[type=submit],[type=reset],[type=checkbox],[type=radio],[type=range],[type=color],[type=file]),select,textarea){height:28px;padding:0 8px;border:1px solid var(--input);border-radius:6px;background:transparent;color:var(--foreground);font:inherit;font-size:13px}",
  ":where(textarea){height:auto;padding:6px 8px}:where(input,textarea)::placeholder{color:var(--muted-foreground)}",
  // The page reads the reader's own setting: a sandboxed frame still matches the system's media queries.
  "@media (prefers-reduced-motion:reduce){:where(a,button,input){transition:none}:where(button:active,input:active){transform:none}}",
  // Unfilled shapes and text would draw black, unreadable on a dark theme.
  ":where(svg:not([fill])){fill:currentColor}:where(img,video){max-width:100%}",
  // The page's first and last element sit flush with the frame, as a reply's do in the chat, through one wrapper; so
  // does the content of a list item, cell, quote or figure. Elsewhere margins stay, so sections keep their spacing.
  `:where(body>${FIRST},body>${FIRST}>${FIRST},${BOXES}>${FIRST}){margin-top:0}`,
  `:where(body>${LAST},body>${LAST}>${LAST},${BOXES}>${LAST}){margin-bottom:0}`,
].join("");

const BASE_CSS = ROOT_CSS + ELEMENT_CSS;

function rootRule(theme: HtmlRenderTheme): string {
  const declarations = Object.entries(theme.variables)
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  return `:root{color-scheme:${theme.appearance};${declarations}}`;
}

// Runs synchronously in <head>, before the page's own styles and body, so the
// first paint is already themed. It rewrites its own <style> element rather
// than setting inline properties, so a page's later `:root` rules still win,
// then drops the fragment so a page's own hash routing never sees it. A link
// the reader clicks to another page never replaces the page inside the thread:
// a framed page asks its client to open it, and a top-level page (mobile)
// opens it as a new window, which the client sends to the browser. A framed
// page also reports its content height, measured as the server measures it,
// so its client can fit the frame to the page. A chord the client named as an
// app shortcut is passed on rather than left to the browser, unless a text
// field has focus or the page handled it: the deciding listener is added while
// the key dispatches, so it runs after every listener the page has. Keys
// match as resolveEventKeys reads them, so the client accepts what it claims.
const BOOTSTRAP_SCRIPT = `(function(){var s=document.getElementById("t3-theme"),n=0;if(!s)return;var b=${JSON.stringify(BASE_CSS)};function a(t){if(!t||typeof t!=="object"||!t.variables||typeof t.variables!=="object")return;var c=":root{color-scheme:"+(t.appearance==="light"?"light":"dark")+";";for(var k in t.variables){if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(t.variables[k]).replace(/[;{}<>]/g,"")+";";}s.textContent=c+"}"+b;}try{var m=/[#&]${THEME_FRAGMENT_KEY}=([^&]*)/.exec(location.hash);if(m){a(JSON.parse(decodeURIComponent(m[1])));history.replaceState(history.state,"",location.pathname+location.search);}}catch(e){}window.addEventListener("message",function(e){var d=e.data,p=d&&d.params;if(d&&d.jsonrpc==="2.0"&&d.method===${JSON.stringify(HOST_CONTEXT_CHANGED_METHOD)}&&p&&p.styles)a({appearance:p.theme,variables:p.styles.variables});});document.addEventListener("click",function(e){var l=e.isTrusted?e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");}):null,u;if(!l)return;try{u=new URL(l.getAttribute("href"),document.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol)||u.href.split("#")[0]===location.href.split("#")[0])return;if(window.parent!==window){e.preventDefault();window.parent.postMessage({jsonrpc:"2.0",id:"t3-link-"+(++n),method:${JSON.stringify(OPEN_LINK_METHOD)},params:{url:u.href,metaKey:e.metaKey,ctrlKey:e.ctrlKey}},"*");}else{l.setAttribute("target","_blank");l.setAttribute("rel","noopener");}},true);if(window.parent!==window){var h,o,z=function(){var r=document.documentElement,v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(v===h)return;h=v;window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(SIZE_CHANGED_METHOD)},params:{height:v}},"*");};if(window.ResizeObserver){o=new ResizeObserver(z);o.observe(document.documentElement);}document.addEventListener("DOMContentLoaded",function(){if(o&&document.body)o.observe(document.body);z();});window.addEventListener("load",z);var K=[],B=[],C=${JSON.stringify(EVENT_CODE_SHORTCUT_KEYS)};window.addEventListener("message",function(e){var d=e.data,p=d&&d.params;if(e.source===window.parent&&d&&d.jsonrpc==="2.0"&&d.method===${JSON.stringify(SHORTCUTS_METHOD)}&&p&&Array.isArray(p.shortcuts)&&Array.isArray(p.blocked)){K=p.shortcuts;B=p.blocked;}});window.addEventListener("keydown",function(e){var t=e.composedPath()[0],c=e.code||"",l=e.key.toLowerCase(),x=/^[a-z]$/.test(l)?[l]:[l,/^Key[A-Z]$/.test(c)?c.slice(3).toLowerCase():"",C.hasOwnProperty(c)?C[c]:""],f,m=function(s){return s&&s.metaKey===e.metaKey&&s.ctrlKey===e.ctrlKey&&s.shiftKey===e.shiftKey&&s.altKey===e.altKey&&x.indexOf(s.key)>-1;};if(!e.isTrusted||e.isComposing||e.getModifierState("AltGraph")&&!/^[a-z0-9]$/i.test(e.key)||t&&(t.isContentEditable||/^(?:INPUT|TEXTAREA|SELECT)$/.test(t.tagName))||!K.some(m)||B.some(m))return;f=function(v){window.removeEventListener("keydown",f);if(v!==e||e.defaultPrevented)return;e.preventDefault();window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(KEY_DOWN_METHOD)},params:{key:e.key,code:e.code,metaKey:e.metaKey,ctrlKey:e.ctrlKey,shiftKey:e.shiftKey,altKey:e.altKey,repeat:e.repeat}},"*");};window.addEventListener("keydown",f);setTimeout(function(){window.removeEventListener("keydown",f);});},true);}})();`;

function bootstrapMarkup(markup: string): string {
  const dark = htmlRenderTheme(HTML_RENDER_DECK_TOKENS.dark, "dark");
  const light = htmlRenderTheme(HTML_RENDER_DECK_TOKENS.light, "light");
  // Without a client-provided theme (a direct download, the headless preview
  // without a fragment) the page follows the OS appearance.
  const defaultCss = `${rootRule(dark)}@media (prefers-color-scheme: light){${rootRule(light)}}${BASE_CSS}`;
  return [
    /<meta\s[^>]*charset/i.test(markup.slice(0, 4096)) ? "" : '<meta charset="utf-8">',
    /<meta\s[^>]*name\s*=\s*["']?viewport/i.test(markup)
      ? ""
      : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="t3-theme">${defaultCss}</style>`,
    `<script>${BOOTSTRAP_SCRIPT}</script>`,
  ].join("");
}

// Comments, raw text, and template contents are blanked to the same length,
// so offsets still line up and inert tags cannot receive the bootstrap.
const blankNonMarkup = (html: string) => {
  const scan = html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[\s\S]*$/gi,
    (match) => " ".repeat(match.length),
  );
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let at = 0;
  for (const match of scan.matchAll(/<(\/?)template(?:\s[^>]*)?\/?>/gi)) {
    if (!match[1]) {
      if (depth++ === 0) start = match.index;
    } else if (depth > 0 && --depth === 0) {
      const end = match.index + match[0].length;
      parts.push(scan.slice(at, start), " ".repeat(end - start));
      at = end;
    }
  }
  if (depth > 0) {
    parts.push(scan.slice(at, start), " ".repeat(scan.length - start));
    at = scan.length;
  }
  parts.push(scan.slice(at));
  return parts.join("");
};

/**
 * Inserts the theme bootstrap at the start of the document head, so a page's
 * own styles and scripts come after it.
 */
export function injectHtmlRenderBootstrap(html: string): string {
  const scan = blankNonMarkup(html);
  const markup = bootstrapMarkup(scan);
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(scan);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + markup + html.slice(at);
  }
  const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(scan);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    const at = doctype[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  return `<!doctype html><head>${markup}</head>${html}`;
}
