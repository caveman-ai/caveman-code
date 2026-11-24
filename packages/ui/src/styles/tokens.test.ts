/// <reference types="node" />
// The deck's text tokens stay readable in both themes: secondary and tertiary text at 4.5:1 or more
// on the panel, cards and menus (WCAG AA for small text). Read from globals.css as written.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

/** The custom properties a block sets, by the block's selector (the first block with it). */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(start, css.indexOf("\n  }", start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

function luminance(hsl: string): number {
  const [h, s, l] = hsl.replace(/%/g, "").split(/\s+/).map(Number) as [number, number, number];
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(0) + 0.7152 * f(8) + 0.0722 * f(4);
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

const light = block('html[data-surface="deck"]');
const dark = { ...light, ...block('html.dark[data-surface="deck"]') };

describe("deck text contrast", () => {
  for (const [name, tokens] of [["light", light], ["dark", dark]] as const) {
    it(`${name}: muted and subtle text read at 4.5:1 on the panel, cards, menus, hover rows and filled controls`, () => {
      for (const text of ["muted-foreground", "subtle-foreground"]) {
        // The panel, cards, menus, and the hover row and filled control (accent, secondary) a line can sit on.
        for (const surface of ["background", "card", "popover", "accent", "secondary"]) {
          expect(contrast(tokens[text]!, tokens[surface]!), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
});

// Dim text is the subtle token, never foreground or muted at an alpha: an alpha is a contrast ratio nobody chose
// (foreground at 50% is 4.4:1 on the panel, muted at 70% is 3.7:1). Disabled controls are exempt (WCAG 1.4.3).
describe("no text dimmed below AA by an alpha", () => {
  it("keeps foreground at 55% or more and never fades muted or sidebar text", async () => {
    const { execFileSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    // execFileSync, not a shell: cmd.exe keeps single quotes, and a URL's pathname is no Windows cwd.
    const globs = ["apps/web/src/*.tsx", "apps/web/src/*.ts", "packages/ui/src/*.tsx", "packages/ui/src/*.ts"];
    const files = execFileSync("git", ["ls-files", ...globs], { cwd: root, encoding: "utf8" })
      .split(/\r?\n/)
      .filter((f) => f && !f.includes(".test."));
    expect(files.length).toBeGreaterThan(100);
    const dim = /(?<![\w/-])((?:[\w-]+:)*)text-(foreground\/(?:[1-4]\d|50|[1-9])|(?:muted|sidebar|secondary)-foreground\/\d+)(?![\w/.-])/g;
    const found: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(`${root}${f}`, "utf8").matchAll(dim)) if (!m[1]!.includes("disabled")) found.push(`${f}: ${m[0]}`);
    }
    expect(found).toEqual([]);
  });
});
