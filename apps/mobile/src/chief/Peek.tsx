// A chat at a glance from a Chief's screen, on the shared medium sheet (shell/Sheet.tsx: glass floating 8 pt in, a
// glass X at the left, the chat's title centred, a glass Open at the right): hold a chat the Chief names and this rises
// instead of leaving the Chief. Tapped
// from a row of its agents, the same page is pushed inside the agents sheet with a back chevron (PeekPage), so one
// sheet is ever up, never one stacked on another.
// It leads with why you looked: where it stands as a glyph and a word, and what it asks or is doing. Then the thing
// itself (the command, the change, the steps it's taking), its latest words, and where it runs as grouped rows with
// inset hairlines (workspace, computer, branch, who runs it). At the foot, the one pair (Deny | Allow, Later | Ship it),
// whose answer waits behind its own Undo right where the pair was, and a "Tell this chat…" field that steers it
// without leaving the Chief. Its latest words are cut only where a sentence ends: the whole opening sentences that fit,
// up to three of its points, then "More", which opens the chat.
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { type Chat, deviceById } from "../board/model";
import * as script from "../board/script";
import { Icon } from "../components/Icon";
import { ToolMark } from "../components/Pixel";
import { RunsPreview } from "../components/RunsPreview";
import { GlassCircle } from "../components/ui/Floating";
import { haptic } from "../motion";
import { rowAge } from "../shell/inbox";
import { Sheet } from "../shell/Sheet";
import { notice } from "../shell/ui";
import { phaseOf } from "../store/select";
import { StateWord } from "../shell/rows/StateWord";
import { askOf, childName } from "../store/select";
import { alpha, mono, useTheme } from "../theme";
import { act } from "../asks/decide";
import { SummaryCard } from "../asks/SummaryCard";
import { askerOf as anyAskerOf, needOf } from "../store/select";
import { askerOf, type Card, cardFor } from "./cards";
import { type Pendings, undo } from "./decide";
import { ChangesPill } from "../components/transcript/TurnEnd";
import { CommandBox, Pair, UndoBar } from "./parts";
import { StateGlyph } from "../components/ui/WorkLink";

interface Props {
  chat: Chat | null;
  /** The whole board: its status counts its subagents, and an ask may be one of theirs. */
  chats: readonly Chat[];
  /** Its number on the Chief's board (CH-12), what the desktop's link shows on hover. */
  number?: string;
  /** What waits behind Undo, by the chat the answer goes to. */
  pending: Pendings;
  onClose: () => void;
  onOpen: (id: string) => void;
  /** Allow or ship (yes), deny or put off (no): the deck's own decision, Undo and all. */
  onDecide: (card: Card, yes: boolean) => void;
}

export function Peek({ chat, ...rest }: Props) {
  const open = chat !== null;
  // The sheet keeps drawing what it showed while it slides away.
  const [last, setLast] = useState<Chat | null>(chat);
  if (chat && chat !== last) setLast(chat);
  const shown = chat ?? last;
  if (!shown) return null;
  return (
    <Sheet open={open} onClose={rest.onClose} detent="medium" title={shown.title} accessory={<PeekOpen chat={shown} {...rest} />}>
      {/* A fresh page each time it opens: the field never keeps words meant for another look. */}
      <PeekPage key={open ? shown.id : "going"} chat={shown} {...rest} />
    </Sheet>
  );
}

/** The glass Open at the head's right: the chat itself, the sheet put away. */
export function PeekOpen({ chat, onClose, onOpen }: { chat: Chat } & Pick<Props, "onClose" | "onOpen">) {
  return <GlassCircle icon="open" label="Open chat" onPress={() => go(chat, { onClose, onOpen })} />;
}

/** The peek as a page: what it's about, then the pair and the field. A sheet's body, standalone or pushed. */
export function PeekPage({ chat, ...rest }: { chat: Chat } & Omit<Props, "chat">) {
  const [field, setField] = useState("");
  return (
    <>
      <Body chat={chat} {...rest} />
      <View style={{ paddingHorizontal: 16, paddingTop: 10, gap: 10 }}>
        <Foot chat={chat} field={field} setField={setField} {...rest} />
      </View>
    </>
  );
}

function go(chat: Chat, { onClose, onOpen }: Pick<Props, "onClose" | "onOpen">) {
  onClose();
  onOpen(chat.id);
}

function Body({ chat, chats, ...rest }: { chat: Chat } & Omit<Props, "chat">) {
  const { c, t } = useTheme();
  const phase = phaseOf(chat, chats);
  const asker = phase === "needs" ? askerOf(chat, chats) : null;
  const latest = chat.items.findLast((item) => item.kind === "text");
  const words = latest?.kind === "text" ? latest.text : null;
  const work = chat.items.findLast((item) => item.kind === "work");
  const steps = work?.kind === "work" ? work.steps.slice(-3) : [];
  const device = deviceById(chat.device);
  // What it waits on, or what it's doing, is why you looked: it comes first, in full ink.
  // A ready change's facts are drawn under its files; its line would only repeat them.
  // An ask is the one question (store/select.ts askOf), and which subagent asks follows it in grey.
  // A question for direction is said whole by its card at the foot, with its options; here it would say it twice.
  const direction = phase === "needs" && needOf(anyAskerOf(chat, chats))?.kind === "question";
  const detail = asker ? askOf(asker).question : direction || (phase === "ready" && chat.moment) ? null : chat.line;
  const by = asker && asker.id !== chat.id ? childName(asker) : null;
  return (
    <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 2, paddingBottom: 8, gap: 16 }} showsVerticalScrollIndicator={false}>
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <StateGlyph phase={phase} />
          <Text style={t.label}>
            <StateWord phase={phase} />
          </Text>
          <View style={{ flex: 1 }} />
          <Text style={t.meta}>{rowAge(chat.updatedAt, Date.now())}</Text>
        </View>
        {detail ? (
          <Text numberOfLines={3} style={[t.body, { fontSize: 15, lineHeight: 22, color: c.soft, paddingLeft: 24 }]}>
            {detail}
            {by ? <Text style={{ color: c.subtle }}>{` · ${by}`}</Text> : null}
          </Text>
        ) : null}
      </View>

      {asker?.ask ? (
        <CommandBox command={asker.ask} />
      ) : chat.phase === "ready" && chat.moment?.preview === "runs" ? (
        <View style={{ height: 150, borderRadius: 12, overflow: "hidden" }}>
          <RunsPreview small />
        </View>
      ) : chat.phase === "ready" && chat.moment ? (
        // What it changed is one line, as a finished turn's is; a tap lists the files in place.
        <ChangesPill files={chat.moment.files} />
      ) : chat.phase === "working" && steps.length ? (
        <View style={{ gap: 6 }}>
          {steps.map((step, i) => (
            <View key={`${step.text}-${i}`} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <ToolMark tool={step.tool} />
              <Text numberOfLines={1} style={[t.body, { flex: 1, fontSize: 15, lineHeight: 21, color: c.muted }]}>
                {step.text}
                {step.detail ? <Text style={{ fontFamily: mono, fontSize: 13, color: c.subtle }}> {step.detail}</Text> : null}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {words ? <Summary text={words} onMore={() => go(chat, rest)} /> : null}

      {/* Where it runs, in one quiet line: the workspace, the branch, the computer (and its state when it's away). */}
      <Text numberOfLines={1} style={t.meta}>
        {[chat.repo, chat.moment?.branch, device.status === "online" ? device.name : `${device.name}, ${device.status === "asleep" ? "asleep" : "offline"}`].filter(Boolean).join(" · ")}
      </Text>
    </ScrollView>
  );
}

/** A paragraph's sentences: a stop, a question or an exclamation, then a space and what starts the next. */
function sentencesOf(text: string): string[] {
  const out: string[] = [];
  const end = /[.!?…]["'”’)\]]*\s+(?=[A-Z0-9"'“‘(])/g;
  let from = 0;
  for (let m = end.exec(text); m; m = end.exec(text)) {
    out.push(text.slice(from, m.index + m[0].length).trim());
    from = m.index + m[0].length;
  }
  if (from < text.length) out.push(text.slice(from).trim());
  return out.filter(Boolean);
}

/** About this many characters of opening words before its points (three lines), or with none (five). */
const LEAD_WITH_POINTS = 140;
const LEAD_ALONE = 240;

/**
 * Its latest words as they were written, cut only where a sentence ends: the opening sentences that fit whole (the
 * first always, never part of one), then its points as real bullets, three of them, then "More", which opens the chat
 * whenever anything is held back (a sentence, a point, what it wrote after its points).
 */
function Summary({ text, onMore }: { text: string; onMore: () => void }) {
  const { c, t } = useTheme();
  const lines = text
    .replace(/\*\*|`/g, "")
    .split("\n")
    .map((l) => l.replace(/^>\s?/, "").trim())
    .filter(Boolean);
  const bullet = (l: string) => /^[-*] /.test(l);
  const firstPoint = lines.findIndex(bullet);
  // The opening is what comes before its points; what follows them waits behind More.
  const opening = (firstPoint < 0 ? lines : lines.slice(0, firstPoint)).join(" ");
  const points = lines.filter(bullet).map((l) => l.slice(2));
  const after = firstPoint < 0 ? [] : lines.slice(firstPoint).filter((l) => !bullet(l));
  const budget = points.length ? LEAD_WITH_POINTS : LEAD_ALONE;
  const sentences = sentencesOf(opening);
  let lead = "";
  let kept = 0;
  for (const sentence of sentences) {
    const next = lead ? `${lead} ${sentence}` : sentence;
    if (kept && next.length > budget) break;
    lead = next;
    kept += 1;
  }
  const shown = points.slice(0, 3);
  const cut = kept < sentences.length || points.length > shown.length || after.length > 0;
  const prose = [t.prose, { fontSize: 15, lineHeight: 23 }];
  return (
    <View style={{ gap: 6 }}>
      {lead ? <Text style={prose}>{lead}</Text> : null}
      {shown.map((p, i) => (
        <View key={i} style={{ flexDirection: "row", gap: 8, paddingLeft: 4 }}>
          <Text style={[prose, { color: c.subtle }]}>•</Text>
          <Text numberOfLines={2} style={[prose, { flex: 1 }]}>
            {p}
          </Text>
        </View>
      ))}
      {cut ? (
        <Pressable accessibilityRole="link" accessibilityLabel="More, in the chat" onPress={onMore} hitSlop={12} style={{ alignSelf: "flex-start" }}>
          <Text style={[t.row, { fontSize: 15, color: c.muted }]}>More</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** The pair, then a field that steers the chat from here: what you write goes to it as a message of yours. */
function Foot({ chat, chats, pending, onDecide, onClose, field, setField }: { chat: Chat; field: string; setField: (text: string) => void } & Omit<Props, "chat">) {
  const { c, t } = useTheme();
  const card = cardFor(chat, chats);
  // A question for direction: the summary card at its dock size (who and what it did are the page above it), its
  // options answered here, through the one way every ask is answered (src/asks/decide.ts), Undo in the toast.
  const direction = (() => {
    if (card || phaseOf(chat, chats) !== "needs") return null;
    const asker = anyAskerOf(chat, chats);
    const need = needOf(asker);
    return need?.kind === "question" ? { asker, need } : null;
  })();
  const send = () => {
    const text = field.trim();
    if (!text) return;
    haptic.thud();
    script.send(chat.id, text);
    setField("");
    onClose();
    notice({ id: `told-${chat.id}-${Date.now()}`, text: `Told “${chat.title}”`, tone: "info", icon: "send" });
  };
  return (
    <>
      {card && pending[card.chat.id] ? (
        <UndoBar pending={pending[card.chat.id]!} onUndo={() => undo(card.chat.id)} />
      ) : card ? (
        <Pair kind={card.kind} onDecide={(yes) => onDecide(card, yes)} />
      ) : direction ? (
        <View style={{ marginHorizontal: -16, marginTop: -16 }}>
          <SummaryCard asker={direction.asker} row={chat} need={direction.need} variant="dock" surface="none" onReply={(reply) => void act(direction.asker.id, reply)} />
        </View>
      ) : null}
      {/* A question's card has its own "Tell it something else…", which answers it; a second field here would only
          steer around the question it waits on. */}
      {direction ? null : (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44, paddingLeft: 14, paddingRight: 4, borderRadius: 22, backgroundColor: alpha(c.text, 0.07) }}>
        <TextInput
          value={field}
          onChangeText={setField}
          placeholder="Tell this chat…"
          placeholderTextColor={c.subtle}
          accessibilityLabel={`Tell ${chat.title}`}
          returnKeyType="send"
          onSubmitEditing={send}
          blurOnSubmit
          style={[t.body, { flex: 1, minHeight: 44, paddingVertical: 10, color: c.text }, { outlineStyle: "none" } as object]}
        />
        {field.trim() ? (
          <Pressable accessibilityRole="button" accessibilityLabel={chat.phase === "working" ? "Steer" : "Send"} onPress={send} hitSlop={6} style={{ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: c.primary }}>
            <Icon name="send" size={18} color={c.onPrimary} />
          </Pressable>
        ) : null}
      </View>
      )}
    </>
  );
}
