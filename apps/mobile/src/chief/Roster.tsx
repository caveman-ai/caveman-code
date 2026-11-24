// The chats a Chief started for one note of yours, as its turn lists them (DECISIONS.md, "A Chief's chat", refined
// 2026-11-06; thread-C s4): the same roster a thread draws for its subagents (components/transcript/Parts.tsx Roster),
// so one idea has one look. "Started 3 chats ⌄", then one 44pt row each: its engine's mark, its title in ink, the
// device only where it isn't where that workspace's chats usually run (or is away), and where it stands as a glyph and a
// word. It stays in view, outside the turn's fold, until every one of them is done; the whole row pushes that chat
// over the Chief, and a hold peeks. An Update's roll call ("One needs you, three are running.") is the same rows
// without the head: its sentence counts them, the rows say which.
import { Platform, Pressable, Text } from "react-native";
import type { Chat } from "../board/model";
import { Roster as Rows } from "../components/transcript/Parts";
import { EngineLogo } from "../components/ui/EngineLogo";
import { haptic } from "../motion";
import { phaseOf } from "../store/select";
import { useTheme } from "../theme";

/** How far a named chat drops to sit on the words' line: iOS stands an inline view on the baseline (WorkLink's). */
const DROP = Platform.OS === "web" ? 0 : 5;

/**
 * A chat named again on a screen that already shows it as a pill: its engine mark and its title in ink at 500, a tap
 * away like the pill (a long press peeks), never bare blue, so a screen holds each chat's pill once.
 */
export function Mention({ chat, onOpen, onPeek, inline = false, size = 16 }: { chat: Chat; onOpen: (id: string) => void; onPeek: (id: string) => void; inline?: boolean; size?: number }) {
  const { c } = useTheme();
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={chat.title}
      accessibilityActions={[{ name: "longpress", label: "Peek" }]}
      onAccessibilityAction={(e) => e.nativeEvent.actionName === "longpress" && onPeek(chat.id)}
      onPress={() => {
        haptic.tick();
        onOpen(chat.id);
      }}
      onLongPress={() => {
        haptic.soft();
        onPeek(chat.id);
      }}
      delayLongPress={350}
      hitSlop={2}
      style={({ pressed }) => [
        { flexDirection: "row", alignItems: "center", gap: 4, height: 22, maxWidth: inline ? 300 : "100%", opacity: pressed ? 0.6 : 1 },
        inline ? { transform: [{ translateY: DROP }] } : { alignSelf: "flex-start" },
      ]}
    >
      <EngineLogo engine={chat.engine} size={14} />
      <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: size, lineHeight: 22, fontWeight: "500", color: c.text }}>
        {chat.title}
      </Text>
    </Pressable>
  );
}

/** Where each workspace's chats mostly run (a subagent counts with its parent): a row on that device doesn't say so. */
const usualCache = new WeakMap<readonly Chat[], Map<string, string>>();
function usualOf(board: readonly Chat[], repo: string): string | undefined {
  let usual = usualCache.get(board);
  if (!usual) {
    const counts = new Map<string, Map<string, number>>();
    for (const chat of board) {
      if (chat.parent) continue;
      const per = counts.get(chat.repo) ?? new Map<string, number>();
      per.set(chat.device, (per.get(chat.device) ?? 0) + 1);
      counts.set(chat.repo, per);
    }
    usual = new Map();
    for (const [where, per] of counts) {
      let best = "";
      for (const [device, n] of per) if (!best || n > (per.get(best) ?? 0)) best = device;
      usual.set(where, best);
    }
    usualCache.set(board, usual);
  }
  return usual.get(repo);
}

interface Props {
  chats: readonly Chat[];
  /** The whole board, to read each chat's status with its subagents' (phaseOf), and where its workspace runs. */
  board: readonly Chat[];
  open: boolean;
  /** Folds the rows away; without it (inside a turn's fold) the rows just show. */
  onToggle?: () => void;
  /** Leave out "Started N chats": a sentence above already counts them (an Update's roll call). */
  bare?: boolean;
  onOpen: (id: string) => void;
  onPeek: (id: string) => void;
}

export function Roster({ chats, board, open, onToggle, onOpen, onPeek, bare = false }: Props) {
  return (
    <Rows
      children={chats}
      noun="chat"
      bare={bare}
      open={open}
      onToggle={onToggle}
      onOpen={onOpen}
      onPeek={onPeek}
      phaseOf={(chat) => phaseOf(chat, board)}
      usualOf={(chat) => usualOf(board, chat.repo)}
    />
  );
}
