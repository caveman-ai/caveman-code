// What the iPhone draws outside the app: the Live Activity (the Lock Screen and the Dynamic Island) and the widget
// (the Home Screen and the Lock Screen), in Expo UI's SwiftUI views. Each is an `expo-widgets` `'widget'` function:
// the bundler turns it into a string that runs in the widget extension's own JavaScript runtime, so it may use only
// the SwiftUI views and modifiers (as globals there), its props and its environment, nothing else from this file.
// `src/system/activity.ts` registers them; the web build's `/?system` page runs the same strings
// (system/preview/), so what the previews show is what the phone shows.
//
// The words come from `src/system/glance.ts`, already chosen; these only lay them out. One thing said, at most two
// buttons, the Chief's own face, amber only for what needs you (docs/).
import type * as SwiftUI from "@expo/ui/swift-ui";
import type * as Mod from "@expo/ui/swift-ui/modifiers";
import type { LiveActivityEnvironment, LiveActivityLayout, WidgetEnvironment } from "expo-widgets";
import type { Glance as Props } from "../system/glance";

// Inside the widget extension the views and modifiers are globals (expo-widgets bundle/ui-globals.ts) and these
// functions are strings by the time the app runs, so nothing here is imported at run time: Expo UI's modules reach
// for native code as they load, which the web build (and the `/?system` previews) doesn't have.
declare const AccessoryWidgetBackground: typeof SwiftUI.AccessoryWidgetBackground;
declare const Button: typeof SwiftUI.Button;
declare const HStack: typeof SwiftUI.HStack;
declare const Image: typeof SwiftUI.Image;
declare const Link: typeof SwiftUI.Link;
declare const Spacer: typeof SwiftUI.Spacer;
declare const Text: typeof SwiftUI.Text;
declare const VStack: typeof SwiftUI.VStack;
declare const ZStack: typeof SwiftUI.ZStack;
declare const background: typeof Mod.background;
declare const buttonStyle: typeof Mod.buttonStyle;
declare const clipShape: typeof Mod.clipShape;
declare const containerBackground: typeof Mod.containerBackground;
declare const font: typeof Mod.font;
declare const foregroundStyle: typeof Mod.foregroundStyle;
declare const frame: typeof Mod.frame;
declare const lineLimit: typeof Mod.lineLimit;
declare const minimumScaleFactor: typeof Mod.minimumScaleFactor;
declare const monospacedDigit: typeof Mod.monospacedDigit;
declare const padding: typeof Mod.padding;
declare const resizable: typeof Mod.resizable;
declare const widgetURL: typeof Mod.widgetURL;

/** The Live Activity, in every place iOS shows one. */
export function Activity(p: Props, env: LiveActivityEnvironment): LiveActivityLayout {
  "widget";
  const light = env.colorScheme === "light";
  const primary = { type: "hierarchical", style: "primary" } as const;
  const secondary = { type: "hierarchical", style: "secondary" } as const;
  const amber = light ? "#995b13" : "#f09c2d";
  const green = light ? "#218349" : "#3fcf7b";
  const red = light ? "#ca2b30" : "#e36369";
  // The app's monochrome primary (theme.ts primary / onPrimary): the one strong button, ink with its label in the
  // ground's colour, set outright so a light tint never gets the system's white label.
  const ink = light ? "#1f1f21" : "#e3e4e6";
  const onInk = light ? "#ffffff" : "#121213";
  const quiet = { type: "hierarchical", style: "quaternary" } as const;
  // Past its stale date nobody vouches for "working" any more; a call keeps the app running, so it never goes stale.
  const stale = !!env.isStale && p.mood !== "talk" && p.mood !== "done";
  const dim = !!env.isLuminanceReduced;
  const accent = stale || dim ? secondary : p.mood === "needs" ? amber : p.mood === "ready" || p.mood === "talk" ? green : primary;
  const line = stale ? "Out of date. Open Caveman to catch up." : p.line;
  const link = p.link ? [widgetURL(p.link)] : [];
  const talking = p.mood === "talk";

  // Images honour only `resizable` themselves: a frame around them sizes them, and tints a symbol.
  const face = (size: number) =>
    p.face ? (
      <ZStack modifiers={[frame({ width: size, height: size })]}>
        <Image uiImage={p.face} modifiers={[resizable()]} />
      </ZStack>
    ) : (
      <ZStack modifiers={[frame({ width: size, height: size }), foregroundStyle(accent)]}>
        <Image systemName="flame.fill" modifiers={[resizable()]} />
      </ZStack>
    );
  const clock = (size: number) => <Text date={new Date(p.since)} dateStyle="timer" modifiers={[font({ size, weight: "semibold" }), monospacedDigit(), foregroundStyle(green)]} />;
  // What sits at the head's right: the call's clock, else where in the queue this ask is, else the tally.
  const meta = talking ? clock(15) : <Text modifiers={[font({ size: 13 }), foregroundStyle(secondary), lineLimit(1)]}>{p.detail}</Text>;

  // The glance's choices, side by side, each one capsule: the strong one ink, End red, the rest quiet. One that lets an
  // agent go ahead is a link into the app (a locked phone unlocks first); the others act in place. Stale, an ask may
  // be gone, so none show.
  const buttons = () => {
    const shown = stale ? [] : p.choices.slice(0, 2);
    if (!shown.length) return null;
    return (
      <HStack spacing={10}>
        {shown.map((c) => {
          const label = (
            <HStack spacing={6} modifiers={[padding({ horizontal: 14 }), frame({ maxWidth: 9999, minHeight: 46, maxHeight: 46 }), background(c.tone === "strong" ? ink : c.tone === "danger" ? red : quiet), clipShape("capsule")]}>
              {c.icon ? (
                <ZStack modifiers={[frame({ width: 16, height: 16 }), foregroundStyle(c.tone === "quiet" ? primary : c.tone === "danger" ? "#ffffff" : onInk)]}>
                  <Image systemName={c.icon as never} modifiers={[resizable()]} />
                </ZStack>
              ) : null}
              <Text modifiers={[font({ size: 16, weight: "semibold" }), foregroundStyle(c.tone === "quiet" ? primary : c.tone === "danger" ? "#ffffff" : onInk), lineLimit(1), minimumScaleFactor(0.8)]}>{c.label}</Text>
            </HStack>
          );
          return c.open ? (
            <Link key={c.open} destination={c.open} modifiers={[frame({ maxWidth: 9999 })]}>
              {label}
            </Link>
          ) : (
            <Button key={c.target} target={c.target} modifiers={[buttonStyle("plain"), frame({ maxWidth: 9999 })]}>
              {label}
            </Button>
          );
        })}
      </HStack>
    );
  };

  // The compact pill's right side: the call's clock, the amber count, a check, or how many are at work.
  const trailing = talking ? (
    clock(13)
  ) : p.mood === "ready" ? (
    <ZStack modifiers={[frame({ width: 14, height: 14 }), foregroundStyle(green)]}>
      <Image systemName="checkmark.circle.fill" modifiers={[resizable()]} />
    </ZStack>
  ) : p.mood === "done" ? null : (
    <Text modifiers={[font({ size: 14, weight: "semibold" }), monospacedDigit(), foregroundStyle(accent)]}>{`${p.count}`}</Text>
  );

  return {
    banner: (
      <VStack alignment="leading" spacing={8} modifiers={[padding({ all: 16 }), ...link]}>
        <HStack spacing={10} alignment="center">
          {face(28)}
          <Text modifiers={[font({ size: 15, weight: "semibold" }), foregroundStyle(primary), lineLimit(1)]}>{p.title}</Text>
          <Spacer minLength={8} />
          {meta}
        </HStack>
        <Text modifiers={[font({ size: 17 }), foregroundStyle(talking || p.mood === "needs" ? primary : secondary), lineLimit(2)]}>{line}</Text>
        {buttons()}
      </VStack>
    ),
    bannerSmall: (
      <VStack alignment="leading" spacing={4} modifiers={[padding({ all: 10 }), ...link]}>
        <HStack spacing={6} alignment="center">
          {face(18)}
          <Text modifiers={[font({ size: 13, weight: "semibold" }), foregroundStyle(accent), lineLimit(1)]}>{talking ? p.who : p.title}</Text>
          <Spacer minLength={4} />
        </HStack>
        <Text modifiers={[font({ size: 12 }), foregroundStyle(secondary), lineLimit(2)]}>{line}</Text>
      </VStack>
    ),
    // One tap target per presentation, from what it says now (the activity starts with none of its own: a URL given
    // at start would stay the one it started with).
    compactLeading: <HStack modifiers={[...link]}>{face(20)}</HStack>,
    compactTrailing: trailing,
    minimal: (
      <HStack modifiers={[...link]}>
        {p.mood === "needs" ? (
          <ZStack modifiers={[frame({ width: 14, height: 14 }), foregroundStyle(amber)]}>
            <Image systemName="exclamationmark.circle.fill" modifiers={[resizable()]} />
          </ZStack>
        ) : talking ? (
          <ZStack modifiers={[frame({ width: 14, height: 14 }), foregroundStyle(green)]}>
            <Image systemName="phone.fill" modifiers={[resizable()]} />
          </ZStack>
        ) : (
          face(18)
        )}
      </HStack>
    ),
    expandedLeading: (
      <HStack spacing={8} alignment="center" modifiers={[padding({ leading: 4, top: 4 })]}>
        {face(26)}
        <Text modifiers={[font({ size: 15, weight: "semibold" }), foregroundStyle(primary), lineLimit(1)]}>{talking ? p.who : p.title}</Text>
      </HStack>
    ),
    expandedTrailing: (
      <HStack modifiers={[padding({ trailing: 4, top: 4 })]}>{talking ? clock(15) : trailing}</HStack>
    ),
    expandedCenter: null,
    expandedBottom: (
      <VStack alignment="leading" spacing={10} modifiers={[padding({ horizontal: 8, bottom: 4 }), ...link]}>
        <Text modifiers={[font({ size: 16 }), foregroundStyle(primary), lineLimit(2)]}>{line}</Text>
        {buttons()}
      </VStack>
    ),
  };
}

/**
 * The widget: the Home Screen's small and medium, the Lock Screen's circle, rectangle and line. It shows how things
 * stand, never a call (activity.ts hands it the glance without one): one number for the most urgent state, its word,
 * and on the medium the three chats that matter most, each with its own line.
 */
export function GlanceWidget(p: Props, env: WidgetEnvironment) {
  "widget";
  const family = env.widgetFamily ?? "systemSmall";
  const light = env.colorScheme === "light";
  const primary = { type: "hierarchical", style: "primary" } as const;
  const secondary = { type: "hierarchical", style: "secondary" } as const;
  const amber = light ? "#995b13" : "#f09c2d";
  const green = light ? "#218349" : "#3fcf7b";
  // Tinted and Lock Screen widgets draw in one ink: the system picks it, so colour would only be lost.
  const mono = env.widgetRenderingMode === "accented" || env.widgetRenderingMode === "vibrant";
  const tone = (mood: string) => (mono ? primary : mood === "needs" ? amber : mood === "ready" ? green : primary);
  const quiet = (mood: string) => (mono ? secondary : mood === "needs" ? amber : mood === "ready" ? green : secondary);
  const ground = light ? "#ffffff" : "#121213";
  const done = p.mood === "done";
  const word = p.mood === "needs" ? (p.count === 1 ? "needs you" : "need you") : p.mood === "ready" ? "ready to try" : p.mood === "working" ? "working" : "All done";
  const link = p.link ? [widgetURL(p.link)] : [];

  const face = (size: number) =>
    p.face ? (
      <ZStack modifiers={[frame({ width: size, height: size })]}>
        <Image uiImage={p.face} modifiers={[resizable()]} />
      </ZStack>
    ) : (
      <ZStack modifiers={[frame({ width: size, height: size }), foregroundStyle(primary)]}>
        <Image systemName="flame.fill" modifiers={[resizable()]} />
      </ZStack>
    );
  const number = (size: number) =>
    done ? (
      <ZStack modifiers={[frame({ width: size * 0.8, height: size * 0.8 }), foregroundStyle(tone("ready"))]}>
        <Image systemName="checkmark.circle.fill" modifiers={[resizable()]} />
      </ZStack>
    ) : (
      <Text modifiers={[font({ size, weight: "semibold", design: "rounded" }), monospacedDigit(), foregroundStyle(tone(p.mood))]}>{`${p.count}`}</Text>
    );

  // iOS 17 draws a placeholder over any widget without a container background; the Lock Screen's are see-through,
  // and the circle sits on the system's own accessory backdrop.
  const clear = containerBackground("clear", "widget");
  if (family === "accessoryInline") {
    return <Text modifiers={[clear]}>{p.tally}</Text>;
  }
  if (family === "accessoryCircular") {
    return (
      <ZStack modifiers={[clear, ...link]}>
        <AccessoryWidgetBackground />
        <VStack spacing={0}>
          {number(24)}
          <Text modifiers={[font({ size: 10 }), lineLimit(1)]}>{done ? "done" : p.mood === "needs" ? "need you" : p.mood === "ready" ? "ready" : "working"}</Text>
        </VStack>
      </ZStack>
    );
  }
  if (family === "accessoryRectangular") {
    return (
      <VStack alignment="leading" spacing={1} modifiers={[clear, ...link]}>
        <Text modifiers={[font({ size: 15, weight: "semibold" }), lineLimit(1)]}>{done ? word : `${p.count} ${word}`}</Text>
        <Text modifiers={[font({ size: 13 }), foregroundStyle(secondary), lineLimit(2)]}>{p.line}</Text>
      </VStack>
    );
  }

  const summary = (withLine: boolean) => (
    <VStack alignment="leading" spacing={2}>
      {face(30)}
      <Spacer minLength={6} />
      {number(34)}
      <Text modifiers={[font({ size: 13, weight: "semibold" }), foregroundStyle(tone(p.mood)), lineLimit(1)]}>{word}</Text>
      {withLine ? <Text modifiers={[font({ size: 12 }), foregroundStyle(secondary), lineLimit(2)]}>{p.line}</Text> : null}
    </VStack>
  );

  if (family === "systemMedium") {
    const row = (r: Props["rows"][number]) => (
      <Link destination={r.link}>
        <HStack spacing={8} alignment="firstTextBaseline">
          <Text modifiers={[font({ size: 9 }), foregroundStyle(tone(r.mood))]}>●</Text>
          <VStack alignment="leading" spacing={1}>
            <Text modifiers={[font({ size: 14, weight: "semibold" }), foregroundStyle(primary), lineLimit(1)]}>{r.title}</Text>
            <Text modifiers={[font({ size: 12 }), foregroundStyle(r.mood === "working" ? secondary : quiet(r.mood)), lineLimit(1)]}>{r.line}</Text>
          </VStack>
          <Spacer minLength={0} />
        </HStack>
      </Link>
    );
    const r0 = p.rows[0];
    const r1 = p.rows[1];
    const r2 = p.rows[2];
    return (
      <HStack spacing={14} alignment="top" modifiers={[containerBackground(ground, "widget"), ...link]}>
        <VStack alignment="leading" modifiers={[frame({ width: 96 })]}>
          {summary(false)}
        </VStack>
        <VStack alignment="leading" spacing={10} modifiers={[frame({ maxWidth: 9999, alignment: "leading" })]}>
          {r0 ? row(r0) : <Text modifiers={[font({ size: 14 }), foregroundStyle(secondary)]}>Nothing running</Text>}
          {r1 ? row(r1) : null}
          {r2 ? row(r2) : null}
          <Spacer minLength={0} />
        </VStack>
      </HStack>
    );
  }

  return (
    <VStack alignment="leading" modifiers={[containerBackground(ground, "widget"), ...link]}>
      {summary(true)}
    </VStack>
  );
}
