// A chat's own subagents, on a medium glass sheet 8pt in from the screen's edges (DECISIONS.md "Agents sheet";
// Cursor 5349): opened from the floating row's "2 of 3 working", or filtered to what waits on you from "2 agents need
// you". Each row has its state as a glyph and a word, the
// title, one live meta line ("Run 143 of 200 · Cloud computer") and how long ago it moved. What needs you comes first;
// finished ones fold into "N done" at the foot, which opens in place. A row opens that child, pushed over this chat, so
// Back comes here again.
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Chat } from "../board/model";
import { Icon } from "../components/Icon";
import { PixelIcon } from "../components/Pixel";
import { haptic } from "../motion";
import { rowAge } from "../shell/inbox";
import { Sheet } from "../shell/Sheet";
import { StateWord } from "../shell/rows/StateWord";
import { lineTwo } from "../store/select";
import { useStore } from "../store/store";
import { alpha, layout, useTheme } from "../theme";

/** Needs you, then working, then the rest, each by when it last moved. */
const ORDER: Record<Chat["phase"], number> = { needs: 0, working: 1, ready: 2, done: 3 };

function StateGlyph({ phase, fate }: { phase: Chat["phase"]; /** A builder's own state: one that failed, was left out or is paused is not done, and wears no check. */ fate?: Chat["fate"] }) {
  const { c } = useTheme();
  if (phase === "needs") return <PixelIcon name="state-needs-you" ink={c.warning} />;
  if (phase === "working") return <PixelIcon name="state-working" />;
  if (fate?.tone === "bad") return <PixelIcon name="state-failed" ink={c.destructive} />;
  if (fate?.tone === "warn") return <PixelIcon name="state-stopped" ink={c.warning} />;
  return <PixelIcon name="state-done" />;
}

const WORD: Record<Chat["phase"], string> = { needs: "Needs you", working: "Working", ready: "Done", done: "Done" };

function AgentRow({ chat, now, usual, divided, onOpen }: { chat: Chat; now: number; /** The parent's computer: a child names its own only when it runs elsewhere or that one is away. */ usual: string; divided: boolean; onOpen: () => void }) {
  const { c, t } = useTheme();
  const [held, setHeld] = useState(false);
  // A builder on a real computer says what became of it, in that state's one colour ("Merged", "Left out: conflicts
  // in a.ts", "Paused until 11:08 PM", "Failed: its agent stopped"); one that asks still says so first.
  const fate = chat.phase === "needs" ? undefined : chat.fate;
  const word = fate?.words ?? WORD[chat.phase];
  // The one O7 line (store/select.ts lineTwo): the ask or the live sentence, no counts; a finished child says how it
  // ended in its own words.
  const line = lineTwo(chat, chat.phase, usual);
  const said = chat.phase === "needs" || chat.phase === "working" ? line.said : chat.line;
  // Nothing is said twice: a line that is the state's own word adds nothing to it.
  const meta = [said === word ? null : said, line.device].filter(Boolean).join(" · ");
  const age = rowAge(chat.updatedAt, now);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${chat.title}, ${word}, ${meta}, ${age === "now" ? "just now" : `${age} ago`}`}
      onPressIn={() => setHeld(true)}
      onPressOut={() => setHeld(false)}
      onPress={() => {
        haptic.tick();
        onOpen();
      }}
      style={[{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 64, paddingHorizontal: 20, paddingVertical: 10, backgroundColor: held ? alpha(c.text, 0.06) : undefined }, { outlineStyle: "none" } as object]}
    >
      {divided ? <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 52, right: 20, height: 1, backgroundColor: c.hairline }} /> : null}
      <View style={{ width: 20, alignItems: "center" }}>
        <StateGlyph phase={chat.phase} fate={fate} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
          <Text numberOfLines={1} style={[t.row, { flex: 1, fontSize: 17, lineHeight: 22 }]}>
            {chat.title}
          </Text>
          <Text style={[t.meta, { fontSize: 15 }]}>{age}</Text>
        </View>
        <Text numberOfLines={1} style={[t.small, { fontSize: 14, lineHeight: 19 }]}>
          {fate ? <Text style={fate.tone === "quiet" ? undefined : { color: fate.tone === "bad" ? c.destructive : c.warning }}>{word}</Text> : <StateWord phase={chat.phase} word={word} />}
          {meta ? ` · ${meta}` : ""}
        </Text>
      </View>
    </Pressable>
  );
}

export function AgentsSheet({ open, onClose, kids, onOpen, filter = null }: { open: boolean; onClose: () => void; kids: readonly Chat[]; onOpen: (id: string) => void; /** "needs": only the ones waiting on you (the capsule's "2 agents need you"). */ filter?: "needs" | null }) {
  const { c, t } = useTheme();
  const [showDone, setShowDone] = useState(false);
  const now = Date.now();
  // Where the parent runs: its children name their computer only when it is another one.
  const usual = useStore((s) => s.board.chats.find((ch) => ch.id === kids[0]?.parent)?.device ?? kids[0]?.device ?? "");
  const sorted = [...kids].sort((a, b) => ORDER[a.phase] - ORDER[b.phase] || b.updatedAt - a.updatedAt);
  // A builder that was left out, is paused or failed is not done: it stays in sight, above the fold.
  const inSight = (k: Chat) => k.phase === "working" || (k.fate !== undefined && k.fate.tone !== "quiet");
  const live = sorted.filter((k) => k.phase === "needs" || (filter !== "needs" && inSight(k)));
  const finished = filter === "needs" ? [] : sorted.filter((k) => k.phase !== "needs" && !inSight(k));
  // With nothing still going, the finished ones are all there is to see: they show, with no fold to open first.
  const all = !live.length;
  const shown = showDone || all ? [...live, ...finished] : live;
  const go = (id: string) => {
    onClose();
    // After the sheet starts down, so the push isn't hidden behind it.
    setTimeout(() => onOpen(id), 120);
  };
  return (
    <Sheet open={open} onClose={onClose} detent="medium" title={filter === "needs" ? "Need you" : "Agents"}>
      <View style={{ paddingTop: 4, paddingBottom: 6 }}>
        {shown.map((kid, i) => (
          <AgentRow key={kid.id} chat={kid} now={now} usual={usual} divided={i > 0} onOpen={() => go(kid.id)} />
        ))}
        {finished.length && !all ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={showDone ? `Hide the ${finished.length} done` : `Show the ${finished.length} done`}
            onPress={() => {
              haptic.tick();
              setShowDone(!showDone);
            }}
            style={[{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: layout.row.sheet, paddingHorizontal: 20 }, { outlineStyle: "none" } as object]}
          >
            {shown.length ? <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 52, right: 20, height: 1, backgroundColor: c.hairline }} /> : null}
            <View style={{ width: 20, alignItems: "center" }}>
              <PixelIcon name="state-done" />
            </View>
            <Text style={[t.row, { flex: 1, fontSize: 17, lineHeight: 22, color: c.muted }]}>{`${finished.length} done`}</Text>
            <Icon name={showDone ? "chevronUp" : "chevronDown"} size={16} color={c.subtle} />
          </Pressable>
        ) : null}
      </View>
    </Sheet>
  );
}
