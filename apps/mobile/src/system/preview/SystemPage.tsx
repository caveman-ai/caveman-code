// `/?system` on the web build: everything the iPhone shows of Caveman outside the app, at its real size, from the
// app's own state as it runs (docs/). The Lock Screen with the Live Activity in
// each mood, the Dynamic Island compact, minimal and expanded, the widgets on a Home Screen, the quick actions menu
// and the Lock Screen widgets. The Live Activity and the widgets are the very layouts the phone runs (swiftui.tsx);
// the iPhone's own chrome around them (the clock, the island, the wallpaper) is drawn here to place them.
import { LinearGradient } from "expo-linear-gradient";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Image, Platform, ScrollView, Text, View } from "react-native";
import { CHIEFS } from "../../board/model";
import { Icon, type IconName } from "../../components/Icon";
import { store, useStore } from "../../store/store";
import type { AppState } from "../../store/store";
import { Activity, GlanceWidget } from "../../widgets/layouts";
import { facePng } from "../faces";
import { type Glance, glanceOf } from "../glance";
import { itemsFor } from "../shortcuts";
import type { Talk } from "../talk";
import { evaluate, type Look, SwiftRoot } from "./swiftui";

type Regions = Record<string, unknown>;
const activity = evaluate<Glance, Record<string, unknown>, Regions>(Activity);
const widget = evaluate<Glance, Record<string, unknown>, unknown>(GlanceWidget);

const W = 402;
const SANS = "-apple-system, system-ui, 'SF Pro Display', sans-serif";
const DARK: Look = { dark: true };

/** Each Chief's face, as the phone writes it into the App Group, here as a data URL. */
function useFaces(): Record<string, string> {
  const [faces, setFaces] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    void Promise.all(
      CHIEFS.map(async (c) => {
        const png = await facePng(c.character, c.tone);
        let bin = "";
        for (const b of png) bin += String.fromCharCode(b);
        return [c.id, `data:image/png;base64,${btoa(bin)}`] as const;
      }),
    ).then((list) => live && setFaces(Object.fromEntries(list)));
    return () => {
      live = false;
    };
  }, []);
  return faces;
}

/** The moods the Live Activity takes, each from the app's state with what outranks it taken away. */
function useMoods(faces: Record<string, string>) {
  const state = useStore((s) => s);
  const [since] = useState(() => Date.now() - 133_000);
  return useMemo(() => {
    const only = (keep: (phase: string) => boolean): AppState => ({ ...state, board: { ...state.board, chats: state.board.chats.filter((c) => keep(c.phase)) } });
    const call: Talk = { kind: "call", who: CHIEFS[0]?.name ?? "Chief", chief: CHIEFS[0]?.id, since, muted: false, state: "Listening" };
    const withFace = (g: Glance): Glance => ({ ...g, face: faces[g.chief] ?? "" });
    return {
      talk: withFace(glanceOf(state, call)),
      needs: withFace(glanceOf(state, null)),
      ready: withFace(glanceOf(only((p) => p !== "needs"), null)),
      working: withFace(glanceOf(only((p) => p === "working"), null)),
      done: withFace(glanceOf(only(() => false), null)),
    };
  }, [state, faces, since]);
}

// ---------------------------------------------------------------- the iPhone around them

function Wallpaper({ height, children, light = false }: { height: number; children: ReactNode; light?: boolean }) {
  return (
    <View style={{ width: W, height, borderRadius: 44, overflow: "hidden", alignSelf: "center" }}>
      <LinearGradient colors={light ? ["#c9d6ee", "#e9d9cf", "#f3eee6"] : ["#0d1b2e", "#1c1830", "#2a1d22"]} locations={[0, 0.55, 1]} style={{ position: "absolute", inset: 0 }} />
      {children}
    </View>
  );
}

function StatusBar({ light = false }: { light?: boolean }) {
  const ink = light ? "#000" : "#fff";
  return (
    <View style={{ height: 54, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 34 }}>
      <Text style={{ color: ink, fontFamily: SANS, fontSize: 17, fontWeight: "600" }}>9:41</Text>
      <View style={{ width: 126, height: 37, borderRadius: 19, backgroundColor: "#000", position: "absolute", left: (W - 126) / 2, top: 11 }} />
      <View style={{ width: 27, height: 13, borderRadius: 4, borderWidth: 1, borderColor: light ? "rgba(0,0,0,0.4)" : "rgba(255,255,255,0.45)", padding: 1.5 }}>
        <View style={{ flex: 1, borderRadius: 2, backgroundColor: ink, width: "80%" }} />
      </View>
    </View>
  );
}

function LockClock() {
  return (
    <View style={{ alignItems: "center", marginTop: 6 }}>
      <Text style={{ color: "rgba(255,255,255,0.86)", fontFamily: SANS, fontSize: 19, fontWeight: "600" }}>Saturday 7 November</Text>
      <Text style={{ color: "rgba(255,255,255,0.92)", fontFamily: "ui-rounded, -apple-system, system-ui", fontSize: 96, lineHeight: 104, fontWeight: "700", letterSpacing: -2 }}>9:41</Text>
    </View>
  );
}

/** The Live Activity on the Lock Screen: its banner on the system's dark material. */
function Banner({ g }: { g: Glance }) {
  const regions = activity(g, { colorScheme: "dark", isStale: false });
  return (
    <View style={{ marginHorizontal: 12, borderRadius: 24, overflow: "hidden", backgroundColor: "rgba(28,28,30,0.78)", ...(Platform.OS === "web" ? ({ backdropFilter: "blur(30px) saturate(1.6)" } as object) : null) }}>
      <SwiftRoot node={regions.banner} look={DARK} />
    </View>
  );
}

/** The Dynamic Island: compact (leading and trailing around the camera), minimal, or expanded. */
function Island({ g, shape }: { g: Glance; shape: "compact" | "minimal" | "expanded" }) {
  const r = activity(g, { colorScheme: "dark" });
  if (shape === "minimal") {
    return (
      <View style={{ flexDirection: "row", gap: 8, justifyContent: "center" }}>
        <View style={{ width: 126, height: 37, borderRadius: 19, backgroundColor: "#000" }} />
        <View style={{ width: 37, height: 37, borderRadius: 19, backgroundColor: "#000", alignItems: "center", justifyContent: "center" }}>
          <SwiftRoot node={r.minimal} look={DARK} />
        </View>
      </View>
    );
  }
  if (shape === "compact") {
    return (
      <View style={{ alignSelf: "center", width: 252, height: 37, borderRadius: 19, backgroundColor: "#000", flexDirection: "row", alignItems: "center", paddingHorizontal: 9 }}>
        <SwiftRoot node={r.compactLeading} look={DARK} />
        <View style={{ flex: 1 }} />
        <View style={{ paddingRight: 4 }}>
          <SwiftRoot node={r.compactTrailing} look={DARK} />
        </View>
      </View>
    );
  }
  return (
    <View style={{ marginHorizontal: 11, borderRadius: 44, backgroundColor: "#000", paddingHorizontal: 18, paddingTop: 14, paddingBottom: 16, gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", minHeight: 37 }}>
        <SwiftRoot node={r.expandedLeading} look={DARK} />
        <SwiftRoot node={r.expandedTrailing} look={DARK} />
      </View>
      <SwiftRoot node={r.expandedBottom} look={DARK} />
    </View>
  );
}

/** A widget at its family's size, on its own background. */
function Widget({ g, family, light = false }: { g: Glance; family: "systemSmall" | "systemMedium" | "accessoryCircular" | "accessoryRectangular" | "accessoryInline"; light?: boolean }) {
  const look: Look = family.startsWith("accessory") ? { dark: true, vibrant: true } : { dark: !light };
  const node = widget(g, { widgetFamily: family, colorScheme: light ? "light" : "dark", widgetRenderingMode: family.startsWith("accessory") ? "vibrant" : "fullColor" });
  if (family === "accessoryInline") return <SwiftRoot node={node} look={look} />;
  if (family === "accessoryCircular") {
    return (
      <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: "rgba(255,255,255,0.16)", alignItems: "center", justifyContent: "center" }}>
        <SwiftRoot node={node} look={look} />
      </View>
    );
  }
  if (family === "accessoryRectangular") {
    return (
      <View style={{ width: 172, height: 72, justifyContent: "center" }}>
        <SwiftRoot node={node} look={look} />
      </View>
    );
  }
  const medium = family === "systemMedium";
  return (
    <View style={{ width: medium ? 364 : 170, height: 170, borderRadius: 22, overflow: "hidden", backgroundColor: light ? "#ffffff" : "#121213", padding: 16, shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 18 }}>
      <SwiftRoot node={node} look={look} />
    </View>
  );
}

const APP_ICON = (() => {
  try {
    return require("../../../../desktop/resources/icon.png");
  } catch {
    return null;
  }
})();

function AppIcon({ size = 64, label = true }: { size?: number; label?: boolean }) {
  return (
    <View style={{ alignItems: "center", gap: 5, width: 76 }}>
      {APP_ICON ? <Image source={APP_ICON} style={{ width: size, height: size, borderRadius: size * 0.225 }} /> : <View style={{ width: size, height: size, borderRadius: size * 0.225, backgroundColor: "#1c1c1e" }} />}
      {label ? <Text style={{ color: "#fff", fontFamily: SANS, fontSize: 12 }}>Caveman Code</Text> : null}
    </View>
  );
}

/** A plain stand-in for another app on the Home Screen. */
function Other({ tint }: { tint: string }) {
  return (
    <View style={{ alignItems: "center", gap: 5, width: 76 }}>
      <View style={{ width: 64, height: 64, borderRadius: 14.4, backgroundColor: tint, opacity: 0.85 }} />
      <View style={{ width: 40, height: 8, borderRadius: 4, backgroundColor: "rgba(255,255,255,0.35)", marginTop: 4 }} />
    </View>
  );
}

const SYMBOL_ICON: Record<string, IconName> = { "square.and.pencil": "compose", "phone.fill": "call", waveform: "voice", "bubble.left": "comment" };

/** Holding the app icon: iOS's menu of the app's quick actions over a blurred Home Screen. */
function QuickMenu() {
  const focused = useStore((s) => s.board.chats.find((c) => !c.parent));
  const items = itemsFor(focused ? { id: focused.id, title: focused.title } : null);
  return (
    <View style={{ width: 254, borderRadius: 14, overflow: "hidden", backgroundColor: "rgba(40,40,44,0.86)", ...(Platform.OS === "web" ? ({ backdropFilter: "blur(40px)" } as object) : null) }}>
      {items.map((a, i) => (
        <View key={a.id} style={{ flexDirection: "row", alignItems: "center", minHeight: 50, paddingHorizontal: 16, borderTopWidth: i ? 0.5 : 0, borderTopColor: "rgba(255,255,255,0.14)" }}>
          <View style={{ flex: 1, paddingVertical: 8 }}>
            <Text numberOfLines={1} style={{ color: "#fff", fontFamily: SANS, fontSize: 17 }}>
              {a.title}
            </Text>
            {a.subtitle ? <Text style={{ color: "rgba(255,255,255,0.55)", fontFamily: SANS, fontSize: 13 }}>{a.subtitle}</Text> : null}
          </View>
          <Icon name={SYMBOL_ICON[String(a.icon).replace("symbol:", "")] ?? "compose"} size={20} color="#fff" />
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------- the page

function Scene({ title, line, children }: { title: string; line: string; children: ReactNode }) {
  return (
    <View style={{ gap: 12, paddingVertical: 22 }}>
      <View style={{ paddingHorizontal: 20, gap: 3 }}>
        <Text style={{ color: "#e3e4e6", fontFamily: SANS, fontSize: 17, fontWeight: "600" }}>{title}</Text>
        <Text style={{ color: "#959597", fontFamily: SANS, fontSize: 14, lineHeight: 19 }}>{line}</Text>
      </View>
      {children}
    </View>
  );
}

export function SystemPage() {
  const faces = useFaces();
  const m = useMoods(faces);
  // The scripted world keeps working while this page is up, as the app would.
  useEffect(() => store.subscribe(() => undefined), []);
  return (
    <ScrollView testID="system-page" style={{ flex: 1, backgroundColor: "#0b0b0c" }} contentContainerStyle={{ paddingBottom: 60 }}>
      <View style={{ paddingHorizontal: 20, paddingTop: 28, gap: 4 }}>
        <Text style={{ color: "#e3e4e6", fontFamily: SANS, fontSize: 28, fontWeight: "700" }}>Caveman on the iPhone</Text>
        <Text style={{ color: "#959597", fontFamily: SANS, fontSize: 15, lineHeight: 21 }}>The Live Activity, the Dynamic Island, the widgets and the quick actions, drawn from the layouts the phone runs and the board as it is right now.</Text>
      </View>

      <Scene title="Lock Screen · needs you" line="The oldest ask, in words, and two buttons. Deny answers in place; Allow, or a question's options, open the app, so a locked phone asks for Face ID first.">
        <Wallpaper height={440}>
          <StatusBar />
          <LockClock />
          <View style={{ marginTop: 18 }}>
            <Banner g={m.needs} />
          </View>
        </Wallpaper>
      </Scene>

      <Scene title="Lock Screen · on a call" line="A call keeps going with the phone locked: the clock, Mute and End.">
        <Wallpaper height={420}>
          <StatusBar />
          <LockClock />
          <View style={{ marginTop: 18 }}>
            <Banner g={m.talk} />
          </View>
        </Wallpaper>
      </Scene>

      <Scene title="Lock Screen · working, ready, done" line="What's at work and its live line; then what's ready to try; then all done.">
        <View style={{ gap: 10 }}>
          <Banner g={m.working} />
          <Banner g={m.ready} />
          <Banner g={m.done} />
        </View>
      </Scene>

      <Scene title="Dynamic Island" line="Compact: the Chief's face and one number (amber when it needs you), or the call's clock. Minimal beside another app's. Expanded when held.">
        <View style={{ gap: 14 }}>
          <Island g={m.needs} shape="compact" />
          <Island g={m.working} shape="compact" />
          <Island g={m.talk} shape="compact" />
          <Island g={m.needs} shape="minimal" />
          <Island g={m.needs} shape="expanded" />
          <Island g={m.talk} shape="expanded" />
        </View>
      </Scene>

      <Scene title="Home Screen" line="Small and medium widgets: the number that matters, the line, and up to three chats.">
        <Wallpaper height={560}>
          <StatusBar />
          <View style={{ paddingHorizontal: 19, gap: 22, marginTop: 10 }}>
            <View style={{ flexDirection: "row", gap: 24 }}>
              <Widget g={m.needs} family="systemSmall" />
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 18, width: 170 }}>
                <AppIcon />
                <Other tint="#3b82f6" />
                <Other tint="#22c55e" />
                <Other tint="#f97316" />
              </View>
            </View>
            <Widget g={m.needs} family="systemMedium" />
          </View>
        </Wallpaper>
      </Scene>

      <Scene title="Light Home Screen" line="The widgets follow the system's appearance.">
        <Wallpaper height={240} light>
          <View style={{ paddingHorizontal: 19, flexDirection: "row", gap: 24, marginTop: 34 }}>
            <Widget g={m.working} family="systemSmall" light />
            <Widget g={m.ready} family="systemSmall" light />
          </View>
        </Wallpaper>
      </Scene>

      <Scene title="Quick actions" line="Hold the app icon: New chat, Call the Chief, Voice chat, and the last chat.">
        <Wallpaper height={420}>
          <View style={{ position: "absolute", inset: 0, backgroundColor: "rgba(0,0,0,0.35)" }} />
          <View style={{ marginTop: 70, marginLeft: 24, gap: 14 }}>
            <QuickMenu />
            <AppIcon size={64} label={false} />
          </View>
        </Wallpaper>
      </Scene>

      <Scene title="Lock Screen widgets" line="In the system's one ink: the count in a ring, the counts and the line, the counts above the clock.">
        <Wallpaper height={330}>
          <StatusBar />
          <View style={{ alignItems: "center", marginTop: 4 }}>
            <Widget g={m.needs} family="accessoryInline" />
          </View>
          <LockClock />
          <View style={{ flexDirection: "row", justifyContent: "center", gap: 14, marginTop: 8 }}>
            <Widget g={m.needs} family="accessoryCircular" />
            <Widget g={m.needs} family="accessoryRectangular" />
          </View>
        </Wallpaper>
      </Scene>
    </ScrollView>
  );
}
