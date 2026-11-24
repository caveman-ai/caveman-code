// What a new chat says before you type ("the new chat page is just so empty it needs the chief and
// some personalized messages to the user like what should we build or up late, (name)"). Your Chief, the one you
// opened last, standing in the middle of the page and breathing; a greeting by the hour that changes from day to day
// so it never reads as boilerplate; and one line on what is going on, which opens the sidebar's queue when something
// waits on you. Tapping the Chief opens it.
//
// The greeting carries a name only on the scripted board, where the script's own person stands in (shell/me.ts). On
// your own board the phone knows your email and no name, so it greets without one ("Night shift?"): the script's name
// never greets somebody else.
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { Sprite } from "../components/Sprite";
import { haptic } from "../motion";
import { showChief } from "../nav/ref";
import { openSidebar, setSidebarMode } from "../shell/drawer";
import { useMe } from "../shell/me";
import { useOpened } from "../sidebar/recent";
import { askQueue, chiefListOf } from "../store/select";
import { useStore } from "../store/store";
import { useTheme } from "../theme";

/** Words with a name after them, or the words alone when there is nobody to name: "Night shift, Ada?", "Night shift?". */
const to = (words: string, name: string, end = "") => `${words}${name ? `, ${name}` : ""}${end}`;

/** Greetings by the part of the day; the day of the year picks one, so it changes daily and holds still within a day. */
const GREETINGS: readonly { until: number; say: readonly ((name: string) => string)[] }[] = [
  { until: 5, say: [(n) => to("Up late", n, "?"), (n) => to("Still going", n, "?"), (n) => to("Night shift", n, "?")] },
  { until: 12, say: [(n) => to("Morning", n), () => "What should we build today?", (n) => to("Fresh start", n)] },
  { until: 18, say: [(n) => to("Afternoon", n), (n) => to("What should we build", n, "?"), (n) => to("What's next", n, "?")] },
  { until: 24, say: [(n) => to("Evening", n), (n) => to("One more thing", n, "?"), () => "What should we build tonight?"] },
];

/** The greeting for a moment of the day; `name` empty greets nobody by name. */
export function greetingFor(now: Date, name: string): string {
  const part = GREETINGS.find((g) => now.getHours() < g.until) ?? GREETINGS[GREETINGS.length - 1]!;
  const day = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86_400_000);
  return part.say[day % part.say.length]!(name);
}

/** The queue, from the line under the greeting: the sidebar out, sorted by state. */
function openQueue() {
  haptic.tick();
  setSidebarMode("queue");
  openSidebar();
}

export function Welcome() {
  const { c, t } = useTheme();
  const chiefs = useStore(chiefListOf);
  const waiting = useStore((s) => askQueue(s).length);
  const lastOpened = useOpened();
  const me = useMe();
  // A first name only from the scripted person: an account's `name` is its email, which is not something to greet by.
  const first = me.scripted ? (me.name.trim().split(/\s+/)[0] ?? "") : "";
  // Worked out once a visit: the greeting mustn't change under you while the page is up.
  const greeting = useMemo(() => greetingFor(new Date(), first), [first]);
  const chief = useMemo(() => [...chiefs].sort((a, b) => (lastOpened[b.chief.id] ?? 0) - (lastOpened[a.chief.id] ?? 0))[0], [chiefs, lastOpened]);
  const ready = chiefs.reduce((n, r) => n + r.ready, 0);
  const working = chiefs.reduce((n, r) => n + r.working, 0);
  const line =
    waiting > 0
      ? `${waiting} ${waiting === 1 ? "thing needs" : "things need"} you`
      : ready > 0
        ? `${ready} ready to look at`
        : working > 0
          ? `${working} ${working === 1 ? "agent" : "agents"} at work`
          : null;

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, paddingBottom: 96 }}>
      {chief ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${chief.chief.name}`}
          onPress={() => {
            haptic.tick();
            showChief(chief.chief.id);
          }}
          hitSlop={8}
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, transform: [{ scale: pressed ? 0.96 : 1 }] })}
        >
          <Sprite character={chief.chief.character} tone={chief.chief.tone} size={96} />
        </Pressable>
      ) : null}
      <Text accessibilityRole="header" style={[t.largeTitle, { marginTop: 18, textAlign: "center" }]}>
        {greeting}
      </Text>
      {line ? (
        <Pressable accessibilityRole="button" accessibilityHint={waiting > 0 ? "Opens the queue" : undefined} onPress={openQueue} hitSlop={10} style={({ pressed }) => ({ marginTop: 8, flexDirection: "row", alignItems: "center", gap: 6, opacity: pressed ? 0.6 : 1 })}>
          {waiting > 0 ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: c.warning }} /> : null}
          <Text style={[t.row, { fontSize: 15, lineHeight: 20, color: waiting > 0 ? c.text : c.muted }]}>{line}</Text>
          <Text style={[t.row, { fontSize: 15, lineHeight: 20, color: c.subtle }]}>›</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
