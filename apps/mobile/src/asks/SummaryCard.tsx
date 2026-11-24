// What an agent needs from you, as one calm card you can answer without opening the chat:
// docked question card, verb-first summary, and approval card in one anatomy:
//
// - who: its Chief's face (across Chiefs; a Chief's own deck leaves it out, the Chief stands on it), the engine's mark
//   and the chat's title, then the Chief, the workspace and how long it has waited, in the tertiary grey;
// - what it did so far and found, in a sentence or two, verb first;
// - what it needs, in bold: the ask ("Run a staging migration?") with why in a few words and the command it would run,
//   or the question ("Keep the legacy_backoff flag?");
// - the choices: Deny | Allow, the one pair every ask uses; or the options as 44 pt rows, the one it would take itself
//   raised and marked "Recommended", then "Tell it something else…".
//
// It comes in four sizes: `row`, a card in the Needs you list (the pair at its inline 44 pt); `deck`, the card in
// front of a stack (Home's, a Chief's), the pair at 48; `dock`, the thread's dock over the box, which leaves out who
// and the summary since the chat itself is right above it; `page`, the Queue's one big card in large type, which adds
// the steps it took and stands at the foot of the page with the ask and its choices at its own foot, where the thumb
// is. Tapping the body opens the chat; the choices sit beside the body, never inside it, so a button never holds another. "Tell it something else…" brings back the box where there is
// one (`onTell`, the dock and a Chief's deck) and otherwise opens a field in the card that sends your words. Every
// choice is deaf for ARM_MS after the card arrives or the asks move, so a tap meant for the card before never answers
// this one.
import { useEffect, useRef, useState } from "react";
import { LinearGradient } from "expo-linear-gradient";
import { Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { type Chat, chiefById, chiefOf, type Need } from "../board/model";
import { Icon } from "../components/Icon";
import { Squish } from "../components/Squish";
import { ApprovalPair, CommandChip } from "../components/ui/Choices";
import { EngineLogo } from "../components/ui/EngineLogo";
import { StepLine } from "../components/transcript/WorkRun";
import { Portrait } from "../home/Portrait";
import { haptic } from "../motion";
import { rowAge } from "../shell/inbox";
import { stepsBeforeAsk } from "../store/asked";
import { childName, shortAsk } from "../store/select";
import { useStore } from "../store/store";
import { alpha, overlayShadow, radius, touch, useTheme, weight } from "../theme";
import { ARM_MS, armed as listArmed, type Reply } from "./decide";

export type CardVariant = "row" | "deck" | "dock" | "page";

/**
 * A risk worth a line of its own, in a word or two, unless the ask already says it ("Run a staging migration?" says
 * what a migration risks). Production and what can't be undone always say so. For an approval that came without a why.
 */
export function riskOf(command: string, question = ""): string | null {
  const said = (words: RegExp) => words.test(question);
  if (/--prod\b|\bdeploy\b.*prod|production/i.test(command)) return said(/production/i) ? null : "Production";
  if (/\brm -rf?\b|--force\b|\bdrop (table|database)\b/i.test(command)) return "Can't be undone";
  if (/\bmigrate\b/i.test(command)) return said(/migrat|database|schema/i) ? null : "Changes the database";
  if (/\b(add|install|i)\b/.test(command) && /\b(pnpm|npm|yarn|bun)\b/.test(command)) return said(/\badd|install|package|dependenc/i) ? null : "Adds a package";
  if (/\bgit push\b/.test(command)) return said(/\bpush/i) ? null : "Pushes to the remote";
  if (/--target=hosted|\bhosted\b/.test(command)) return said(/hosted/i) ? null : "Reaches the hosted relay";
  return null;
}

/** The ask in bold: an approval's short question ("Add a package?"), or the question it asked, whole. */
export function headlineOf(asker: Pick<Chat, "line" | "ask">, need: Need): string {
  return need.kind === "approval" ? shortAsk(asker, need.command).ask : need.question;
}

/** The option a yes takes: the one it recommends, else its first. */
export const recommendedOf = (need: Need) => (need.kind === "question" ? (need.options.find((o) => o.recommended) ?? need.options[0] ?? null) : null);

export interface SummaryCardProps {
  /** The chat that asks: the answer goes to it. */
  asker: Chat;
  /** The chat it shows under: the same chat, or the parent of the subagent that asks (whose title it carries). */
  row: Chat;
  need: Need;
  variant: CardVariant;
  /** Lead with its Chief's face and name: across Chiefs (the Queue, the Needs you list). A Chief's own deck leaves it out. */
  showChief?: boolean;
  /** With `showChief`, its face too; false where the Chief stands on the card itself (the Queue), its name kept. */
  face?: boolean;
  /**
   * Its surface: `flat` in content (a list, the Queue: the card grey and a hairline, rounded 16), `float` over it (a
   * dock: opaque, rounded 24, with the overlay's shadow), `none` where what holds it draws one. By size by default.
   */
  surface?: "flat" | "float" | "none";
  /** Changes when the ask in front of you does: its choices are deaf again for ARM_MS. */
  armKey?: string;
  /** Whether a tap now is meant, given when the choices armed; by default ARM_MS and the asks' last move. */
  armed?: (since: number) => boolean;
  onReply: (reply: Reply) => void;
  /** The body: opens the chat. */
  onOpen?: () => void;
  /** A hold on the body: a peek, where there is one (a Chief's screen). */
  onPeek?: () => void;
  /** "Tell it something else…" brings back the box (the dock, a Chief's deck); absent, the card opens its own field. */
  onTell?: () => void;
  /** The card's own field took focus, so what holds it can bring it clear of the keyboard. */
  onFieldFocus?: () => void;
  /** At the right of the ask's line: "‹ 1 of 3 ›". */
  pager?: React.ReactNode;
  /** The dock in a subagent: who asks ("Audit the phone app › the composer"), which opens the parent. */
  source?: { engine: string; words: string; onOpen: () => void } | null;
}

/** A card's surface, for the card and for the plates a stack shows behind it. */
export function surfaceOf(kind: "flat" | "float", c: ReturnType<typeof useTheme>["c"], dark: boolean) {
  return kind === "flat"
    ? ({ backgroundColor: c.card, borderRadius: 16, borderWidth: 1, borderColor: c.hairline } as const)
    : ({ backgroundColor: c.card, borderRadius: 24, borderWidth: 1, borderColor: c.edge, ...overlayShadow(dark) } as const);
}

/** When the choices armed: the card arriving, or what it asks changing under it. */
function useArmedSince(armKey: string | undefined) {
  const since = useRef(Date.now());
  useEffect(() => {
    since.current = Date.now();
  }, [armKey]);
  return since;
}

export function SummaryCard(props: SummaryCardProps) {
  const { asker, row, need, variant, showChief = false, face = true, surface: kind = variant === "row" ? "flat" : "float", armKey, armed, onReply, onOpen, onPeek, onTell, onFieldFocus, pager, source } = props;
  const { c, t, dark } = useTheme();
  const since = useArmedSince(armKey ?? `${asker.id}:${need.at}`);
  const ready = () => (armed ?? listArmed)(since.current) && Date.now() - since.current >= ARM_MS;
  const [writing, setWriting] = useState(false);
  // How wide the pager stands, for the room the body's header keeps for it.
  const [pagerW, setPagerW] = useState(0);
  // A new ask in front of you closes a field left open for the one before.
  useEffect(() => setWriting(false), [asker.id, need.at]);
  const reply = (r: Reply) => {
    if (!ready()) return;
    onReply(r);
  };

  const headline = headlineOf(asker, need);
  const why = need.kind === "approval" ? (need.why ?? riskOf(need.command, headline)) : null;
  const summary = variant === "dock" ? null : need.summary;
  const tellWords = need.kind === "question" ? "Tell it something else…" : "Tell it what to do instead";
  const tell = () => {
    if (onTell) onTell();
    else setWriting(true);
  };

  const surface = kind === "none" ? null : surfaceOf(kind, c, dark);

  const recommended = recommendedOf(need);
  const actions =
    need.kind === "approval"
      ? [
          { name: "allow", label: "Allow" },
          { name: "deny", label: "Deny" },
          { name: "instead", label: tellWords },
        ]
      : [...need.options.map((o, i) => ({ name: `option-${i}`, label: o.recommended ? `${o.label}, recommended` : o.label })), { name: "instead", label: tellWords }];

  // VoiceOver answers from the part it lands on first (the body, or the dock's ask), as the buttons do by sight.
  const voice = {
    accessibilityActions: actions,
    onAccessibilityAction: (e: { nativeEvent: { actionName: string } }) => {
      const name = e.nativeEvent.actionName;
      if (name === "allow") reply({ kind: "allow" });
      else if (name === "deny") reply({ kind: "deny" });
      else if (name === "instead") tell();
      else if (name.startsWith("option-") && need.kind === "question") {
        const option = need.options[Number(name.slice(7))];
        if (option) reply({ kind: "option", option });
      }
    },
  };

  if (variant === "page")
    return (
      <PageCard
        asker={asker}
        row={row}
        need={need}
        headline={headline}
        why={why}
        tellWords={tellWords}
        writing={writing}
        onWrite={tell}
        onWritten={() => setWriting(false)}
        armKey={armKey}
        armedFor={(at) => (armed ?? listArmed)(Math.max(at, since.current))}
        ready={ready}
        reply={reply}
        onReply={onReply}
        onOpen={onOpen}
        onPeek={onPeek}
        onFieldFocus={onFieldFocus}
        voice={voice}
      />
    );

  return (
    <View style={[{ paddingHorizontal: 16, paddingTop: variant === "dock" ? 16 : 14, paddingBottom: 14 }, surface]}>
      {variant === "dock" ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 24 }}>
            <Text accessible accessibilityRole="header" {...voice} style={[t.heading, { flex: 1, fontSize: 17, lineHeight: 22, fontWeight: weight.semibold }]}>
              {headline}
            </Text>
            {pager}
          </View>
          {source ? <SourceLine {...source} /> : null}
          {why ? <Text style={[t.small, { fontSize: 15, lineHeight: 20, marginTop: 2 }]}>{why}</Text> : null}
        </>
      ) : (
        // The pager is the body's neighbour, laid over the room the body keeps for it at its header's right: the body
        // is one button, and a button never holds another (the web says so out loud).
        <View>
          <Body asker={asker} row={row} need={need} showChief={showChief} face={face} headline={headline} why={why} summary={summary} pager={pager ? <View style={{ width: pagerW, height: 22 }} /> : null} onOpen={onOpen} onPeek={onPeek} voice={voice} />
          {pager ? (
            <View onLayout={(e) => setPagerW(Math.round(e.nativeEvent.layout.width))} style={{ position: "absolute", right: 0, top: showChief && chiefOf(row) ? 8 : 0 }}>
              {pager}
            </View>
          ) : null}
        </View>
      )}

      {need.kind === "approval" ? (
        <>
          <View style={{ marginTop: 10 }}>
            <CommandChip command={need.command} />
          </View>
          <View style={{ marginTop: 12 }}>
            <ApprovalPair
              size={variant === "row" ? "inline" : "standard"}
              command={need.command}
              armKey={armKey}
              armed={(at) => (armed ?? listArmed)(Math.max(at, since.current))}
              onDeny={() => onReply({ kind: "deny" })}
              onAllow={() => onReply({ kind: "allow" })}
            />
          </View>
          {variant === "row" && !writing ? null : writing ? (
            <View style={{ marginTop: 8 }}>
              <Field placeholder="Tell it what to do instead…" onSend={(text) => reply({ kind: "deny", instead: text })} onCancel={() => setWriting(false)} onFocus={onFieldFocus} />
            </View>
          ) : (
            // The card's foot, edge to edge. Its place and its rule are this plain view's, so the row you press is the
            // whole 44 pt: with the margins on the row itself, the part that hears a finger came out 40 tall.
            <View style={{ marginTop: 10, marginBottom: -14, marginHorizontal: -16 }}>
              <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, height: 1, backgroundColor: c.hairline }} />
              <Squish label={tellWords} depth={0.98} onPress={tell} style={{ height: touch, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 18 }}>
                <Icon name="rename" size={18} color={c.muted} />
                <Text style={[t.body, { fontSize: 15, color: c.muted }]}>{tellWords}</Text>
              </Squish>
            </View>
          )}
        </>
      ) : (
        <View style={{ marginTop: 10, gap: 6 }}>
          {need.options.map((option) => (
            <Squish
              key={option.label}
              label={option.recommended ? `${option.label}, recommended${option.detail ? `. ${option.detail}` : ""}` : `${option.label}${option.detail ? `. ${option.detail}` : ""}`}
              depth={0.98}
              onPress={() => {
                if (!ready()) return;
                haptic.thud();
                onReply({ kind: "option", option });
              }}
              style={{
                minHeight: touch,
                justifyContent: "center",
                paddingHorizontal: 14,
                paddingVertical: 7,
                borderRadius: radius.card,
                borderWidth: 1,
                borderColor: option === recommended ? (dark ? c.field : alpha(c.text, 0.18)) : c.hairline,
                backgroundColor: option === recommended ? alpha(c.text, dark ? 0.07 : 0.05) : undefined,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                <Text style={[t.row, { flex: 1, fontSize: 16, lineHeight: 20, fontWeight: option === recommended ? weight.medium : weight.regular }]}>{option.label}</Text>
                {option.recommended ? <Text style={[t.meta, { fontSize: 13 }]}>Recommended</Text> : null}
              </View>
              {option.detail ? <Text style={[t.small, { fontSize: 13, lineHeight: 17, marginTop: 1 }]}>{option.detail}</Text> : null}
            </Squish>
          ))}
          {writing ? (
            <Field placeholder="Tell it something else…" onSend={(text) => reply({ kind: "told", text })} onCancel={() => setWriting(false)} onFocus={onFieldFocus} />
          ) : (
            <Squish
              label={tellWords}
              depth={0.98}
              onPress={tell}
              style={{ minHeight: touch, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, borderRadius: radius.card, borderWidth: 1, borderColor: c.hairline, borderStyle: "dashed" }}
            >
              <Icon name="rename" size={16} color={c.muted} />
              <Text style={[t.row, { fontSize: 16, lineHeight: 21, color: c.muted }]}>{tellWords}</Text>
            </Squish>
          )}
        </View>
      )}
    </View>
  );
}

/** Who asks, what it did so far, and what it needs: the part of the card that opens the chat. */
function Body({
  asker,
  row,
  need,
  showChief,
  face,
  headline,
  why,
  summary,
  pager,
  onOpen,
  onPeek,
  voice,
}: Pick<SummaryCardProps, "asker" | "row" | "need" | "pager" | "onOpen" | "onPeek"> & {
  showChief: boolean;
  face: boolean;
  headline: string;
  why: string | null;
  summary: string | null;
  /** The card's answers, as VoiceOver actions on its body. */
  voice: { accessibilityActions: { name: string; label: string }[]; onAccessibilityAction: (e: { nativeEvent: { actionName: string } }) => void };
}) {
  const { c, t } = useTheme();
  const title = useStore((s) => s.inbox.titles[row.id]) ?? row.title;
  const chiefId = chiefOf(row);
  const chief = showChief && chiefId ? chiefById(chiefId) : null;
  // Which subagent asks, by its own short name ("the composer"), when it isn't the chat the card is under.
  const by = asker.id !== row.id ? childName(asker) : null;
  const where = [by, chief?.name ?? null, row.repo].filter(Boolean).join(" · ");
  const age = rowAge(need.at, Date.now());
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${where}. ${summary ? `${summary} ` : ""}${headline}${why ? ` ${why}` : ""}`}
      accessibilityHint="Opens the chat"
      {...voice}
      onPress={onOpen}
      onLongPress={
        onPeek
          ? () => {
              haptic.soft();
              onPeek();
            }
          : undefined
      }
      delayLongPress={350}
      style={({ pressed }) => ({ opacity: pressed && onOpen ? 0.7 : 1 })}
    >
      {chief ? (
        // Across Chiefs: its Chief's face, then the chat and, under it, whose board and where.
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {face ? <Portrait character={chief.character} tone={chief.tone} size={28} crop="head" ground={c.card} /> : null}
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <EngineLogo engine={asker.engine} size={14} />
              <Text numberOfLines={1} style={[t.label, { flex: 1, fontSize: 15, lineHeight: 20 }]}>
                {title}
              </Text>
              {pager ? null : <Text style={[t.meta, { fontSize: 13 }]}>{age}</Text>}
            </View>
            <Text numberOfLines={1} style={[t.meta, { fontSize: 13, lineHeight: 18 }]}>
              {where}
            </Text>
          </View>
          {pager}
        </View>
      ) : (
        // On a Chief's own deck, one line: the chat, and which subagent asks; its capsule already says where it runs.
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 22 }}>
          <EngineLogo engine={asker.engine} size={14} />
          <Text numberOfLines={1} style={[t.label, { flex: 1, fontSize: 15, lineHeight: 20 }]}>
            {title}
            {by ? <Text style={{ color: c.subtle, fontWeight: weight.regular }}>{` › ${by}`}</Text> : null}
          </Text>
          {pager ?? <Text style={[t.meta, { fontSize: 13 }]}>{age}</Text>}
        </View>
      )}
      {summary ? (
        <Text numberOfLines={2} style={[t.body, { fontSize: 15, lineHeight: 21, color: c.muted, marginTop: chief ? 10 : 6 }]}>
          {summary}
        </Text>
      ) : null}
      <Text style={[t.heading, { fontSize: 17, lineHeight: 22, fontWeight: weight.semibold, marginTop: 8 }]}>{headline}</Text>
      {why ? <Text style={[t.body, { fontSize: 15, lineHeight: 20, color: c.muted, marginTop: 1 }]}>{why}</Text> : null}
    </Pressable>
  );
}

/** In a subagent's dock: who asks, by its engine's mark and "Parent › the child"; a tap opens the parent. */
function SourceLine({ engine, words, onOpen }: { engine: string; words: string; onOpen: () => void }) {
  const { c, t } = useTheme();
  return (
    <Squish
      label={`Asked by ${words}. Open the parent`}
      depth={0.98}
      onPress={onOpen}
      // A 44 pt target around its 20 pt line, reaching into the room above and below it.
      style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: touch, marginTop: -12 + 2, marginBottom: -12, alignSelf: "flex-start", maxWidth: "100%" }}
    >
      <EngineLogo engine={engine} size={14} />
      <Text numberOfLines={1} style={[t.body, { flexShrink: 1, fontSize: 15, lineHeight: 20, color: c.muted }]}>
        {words}
      </Text>
      <Icon name="chevronRight" size={12} color={c.subtle} />
    </Squish>
  );
}

/** Your own words, in the card: a field and its send circle. Leaving it empty puts the row back. */
export function Field({ placeholder, onSend, onCancel, onFocus }: { placeholder: string; onSend: (text: string) => void; onCancel: () => void; onFocus?: () => void }) {
  const { c, t } = useTheme();
  const [text, setText] = useState("");
  const said = text.trim();
  const send = () => {
    if (!said) return;
    haptic.thud();
    onSend(said);
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6, minHeight: touch, paddingLeft: 14, paddingRight: 4, borderRadius: radius.card, borderWidth: 1, borderColor: c.field, backgroundColor: c.panel }}>
      <TextInput
        autoFocus
        value={text}
        onChangeText={setText}
        placeholder={placeholder}
        placeholderTextColor={c.subtle}
        multiline
        // One line to start on the web (a textarea's default is two); a phone's field grows as you write.
        numberOfLines={Platform.OS === "web" ? 1 : undefined}
        submitBehavior="submit"
        returnKeyType="send"
        onSubmitEditing={send}
        // A browser's textarea takes Enter as a new line whatever `submitBehavior` says: there Enter sends and
        // Shift-Enter breaks the line, as the box does.
        onKeyPress={
          Platform.OS === "web"
            ? (e) => {
                const key = e.nativeEvent as { key: string; shiftKey?: boolean };
                if (key.key !== "Enter" || key.shiftKey) return;
                e.preventDefault();
                send();
              }
            : undefined
        }
        onFocus={onFocus}
        onBlur={() => {
          if (!said) onCancel();
        }}
        accessibilityLabel={placeholder}
        selectionColor={c.text}
        style={[t.body, { flex: 1, fontSize: 16, lineHeight: 21, paddingTop: 11, paddingBottom: 11, maxHeight: 21 * 4 + 22, color: c.text, outlineStyle: "none" } as object]}
      />
      <Squish label="Send" depth={0.9} hitSlop={4} disabled={!said} onPress={send} style={{ width: 36, height: 36, borderRadius: 18, marginBottom: 3, alignItems: "center", justifyContent: "center", backgroundColor: said ? c.primary : c.control }}>
        <Icon name="send" size={18} color={said ? c.onPrimary : c.subtle} />
      </Squish>
    </View>
  );
}

/** The most steps the Queue's card lists; past it, the earliest give way to "N steps before". */
const PAGE_STEPS = 4;

/**
 * The Queue's card: who asks and where at the top, what it did (its summary at 20, then the steps since your last
 * message as the transcript lists them), and at the foot the ask in bold at the page title's 24 with its why and its
 * command, then the choices. It stands at its own height at the foot of the page, in thumb reach; when that is more
 * than the page has room for, what it did scrolls inside the card and the ask and its choices stay put.
 */
function PageCard({
  asker,
  row,
  need,
  headline,
  why,
  tellWords,
  writing,
  onWrite,
  onWritten,
  armKey,
  armedFor,
  ready,
  reply,
  onReply,
  onOpen,
  onPeek,
  onFieldFocus,
  voice,
}: {
  asker: Chat;
  row: Chat;
  need: Need;
  headline: string;
  why: string | null;
  tellWords: string;
  writing: boolean;
  onWrite: () => void;
  onWritten: () => void;
  armKey?: string;
  armedFor: (at: number) => boolean;
  ready: () => boolean;
  reply: (r: Reply) => void;
  onReply: (r: Reply) => void;
  onOpen?: () => void;
  onPeek?: () => void;
  onFieldFocus?: () => void;
  voice: { accessibilityActions: { name: string; label: string }[]; onAccessibilityAction: (e: { nativeEvent: { actionName: string } }) => void };
}) {
  const { c, t, dark } = useTheme();
  const title = useStore((s) => s.inbox.titles[row.id]) ?? row.title;
  const chiefId = chiefOf(row);
  const chief = chiefId ? chiefById(chiefId) : null;
  const by = asker.id !== row.id ? childName(asker) : null;
  const where = [by, chief?.name ?? "Your chat", row.repo].filter(Boolean).join(" · ");
  const age = rowAge(need.at, Date.now());
  // What it did on the way to asking; the command it waits on is the ask's own chip, said there once.
  const steps = stepsBeforeAsk(asker.items);
  const recommended = recommendedOf(need);
  // How tall what it did is, and the room it has: when it's taller, it scrolls and fades at its foot until read.
  const [box, setBox] = useState(0);
  const [content, setContent] = useState(0);
  const [read, setRead] = useState(false);
  return (
    <View style={{ flexShrink: 1, minHeight: 0, backgroundColor: c.card, borderRadius: PAGE_CORNER, borderWidth: 1, borderColor: dark ? c.hairline : c.edge, overflow: "hidden" }}>
      <View style={{ flexShrink: 1, minHeight: 0 }}>
      <ScrollView
        style={{ flexGrow: 0, flexShrink: 1 }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 18, paddingBottom: 12 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={32}
        onLayout={(e) => setBox(e.nativeEvent.layout.height)}
        onContentSizeChange={(_w, h) => setContent(h)}
        onScroll={(e) => setRead(e.nativeEvent.contentOffset.y + e.nativeEvent.layoutMeasurement.height >= e.nativeEvent.contentSize.height - 4)}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${title}. ${where}. ${need.summary} ${headline}${why ? ` ${why}` : ""}`}
          accessibilityHint="Opens the chat"
          {...voice}
          onPress={onOpen}
          onLongPress={
            onPeek
              ? () => {
                  haptic.soft();
                  onPeek();
                }
              : undefined
          }
          delayLongPress={350}
          style={({ pressed }) => ({ opacity: pressed && onOpen ? 0.7 : 1 })}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingRight: 52 }}>
            <EngineLogo engine={asker.engine} size={16} />
            <Text numberOfLines={1} style={[t.heading, { flexShrink: 1, fontSize: 17, lineHeight: 22 }]}>
              {title}
            </Text>
          </View>
          <Text numberOfLines={1} style={[t.meta, { fontSize: 13, lineHeight: 18, marginTop: 2 }]}>
            {where} · {age}
          </Text>
          {need.summary ? <Text style={[t.body, { fontSize: 20, lineHeight: 28, color: c.prose, marginTop: 16, letterSpacing: -0.2 }]}>{need.summary}</Text> : null}
        </Pressable>
        {steps.length ? (
          // What it did, step by step as the transcript lists them: the evidence under the summary.
          <View style={{ marginTop: 12 }}>
            {steps.length > PAGE_STEPS ? <Text style={[t.meta, { fontSize: 13, lineHeight: 18, marginLeft: 24, marginBottom: 4 }]}>{`${steps.length - PAGE_STEPS + 1} steps before`}</Text> : null}
            {steps.slice(steps.length > PAGE_STEPS ? -(PAGE_STEPS - 1) : 0).map((step, i) => (
              <StepLine key={`${i}-${step.text}`} step={step} />
            ))}
          </View>
        ) : null}
      </ScrollView>
      {/* Cut short on a short screen, what it did fades out at its foot, so the cut reads as more, not as broken. */}
      {content > box + 4 && !read ? <LinearGradient pointerEvents="none" colors={[alpha(c.card, 0), c.card]} style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 32 }} /> : null}
      </View>
      {/* What it needs stays put with its choices; only what it did gives way and scrolls on a short screen. */}
      <View style={{ paddingHorizontal: 20, paddingBottom: 6 }}>
        <Text accessibilityRole="header" style={[t.largeTitle, { marginTop: 16 }]}>
          {headline}
        </Text>
        {why ? <Text style={[t.body, { fontSize: 15, lineHeight: 20, color: c.muted, marginTop: 2 }]}>{why}</Text> : null}
        {need.kind === "approval" ? (
          <View style={{ marginTop: 12 }}>
            <CommandChip command={need.command} />
          </View>
        ) : null}
        <View style={{ height: 12 }} />
        {need.kind === "approval" ? (
          <>
            <ApprovalPair command={need.command} armKey={armKey} armed={armedFor} onDeny={() => onReply({ kind: "deny" })} onAllow={() => onReply({ kind: "allow" })} />
            {writing ? (
              <View style={{ marginTop: 8, marginBottom: 8 }}>
                <Field placeholder="Tell it what to do instead…" onSend={(text) => reply({ kind: "deny", instead: text })} onCancel={onWritten} onFocus={onFieldFocus} />
              </View>
            ) : (
              <TellRow words={tellWords} onPress={onWrite} />
            )}
          </>
        ) : (
          <View style={{ gap: 8 }}>
            {need.options.map((option) => (
              <Squish
                key={option.label}
                label={option.recommended ? `${option.label}, recommended${option.detail ? `. ${option.detail}` : ""}` : `${option.label}${option.detail ? `. ${option.detail}` : ""}`}
                depth={0.98}
                onPress={() => {
                  if (!ready()) return;
                  haptic.thud();
                  onReply({ kind: "option", option });
                }}
                style={{
                  minHeight: 52,
                  justifyContent: "center",
                  paddingHorizontal: 16,
                  paddingVertical: 8,
                  borderRadius: 26,
                  backgroundColor: option === recommended ? c.primary : c.control,
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                  <Text numberOfLines={1} style={[t.row, { flex: 1, fontSize: 17, lineHeight: 22, fontWeight: weight.medium, color: option === recommended ? c.onPrimary : c.text }]}>
                    {option.label}
                  </Text>
                  {option.recommended ? <Text style={[t.meta, { fontSize: 13, color: option === recommended ? alpha(c.onPrimary, 0.7) : c.subtle }]}>Recommended</Text> : null}
                </View>
                {option.detail ? (
                  <Text numberOfLines={1} style={[t.small, { fontSize: 13, lineHeight: 17, color: option === recommended ? alpha(c.onPrimary, 0.7) : c.muted }]}>
                    {option.detail}
                  </Text>
                ) : null}
              </Squish>
            ))}
            {writing ? (
              <View style={{ marginBottom: 8 }}>
                <Field placeholder="Tell it something else…" onSend={(text) => reply({ kind: "told", text })} onCancel={onWritten} onFocus={onFieldFocus} />
              </View>
            ) : (
              <TellRow words={tellWords} onPress={onWrite} />
            )}
          </View>
        )}
      </View>
    </View>
  );
}

/** The Queue card's corner: a card you hold, rounder than a list's. */
export const PAGE_CORNER = 24;

/** "Tell it what to do instead": a 44 pt text row under the choices, the way it sits under every pair. */
function TellRow({ words, onPress }: { words: string; onPress: () => void }) {
  const { c, t } = useTheme();
  return (
    <Squish label={words} depth={0.98} onPress={onPress} style={{ height: touch, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 2 }}>
      <Icon name="rename" size={16} color={c.muted} />
      <Text style={[t.body, { fontSize: 15, color: c.muted }]}>{words}</Text>
    </Squish>
  );
}
