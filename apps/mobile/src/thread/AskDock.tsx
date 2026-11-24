// What the chat waits on, docked where the thumb already is (DECISIONS.md "Approval dock"; Codex and Claude dock their
// asks over the box): the summary card at its dock size (src/asks/SummaryCard.tsx), an opaque card rounded 24 in the
// box's place. It leaves out who asks and what it did so far, since the chat is right above it: the ask in bold ("Run a
// staging migration?", or the question it asked), why in a few words when the risk needs saying, then the command chip
// and Deny | Allow, or the question's options (the one it recommends raised) and "Tell it something else…". In a
// subagent, the grey line under the ask says who asks ("Audit the phone app › the composer") and opens the parent.
// "Tell it what to do instead" brings the box back focused, and what you send from there answers.
//
// Swipe right to allow (or take what it recommends) and left to deny, the Chief's grammar. An answer leaves the dock at
// once and the box comes back; its Undo is the shell's toast for four seconds, and Undo docks the ask again
// (src/asks/decide.ts). Every choice ignores taps for 450 ms after the card appears.
import { useRoute } from "@react-navigation/native";
import { View } from "react-native";
import type { Need } from "../board/model";
import { act } from "../asks/decide";
import { Stack } from "../asks/Stack";
import { ARM_MS } from "../components/ui/Choices";
import { needOf, useChat } from "../store/select";

/** An answer's Undo holds this long (the toast's, src/asks/decide.ts UNDO_MS). */
export const DOCK_UNDO_MS = 4000;
/** Allow is deaf this long after the card appears or pages (the one pair's own, components/ui/Choices.tsx). */
export { ARM_MS };

/** Who asks, in a subagent: its engine's mark and "Parent › the child"; a tap opens the parent. */
export interface AskSource {
  engine: string;
  words: string;
  onOpen: () => void;
}

export function AskDock({
  chat: chatId,
  asks,
  source,
  onDecide,
  onInstead,
  bottom,
  onHeight,
}: {
  /** The chat that asks; by default the one this screen shows. */
  chat?: string;
  /** Its open asks' commands (an empty one for a question): the dock shows the chat's ask, these say it has one. */
  asks: readonly string[];
  /** The chat's ask as its one question (read from the chat itself now). */
  question?: string;
  /** Who asks, in a subagent. */
  source?: AskSource | null;
  /** For a dock with no chat to answer: the answer for its first command, at once. */
  onDecide?: (yes: boolean, command: string) => void;
  onInstead: () => void;
  /** From the screen's foot. */
  bottom: number;
  /** How tall the card stands, for the chat's end to stay clear of it. */
  onHeight?: (height: number) => void;
}) {
  const route = useRoute();
  const id = chatId ?? (route.params as { id?: string } | undefined)?.id;
  const chat = useChat(id);
  const need: Need | null = chat ? needOf(chat) : null;
  if (!chat || !need) {
    // A chat this dock can't find (not on the board yet): its first command alone, answered at once.
    const command = asks[0];
    if (!command || !chat) return null;
    const stand: Need = { kind: "approval", command, summary: "", at: chat.updatedAt };
    return (
      <Place bottom={bottom} onHeight={onHeight}>
        <Stack
          items={[{ key: `${chat.id}:${command}`, asker: chat, row: chat, need: stand }]}
          surface="float"
          peek="up"
          variant="dock"
          source={source}
          onReply={(_, reply) => onDecide?.(reply.kind === "allow", command)}
          onOpen={() => {}}
          onTell={onInstead}
        />
      </Place>
    );
  }
  return (
    <Place bottom={bottom} onHeight={onHeight}>
      <Stack
        items={[{ key: `${chat.id}:${need.at}`, asker: chat, row: chat, need }]}
        surface="float"
        peek="up"
        variant="dock"
        source={source}
        onReply={(_, reply) => void act(chat.id, reply)}
        onOpen={() => {}}
        onTell={onInstead}
      />
    </Place>
  );
}

/** Where it stands and how tall, measured on a plain view: the card inside moves with the thumb. */
function Place({ bottom, onHeight, children }: { bottom: number; onHeight?: (height: number) => void; children: React.ReactNode }) {
  return (
    <View pointerEvents="box-none" onLayout={(e) => onHeight?.(Math.round(e.nativeEvent.layout.height))} style={{ position: "absolute", left: 16, right: 16, bottom }}>
      {children}
    </View>
  );
}
