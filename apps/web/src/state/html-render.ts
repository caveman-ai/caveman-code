// Pages an agent showed with the runtime's `html_render` tool (upstream HTML
// renders): which tool calls published one, and the app's theme as the
// variables a page styles against, so a page wears the chat's colours.
import {
  HTML_RENDER_DEFAULT_FONTS,
  HTML_RENDER_TOKEN_NAMES,
  htmlRenderTheme,
  type HtmlRenderReference,
  type HtmlRenderTheme,
} from "@caveman-app/shared/htmlRender";
import { htmlRenderFromToolItem } from "@caveman-app/shared/toolOutput";
import { useSyncExternalStore } from "react";
import type { ToolItem } from "./transcript-model.ts";

/** The page a finished `html_render` call published, under any engine's spelling of the tool. */
export function pageOf(
  tool: Pick<ToolItem, "name" | "result" | "status">,
): HtmlRenderReference | undefined {
  return tool.status === "done"
    ? htmlRenderFromToolItem({ toolName: tool.name, output: tool.result })
    : undefined;
}

/** The app's theme as a page's variables: its tokens as the root has them now, under any colour theme. */
export function readAppTheme(root: HTMLElement = document.documentElement): HtmlRenderTheme {
  const style = getComputedStyle(root);
  const tokens = Object.fromEntries(
    HTML_RENDER_TOKEN_NAMES.map((name) => [name, style.getPropertyValue(`--${name}`).trim()]),
  );
  const sans = getComputedStyle(document.body ?? root).fontFamily;
  const mono = style.getPropertyValue("--font-jetbrains").trim();
  return htmlRenderTheme(
    tokens,
    root.classList.contains("dark") ? "dark" : "light",
    // The app's web fonts don't load in a sandboxed page; the stacks fall back to the system's.
    {
      sans: sans || HTML_RENDER_DEFAULT_FONTS.sans,
      mono: mono ? `${mono}, ${HTML_RENDER_DEFAULT_FONTS.mono}` : HTML_RENDER_DEFAULT_FONTS.mono,
    },
  );
}

// applyAppearance (state/appearance.ts) changes the root's class, style and data-theme: a page follows each change.
let current: { key: string; theme: HtmlRenderTheme } | null = null;
const snapshot = () => {
  const theme = readAppTheme();
  const key = JSON.stringify(theme);
  if (current?.key !== key) current = { key, theme };
  return current.theme;
};
const subscribe = (notify: () => void) => {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme"],
  });
  return () => observer.disconnect();
};

/** The app's theme for pages, current with Settings > Appearance and the system's light or dark. */
export function useAppTheme(): HtmlRenderTheme {
  return useSyncExternalStore(subscribe, snapshot);
}
