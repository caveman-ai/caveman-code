// Who runs a chat or an agent, drawn the way the desktop draws it (packages/ui/src/components/runner-badge.tsx and
// model-picker.tsx's VendorMark): every harness shows its vendor's real logo (Claude Agent the Claude spark in its
// clay, never the Claude Code mascot; Codex the OpenAI mark in ink; Cursor, Grok, Pi, OpenCode, Muse, Antigravity
// theirs), the Caveman engine keeps its pixel bust, and any other ACP agent its pixel AC tile. Beside the logo goes
// the model's short name ("Opus 5.5") and a four-step effort pip, never a word; the harness accent is only ever a
// thin rule. Text stays in the chrome tiers. Words always say "Claude Agent".
import { engineIcon } from "@caveman-app/ui/icons/names";
import { LinearGradient } from "expo-linear-gradient";
import type { ReactNode } from "react";
import { type StyleProp, Text, View, type ViewStyle } from "react-native";
import { modelName } from "../../board/catalog";
import { type Colors, alpha, useTheme } from "../../theme";
import { Icon } from "../Icon";
import { PixelIcon } from "../Pixel";
import { BrandMark, type BrandName } from "./BrandMark";

/** The phone's board says "claude" where the desktop's engines say "claude-agent"; both name the same harness. */
export function harnessId(engine: string): string {
  return engine === "claude" ? "claude-agent" : engine;
}

/** What each harness is called, wherever a word names it. */
export const HARNESS_NAME: Record<string, string> = {
  caveman: "Caveman",
  "claude-agent": "Claude Agent",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  muse: "Muse Code",
  grok: "Grok",
  pi: "Pi",
  antigravity: "Antigravity",
};

const BRAND: Partial<Record<string, BrandName>> = {
  "claude-agent": "claude",
  codex: "openai",
  cursor: "cursor",
  opencode: "opencode",
  muse: "muse",
  grok: "grok",
  pi: "pi",
  antigravity: "antigravity",
};

/** The harness's vendor mark; undefined for Caveman (its bust) and other ACP agents (their tile). */
export function engineBrand(engine: string): BrandName | undefined {
  return BRAND[harnessId(engine)];
}

/**
 * The harness logo at `size`: the vendor's mark, or the pixel bust or tile. Pixel art stays crisp only at 16 and 32,
 * so give a pixel logo one of those; a vendor mark draws at any size (14 in a chip, 16 in a row, 20 in a sheet).
 */
export function EngineLogo({ engine, size = 16, label, color, colour = true }: { engine: string; size?: number; label?: string; color?: string; /** The vendor's own colours, as every logo now wears them; off draws the mark in one ink. */ colour?: boolean }) {
  const { c } = useTheme();
  const brand = engineBrand(engine);
  if (brand) return <BrandMark name={brand} size={size} label={label} color={color} mono={!colour} />;
  // The Caveman engine's bust in one ink too (`text`, or the ink it's given: `link` in a thread pill), so its warm
  // tunic never sits beside the amber of needs-you.
  return <PixelIcon name={engineIcon(harnessId(engine))} size={size} label={label} mono={!colour} ink={colour ? undefined : (color ?? c.text)} />;
}

/** The harness accent (pixel.css --runner-*): a delegated agent's 3px rule and its 8% running wash. Never text. */
const ACCENT: Record<"dark" | "light", Record<string, string>> = {
  dark: { caveman: "#eb9d3d", "claude-agent": "#cc785c", codex: "#d9dbdd", cursor: "#bda575", opencode: "#fbbb84", muse: "#0081fa", grok: "#7087a9", pi: "#5ebaab", antigravity: "#8e74dc", acp: "#4fadd8" },
  light: { caveman: "#b36619", "claude-agent": "#cc785c", codex: "#35373b", cursor: "#816837", opencode: "#c16515", muse: "#0081fa", grok: "#445c7e", pi: "#267366", antigravity: "#5c3db8", acp: "#23789f" },
};

export function runnerAccent(engine: string, dark: boolean): string {
  const set = ACCENT[dark ? "dark" : "light"];
  return set[harnessId(engine)] ?? set.acp!;
}

// ---------------------------------------------------------------- effort and speed

const EFFORT_LABEL: Record<string, string> = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultracode: "Ultracode" };

/** An effort level as the picker says it: "Extra high" for xhigh (effort.tsx effortLabel). */
export function effortLabel(level: string): string {
  return EFFORT_LABEL[level] ?? level.charAt(0).toUpperCase() + level.slice(1);
}

/** Past the ceiling the level changes colour: Max danger red, Claude's Ultracode purple; the rest keep the grey. */
export function effortColor(level: string | undefined, c: Colors): string | undefined {
  const l = level?.toLowerCase();
  return l === "max" ? c.effortMax : l === "ultracode" || l === "ultra" ? c.effortUltra : undefined;
}

const EFFORT_STEP: Record<string, number> = { none: 0, minimal: 1, low: 1, medium: 2, high: 3, xhigh: 4, max: 4, ultracode: 4, ultra: 4 };

/** 0 to 4 filled pips for an effort level; an unknown level reads as medium. */
export function effortPips(effort: string): number {
  return EFFORT_STEP[effort.toLowerCase()] ?? 2;
}

/** Four 3pt bars rising 4, 6, 8, 10, filled to the level: a pip, never a word, beside the model. */
export function EffortPip({ effort, color }: { effort: string; color?: string }) {
  const { c } = useTheme();
  const n = effortPips(effort);
  const ink = effortColor(effort, c) ?? color ?? c.muted;
  return (
    <View accessibilityRole="image" accessibilityLabel={`${effortLabel(effort)} effort`} style={{ flexDirection: "row", alignItems: "flex-end", gap: 1, height: 10 }}>
      {[0, 1, 2, 3].map((i) => (
        <View key={i} style={{ width: 3, height: 4 + i * 2, borderRadius: 0.5, backgroundColor: ink, opacity: i < n ? 1 : 0.25 }} />
      ))}
    </View>
  );
}

/** The bolt for a speed past standard (speed.tsx): filled in `speed` while on, two at the fastest of two. */
export function SpeedBolt({ on, double = false, size = 16 }: { on: boolean; double?: boolean; size?: number }) {
  const { c } = useTheme();
  const bolt = <Icon name="speed" size={size} color={on ? c.speed : c.muted} filled={on} />;
  return (
    <View accessibilityRole="image" accessibilityLabel={on ? (double ? "Fastest speed" : "Fast speed") : "Standard speed"} style={{ flexDirection: "row" }}>
      {/* At the fastest speed a second bolt sits first and behind, fainter, as the desktop's SpeedMark draws it. A plain
          view, never Glass, so the opacity is safe. */}
      {double ? <View style={{ opacity: 0.55, marginRight: -size * 0.43 }}>{bolt}</View> : null}
      {bolt}
    </View>
  );
}

// ---------------------------------------------------------------- models

/**
 * A model's short, human name: "Opus 5.5", "GPT-6.1 Sol". From its label where the engine gives one, else from its id
 * by the one lookup (board/catalog.ts modelName: the catalog's name, or one made from the id), minus the vendor's name
 * either way (runner-badge.tsx shortModel).
 */
export function shortModel(label: string | undefined, id?: string): string {
  const name = label || (id ? modelName(id) : "");
  return name.replace(/^(anthropic:?\s*)?(claude|openai)\s+/i, "").trim();
}

/** The Caveman engine's connections and their vendors' marks (model-picker.tsx PROVIDERS). */
const PROVIDER_BRAND: Record<string, BrandName> = {
  anthropic: "claude",
  openai: "openai",
  chatgpt: "openai",
  azure: "openai",
  google: "gemini",
  "google-vertex": "gemini",
  xai: "xai",
  deepseek: "deepseek",
  mistral: "mistral",
  moonshot: "moonshot",
  moonshotai: "moonshot",
  "kimi-coding": "moonshot",
  groq: "groq",
  "github-copilot": "github",
};

/**
 * Whose model this is, for its mark: Claude Agent runs Claude, Codex OpenAI; a Caveman engine model is
 * `provider/model`, so its first slot with a mark. Caveman's own (Auto, credits with no vendor) has none.
 */
export function modelVendor(engine: string, model = ""): BrandName | undefined {
  if (harnessId(engine) !== "caveman") return engineBrand(engine);
  return model
    .split("/")
    .slice(0, -1)
    .map((slot) => PROVIDER_BRAND[slot.split("~")[0]!])
    .find(Boolean);
}

/** A model's mark in the picker, a chat's header and the composer: its vendor's, else the engine's pixel logo. */
export function VendorMark({ engine, model, size = 16 }: { engine: string; model?: string; size?: number }) {
  const vendor = modelVendor(engine, model);
  // In the vendor's own colours: Claude's orange, Gemini's gradient; the marks that are black and white by nature
  // (OpenAI, Cursor, xAI) wear the text colour.
  return vendor ? <BrandMark name={vendor} size={size} /> : <EngineLogo engine={engine} size={16} />;
}

/**
 * A model's name beside its vendor's mark, which already says whose it is: "Opus 5.5" for "Claude Opus 5.5". The
 * agent's own name stays whole ("Claude Agent", where a computer names no model for it).
 */
export function nameBesideMark(label: string, vendor: BrandName | undefined): string {
  return vendor === "claude" ? label.replace(/^Claude\s+(?!Agent\b)/, "") : label;
}

// ---------------------------------------------------------------- the runner

export type Runner = {
  readonly engine: string;
  readonly model?: string;
  /** The model's own label where known ("Claude Opus 5.5"); shortened for display. */
  readonly modelLabel?: string;
  /** The login it runs on (EngineAccount.tag): 2 or 3 letters. */
  readonly tag?: string;
  readonly effort?: string;
};

/**
 * The whole identity on one line (RunnerBadge): logo, the login's tag beside it in small mono caps, the model's short
 * name and the effort pip, all in the description grey. `chip`: inline at 13pt. `header`: a chat's header, the model
 * a step brighter.
 */
export function RunnerBadge({ runner, size = "chip" }: { runner: Runner; size?: "chip" | "header" }) {
  const { c, t } = useTheme();
  const model = shortModel(runner.modelLabel, runner.model);
  const label = [HARNESS_NAME[harnessId(runner.engine)] ?? "Agent", runner.tag, model, runner.effort && `${effortLabel(runner.effort)} effort`].filter(Boolean).join(", ");
  return (
    <View accessible accessibilityLabel={label} style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 }}>
      <EngineLogo engine={runner.engine} size={size === "header" ? 16 : 14} />
      {runner.tag ? <Text style={[t.line, { fontSize: 10.5, letterSpacing: 0.4, color: c.muted }]}>{runner.tag.toUpperCase()}</Text> : null}
      {model ? (
        <Text numberOfLines={1} style={[t.small, { flexShrink: 1, color: size === "header" ? c.soft : c.muted }]}>
          {model}
        </Text>
      ) : null}
      {runner.effort ? <EffortPip effort={runner.effort} /> : null}
    </View>
  );
}

/**
 * The model as the composer's trigger names it (the picker's trigger): the vendor's mark, the name in ink, the effort
 * word in grey (red at Max, purple at Ultracode) and the bolt while a faster speed is on. Wrap it in whatever presses.
 */
export function ModelName({ engine, model, label, effort, fast, size = "row" }: { engine: string; model?: string; label: string; effort?: string; fast?: "fast" | "fastest"; size?: "row" | "small" }) {
  const { c, t } = useTheme();
  const vendor = modelVendor(engine, model);
  const text = size === "row" ? t.label : [t.small, { fontWeight: "500" as const, color: c.text }];
  return (
    // It gives way on a crowded bar, the name truncating with an ellipsis as the desktop's `truncate` does.
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0, flexShrink: 1 }}>
      <VendorMark engine={engine} model={model} size={size === "row" ? 16 : 14} />
      <Text numberOfLines={1} style={[text, { flexShrink: 1 }]}>
        {nameBesideMark(label, vendor)}
      </Text>
      {effort ? <Text style={[text, { fontWeight: "400", color: effortColor(effort, c) ?? c.muted }]}>{effortLabel(effort)}</Text> : null}
      {fast ? <SpeedBolt on double={fast === "fastest"} size={size === "row" ? 16 : 14} /> : null}
    </View>
  );
}

/**
 * A surface carrying the harness accent as a 3pt rule on its left edge (pixel.css runner-edge), with the faint accent
 * wash while it runs. The rule never loops; the status text says it is working.
 */
export function RunnerEdge({ engine, running = false, style, children }: { engine: string; running?: boolean; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const { dark } = useTheme();
  const accent = runnerAccent(engine, dark);
  return (
    <View style={[{ overflow: "hidden" }, style]}>
      {running ? <LinearGradient pointerEvents="none" colors={[alpha(accent, 0.08), alpha(accent, 0)]} locations={[0, 0.55]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0 }} /> : null}
      <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 6, bottom: 6, width: 3, borderRadius: 2, backgroundColor: accent }} />
      {children}
    </View>
  );
}
