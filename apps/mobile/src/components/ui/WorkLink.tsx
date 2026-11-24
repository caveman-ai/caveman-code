// A chat named in words, drawn as the desktop's thread reference (STYLE.md 3, "The one blue"; DECISIONS.md, "Thread
// references in prose"): the link ink inside a tint-and-ring pill of the one blue, led by the chat's engine mark, kept
// on one line. The thread's prose and rosters and the Chief's chat all draw it here, so it is the same pill
// everywhere. It points somewhere: a tap pushes that chat, so Back comes straight back, and where it's offered, a long
// press peeks at it without leaving. Where a chat stands is said beside it in a glyph and a word (StateWord), never by
// the pill's colour: blue is "there", never a state.
import { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import type { Phase } from "../../board/model";
import { haptic } from "../../motion";
import { alpha, useTheme } from "../../theme";
import { PixelIcon } from "../Pixel";
import { STATE_WORD } from "./Badge";
import { EngineLogo } from "./EngineLogo";

export { STATE_WORD };

interface Props {
  /** The chat it names: only its id, title and engine are drawn. */
  chat: { id: string; title: string; engine: string };
  /** Its status as every row shows it (its subagents' included). */
  onOpen: (id: string) => void;
  onPeek?: (id: string) => void;
  /** Sitting in a sentence: it lines up with the words around it. */
  inline?: boolean;
  /** Its title at another size (a roster row's 15). */
  size?: number;
}

/**
 * The pill's height in a 16/26 line, and how far it drops to sit on the words' line: iOS stands an inline view on the
 * baseline, so it comes down by the descender; the web lines it up by itself.
 */
const PILL = 22;
const DROP = Platform.OS === "web" ? 0 : 5;
/**
 * Inline, its touch reaches half the gap to the line above and below (a 26pt line holds the 22pt pill with 4 to spare)
 * and a little to the sides, so pills on neighbouring lines never share a touch.
 */
const INLINE_SLOP = { top: 2, bottom: 2, left: 4, right: 4 };

export function WorkLink({ chat, onOpen, onPeek, inline = false, size = 16 }: Props) {
  const { c } = useTheme();
  const [held, setHeld] = useState(false);
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={chat.title}
      accessibilityHint={onPeek ? "Opens the chat. Hold to peek at it." : "Opens the chat."}
      accessibilityActions={onPeek ? [{ name: "longpress", label: "Peek" }] : undefined}
      onAccessibilityAction={(e) => e.nativeEvent.actionName === "longpress" && onPeek?.(chat.id)}
      onPressIn={() => setHeld(true)}
      onPressOut={() => setHeld(false)}
      onPress={() => {
        haptic.tick();
        onOpen(chat.id);
      }}
      onLongPress={
        onPeek
          ? () => {
              haptic.soft();
              onPeek(chat.id);
            }
          : undefined
      }
      delayLongPress={350}
      hitSlop={inline ? INLINE_SLOP : 10}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          height: PILL,
          maxWidth: inline ? 300 : "100%",
          paddingHorizontal: 6,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: alpha(c.target, held ? 0.6 : 0.28),
          backgroundColor: alpha(c.target, held ? 0.24 : 0.12),
        },
        inline ? { transform: [{ translateY: DROP }] } : { alignSelf: "flex-start" },
      ]}
    >
      <EngineLogo engine={chat.engine} size={14} color={c.link} />
      <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: size - 1, lineHeight: PILL - 2, color: c.link }}>
        {chat.title}
      </Text>
    </Pressable>
  );
}

/** A chat it names that isn't on the board any more: the same pill, neutral, pointing nowhere. */
export function GoneLink({ inline = false }: { inline?: boolean }) {
  const { c } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel="a chat that's gone"
      style={[
        { height: PILL, justifyContent: "center", paddingHorizontal: 6, borderRadius: 6, borderWidth: 1, borderColor: alpha(c.text, 0.12), backgroundColor: alpha(c.text, 0.06) },
        inline ? { transform: [{ translateY: DROP }] } : null,
      ]}
    >
      <Text style={{ fontSize: 15, lineHeight: PILL - 2, color: c.muted }}>a chat</Text>
    </View>
  );
}

/** Its state as a glyph and a word: Done in green, Needs you in amber, Working in grey (DECISIONS.md, "A Chief's chat"). */
export function StateWord({ phase, size = 13 }: { phase: Phase; size?: number }) {
  const { c } = useTheme();
  const ink = phase === "needs" ? c.warning : phase === "done" || phase === "ready" ? c.success : c.muted;
  return (
    <View accessible accessibilityLabel={STATE_WORD[phase]} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      <StateGlyph phase={phase} />
      <Text style={{ fontSize: size, lineHeight: size + 5, color: ink }}>{STATE_WORD[phase]}</Text>
    </View>
  );
}

/** The state's pixel glyph alone, from the same family as Home's tiles. */
export function StateGlyph({ phase, size = 16 }: { phase: Phase; size?: number }) {
  const { c } = useTheme();
  if (phase === "needs") return <PixelIcon name="state-needs-you" size={size} />;
  if (phase === "working") return <PixelIcon name="state-working" size={size} />;
  return <PixelIcon name="state-done" size={size} ink={c.success} />;
}
