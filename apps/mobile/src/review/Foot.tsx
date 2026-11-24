// The decision, at the guide's foot, in reach however far you read: the dock's 48 pt pair (DECISIONS.md "Approval
// dock"), the way back on the left and the way forward on the right, led by a 48 pt circle that asks the agent. They
// stand on the page's foot over its progressive fade, as the chat bar does, with no card: the pair says what it does,
// so the code keeps the room.
// - One of your agents' pull requests: Request changes | Merge. Request changes goes to the chat that made it, which
//   gets back to work on the same branch while the guide waits ("Back at work on your note"); Merge asks once
//   ("Squash and merge #491?"), and says what you haven't read before it ships.
// - A teammate's: Request changes | Approve, sent as your review.
// - Your own draft: Ask to fix | Mark ready.
// Ask is answer only, on any of them: the agent reads the code, changes nothing, and its answer comes back here.
//
// What you type goes in a sheet that rides up on the keyboard, led by where you are (the chapter you're reading, as a
// chip you can drop) and, for pushing back, what you'd most likely say, a tap each: disagreeing is two taps.
import { useEffect, useRef, useState } from "react";
import { Text, TextInput, type TextInputInstance, View } from "react-native";
import { ENGINE_NAME } from "../board/model";
import { Icon } from "../components/Icon";
import { PixelIcon } from "../components/Pixel";
import { Squish } from "../components/Squish";
import { Shimmer } from "../components/transcript/Shimmer";
import { Button } from "../components/ui/Button";
import { ApprovalPair } from "../components/ui/Choices";
import { haptic } from "../motion";
import { ago, Overlay } from "../screens/pages/parts";
import { type Pr, type Sent } from "../screens/pages/review-model";
import { alpha, FLOAT_TYPE, mono, radius, useFontScale, useTheme } from "../theme";
import { CALL_WORD, type Passage, type PrGuideAttention } from "./model";
import { CallWord, Prose } from "./parts";
import type { Asked } from "./state";

export type ComposeMode = "ask" | "changes" | "reply" | "comment";

export interface Compose {
  mode: ComposeMode;
  passage?: Passage;
  text: string;
  /** The thread a reply goes on. */
  thread?: string;
  /** The chapter it is about, by index, when it is about one. */
  stop?: number | null;
  /** The line it is about, when it was asked from one. */
  line?: { path: string; line: number };
  /** What you'd most likely say, a tap each. */
  suggestions?: readonly string[];
}

/** Who answers an Ask from this guide: the chat's harness, or an agent started for it. */
export const askerOf = (pr: Pr) => (pr.agent ? ENGINE_NAME[pr.agent.engine] : "an agent");

const SENT_WORD: Record<Sent["verdict"], string> = { approve: "approved", request_changes: "asked for changes", comment: "commented" };

export function Foot({ pr, sent, working, bottom, onHeight, onCompose, onMerge, onApprove, onReady, onOpenChat }: { pr: Pr; sent: readonly Sent[]; /** The chat that made it is back at work on what you asked. */ working: boolean; bottom: number; onHeight: (h: number) => void; onCompose: (mode: ComposeMode) => void; onMerge: () => void; onApprove: () => void; onReady: () => void; onOpenChat?: () => void }) {
  const { c, t } = useTheme();
  const big = useFontScale() > FLOAT_TYPE;
  const open = pr.state === "open" || pr.state === "draft";
  if (!open) return null;
  const last = [...sent].reverse().find((r) => r.verdict !== "comment");
  const asker = askerOf(pr);
  const draft = pr.state === "draft";
  const deny = draft ? "Ask to fix" : big ? "Changes" : "Request changes";
  const box = { flexDirection: "row" as const, alignItems: "center" as const, gap: 10, height: 48, paddingLeft: 14, paddingRight: 4, borderRadius: 24, backgroundColor: c.control };
  return (
    <View pointerEvents="box-none" onLayout={(e) => onHeight(Math.round(e.nativeEvent.layout.height))} style={{ position: "absolute", left: 16, right: 16, bottom, flexDirection: "row", alignItems: "center", gap: 8 }}>
      {/* Ask leads, a circle with the speech mark, so the pair keeps the width its words need. */}
      <Squish label={`Ask ${asker} about it. It reads the code and changes nothing`} depth={0.94} onPress={() => onCompose("ask")} style={{ width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center", backgroundColor: c.control }}>
        <Icon name="comment" size={21} color={c.text} />
      </Squish>
      <View style={{ flex: 1 }}>
        {working ? (
          <View accessibilityLiveRegion="polite" style={box}>
            <PixelIcon name="state-working" />
            <Text maxFontSizeMultiplier={FLOAT_TYPE} numberOfLines={1} style={[t.row, { flex: 1, fontSize: 16 }]}>
              Back at work on your note
            </Text>
            {onOpenChat ? (
              <Squish label="Open the chat" depth={0.95} onPress={onOpenChat} style={{ height: 44, paddingHorizontal: 12, justifyContent: "center" }}>
                <Text maxFontSizeMultiplier={FLOAT_TYPE} style={[t.small, { color: c.text }]}>
                  Open
                </Text>
              </Squish>
            ) : null}
          </View>
        ) : !pr.mine && last ? (
          <View accessibilityLiveRegion="polite" style={box}>
            <PixelIcon name={last.verdict === "approve" ? "state-done" : "state-failed"} />
            <Text maxFontSizeMultiplier={FLOAT_TYPE} numberOfLines={1} style={[t.row, { flex: 1, fontSize: 16 }]}>
              You {SENT_WORD[last.verdict]} <Text style={{ color: c.muted }}>· {ago(last.at)}</Text>
            </Text>
            <Squish label="Review again" depth={0.95} onPress={() => onCompose("changes")} style={{ height: 44, paddingHorizontal: 12, justifyContent: "center" }}>
              <Text maxFontSizeMultiplier={FLOAT_TYPE} style={[t.small, { color: c.text }]}>
                Change
              </Text>
            </Squish>
          </View>
        ) : draft ? (
          <ApprovalPair deny={deny} allow="Mark ready" onDeny={() => onCompose("changes")} onAllow={onReady} armKey={pr.number} />
        ) : (
          <ApprovalPair deny={deny} allow={pr.mine ? "Merge" : "Approve"} onDeny={() => onCompose("changes")} onAllow={pr.mine ? onMerge : onApprove} armKey={`${pr.repo}#${pr.number}`} />
        )}
      </View>
    </View>
  );
}

/** A suggestion, a tap that puts its words in the box. */
function Suggestion({ text, onPress }: { text: string; onPress: () => void }) {
  const { c, t } = useTheme();
  return (
    <Squish label={`Say: ${text}`} depth={0.97} onPress={onPress} style={{ paddingHorizontal: 14, paddingVertical: 10, minHeight: 44, justifyContent: "center", borderRadius: radius.control, backgroundColor: alpha(c.text, 0.05), borderWidth: 1, borderColor: c.hairline }}>
      <Text style={[t.body, { fontSize: 15, lineHeight: 21, color: c.soft }]}>{text}</Text>
    </Squish>
  );
}

/** What you type for the agent or the review, in a sheet that rides on the keyboard. */
export function ComposeSheet({ pr, compose, onClose, onSend }: { pr: Pr; compose: Compose | null; onClose: () => void; onSend: (c: Compose) => void }) {
  const { c, t } = useTheme();
  const last = useRef(compose);
  if (compose) last.current = compose;
  const now = compose ?? last.current;
  const [text, setText] = useState(now?.text ?? "");
  const [about, setAbout] = useState<Passage | undefined>(now?.passage);
  const [focused, setFocused] = useState(false);
  const input = useRef<TextInputInstance>(null);
  useEffect(() => {
    if (!compose) return;
    setText(compose.text);
    setAbout(compose.passage);
  }, [compose]);
  if (!now) return null;
  const asker = askerOf(pr);
  const changes = now.mode === "changes";
  const replying = now.mode === "reply" || now.mode === "comment";
  const theirs = !pr.mine;
  const title = now.mode === "comment" ? "Comment" : replying ? "Reply" : changes ? (pr.state === "draft" ? "Ask to fix" : "Request changes") : `Ask ${asker}`;
  const placeholder = now.mode === "comment" ? "Comment on this line" : replying ? "Reply on the thread" : changes ? "What should change?" : "Ask about this pull request";
  const where = replying
    ? "Goes on the pull request as your comment."
    : changes
      ? theirs && pr.state !== "draft"
        ? "Goes on the pull request as your review."
        : pr.chat
          ? `Goes to the chat that made it; ${asker} changes this branch and brings it back.`
          : "Starts an agent on its branch to make it."
      : `${asker === "an agent" ? "An agent" : asker} reads the code and answers here. It changes nothing.`;
  const send = now.mode === "comment" ? "Comment" : replying ? "Reply" : changes ? (theirs && pr.state !== "draft" ? "Request changes" : "Send it back") : "Ask";
  const ok = text.trim().length > 0;
  const suggestions = (now.suggestions ?? []).filter((s) => s !== text.trim());
  return (
    <Overlay open={!!compose} onClose={onClose} title={title}>
      <View style={{ paddingHorizontal: 20, paddingBottom: 8, gap: 12 }}>
        {about ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 12, borderRadius: radius.control, backgroundColor: alpha(c.text, 0.05) }}>
            <Icon name="link" size={14} color={c.subtle} />
            <Text numberOfLines={2} style={[t.small, { flex: 1, paddingVertical: 10 }]}>
              About {about.where}
            </Text>
            <Squish label="Not about this" depth={0.9} onPress={() => setAbout(undefined)} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
              <Icon name="close" size={14} color={c.muted} />
            </Squish>
          </View>
        ) : null}
        {suggestions.length ? (
          <View style={{ gap: 8 }}>
            {suggestions.map((s) => (
              <Suggestion
                key={s}
                text={s}
                onPress={() => {
                  haptic.tick();
                  setText(s);
                  input.current?.focus();
                }}
              />
            ))}
          </View>
        ) : null}
        <TextInput
          ref={input}
          value={text}
          onChangeText={setText}
          autoFocus={!suggestions.length}
          multiline
          placeholder={suggestions.length ? "Or say it your way" : placeholder}
          placeholderTextColor={c.subtle}
          accessibilityLabel={placeholder}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={[t.body, { minHeight: suggestions.length && text.length < 50 ? 64 : 104, maxHeight: 180, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12, borderRadius: radius.control, borderWidth: 1, borderColor: focused ? c.field : c.hairline, backgroundColor: c.panel, color: c.text, textAlignVertical: "top" }, { outlineStyle: "none" } as object]}
        />
        <Text style={t.small}>{where}</Text>
        <Button
          label={send}
          variant="primary"
          stretch
          disabled={!ok}
          onPress={() => {
            if (!ok) return;
            haptic.done();
            onSend({ ...now, passage: about, stop: about ? now.stop : null, text: text.trim() });
          }}
        />
      </View>
    </Overlay>
  );
}

/** The answer to what you asked, in the sheet you asked from: your words, then the agent reading, then what it said. */
export function AnswerSheet({ asked, asker, onClose, onOpenChat, onAskMore }: { asked: Asked | null; asker: string; onClose: () => void; onOpenChat?: () => void; onAskMore: () => void }) {
  const { c, t } = useTheme();
  const last = useRef(asked);
  if (asked) last.current = asked;
  const now = asked ?? last.current;
  if (!now) return null;
  const who = asker === "an agent" ? "The agent" : asker;
  return (
    <Overlay open={!!asked} onClose={onClose} title={`Ask ${asker}`}>
      <View style={{ paddingHorizontal: 20, paddingBottom: 8, gap: 14 }}>
        <View style={{ alignSelf: "flex-end", maxWidth: "88%", paddingHorizontal: 14, paddingVertical: 10, borderRadius: 18, backgroundColor: c.control }}>
          <Text style={[t.body, { fontSize: 16, lineHeight: 22, color: c.text }]}>{now.question}</Text>
        </View>
        {now.where ? <Text style={[t.meta, { alignSelf: "flex-end", marginTop: -8 }]}>About {now.where}</Text> : null}
        <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", gap: 10 }}>
          <View style={{ paddingTop: 3 }}>
            <PixelIcon name={now.answer ? "engine-caveman" : "state-working"} size={16} />
          </View>
          {now.answer ? <Prose text={now.answer} style={[t.body, { flex: 1, fontSize: 16, lineHeight: 24, color: c.prose }]} /> : <Shimmer text={`${who} is reading the code…`} on style={[t.body, { flex: 1, fontSize: 16, lineHeight: 24 }]} />}
        </View>
        <Text style={t.small}>{now.answer ? `${who} read the code and changed nothing. The answer stays under ${now.stop !== null ? "its chapter" : "the TL;DR"}.` : "It changes nothing; you stay on the guide."}</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {onOpenChat ? (
            <View style={{ flex: 1 }}>
              <Button label="Open the chat" stretch onPress={onOpenChat} />
            </View>
          ) : null}
          <View style={{ flex: 1 }}>
            <Button label="Ask more" stretch onPress={onAskMore} />
          </View>
        </View>
      </View>
    </Overlay>
  );
}

/** What merging skips, said once in the merge sheet: the calls you haven't opened, and how much is unread. */
export interface Unread {
  read: number;
  total: number;
  /** Calls in chapters not marked read, risk first. */
  calls: readonly { stop: number; kind: PrGuideAttention["kind"]; note: string }[];
  /** No guide to read, and no file viewed: you'd merge code you haven't seen. */
  unseen: boolean;
}

/**
 * Merge, asked once (the desktop's merge confirm): what goes where, that checks fail when they do, and what you
 * haven't read, each call a tap from its chapter. Still one confirm, so still two taps.
 */
export function MergeSheet({ pr, open, unread, onClose, onMerge, onRead }: { pr: Pr; open: boolean; unread: Unread; onClose: () => void; onMerge: () => void; onRead: (stop: number) => void }) {
  const { c, t } = useTheme();
  const failing = pr.checks === "failing";
  const left = unread.total - unread.read;
  return (
    <Overlay open={open} onClose={onClose} title={`Squash and merge #${pr.number}?`}>
      <View style={{ paddingHorizontal: 20, paddingBottom: 8, gap: 8 }}>
        <Text style={[t.body, { fontSize: 15, lineHeight: 22, color: c.muted }]}>
          <Text style={{ fontFamily: mono, fontSize: 14 }}>{pr.branch}</Text> into <Text style={{ fontFamily: mono, fontSize: 14 }}>{pr.base}</Text> on {pr.repo.split("/").pop()}, as one commit.{failing ? " Some checks fail." : ""}
        </Text>
        {unread.total && left > 0 ? (
          <Text style={[t.body, { fontSize: 15, lineHeight: 22, color: c.text }]}>
            {unread.read} of {unread.total} chapters read{unread.calls.length ? ` · ${unread.calls.length} ${unread.calls.length === 1 ? "call" : "calls"} you haven't opened` : ""}.
          </Text>
        ) : unread.unseen ? (
          <Text style={[t.body, { fontSize: 15, lineHeight: 22, color: c.text }]}>You haven't opened the code yet.</Text>
        ) : null}
        {unread.calls.length ? (
          <View style={{ marginHorizontal: -8, marginBottom: 4 }}>
            {unread.calls.map((call) => (
              <Squish key={call.stop} label={`${CALL_WORD[call.kind]}, chapter ${call.stop + 1}: ${call.note.replace(/`/g, "")}. Read it`} depth={0.99} highlight onPress={() => onRead(call.stop)} style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48, paddingHorizontal: 8, borderRadius: 10 }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <CallWord kind={call.kind} size={13} />
                  <Prose text={call.note} lines={1} style={[t.small, { color: c.soft }]} />
                </View>
                <Text style={[t.small, { color: c.text }]}>Read it</Text>
                <Icon name="chevronRight" size={12} color={c.subtle} />
              </Squish>
            ))}
          </View>
        ) : null}
        <View style={{ height: 4 }} />
        <Button
          label="Squash and merge"
          variant={failing ? "destructive" : "primary"}
          stretch
          onPress={() => {
            haptic.thud();
            onMerge();
            onClose();
          }}
        />
      </View>
    </Overlay>
  );
}

/** A held line's choices: ask about it, ask for a change there, or comment on it on someone else's pull request. */
export function LineSheet({ line, pr, onClose, onAsk, onChange, onComment }: { line: { path: string; line: number; side: "new" | "old"; text: string } | null; pr: Pr; onClose: () => void; onAsk: () => void; onChange: () => void; onComment?: () => void }) {
  const { c, t } = useTheme();
  const last = useRef(line);
  if (line) last.current = line;
  const now = line ?? last.current;
  if (!now) return null;
  const name = now.path.split("/").pop();
  const row = { flexDirection: "row" as const, alignItems: "center" as const, gap: 12, minHeight: 52, paddingHorizontal: 20 };
  const asker = askerOf(pr);
  return (
    <Overlay open={!!line} onClose={onClose} title={`${now.side === "old" ? "Removed line" : "Line"} ${now.line} · ${name}`}>
      <View style={{ paddingBottom: 8 }}>
        <View style={{ marginHorizontal: 20, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: radius.control, backgroundColor: alpha(c.text, 0.05) }}>
          <Text numberOfLines={3} style={{ fontFamily: mono, fontSize: 13, lineHeight: 19, color: c.text }}>
            {now.text.trim() || " "}
          </Text>
        </View>
        <Squish label={`Ask ${asker} about this line`} depth={0.99} highlight onPress={onAsk} style={row}>
          <Icon name="comment" size={18} color={c.muted} />
          <Text style={[t.row, { flex: 1 }]}>Ask about this line</Text>
        </Squish>
        <Squish label="Ask for a change here" depth={0.99} highlight onPress={onChange} style={row}>
          <Icon name="rename" size={18} color={c.muted} />
          <Text style={[t.row, { flex: 1 }]}>{pr.mine ? "Ask for a change here" : "Request a change here"}</Text>
        </Squish>
        {onComment ? (
          <Squish label="Comment on this line" depth={0.99} highlight onPress={onComment} style={row}>
            <Icon name="compose" size={18} color={c.muted} />
            <Text style={[t.row, { flex: 1 }]}>Comment on this line</Text>
          </Squish>
        ) : null}
      </View>
    </Overlay>
  );
}
