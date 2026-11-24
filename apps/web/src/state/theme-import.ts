// Themes from outside: a VS Code colour theme (.json), a VS Code extension
// (.vsix), or an extension found on Open VSX. Each becomes a CustomTheme of
// ThemePalettes: only "#rrggbb" colours survive, so an imported file can
// never put anything but a colour into the page. Modelled on upstream
// vscodeThemeImport.ts and openVsxThemes.ts; the .vsix is read with the
// browser's own DecompressionStream instead of a zip library.
import type { CustomTheme, ThemePalette } from "@caveman-app/session-protocol";
import { BUILT_IN_THEMES, appearanceOf, contrast, hexToRgb, mix, palette, type ThemeAppearance } from "./themes.ts";

// --------------------------------------------------------------- JSONC

/** JSON with the comments and trailing commas VS Code theme files carry. */
export function parseJsonc(text: string): unknown {
  // Pass 1 drops comments; pass 2 drops a comma before } or ]. Both copy strings untouched.
  const string = (src: string, i: number) => {
    let j = i + 1;
    for (; j < src.length && src[j] !== '"'; j++) if (src[j] === "\\") j++;
    return j;
  };
  let bare = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const j = string(text, i);
      bare += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      bare += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) throw new Error("A comment in the theme file is never closed.");
      i = close + 1;
    } else bare += c;
  }
  let out = "";
  for (let i = 0; i < bare.length; i++) {
    const c = bare[i]!;
    if (c === '"') {
      const j = string(bare, i);
      out += bare.slice(i, j + 1);
      i = j;
    } else if (c === ",") {
      let k = i + 1;
      while (/\s/.test(bare[k] ?? "")) k++;
      if (bare[k] !== "}" && bare[k] !== "]") out += c;
    } else out += c;
  }
  return JSON.parse(out);
}

// --------------------------------------------------------------- VS Code

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** "#abc", "#abcd", "#aabbcc" or "#aabbccdd", flattened over `base` when it has alpha. Anything else is null. */
export function vsCodeColor(value: unknown, base: string): string | null {
  if (typeof value !== "string") return null;
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (!m) return null;
  let h = m[1]!.toLowerCase();
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const rgb = `#${h.slice(0, 6)}`;
  const alpha = h.length === 8 ? Number.parseInt(h.slice(6), 16) / 255 : 1;
  return alpha >= 1 ? rgb : mix(base, rgb, alpha);
}

interface TokenColor {
  scope?: unknown;
  settings?: { foreground?: unknown };
}

/** The foreground of the first tokenColors rule naming `scope` (or a parent scope of it). */
function tokenColor(rules: ReadonlyArray<TokenColor>, scope: string): unknown {
  for (const rule of rules) {
    const scopes = Array.isArray(rule.scope) ? rule.scope : typeof rule.scope === "string" ? rule.scope.split(",") : [];
    if (scopes.some((s) => typeof s === "string" && (scope === s.trim() || scope.startsWith(`${s.trim()}.`)))) {
      if (rule.settings?.foreground !== undefined) return rule.settings.foreground;
    }
  }
  return undefined;
}

export interface ParsedTheme {
  readonly name: string;
  readonly appearance: ThemeAppearance;
  readonly palette: ThemePalette;
}

/**
 * A VS Code theme's `colors` and `tokenColors` as a palette. Surfaces come
 * from the workbench colours, the eight hues from the terminal's ANSI
 * colours (then syntax scopes), and whatever the file leaves out from the
 * built-in GitHub theme of the same appearance.
 */
export function parseVsCodeTheme(json: unknown, hint?: { name?: string; uiTheme?: string }): ParsedTheme {
  if (!isRecord(json)) throw new Error("Not a VS Code theme: the file isn't a JSON object.");
  const colors = isRecord(json.colors) ? json.colors : {};
  const rules = (Array.isArray(json.tokenColors) ? json.tokenColors : []).filter(isRecord) as TokenColor[];
  if (Object.keys(colors).length === 0 && rules.length === 0) throw new Error("Not a VS Code theme: it has no colors or tokenColors.");
  const declared = hint?.uiTheme ?? (typeof json.type === "string" ? json.type : undefined);
  const typed: ThemeAppearance | undefined = declared === undefined ? undefined : /light|^vs$/.test(declared) ? "light" : "dark";
  const panel = vsCodeColor(colors["editor.background"], typed === "light" ? "#ffffff" : "#000000") ?? (typed === "light" ? "#ffffff" : "#1e1e1e");
  const appearance = typed ?? appearanceOf(panel);
  const fallback = BUILT_IN_THEMES.find((t) => t.id === "github")![appearance]!;
  const pick = (...values: unknown[]) => {
    for (const v of values) {
      const c = vsCodeColor(v, panel);
      if (c) return c;
    }
    return undefined;
  };
  const text = pick(colors["editor.foreground"], colors.foreground) ?? fallback.text;
  const shell = pick(colors["sideBar.background"], colors["activityBar.background"]);
  const border = pick(colors["panel.border"], colors["editorGroup.border"], colors["sideBar.border"], colors["editorWidget.border"]);
  const red = pick(colors["terminal.ansiRed"], colors.errorForeground, tokenColor(rules, "invalid")) ?? fallback.red;
  const yellow = pick(colors["terminal.ansiYellow"], colors["editorWarning.foreground"]) ?? fallback.yellow;
  const blue = pick(colors["terminal.ansiBlue"], tokenColor(rules, "entity.name.function")) ?? fallback.blue;
  const purple = pick(colors["terminal.ansiMagenta"], tokenColor(rules, "keyword")) ?? fallback.purple;
  const name = (typeof json.name === "string" && json.name.trim()) || hint?.name || "Imported theme";
  return {
    name: name.replace(/[\0\n]/g, " ").slice(0, 64),
    appearance,
    palette: palette({
      panel,
      text,
      // A shell or border the same as the panel would flatten the deck's layers: let palette() step them instead.
      ...(shell && shell !== panel ? { shell } : {}),
      ...(border && border !== panel ? { border } : {}),
      ...optional("raised", pick(colors["editorWidget.background"], colors["dropdown.background"])),
      ...optional("hover", pick(colors["list.hoverBackground"], colors["list.inactiveSelectionBackground"])),
      dim: [tokenColor(rules, "comment"), colors.descriptionForeground, colors["editorLineNumber.foreground"]].map((v) => vsCodeColor(v, panel)).find((c) => c && c !== text) ?? mix(text, panel, 0.4),
      // The first of the theme's own highlight colours that is a colour at all: some themes fill buttons grey.
      accent:
        [colors["button.background"], colors["activityBarBadge.background"], colors.focusBorder, colors["textLink.foreground"], colors["progressBar.background"]]
          .map((v) => vsCodeColor(v, panel))
          .find((c) => c && saturation(c) >= 0.3 && contrast(c, panel) >= 2.5) ?? blue,
      red,
      orange: pick(tokenColor(rules, "constant.numeric"), colors["terminal.ansiBrightYellow"]) ?? mix(red, yellow, 0.5),
      yellow,
      green: pick(colors["terminal.ansiGreen"], tokenColor(rules, "string")) ?? fallback.green,
      cyan: pick(colors["terminal.ansiCyan"], tokenColor(rules, "support.type")) ?? fallback.cyan,
      blue,
      purple,
      pink: pick(colors["terminal.ansiBrightMagenta"]) ?? purple,
    }),
  };
}

/** HSL saturation, 0..1: how much of a colour, as against a grey, it is. */
function saturation(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  return max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value ? ({ [key]: value } as Record<K, string>) : {};
}

/** A file name or label as a custom theme id. */
export function customThemeId(...parts: string[]): CustomTheme["id"] {
  const slug = parts
    .join("-")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return `custom:${slug || "theme"}`;
}

/**
 * Themes as CustomThemes. One dark and one light (or one of either side
 * against several of the other, as Catppuccin's three darks and Latte) pair
 * into themes with both halves; otherwise each stands alone.
 */
export function pairThemes(parsed: ReadonlyArray<ParsedTheme>, source: string): CustomTheme[] {
  const darks = parsed.filter((t) => t.appearance === "dark");
  const lights = parsed.filter((t) => t.appearance === "light");
  // Two names can slug alike ("Theme" and "Theme+"), or a long source cut them alike: number the repeats.
  const taken = new Set<string>();
  const uniqueId = (name: string) => {
    let id = customThemeId(source, name);
    for (let n = 2; taken.has(id); n++) id = `${customThemeId(source, name).slice(0, 7 + 60)}-${n}`;
    taken.add(id);
    return id;
  };
  const make = (lead: ParsedTheme, dark?: ParsedTheme, light?: ParsedTheme): CustomTheme => ({
    id: uniqueId(lead.name),
    name: lead.name,
    source,
    ...(dark ? { dark: dark.palette } : {}),
    ...(light ? { light: light.palette } : {}),
  });
  if (darks.length >= 1 && lights.length === 1) return darks.map((d) => make(d, d, lights[0]));
  if (lights.length > 1 && darks.length === 1) return lights.map((l) => make(l, darks[0], l));
  // Gruvbox's "Dark Medium" and "Light Medium": the same name but for the side.
  const side = (name: string) => name.toLowerCase().replace(/\b(dark|light)\b/g, "").replace(/\s+/g, " ").trim();
  const partner = (d: ParsedTheme) => lights.filter((l) => side(l.name) === side(d.name));
  if (darks.length > 0 && darks.length === lights.length && darks.every((d) => partner(d).length === 1)) {
    return darks.map((d) => {
      const l = partner(d)[0]!;
      return { ...make(d, d, l), name: d.name.replace(/\s*\b[Dd]ark\b\s*/, " ").replace(/\s+/g, " ").trim() || d.name };
    });
  }
  return parsed.map((t) => make(t, t.appearance === "dark" ? t : undefined, t.appearance === "light" ? t : undefined));
}

// --------------------------------------------------------------- .vsix

/** Theme JSON is rarely past 500 KB; a bigger file isn't a theme. */
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;

/** A zip's entries by path, each read (and inflated) on demand. Enough of the format for a .vsix: no zip64, no encryption. */
export function readZip(bytes: Uint8Array): Map<string, () => Promise<Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("Not a .vsix: no zip directory found.");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries = new Map<string, () => Promise<Uint8Array>>();
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("Not a .vsix: a damaged zip directory.");
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    let read: Promise<Uint8Array> | undefined;
    // Read once: twelve themes including one base file would otherwise inflate it twelve times.
    entries.set(name, () => (read ??= readEntry()));
    const readEntry = async () => {
      if (size > MAX_ENTRY_BYTES || compressed > MAX_ENTRY_BYTES) throw new Error(`${name} is too large to be a theme.`);
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + compressed);
      if (method === 0) return data;
      if (method !== 8) throw new Error(`${name} uses a zip compression the app can't read.`);
      return inflate(data);
    };
  }
  return entries;
}

/** Raw deflate, stopped at MAX_ENTRY_BYTES whatever the zip's directory claims. */
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ENTRY_BYTES) {
      await reader.cancel();
      throw new Error("A file in the .vsix is too large to be a theme.");
    }
    chunks.push(value);
  }
  return concat(chunks, total);
}

function concat(chunks: ReadonlyArray<Uint8Array>, total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** A theme extension past this carries much more than themes. */
const MAX_VSIX_BYTES = 30 * 1024 * 1024;

/** `relative` resolved against the directory of `from`, inside the zip. */
function zipPath(from: string, relative: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const seg of relative.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}

/** A theme file and the files it `include`s (VS Code merges them: the including file wins). */
async function readThemeFile(zip: Map<string, () => Promise<Uint8Array>>, parsed: Map<string, unknown>, path: string, depth = 0): Promise<Record<string, unknown>> {
  const read = zip.get(path);
  if (!read) throw new Error(`The extension names ${path}, but it isn't in the .vsix.`);
  if (!parsed.has(path)) parsed.set(path, parseJsonc(new TextDecoder().decode(await read())));
  const json = parsed.get(path);
  if (!isRecord(json)) throw new Error(`${path} isn't a theme.`);
  if (typeof json.include !== "string" || depth > 3) return json;
  const base = await readThemeFile(zip, parsed, zipPath(path, json.include), depth + 1);
  return {
    ...base,
    ...json,
    colors: { ...(isRecord(base.colors) ? base.colors : {}), ...(isRecord(json.colors) ? json.colors : {}) },
    tokenColors: [...(Array.isArray(json.tokenColors) ? json.tokenColors : []), ...(Array.isArray(base.tokenColors) ? base.tokenColors : [])],
  };
}

/** Most themes an extension may bring in one go. */
const MAX_THEMES_PER_EXTENSION = 12;

/** Every colour theme a .vsix contributes, paired into light/dark where it can be. */
export async function themesFromVsix(bytes: Uint8Array, source: string): Promise<CustomTheme[]> {
  const zip = readZip(bytes);
  const manifest = zip.get("extension/package.json");
  if (!manifest) throw new Error("Not a VS Code extension: it has no package.json.");
  const pkg = parseJsonc(new TextDecoder().decode(await manifest()));
  const contributed = isRecord(pkg) && isRecord(pkg.contributes) && Array.isArray(pkg.contributes.themes) ? pkg.contributes.themes.filter(isRecord) : [];
  if (contributed.length === 0) throw new Error("This extension has no colour themes.");
  const parsed: ParsedTheme[] = [];
  const files = new Map<string, unknown>();
  let firstError: unknown;
  for (const t of contributed.slice(0, MAX_THEMES_PER_EXTENSION)) {
    try {
      if (typeof t.path !== "string" || !/\.jsonc?$/i.test(t.path)) throw new Error("Only JSON colour themes can be imported (not .tmTheme).");
      const json = await readThemeFile(zip, files, zipPath("extension/package.json", t.path));
      const theme = parseVsCodeTheme(json, typeof t.uiTheme === "string" ? { uiTheme: t.uiTheme } : {});
      // The label is what VS Code's theme picker shows; a file's own name is often a slug.
      parsed.push(typeof t.label === "string" && t.label.trim() ? { ...theme, name: t.label.trim().replace(/[\0\n]/g, " ").slice(0, 64) } : theme);
    } catch (cause) {
      // One broken theme doesn't sink the rest of the extension.
      firstError ??= cause;
    }
  }
  if (parsed.length === 0) throw firstError instanceof Error ? firstError : new Error("This extension has no colour themes the app can read.");
  return pairThemes(parsed, source);
}

/** A file the user dropped or picked: a theme .json or an extension .vsix. */
export async function themesFromFile(file: File): Promise<CustomTheme[]> {
  if (file.size > MAX_VSIX_BYTES) throw new Error("That file is too large to be a theme.");
  const stem = file.name.replace(/\.[^.]+$/, "");
  if (/\.vsix$/i.test(file.name)) return themesFromVsix(new Uint8Array(await file.arrayBuffer()), stem);
  const parsed = parseVsCodeTheme(parseJsonc(await file.text()), { name: stem });
  return pairThemes([parsed], stem);
}

// --------------------------------------------------------------- Open VSX

export interface OpenVsxExtension {
  readonly id: string;
  readonly name: string;
  readonly publisher: string;
  readonly description: string;
  readonly downloads: number;
  readonly iconUrl: string | null;
  readonly downloadUrl: string;
}

const OPEN_VSX = "https://open-vsx.org";

const onOpenVsx = (url: unknown): url is string => {
  try {
    const u = new URL(String(url));
    return u.protocol === "https:" && u.hostname === "open-vsx.org";
  } catch {
    return false;
  }
};

/** Colour-theme extensions on Open VSX, most downloaded first. */
export async function searchOpenVsx(query: string, signal?: AbortSignal): Promise<OpenVsxExtension[]> {
  const url = `${OPEN_VSX}/api/-/search?${new URLSearchParams({ query, category: "Themes", size: "24", sortBy: "downloadCount", sortOrder: "desc" })}`;
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok) throw new Error(`Open VSX answered ${response.status}.`);
  const body = (await response.json()) as { extensions?: unknown };
  return (Array.isArray(body.extensions) ? body.extensions : []).filter(isRecord).flatMap((e) => {
    const files = isRecord(e.files) ? e.files : {};
    if (typeof e.namespace !== "string" || typeof e.name !== "string" || !onOpenVsx(files.download)) return [];
    return [
      {
        id: `${e.namespace}.${e.name}`,
        name: typeof e.displayName === "string" && e.displayName ? e.displayName : e.name,
        publisher: e.namespace,
        description: typeof e.description === "string" ? e.description : "",
        downloads: typeof e.downloadCount === "number" ? e.downloadCount : 0,
        iconUrl: onOpenVsx(files.icon) ? files.icon : null,
        downloadUrl: files.download,
      },
    ];
  });
}

/** Download an extension from Open VSX and read its themes. */
export async function installOpenVsx(extension: OpenVsxExtension, signal?: AbortSignal): Promise<CustomTheme[]> {
  if (!onOpenVsx(extension.downloadUrl)) throw new Error("Only extensions from open-vsx.org can be installed.");
  const response = await fetch(extension.downloadUrl, signal ? { signal } : {});
  if (!response.ok || !response.body) throw new Error(`Open VSX answered ${response.status}.`);
  const tooLarge = () => new Error("That extension is too large to be a theme.");
  if (Number(response.headers.get("content-length") ?? 0) > MAX_VSIX_BYTES) throw tooLarge();
  // Counted as it arrives: the header can be missing or wrong.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_VSIX_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return themesFromVsix(concat(chunks, total), extension.id);
}
