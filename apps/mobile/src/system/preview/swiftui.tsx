// Expo UI's SwiftUI views, drawn on the web, for the `/?system` previews. The widget layouts (widgets/layouts.tsx) are
// `'widget'` functions the bundler turns into strings; the iPhone's widget extension evaluates each with the SwiftUI
// views and modifiers as globals (expo-widgets bundle/index.ts). This does the same with stand-ins: every view is a
// marker naming itself, each modifier builds the `{ $type, … }` record Expo UI's own does (its module reaches for
// native code as it loads, so it can't be imported here; MODIFIERS mirrors the ones the layouts use), and `Swift` lays the
// resulting tree out in React Native views the way SwiftUI would, closely enough to judge a design by: stacks with
// their spacing and alignment, spacers, frames, padding, fonts, hierarchical colours, line limits, buttons, images.
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { Image as RNImage, Text as RNText, View, type ViewStyle } from "react-native";
import { Icon, type IconName } from "../../components/Icon";

/** A node of a widget layout's tree, as the extension's JSX runtime makes it. */
export interface SwiftNode {
  type: string;
  key: string | null;
  props: Record<string, unknown> & { modifiers?: readonly Modifier[]; children?: unknown };
}
type Modifier = { $type: string } & Record<string, unknown>;

const VIEWS = ["Button", "HStack", "VStack", "ZStack", "Text", "Image", "Spacer", "Link", "Divider", "Label", "ProgressView", "Gauge", "Group", "Rectangle", "RoundedRectangle", "Capsule", "Circle", "AccessoryWidgetBackground"];

/** Expo UI's shape styles: a bare colour becomes `{ type: "color" }`, a hierarchical one names its level. */
const shape = (style: unknown) => {
  if (style == null || typeof style !== "object" || !("type" in style)) return { type: "color", color: style };
  const s = style as { type: string; style?: string };
  return s.type === "hierarchical" ? { type: "hierarchical", hierarchical: s.style } : style;
};
const mod = ($type: string, params: object = {}) => ({ $type, ...params });

/** The modifiers the layouts use, as Expo UI builds them (@expo/ui build/swift-ui/modifiers/index.js). */
const MODIFIERS: Record<string, (...args: never[]) => unknown> = {
  font: (p: object) => mod("font", p),
  foregroundStyle: (style: unknown) => mod("foregroundStyle", { style: shape(style) }),
  tint: (t: unknown) => mod("tint", { tint: shape(t) }),
  padding: (p: object = {}) => mod("padding", p),
  frame: (p: object) => mod("frame", p),
  lineLimit: (limit: number) => mod("lineLimit", { limit }),
  monospacedDigit: () => mod("monospacedDigit"),
  resizable: () => mod("resizable"),
  widgetURL: (url: string) => mod("widgetURL", { url }),
  containerBackground: (style: unknown, container: string) => mod("containerBackground", { style: shape(style), container }),
  buttonStyle: (style: string) => mod("buttonStyle", { style }),
  buttonBorderShape: (s: string) => mod("buttonBorderShape", { shape: s }),
  controlSize: (size: string) => mod("controlSize", { size }),
  opacity: (value: number) => mod("opacity", { value }),
  minimumScaleFactor: (factor: number) => mod("minimumScaleFactor", { factor }),
  background: (style: unknown) => mod("background", { style: shape(style) }),
  clipShape: (s: string, cornerRadius?: number) => mod("clipShape", { shape: s, cornerRadius }),
};

const jsx = (type: unknown, config: Record<string, unknown> | null, maybeKey?: unknown): SwiftNode => {
  const { key = maybeKey, ...props } = config ?? {};
  return { type: String(type), key: key == null ? null : String(key), props };
};

/** The globals a layout's string expects (the extension's own: bundle/index.ts, jsx-runtime-stub.ts, ui-globals.ts). */
const SCOPE: Record<string, unknown> = {
  ...Object.fromEntries(VIEWS.map((v) => [v, v])),
  ...MODIFIERS,
  jsx,
  jsxs: jsx,
  jsxDEV: jsx,
  _jsx: jsx,
  _jsxs: jsx,
  _jsxDEV: jsx,
  Fragment: "Fragment",
  _Fragment: "Fragment",
  _jsxFileName: "widget",
};

/** A layout's string (or, untransformed, its function) as a function of its props and environment. */
export function evaluate<P, E, R>(layout: unknown): (props: P, env: E) => R {
  if (typeof layout === "function") return layout as (props: P, env: E) => R;
  const names = Object.keys(SCOPE);
  // The same evaluation the extension does, `(<layout>)`, with the stand-ins in scope instead of as globals.
  // eslint-disable-next-line no-new-func
  const make = new Function(...names, `return (${String(layout)});`) as (...args: unknown[]) => (props: P, env: E) => R;
  return make(...names.map((n) => SCOPE[n]));
}

// ---------------------------------------------------------------- what SwiftUI resolves on its own

export interface Look {
  dark: boolean;
  /** Lock Screen and accessory widgets draw everything in the system's one ink. */
  vibrant?: boolean;
}
const LookContext = createContext<Look>({ dark: true });
/** What a container's modifiers hand down: SwiftUI's foreground style, font and line limit are environment values. */
interface Inherited {
  color?: string;
  font?: { size?: number; weight?: string; design?: string };
  lines?: number;
}
const Inherit = createContext<Inherited>({});

const WEIGHT: Record<string, string> = { ultraLight: "100", thin: "200", light: "300", regular: "400", medium: "500", semibold: "600", bold: "700", heavy: "800", black: "900" };

function colorOf(style: unknown, look: Look): string | undefined {
  if (style == null) return undefined;
  if (typeof style === "string") return look.vibrant ? (look.dark ? "#ffffff" : "#000000") : style;
  if (typeof style === "object") {
    const s = style as { type?: string; style?: string; hierarchical?: string; color?: string };
    if (s.type === "hierarchical") {
      const level = s.hierarchical ?? s.style;
      const base = look.dark ? "255,255,255" : "0,0,0";
      const alpha = level === "primary" ? (look.dark ? 0.96 : 0.92) : level === "secondary" ? 0.6 : level === "tertiary" ? 0.35 : 0.22;
      return `rgba(${base},${alpha})`;
    }
    if (s.type === "color" && s.color) return colorOf(s.color, look);
  }
  return undefined;
}

const find = (mods: readonly Modifier[] | undefined, type: string) => mods?.findLast((m) => m.$type === type);

/** Padding, frame and the inherited values a node's modifiers set. */
function boxOf(mods: readonly Modifier[] | undefined, look: Look) {
  // React Native's style types are read-only; this one is built up here and handed over once.
  const style: { -readonly [K in keyof ViewStyle]: ViewStyle[K] } = {};
  const inherit: Inherited = {};
  let background: string | undefined;
  for (const m of mods ?? []) {
    switch (m.$type) {
      case "padding": {
        const n = (v: unknown) => (typeof v === "number" ? v : v === undefined ? undefined : 16);
        if (m.all !== undefined) style.padding = n(m.all);
        if (m.horizontal !== undefined) style.paddingHorizontal = n(m.horizontal);
        if (m.vertical !== undefined) style.paddingVertical = n(m.vertical);
        if (m.top !== undefined) style.paddingTop = n(m.top);
        if (m.bottom !== undefined) style.paddingBottom = n(m.bottom);
        if (m.leading !== undefined) style.paddingLeft = n(m.leading);
        if (m.trailing !== undefined) style.paddingRight = n(m.trailing);
        if (Object.keys(m).length === 1) style.padding = 16;
        break;
      }
      case "frame": {
        if (typeof m.width === "number") style.width = m.width;
        if (typeof m.height === "number") style.height = m.height;
        if (typeof m.maxWidth === "number") {
          style.flexGrow = 1;
          style.flexBasis = 0;
          style.alignSelf = "stretch";
        }
        if (typeof m.minWidth === "number") style.minWidth = m.minWidth;
        if (typeof m.minHeight === "number") style.minHeight = m.minHeight;
        if (typeof m.maxHeight === "number") style.maxHeight = m.maxHeight;
        break;
      }
      case "clipShape": {
        style.overflow = "hidden";
        style.borderRadius = m.shape === "capsule" || m.shape === "circle" ? 999 : typeof m.cornerRadius === "number" ? m.cornerRadius : 8;
      }
      case "foregroundStyle":
      case "foregroundColor":
        inherit.color = colorOf(m.style ?? m.color ?? (m as { value?: unknown }).value, look) ?? inherit.color;
        break;
      case "font":
        inherit.font = { size: m.size as number | undefined, weight: m.weight as string | undefined, design: m.design as string | undefined };
        break;
      case "lineLimit":
        inherit.lines = typeof m.limit === "number" ? m.limit : undefined;
        break;
      case "background":
      case "containerBackground":
        background = colorOf(m.style ?? m.color, look);
        break;
      case "opacity":
        style.opacity = m.value as number;
        break;
    }
  }
  if (background) style.backgroundColor = background;
  return { style, inherit };
}

/** SF Symbols the layouts use, drawn with the app's own icons. */
const SYMBOLS: Record<string, { icon: IconName; disc?: boolean }> = {
  "checkmark.circle.fill": { icon: "check", disc: true },
  "exclamationmark.circle.fill": { icon: "alert", disc: true },
  "phone.fill": { icon: "call" },
  "phone.down.fill": { icon: "hangUp" },
  "mic.fill": { icon: "mic" },
  "mic.slash.fill": { icon: "micOff" },
  "square.and.pencil": { icon: "compose" },
  waveform: { icon: "voice" },
  "bubble.left": { icon: "comment" },
};

/** A frame's size, read off a node, for an image that fills it. */
const sizeOf = (mods: readonly Modifier[] | undefined) => {
  const f = find(mods, "frame");
  return { w: typeof f?.width === "number" ? f.width : undefined, h: typeof f?.height === "number" ? f.height : undefined };
};

function Symbol({ name, size, color }: { name: string; size: number; color: string }) {
  const sym = SYMBOLS[name];
  if (name === "flame.fill") return <RNText style={{ fontSize: size * 0.9, lineHeight: size, color }}>🔥</RNText>;
  if (!sym) return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
  if (sym.disc) {
    return (
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, alignItems: "center", justifyContent: "center" }}>
        <Icon name={sym.icon} size={size * 0.62} color="#000000" stroke={2.6} />
      </View>
    );
  }
  return <Icon name={sym.icon} size={size} color={color} stroke={2} filled={name.endsWith(".fill") && sym.icon === "call"} />;
}

/** The call's clock, ticking, as SwiftUI's `Text(date, style: .timer)` does. */
function Timer({ since, style }: { since: number; style: object }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return <RNText style={style}>{`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`}</RNText>;
}

function textStyle(inherit: Inherited, look: Look, mods: readonly Modifier[] | undefined) {
  const font = inherit.font ?? {};
  const size = font.size ?? 17;
  const mono = !!find(mods, "monospacedDigit");
  return {
    color: inherit.color ?? colorOf({ type: "hierarchical", style: "primary" }, look),
    fontSize: size,
    lineHeight: Math.round(size * 1.24),
    fontWeight: (WEIGHT[font.weight ?? "regular"] ?? "400") as "400",
    fontFamily: font.design === "rounded" ? "ui-rounded, -apple-system, system-ui, sans-serif" : "-apple-system, system-ui, 'SF Pro Text', sans-serif",
    letterSpacing: size >= 20 ? -0.4 : -0.1,
    ...(mono ? { fontVariant: ["tabular-nums" as const] } : null),
  };
}

const children = (node: SwiftNode): unknown[] => {
  const c = node.props.children;
  return (Array.isArray(c) ? c.flat(Infinity) : [c]).filter((x) => x !== null && x !== undefined && x !== false && x !== "");
};

/** One node of a layout, laid out the way SwiftUI would. */
export function Swift({ node, axis }: { node: unknown; axis?: "h" | "v" }): ReactNode {
  const look = useContext(LookContext);
  const above = useContext(Inherit);
  if (node === null || node === undefined || node === false) return null;
  if (Array.isArray(node)) return node.map((n, i) => <Swift key={i} node={n} axis={axis} />);
  if (typeof node === "string" || typeof node === "number") return <RNText style={textStyle(above, look, undefined)}>{String(node)}</RNText>;
  const n = node as SwiftNode;
  const mods = n.props.modifiers;
  const { style, inherit } = boxOf(mods, look);
  const here: Inherited = { ...above, ...Object.fromEntries(Object.entries(inherit).filter(([, v]) => v !== undefined)) };
  const kids = children(n);
  const wrap = (body: ReactNode) => <Inherit.Provider value={here}>{body}</Inherit.Provider>;

  switch (n.type) {
    case "Fragment":
    case "Group":
      return wrap(kids.map((k, i) => <Swift key={i} node={k} axis={axis} />));
    case "Link":
      return wrap(
        <View style={[{ minWidth: 0 }, style]}>
          {kids.map((k, i) => (
            <Swift key={i} node={k} axis={axis} />
          ))}
        </View>,
      );
    case "VStack":
    case "HStack":
    case "ZStack": {
      const h = n.type === "HStack";
      const z = n.type === "ZStack";
      const align = String(n.props.alignment ?? "center");
      const cross = align === "leading" || align === "top" ? "flex-start" : align === "trailing" || align === "bottom" ? "flex-end" : align.endsWith("TextBaseline") ? "baseline" : "center";
      const spacing = typeof n.props.spacing === "number" ? n.props.spacing : 8;
      // A frame wider than what the stack holds places it by the frame's alignment, the centre unless it says.
      const f = find(mods, "frame");
      const framed = h && f && (typeof f.maxWidth === "number" || typeof f.width === "number");
      const main = framed ? (f.alignment === "leading" ? "flex-start" : f.alignment === "trailing" ? "flex-end" : "center") : "flex-start";
      return wrap(
        <View style={[{ flexDirection: h ? "row" : "column", alignItems: z ? "center" : cross, justifyContent: z ? "center" : main, gap: z ? 0 : spacing, minWidth: 0, flexShrink: 1 }, h && !style.width ? { alignSelf: "stretch" } : null, style]}>
          {kids.map((k, i) => (
            <Swift key={i} node={k} axis={h ? "h" : "v"} />
          ))}
        </View>,
      );
    }
    case "Spacer": {
      const min = typeof n.props.minLength === "number" ? n.props.minLength : 8;
      return <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: axis === "h" ? min : 0, minHeight: axis === "v" ? min : 0 }} />;
    }
    case "Text": {
      const t = textStyle(here, look, mods);
      const lines = here.lines;
      if (n.props.date instanceof Date) return <Timer since={n.props.date.getTime()} style={[t, style] as object} />;
      return (
        <RNText numberOfLines={lines} style={[t, { flexShrink: 1, minWidth: 0 }, style]}>
          {kids.map((k) => (typeof k === "string" || typeof k === "number" ? String(k) : "")).join("")}
        </RNText>
      );
    }
    case "Image": {
      // Inside a frame (the layouts size images by the container around them), it fills that frame.
      const fill = { width: "100%" as const, height: "100%" as const };
      if (typeof n.props.uiImage === "string") return <RNImage source={{ uri: n.props.uiImage }} style={[fill, { imageRendering: "pixelated" } as object]} resizeMode="contain" />;
      const color = here.color ?? colorOf({ type: "hierarchical", style: "primary" }, look) ?? "#fff";
      return (
        <View style={[fill, { alignItems: "center", justifyContent: "center" }]} onLayout={undefined}>
          <SymbolFill name={String(n.props.systemName ?? "")} color={color} />
        </View>
      );
    }
    case "Button": {
      // A plain button with a label of its own draws that label.
      if (find(mods, "buttonStyle")?.style === "plain" && kids.length) {
        return wrap(
          <View style={[{ minWidth: 0 }, style]}>
            {kids.map((k, i) => (
              <Swift key={i} node={k} axis={axis} />
            ))}
          </View>,
        );
      }
      const prominent = find(mods, "buttonStyle")?.style === "borderedProminent";
      const tintMod = find(mods, "tint");
      const tint = colorOf(tintMod?.color ?? tintMod?.tint ?? tintMod?.style, look) ?? colorOf({ type: "hierarchical", style: "primary" }, look)!;
      const large = find(mods, "controlSize")?.size === "large";
      const label = typeof n.props.label === "string" ? n.props.label : "";
      const labelColor = colorOf(find(mods, "foregroundStyle")?.style, look);
      const ink = labelColor ?? (prominent ? (look.dark ? "#121213" : "#ffffff") : tint);
      const fill = prominent ? tint : look.dark ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.08)";
      return (
        <View style={[{ height: large ? 50 : 40, borderRadius: 999, backgroundColor: fill, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 16 }, style]}>
          {typeof n.props.systemImage === "string" ? <Symbol name={n.props.systemImage} size={16} color={ink} /> : null}
          <RNText numberOfLines={1} style={{ color: ink, fontSize: label.length > 16 ? 14 : 16, fontWeight: "600", fontFamily: "-apple-system, system-ui, sans-serif", flexShrink: 1 }}>{label}</RNText>
        </View>
      );
    }
    default:
      return wrap(kids.map((k, i) => <Swift key={i} node={k} axis={axis} />));
  }
}

/** A symbol filling its frame: measured, so it is drawn at the frame's size. */
function SymbolFill({ name, color }: { name: string; color: string }) {
  const [size, setSize] = useState(0);
  return (
    <View style={{ width: "100%", height: "100%", alignItems: "center", justifyContent: "center" }} onLayout={(e) => setSize(Math.min(e.nativeEvent.layout.width, e.nativeEvent.layout.height))}>
      {size ? <Symbol name={name} size={size} color={color} /> : null}
    </View>
  );
}

/** Draws a layout's tree (or one region of a Live Activity) in a look: dark or light, full colour or vibrant. */
export function SwiftRoot({ node, look }: { node: unknown; look: Look }) {
  return (
    <LookContext.Provider value={look}>
      <Inherit.Provider value={{}}>
        <Swift node={node} axis="v" />
      </Inherit.Provider>
    </LookContext.Provider>
  );
}

export { sizeOf };
