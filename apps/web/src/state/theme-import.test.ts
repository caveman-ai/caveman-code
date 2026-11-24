import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { pairThemes, parseJsonc, parseVsCodeTheme, readZip, themesFromVsix, vsCodeColor } from "./theme-import.ts";

/** A minimal zip (deflate), enough to stand in for a .vsix. */
function zip(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = enc.encode(name);
    const raw = enc.encode(text);
    const data = new Uint8Array(deflateRawSync(raw));
    const local = new Uint8Array(30 + n.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 8, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, n.length, true);
    local.set(n, 30);
    local.set(data, 30 + n.length);
    const central = new Uint8Array(46 + n.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, n.length, true);
    cv.setUint32(42, offset, true);
    central.set(n, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const size = centrals.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + size + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const mocha = {
  name: "Mocha",
  type: "dark",
  colors: {
    "editor.background": "#1e1e2e",
    "editor.foreground": "#cdd6f4",
    "sideBar.background": "#181825",
    "button.background": "#cba6f7",
    "list.hoverBackground": "#cdd6f41a",
    "terminal.ansiRed": "#f38ba8",
    "terminal.ansiBlue": "#89b4fa",
  },
  tokenColors: [{ scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#9399b2" } }],
};

describe("VS Code themes", () => {
  it("parses JSONC: comments and trailing commas, but not inside strings", () => {
    expect(parseJsonc('{ // c\n "a": "x//y", /* b */ "b": [1, 2,], }')).toEqual({ a: "x//y", b: [1, 2] });
    expect(parseJsonc('{ "a": "x,]", "b": "q\\"/*", }')).toEqual({ a: "x,]", b: 'q"/*' });
    expect(parseJsonc('{ "a": 1, // last\n }')).toEqual({ a: 1 });
    expect(() => parseJsonc('{ "a": 1 /* never closed')).toThrow(/never closed/);
  });

  it("reads colours: short forms, alpha flattened over the panel, nothing else", () => {
    expect(vsCodeColor("#ABC", "#000000")).toBe("#aabbcc");
    expect(vsCodeColor("#ffffff80", "#000000")).toBe("#808080");
    expect(vsCodeColor("red", "#000000")).toBeNull();
    expect(vsCodeColor("#fff; x: y", "#000000")).toBeNull();
  });

  it("maps the workbench, terminal and syntax colours onto a palette, the gaps from GitHub", () => {
    const t = parseVsCodeTheme(mocha);
    expect(t).toMatchObject({ name: "Mocha", appearance: "dark" });
    expect(t.palette).toMatchObject({ panel: "#1e1e2e", shell: "#181825", text: "#cdd6f4", dim: "#9399b2", accent: "#cba6f7", red: "#f38ba8", blue: "#89b4fa" });
    expect(t.palette.hover).toMatch(/^#[0-9a-f]{6}$/);
    expect(t.palette.green).toBe("#3fb950");
    expect(parseVsCodeTheme({ colors: { "editor.background": "#fdf6e3" } }).appearance).toBe("light");
    expect(() => parseVsCodeTheme({ hello: 1 })).toThrow(/Not a VS Code theme/);
  });

  it("pairs light and dark: one light with every dark, or by the name less its side", () => {
    const d = (name: string) => ({ ...parseVsCodeTheme(mocha), name });
    const l = (name: string) => ({ ...parseVsCodeTheme({ colors: { "editor.background": "#eff1f5" } }), name });
    const cat = pairThemes([d("Mocha"), d("Frappé"), l("Latte")], "cat");
    expect(cat.map((t) => [t.id, !!t.dark, !!t.light])).toEqual([["custom:cat-mocha", true, true], ["custom:cat-frappe", true, true]]);
    const gruv = pairThemes([d("Gruvbox Dark Hard"), d("Gruvbox Dark Soft"), l("Gruvbox Light Soft"), l("Gruvbox Light Hard")], "gruvbox");
    expect(gruv.map((t) => t.name)).toEqual(["Gruvbox Hard", "Gruvbox Soft"]);
    expect(gruv.every((t) => t.dark && t.light)).toBe(true);
    expect(pairThemes([d("A"), d("B"), l("C"), l("D")], "x")).toHaveLength(4);
    // Names that slug alike still get their own ids.
    expect(pairThemes([d("Theme"), d("Theme+")], "x").map((t) => t.id)).toEqual(["custom:x-theme", "custom:x-theme-2"]);
  });
});

describe(".vsix", () => {
  it("reads every contributed theme, following includes, with ids the protocol accepts", async () => {
    const vsix = zip({
      "extension/package.json": JSON.stringify({
        contributes: {
          themes: [
            { label: "Night", uiTheme: "vs-dark", path: "./themes/night.json" },
            { label: "Day", uiTheme: "vs", path: "./themes/day.json" },
          ],
        },
      }),
      "extension/themes/base.json": JSON.stringify({ colors: { "editor.foreground": "#cdd6f4", "terminal.ansiRed": "#f38ba8" } }),
      "extension/themes/night.json": '{ "include": "./base.json", // dark\n "colors": { "editor.background": "#1e1e2e", }, }',
      "extension/themes/day.json": JSON.stringify({ colors: { "editor.background": "#eff1f5", "editor.foreground": "#4c4f69" } }),
    });
    expect([...readZip(vsix).keys()]).toContain("extension/themes/base.json");
    const [night, ...rest] = await themesFromVsix(vsix, "acme.night-owl");
    expect(rest).toHaveLength(0);
    expect(night).toMatchObject({ id: "custom:acme-night-owl-night", name: "Night", source: "acme.night-owl" });
    expect(night!.dark).toMatchObject({ panel: "#1e1e2e", text: "#cdd6f4", red: "#f38ba8" });
    expect(night!.light).toMatchObject({ panel: "#eff1f5", text: "#4c4f69" });
    expect(night!.id).toMatch(/^custom:[a-z0-9][a-z0-9-]{0,63}$/);
  });

  it("skips a theme it can't read and keeps the rest", async () => {
    const vsix = zip({
      "extension/package.json": JSON.stringify({ contributes: { themes: [{ label: "Old", path: "./old.tmTheme" }, { label: "Broken", path: "./broken.json" }, { label: "Good", uiTheme: "vs-dark", path: "./good.json" }] } }),
      "extension/broken.json": "{ not json",
      "extension/good.json": JSON.stringify({ colors: { "editor.background": "#101010" } }),
    });
    expect((await themesFromVsix(vsix, "x")).map((t) => t.name)).toEqual(["Good"]);
    const none = zip({ "extension/package.json": JSON.stringify({ contributes: { themes: [{ label: "Old", path: "./old.tmTheme" }] } }) });
    await expect(themesFromVsix(none, "x")).rejects.toThrow(/tmTheme/);
  });

  it("refuses an extension with no themes, or a file that isn't a zip", async () => {
    await expect(themesFromVsix(zip({ "extension/package.json": "{}" }), "x")).rejects.toThrow(/no colour themes/);
    expect(() => readZip(new TextEncoder().encode("not a zip at all, just text padding it out"))).toThrow(/Not a .vsix/);
  });
});
