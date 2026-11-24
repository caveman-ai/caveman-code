// Where a piece of a Chief's work stands, as one mark everywhere its screen names it (the strip, the Chief's sentences,
// the peek, the cards, the board), drawn as the desktop's WorkMark (apps/web/src/routes/chief/work.tsx): waiting on you
// an amber dot, under way the turning ring, for review a half-filled ring, done a green tick. And each piece's number
// on its Chief's board, CH-12, which the desktop's Work list shows beside its title and never reuses.
import { View } from "react-native";
import { type Chat, chiefById, chiefOf, HOME_CHIEF, type Phase } from "../board/model";
import { PixelIcon } from "../components/Pixel";
import { useTheme } from "../theme";

/** The desktop's work groups, from a chat's phase: a ready change waits for review. */
export type WorkGroup = "needs" | "working" | "review" | "done";
export const GROUP: Record<Phase, WorkGroup> = { needs: "needs", working: "working", ready: "review", done: "done" };

/** What each mark says, as the desktop's Work list heads its groups. */
export const GROUP_LABEL: Record<WorkGroup, string> = { needs: "Needs you", working: "In progress", review: "For review", done: "Done" };

export function WorkMark({ phase, size = 16 }: { phase: Phase; size?: number }) {
  const { c } = useTheme();
  const group = GROUP[phase];
  const label = GROUP_LABEL[group];
  if (group === "needs") return <PixelIcon name="state-needs-you" size={size} label={label} />;
  if (group === "working") return <PixelIcon name="state-working" size={size} label={label} />;
  if (group === "done") return <PixelIcon name="state-done" size={size} ink={c.success} label={label} />;
  // For review: a ring in ink, its left half filled (the desktop's 12px ring at 1.5px).
  const ring = Math.round(size * 0.75);
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <View style={{ width: ring, height: ring, borderRadius: ring / 2, borderWidth: 1.5, borderColor: c.text, overflow: "hidden" }}>
        <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: (ring - 3) / 2, backgroundColor: c.text }} />
      </View>
    </View>
  );
}

/**
 * The prefix of a Chief's numbers (the desktop's workKey): CH for the home Chief, else the first three letters of its
 * name (Oona's OON-4).
 */
export function workKey(chiefId: string): string {
  if (chiefId === HOME_CHIEF) return "CH";
  const chief = chiefById(chiefId);
  return chief.name.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "CH";
}

/**
 * Each piece of work's number, given the first time the screen sees it and never changed or reused: the runtime keeps
 * these on the board; the prototype's board has none, so it numbers what it finds, oldest first, from where a board
 * that has been in use a while would be.
 */
const numbers = new Map<string, number>();
const counters = new Map<string, number>();
const FIRST: Record<string, number> = { home: 9, oona: 2 };

export function workId(chat: Chat, all: readonly Chat[]): string {
  if (!numbers.has(chat.id)) {
    const fresh = [...all, chat].filter((ch) => !numbers.has(ch.id)).sort((a, b) => a.startedAt - b.startedAt);
    for (const ch of fresh) {
      if (numbers.has(ch.id)) continue;
      // Your own chats are numbered on the home Chief's run, as the desktop's sidebar numbers them.
      const chief = chiefOf(ch) ?? HOME_CHIEF;
      const n = counters.get(chief) ?? FIRST[chief] ?? 1;
      numbers.set(ch.id, n);
      counters.set(chief, n + 1);
    }
  }
  return `${workKey(chiefOf(chat) ?? HOME_CHIEF)}-${numbers.get(chat.id)}`;
}
