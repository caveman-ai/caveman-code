// The prototype's drawn screens, in place of the runtime's frames: each drawn at its frame's size with its controls
// where live/pages.ts says they are, in the state the scripted source hands it. They only draw; clicks land in the
// source, as `*.input` does on a runtime.
import { LinearGradient } from "expo-linear-gradient";
import type { ReactElement } from "react";
import { Text, View } from "react-native";
import type { DrawnScreen } from "../board/model";
import { DARK, LIGHT, RUNS } from "../components/RunsPreview";
import Svg, { Path } from "react-native-svg";
import { mono, sans } from "../theme";
import { HERO, type PageState, type Rect, RUN_ROW, SIM, START, STEP, THEME, WINDOW } from "./pages";

const at = (r: Rect) => ({ position: "absolute" as const, left: r.x, top: r.y, width: r.w, height: r.h });

/** The theme switch's mark: a ring, half filled. */
function ThemeMark({ ink }: { ink: string }) {
  return (
    <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: ink, overflow: "hidden" }}>
      <View style={{ width: 9, height: 18, backgroundColor: ink }} />
    </View>
  );
}

/** The Runs page the dark-mode chat is building, on its dev server: the same rows and palettes as its moment's preview. */
function RunsPage({ page }: { page: PageState }) {
  const k = page.dark ? DARK : LIGHT;
  return (
    <View style={{ width: 800, height: 500, backgroundColor: k.page }}>
      <View style={{ position: "absolute", left: 32, right: 32, top: 0, height: 64, flexDirection: "row", alignItems: "center", gap: 28, borderBottomWidth: 1, borderColor: k.line }}>
        <Text style={{ fontSize: 20, fontWeight: "700", color: k.text }}>Caveman Code</Text>
        {["Runs", "Agents", "Settings"].map((name, i) => (
          <Text key={name} style={{ fontSize: 18, fontWeight: i === 0 ? "600" : "400", color: i === 0 ? k.text : k.muted }}>
            {name}
          </Text>
        ))}
      </View>
      <View style={[at(THEME), { borderRadius: 10, borderWidth: 1, borderColor: k.line, alignItems: "center", justifyContent: "center" }]}>
        <ThemeMark ink={k.text} />
      </View>
      <Text style={{ position: "absolute", left: 32, top: 86, fontSize: 34, fontWeight: "700", letterSpacing: -0.5, color: k.text }}>Runs</Text>
      <Text style={{ position: "absolute", right: 32, top: 100, fontSize: 18, color: k.muted }}>4 today</Text>
      {RUNS.map((run, i) => (
        <View
          key={run.name}
          style={[at(RUN_ROW(i)), { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 20, borderRadius: 10, borderWidth: 2, borderColor: page.row === i ? k.muted : "transparent", backgroundColor: k.row }]}
        >
          <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: k[run.dot] }} />
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 22, fontWeight: "600", color: k.text }}>
            {run.name}
          </Text>
          <Text style={{ fontSize: 18, color: k.muted }}>{run.state}</Text>
          <Text style={{ minWidth: 84, textAlign: "right", fontSize: 18, fontFamily: mono, color: k.muted }}>{run.time}</Text>
        </View>
      ))}
    </View>
  );
}

const SITE = { page: "#fbfaf7", ink: "#1b1a17", muted: "#6b675f", line: "#e6e1d8", card: "#ffffff" };
const STEPS = ["Connect a computer", "Pick an engine", "Start a chat"];
/** The heroes the onboarding pass tries: the one it found, then the two shorter ones it goes between. */
const HEROES = ["Welcome to the agentic development environment built for modern teams", "Your agents, on every computer you have", "Start a chat. Come back to a change."];

/** The marketing site's onboarding page, whose copy the onboarding chat is rewriting. */
function OnboardingPage({ page }: { page: PageState }) {
  return (
    <View style={{ width: 800, height: 500, backgroundColor: SITE.page }}>
      <View style={{ position: "absolute", left: 40, right: 40, top: 0, height: 64, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ fontSize: 22, fontWeight: "800", letterSpacing: -0.5, color: SITE.ink }}>caveman</Text>
        <Text style={{ fontSize: 18, color: SITE.muted }}>Sign in</Text>
      </View>
      <View style={[at(HERO), { justifyContent: "center" }]}>
        <Text numberOfLines={2} style={{ fontSize: 42, lineHeight: 50, fontWeight: "700", letterSpacing: -1, color: SITE.ink }}>
          {HEROES[page.hero]}
        </Text>
      </View>
      <Text style={{ position: "absolute", left: 40, top: 212, fontSize: 20, color: SITE.muted }}>Connect a computer, pick an engine, start a chat.</Text>
      <View style={[at(START), { borderRadius: 26, backgroundColor: SITE.ink, alignItems: "center", justifyContent: "center" }]}>
        <Text style={{ fontSize: 19, fontWeight: "600", color: SITE.page }}>Get started</Text>
      </View>
      {STEPS.map((step, i) => (
        <View key={step} style={[at(STEP(i)), { padding: 18, gap: 8, borderRadius: 14, borderWidth: 2, borderColor: page.step === i ? SITE.ink : SITE.line, backgroundColor: SITE.card }]}>
          <Text style={{ fontSize: 16, fontFamily: mono, color: SITE.muted }}>0{i + 1}</Text>
          <Text style={{ fontSize: 20, fontWeight: "600", color: SITE.ink }}>{step}</Text>
        </View>
      ))}
    </View>
  );
}

/** A Cloud computer's Linux desktop, the onboarding page open in its browser. */
function Desktop({ page }: { page: PageState }) {
  const ink = "#e8eaed";
  return (
    <View style={{ width: 960, height: 600 }}>
      <LinearGradient colors={["#2b3a55", "#141a26"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }} />
      <View style={{ height: 28, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: "rgba(0,0,0,0.6)" }}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: ink }}>Activities</Text>
        <Text style={{ fontSize: 14, fontWeight: "600", color: ink }}>Thu 10:42</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: ink, opacity: 0.8 }} />
          ))}
        </View>
      </View>
      <View style={{ position: "absolute", left: WINDOW.x, top: WINDOW.y, width: 800, borderRadius: 10, overflow: "hidden", backgroundColor: "#202124" }}>
        <View style={{ height: WINDOW.bar, flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 14 }}>
          <Text style={{ fontSize: 20, color: "#9aa0a6" }}>‹  ›</Text>
          <View style={{ flex: 1, height: 30, borderRadius: 15, paddingHorizontal: 14, justifyContent: "center", backgroundColor: "#35363a" }}>
            <Text style={{ fontSize: 15, color: ink }}>localhost:4321/onboarding</Text>
          </View>
          <Text style={{ fontSize: 18, color: "#9aa0a6" }}>✕</Text>
        </View>
        <OnboardingPage page={page} />
      </View>
    </View>
  );
}

/** This Mac's Simulator window, as agent-desktop frames it (the app's window alone), the Chief's push on its lock screen. */
function Simulator() {
  const { screen } = SIM;
  return (
    <View style={{ width: SIM.width, height: SIM.height, borderRadius: 12, overflow: "hidden", backgroundColor: "#1f1f21" }}>
      <View style={{ height: SIM.bar, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, gap: 7, backgroundColor: "#2b2b2e" }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((fill) => (
          <View key={fill} style={{ width: 11, height: 11, borderRadius: 6, backgroundColor: fill }} />
        ))}
        <Text style={{ flex: 1, textAlign: "center", marginRight: 54, fontSize: 13, fontWeight: "600", color: "#d7d7da" }}>iPhone 17 Pro</Text>
      </View>
      <View style={{ position: "absolute", left: screen.x, top: screen.y, width: screen.w, height: screen.h, borderRadius: 44, overflow: "hidden" }}>
        <PushLock />
      </View>
    </View>
  );
}

export const DRAWINGS: Record<DrawnScreen, (props: { page: PageState }) => ReactElement> = { runs: RunsPage, onboarding: OnboardingPage, desktop: Desktop, simulator: Simulator };

const FLAME = ["00011000", "00111100", "00111100", "01100110", "01100110", "11000011", "01100110", "00111100"];

/** The app icon as a notification shows it: the pixel flame in white on black. */
function AppIcon({ size }: { size: number }) {
  const cell = (size * 0.5) / 8;
  const d = FLAME.flatMap((row, y) => [...row].map((on, x) => (on === "1" ? `M${x * cell} ${y * cell}h${cell * 0.86}v${cell * 0.86}h-${cell * 0.86}z` : ""))).join("");
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.23, backgroundColor: "#0f0f10", alignItems: "center", justifyContent: "center" }}>
      <Svg width={cell * 8} height={cell * 8}>
        <Path d={d} fill="#f2f2f2" />
      </Svg>
    </View>
  );
}

/** A lock screen with the Chief's push on it: the ask, and Allow and Deny right there. */
export function PushLock() {
  return (
    <View style={{ flex: 1, backgroundColor: "#16181d", alignItems: "center", paddingTop: 14 }}>
      <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 120, backgroundColor: "#22252c", opacity: 0.6 }} />
      <Text style={{ fontFamily: sans, fontSize: 11, color: "#c8cad0", fontWeight: "500" }}>Saturday 7 November</Text>
      <Text style={{ fontFamily: sans, fontSize: 52, lineHeight: 58, color: "#eceef2", fontWeight: "600", letterSpacing: -1.5 }}>9:41</Text>
      <View style={{ marginTop: 10, width: 316, borderRadius: 18, backgroundColor: "rgba(72,76,86,0.72)", padding: 11, gap: 8 }}>
        <View style={{ flexDirection: "row", gap: 9 }}>
          <AppIcon size={30} />
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row" }}>
              <Text style={{ flex: 1, fontFamily: sans, fontSize: 12, fontWeight: "600", color: "#f2f3f5" }}>Grug needs you</Text>
              <Text style={{ fontFamily: sans, fontSize: 11, color: "#b9bcc4" }}>now</Text>
            </View>
            <Text numberOfLines={2} style={{ fontFamily: sans, fontSize: 12, lineHeight: 16, color: "#e2e4e8" }}>
              Usage table migration: run a staging migration? Touches three tables.
            </Text>
          </View>
        </View>
        <View style={{ flexDirection: "row", gap: 6 }}>
          {["Deny", "Allow"].map((label) => (
            <View key={label} style={{ flex: 1, height: 28, borderRadius: 14, backgroundColor: label === "Allow" ? "rgba(255,255,255,0.86)" : "rgba(255,255,255,0.14)", alignItems: "center", justifyContent: "center" }}>
              <Text style={{ fontFamily: sans, fontSize: 12, fontWeight: "600", color: label === "Allow" ? "#16181d" : "#eceef2" }}>{label}</Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}
