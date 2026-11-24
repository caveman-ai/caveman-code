// The sidebar's pieces, for clean mobile navigation.md 4-5, the desktop's shell/Sidebar.tsx):
// section heads of a glyph, a name and a chevron; rows of one line at the desktop sidebar's tight pitch, the state's
// pixel mark at the left, the title, and the pull request's glyph at the right in its state's colour; the chat or
// Chief in the main panel on the desktop's selected fill; what a Chief spawned and a parent's subagents hung on a thread, the
// desktop folder's hairline rule. One text edge for every title and head.
import type { CastCharacter, SkinTone } from "@caveman-app/ui/mascot/poses";
import { type ComponentRef, memo, type ReactNode, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { Icon, type IconName } from "../components/Icon";
import { PixelIcon } from "../components/Pixel";
import { Count, StateDot } from "../components/ui/Badge";
import type { Anchor } from "../components/ui/Menu";
import { Shimmer } from "../components/transcript/Shimmer";
import { Portrait } from "../home/Portrait";
import { duration, ease, haptic, useReducedMotion } from "../motion";
import { useRowMark } from "../live/link";
import { kidsWord } from "../live/seams";
import { rowAge } from "../shell/inbox";
import { alpha, useTheme, weight } from "../theme";
import { type PrMark, type SectionKind, type SideChat, spokenRow, stateWord } from "./model";

// ---------------------------------------------------------------- measures

/**
 * A row's pitch: the desktop sidebar's (its rows are 32 to 34) with a little more for a finger (
 * "make it more condensed"). Each row's touch still reaches the full 44 through its hit slop.
 */
export const ROW = 36;
/** A queue row's two lines. */
export const ROW_TWO = 50;
/** A place at the top (Pull requests, Automations, each Chief): a step taller than a chat, as compact are. */
const PLACE = 40;
const PLACE_TITLE = { fontSize: 16, lineHeight: 21 } as const;
/** A title's line (15 on 20, the desktop's 14 a step up for a phone), and a queue row's second line under it. */
const LINE = 20;
const META = 18;
/** A row's title. */
const TITLE = { fontSize: 15, lineHeight: LINE } as const;
/** The selection's outline and a held row's fill stand this far in from the sidebar's edges. */
export const EDGE = 12;
/** The leading slot (a state mark, a head's glyph, a Chief's face): its centre from the sidebar's edge. */
const SLOT = 20;
const SLOT_X = EDGE + 6;
/** Every title and every head's name start here. */
export const TEXT_X = SLOT_X + SLOT + 10;
/** The thread: a hairline down from under the parent's mark (a Chief's face, a lead's state), the desktop's folder rule. */
const THREAD_X = SLOT_X + SLOT / 2 - 0.5;
/** A row on the thread steps in so its mark stands just right of the thread. */
const SUB_X = THREAD_X + 14 - (SLOT_X - EDGE) - SLOT / 2 + 0.5;
/** A trailing glyph's square (the pull request, the subagents' chevron), each a 32 pt target in the row. */
const TRAIL = 32;
/** The trailing column's centre, from the sidebar's right edge: a row's last glyph, a place's or a Chief's count. */
const TRAIL_X = EDGE + 2 + TRAIL / 2;

/**
 * The chat in the main panel wears the desktop sidebar's selected row ("make it more similar to
 * desktop selected chat"): the sidebar-accent fill on 8 pt corners (rounded-lg), no outline; a held row the same at 60%.
 */
const ROUND = 8;

// ---------------------------------------------------------------- a chevron that turns

/** A chevron pointing right when shut and down when open, turning between on the snap curve; still under Reduce Motion. */
export function Chevron({ open, size = 14, color }: { open: boolean; size?: number; color?: string }) {
  const { c } = useTheme();
  const still = useReducedMotion();
  const turn = useSharedValue(open ? 1 : 0);
  useEffect(() => {
    turn.value = still ? (open ? 1 : 0) : withTiming(open ? 1 : 0, { duration: duration.fast, easing: ease.snap });
  }, [open, still, turn]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 90}deg` }] }));
  return (
    <Animated.View style={[{ width: size, height: size, alignItems: "center", justifyContent: "center" }, style]}>
      <Icon name="chevronRight" size={size} color={color ?? c.subtle} stroke={2} />
    </Animated.View>
  );
}

// ---------------------------------------------------------------- a section's head

/**
 * A section's head: its glyph in the leading slot, its name on the titles' edge, a count where the queue gives one,
 * then the chevron that folds it (the compact layout). A head that folds is a button that says whether it is open; one
 * that doesn't is only a heading.
 */
export function SectionHead({ glyph, title, count, shut, onToggle, label }: { glyph: ReactNode; title: string; count?: number; shut?: boolean; onToggle?: () => void; label?: string }) {
  const { c, t } = useTheme();
  const body = (
    <>
      {glyph ? <View style={{ position: "absolute", left: SLOT_X, width: SLOT, top: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}>{glyph}</View> : null}
      <Text numberOfLines={1} style={[t.section, { flexShrink: 1, color: c.subtle }]}>
        {title}
      </Text>
      {count ? <Text style={[t.meta, { color: alpha(c.subtle, 0.75) }]}>{count}</Text> : null}
      {onToggle ? <Chevron open={!shut} size={11} /> : null}
    </>
  );
 // A head with no glyph (the queue's shelves) starts where the rows' marks do, as compact do; one with a glyph puts
  // its name on the titles' edge.
  const row = { height: 28, flexDirection: "row" as const, alignItems: "center" as const, gap: 5, paddingLeft: glyph ? TEXT_X : SLOT_X + 2, paddingRight: EDGE };
  if (!onToggle)
    return (
      <View accessible accessibilityRole="header" accessibilityLabel={label ?? title} style={row}>
        {body}
      </View>
    );
  return (
    <Pressable
      accessibilityRole="header"
      accessibilityLabel={label ?? (count ? `${title}, ${count}` : title)}
      accessibilityState={{ expanded: !shut }}
      accessibilityHint={shut ? "Shows this section" : "Folds this section"}
      accessibilityActions={[{ name: "activate" }]}
      onAccessibilityAction={() => onToggle()}
      onPress={() => {
        haptic.tick();
        onToggle();
      }}
      hitSlop={{ top: 2, bottom: 2 }}
      style={({ pressed }) => [row, { opacity: pressed ? 0.6 : 1 }]}
    >
      {body}
    </Pressable>
  );
}

/** A head's glyph: a chrome icon in the heads' grey. */
export function HeadGlyph({ name, filled }: { name: IconName; filled?: boolean }) {
  const { c } = useTheme();
  return <Icon name={name} size={15} color={c.subtle} filled={filled} stroke={1.5} />;
}

// ---------------------------------------------------------------- the selection and a held row

/** The outline the chat or Chief in the main panel wears, or the fill a held row lights. */
function Pill({ here, held }: { here: boolean; held: boolean }) {
  const { c } = useTheme();
  if (!here && !held) return null;
  return <View pointerEvents="none" style={{ position: "absolute", top: 1, bottom: 1, left: 0, right: 0, borderRadius: ROUND, backgroundColor: here ? c.selected : alpha(c.selected, 0.6) }} />;
}

// ---------------------------------------------------------------- the pull request's glyph

const PR_ICON: Record<PrMark["state"], IconName> = { open: "pullRequest", draft: "pullRequestDraft", merged: "merge", closed: "pullRequestClosed" };
const PR_WORD: Record<PrMark["state"], string> = { open: "open", draft: "a draft", merged: "merged", closed: "closed" };

/** A pull request's state in its colour, as Review draws it: open green, a draft grey, merged in near ink, closed red. */
export function usePrTone() {
  const { c } = useTheme();
  return (state: PrMark["state"]) => (state === "open" ? c.success : state === "draft" ? c.muted : state === "merged" ? alpha(c.text, 0.6) : c.destructive);
}

export const prSpoken = (pr: PrMark) => `Pull request ${pr.number}, ${PR_WORD[pr.state]}`;

function PrGlyph({ pr, onPress }: { pr: PrMark; onPress: () => void }) {
  const tone = usePrTone();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={prSpoken(pr)}
      accessibilityHint="Opens its guide"
      onPress={() => {
        haptic.tick();
        onPress();
      }}
      hitSlop={{ top: 6, bottom: 6 }}
      style={({ pressed }) => ({ width: TRAIL, height: TRAIL, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.5 : 1 })}
    >
      <Icon name={PR_ICON[pr.state]} size={17} color={tone(pr.state)} stroke={1.75} />
    </Pressable>
  );
}

// ---------------------------------------------------------------- a chat's row

export interface RowActions {
  onOpen: (row: SideChat) => void;
  onGuide: (row: SideChat) => void;
  onAgents: (row: SideChat) => void;
  /** A hold: the chat's menu, hung from the row (where it stands on the screen). */
  onHold: (row: SideChat, at: Anchor) => void;
}

/**
 * A chat's state as the app marks it everywhere, the desktop's StatusMark in pixels: the amber ask, the green check, a
 * dim dot once it is over, and the turning ring while it works, two comets while a parent waits on its subagents.
 */
function Mark({ row }: { row: SideChat }) {
  if (row.phase === "working" && row.agents.some((a) => a.phase === "working")) {
    return (
      <View accessibilityRole="image" accessibilityLabel="Its subagents are working" style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center" }}>
        <PixelIcon name="state-agents" />
      </View>
    );
  }
  return <StateDot phase={row.phase} />;
}

/**
 * A chat in one line (the compact layout), or two in the queue, where its state word, its project and its age go under the
 * title (upstream row). Its state's mark leads; the title is full ink while there is something new in it and the sidebar's
 * grey once you have seen it; the pull request's glyph and, for a parent, the chevron that opens its subagents end it,
 * each a target of its own (VoiceOver reaches them apart, and as actions on the row). A subagent's row is the same
 * row stepped in under its parent's title.
 */
export const ChatRow = memo(function ChatRow({ row, here, agentsOpen, queue, now, sub, shelf, flat, actions }: { row: SideChat; here: boolean; agentsOpen: boolean; queue: boolean; now: number; sub?: boolean; /** The queue section it sits in, which may say its state already. */ shelf?: SectionKind; /** Its subagents open elsewhere (Recent repeats a row its project shows). */ flat?: boolean; actions: RowActions }) {
  const { c, t } = useTheme();
  const [held, setHeld] = useState(false);
  const box = useRef<ComponentRef<typeof View>>(null);
 // A hold opens the chat's menu, hung from this row.
  const hold = () => {
    haptic.thud();
    box.current?.measureInWindow((x, y, width, height) => actions.onHold(row, { x, y, width, height }));
  };
  const word = queue ? stateWord(row, shelf) : null;
  // On the person's own board: where it runs, as a small mark in the web's words ("In Cloud", "On <Mac's name>"),
  // with that place's one state word when it does not simply run ("In Cloud · Asleep"). Nothing on the scripted board.
  const place = useRowMark(row.id);
  // A builder's row says what became of it, in that state's one colour ("Merged", "Left out: conflicts in a.ts",
  // "Paused until 11:08 PM"): its lead's row, right above, already says where they run.
  const fate = sub ? row.fate : undefined;
  const mark = fate ? { where: fate.words, word: null } : place;
  const markInk = fate?.tone === "bad" ? c.destructive : fate?.tone === "warn" ? c.warning : c.subtle;
  const markSpoken = mark ? (mark.word ? `${mark.where}, ${mark.word}` : mark.where) : null;
  const ink = row.unread || here ? c.text : c.sidebarInk;
  const two = queue && !sub;
  const height = two ? ROW_TWO : ROW;
  const hasAgents = !sub && !flat && row.agents.length > 0;
  const a11yActions = [{ name: "activate" }, { name: "longpress", label: "More" }, ...(row.pr ? [{ name: "guide", label: "Open the pull request's guide" }] : []), ...(hasAgents ? [{ name: "agents", label: agentsOpen ? "Hide subagents" : "Show subagents" }] : [])];
  // The title's line is a row of its own with the mark in it, so the mark sits on that line's middle in either mode;
  // the trailing glyphs stand on the same middle, a queue row's second line hanging under the title alone.
  const block = two ? LINE + 1 + META : LINE;
  const middle = (height - block) / 2 + LINE / 2;
  const trail = (row.pr ? TRAIL : 0) + (hasAgents ? TRAIL - 4 : 0);
  return (
    <View ref={box} style={{ height, marginLeft: sub ? SUB_X : EDGE, marginRight: EDGE }}>
      <Pill here={here} held={held} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={markSpoken && !fate ? `${spokenRow(row)}, ${markSpoken}` : spokenRow(row)}
        accessibilityHint={row.opens !== row.id ? "Opens its subagent's question" : "Opens the chat"}
        accessibilityState={{ selected: here }}
        accessibilityActions={a11yActions}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === "guide") actions.onGuide(row);
          else if (e.nativeEvent.actionName === "agents") actions.onAgents(row);
          else if (e.nativeEvent.actionName === "longpress") hold();
          else actions.onOpen(row);
        }}
        onPressIn={() => setHeld(true)}
        onPressOut={() => setHeld(false)}
        onPress={() => {
          haptic.tick();
          actions.onOpen(row);
        }}
        onLongPress={hold}
        delayLongPress={350}
        hitSlop={{ top: 4, bottom: 4 }}
        style={{ flex: 1, justifyContent: "center", paddingLeft: SLOT_X - EDGE, paddingRight: trail + 4 }}
      >
        <View style={{ height: LINE, flexDirection: "row", alignItems: "center", gap: TEXT_X - SLOT_X - SLOT }}>
          <View style={{ width: SLOT, alignItems: "center" }}>
            <Mark row={row} />
          </View>
          {row.phase === "working" ? (
            // At work it recedes to the sidebar's grey with a light passing over it, half as bright as a live row's.
            <View style={{ flex: 1, minWidth: 0 }}>
              <Shimmer text={row.title} style={[t.row, TITLE, { color: c.sidebarInk }]} lift={0.55} />
            </View>
          ) : (
            <Text numberOfLines={1} style={[t.row, TITLE, { flex: 1, minWidth: 0, color: ink }]}>
              {row.title}
            </Text>
          )}
          {mark ? (
            // A long Mac's name gives way; the state word never does. A builder's state has the wider share: on a
            // narrow phone "Paused until 11:08 PM" is read whole, and its title gives way first.
            <View accessible accessibilityLabel={markSpoken ?? undefined} style={{ flexDirection: "row", flexShrink: 0, maxWidth: fate ? "66%" : "52%" }}>
              <Text numberOfLines={1} style={[t.meta, { flexShrink: 1, color: markInk }]}>
                {mark.where}
              </Text>
              {mark.word ? (
                <Text numberOfLines={1} style={[t.meta, { flexShrink: 0, color: c.subtle }]}>
                  {/* A no-break space: a line's leading space is dropped where the word is its own text. */}
                  {`\u00A0· ${mark.word}`}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
        {two ? (
          <View style={{ marginTop: 1, marginLeft: TEXT_X - SLOT_X }}>
            <QueueMeta row={row} word={word} now={now} />
          </View>
        ) : null}
      </Pressable>
      {trail ? (
        <View style={{ position: "absolute", right: 2, top: middle - TRAIL / 2, height: TRAIL, flexDirection: "row", alignItems: "center" }}>
          {row.pr ? <PrGlyph pr={row.pr} onPress={() => actions.onGuide(row)} /> : null}
          {hasAgents ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${row.agents.length} ${kidsWord(row.agents.length, "subagent")}`}
              accessibilityState={{ expanded: agentsOpen }}
              onPress={() => {
                haptic.tick();
                actions.onAgents(row);
              }}
              hitSlop={{ top: 6, bottom: 6 }}
              style={({ pressed }) => ({ width: TRAIL - 4, height: TRAIL, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.5 : 1 })}
            >
              <Chevron open={agentsOpen} size={14} color={c.muted} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

/** A queue row's second line: its state word in its colour (none for Ready), where it lives, and how long ago. */
function QueueMeta({ row, word, now }: { row: SideChat; word: ReturnType<typeof stateWord>; now: number }) {
  const { c, t } = useTheme();
  const at = row.phase === "needs" ? row.askedAt : row.snoozedUntil !== null ? row.since : row.at;
  return (
    <Text numberOfLines={1} style={[t.meta, { color: c.subtle }]}>
      {word ? <Text style={{ color: word.tone === "needs" ? c.warning : c.muted, fontWeight: weight.medium }}>{word.word}</Text> : null}
      {word ? " · " : ""}
      {row.repo} · {rowAge(at, now)}
    </Text>
  );
}

// ---------------------------------------------------------------- a parent's subagents

/**
 * A parent's subagents, stepped in under its title ("no weird square around it, just an indent
 * and a chevron toggle"), with "Load more" on the same step past the cut-off.
 */
export function Agents({ children, hidden, all, onMore, what = kidsWord(2, "subagent") }: { children: ReactNode; hidden: number; all: boolean; onMore: () => void; /** What they are, for VoiceOver's Load more. */ what?: string }) {
  return (
    <Thread>
      {children}
      {hidden > 0 || all ? <MoreRow label={all ? "Show fewer" : "Load more"} onPress={onMore} indent={SUB_X - EDGE} spoken={all ? `Show fewer ${what}` : `Load ${hidden} more ${what}`} /> : null}
    </Thread>
  );
}

/**
 * The thread: the desktop folder's
 * rule, a hairline from under the parent's mark down to the last row's middle, the rows on it stepped in beside it.
 */
function Thread({ children }: { children: ReactNode }) {
  const { c } = useTheme();
  return (
    <View style={{ paddingBottom: 2 }}>
      <View pointerEvents="none" style={{ position: "absolute", left: THREAD_X, top: 0, bottom: ROW / 2 + 2, width: 1, borderRadius: 0.5, backgroundColor: alpha(c.sidebarInk, 0.3) }} />
      {children}
    </View>
  );
}

// ---------------------------------------------------------------- Load more

/** the compact layout: the rest of a list past its cut-off, or back to it. */
export function MoreRow({ label, onPress, indent = 0, spoken }: { label: string; onPress: () => void; /** Stepped in with a parent's subagents. */ indent?: number; spoken?: string }) {
  const { c, t } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spoken ?? label}
      onPress={() => {
        haptic.tick();
        onPress();
      }}
      hitSlop={{ top: 4, bottom: 4 }}
      style={({ pressed }) => ({ height: 32, flexDirection: "row", alignItems: "center", paddingLeft: SLOT_X + indent, paddingRight: 12, opacity: pressed ? 0.55 : 1 })}
    >
      <View style={{ width: SLOT, alignItems: "center" }}>
        <Icon name="more" size={16} color={c.subtle} />
      </View>
      <Text style={[t.row, { marginLeft: TEXT_X - SLOT_X - SLOT, fontSize: 15, lineHeight: 20, color: c.muted }]}>{label}</Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------- the Chiefs

export interface ChiefLine {
  id: string;
  name: string;
  character: CastCharacter;
  tone: SkinTone;
  needs: number;
  working: number;
  ready: number;
}

/** A Chief's state at the right: the amber count of what its agents ask, else the ring while they work, else Ready's check. */
function ChiefState({ chief }: { chief: ChiefLine }) {
  if (chief.needs) return <Count n={chief.needs} urgent label={`${chief.needs} ${chief.needs === 1 ? "needs" : "need"} you`} />;
  if (chief.working) return <PixelIcon name="state-working" label={`${chief.working} working`} />;
  if (chief.ready) return <PixelIcon name="state-done" label={`${chief.ready} ready`} />;
  return null;
}

/** A Chief: its face, its name, its loudest state, as a place at the top. The Chief in the main panel wears the selected fill. */
export const ChiefRow = memo(function ChiefRow({ chief, here, onPress }: { chief: ChiefLine; here: boolean; onPress: (id: string) => void }) {
  const { c, t } = useTheme();
  const [held, setHeld] = useState(false);
  const state = chief.needs ? `${chief.needs} ${chief.needs === 1 ? "needs" : "need"} you` : chief.working ? `${chief.working} working` : chief.ready ? `${chief.ready} ready` : "";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[chief.name, state].filter(Boolean).join(", ")}
      accessibilityHint={`Opens ${chief.name}`}
      accessibilityState={{ selected: here }}
      onPressIn={() => setHeld(true)}
      onPressOut={() => setHeld(false)}
      onPress={() => {
        haptic.tick();
        onPress(chief.id);
      }}
      hitSlop={{ top: 3, bottom: 3 }}
      style={{ height: PLACE, marginHorizontal: EDGE, flexDirection: "row", alignItems: "center" }}
    >
      <Pill here={here} held={held} />
      <View style={{ position: "absolute", left: SLOT_X - EDGE + SLOT / 2 - 12, width: 24, height: 24, top: (PLACE - 24) / 2 }}>
        <Portrait character={chief.character} tone={chief.tone} size={24} crop="head" ground={here ? c.selected : c.shell} />
      </View>
      {/* A Chief is a place, like Pull requests above it, not a chat: always in ink, at the places' size. */}
      <Text numberOfLines={1} style={[t.row, PLACE_TITLE, { flex: 1, marginLeft: TEXT_X - EDGE, color: c.text }]}>
        {chief.name}
      </Text>
      {/* Its state stands centred on the trailing column, in line with the places' counts and the rows' PR glyphs. */}
      <View style={{ width: (TRAIL_X - EDGE) * 2, alignItems: "center" }}>
        <ChiefState chief={chief} />
      </View>
    </Pressable>
  );
});

// ---------------------------------------------------------------- the top rows

/**
 * A place, not a chat, at the sidebar's top (compact Projects, Plugins, Scheduled): its glyph and its name in ink,
 * and at the trailing column what waits there (the reviews that wait on you in amber, failed runs in grey).
 */
export function PlaceRow({ icon, label, count = 0, urgent = false, spoken, here = false, onPress }: { icon: IconName; label: string; count?: number; urgent?: boolean; spoken?: string; /** It is the place in the main panel. */ here?: boolean; onPress: () => void }) {
  const { c, t } = useTheme();
  const [held, setHeld] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[label, count ? spoken : null].filter(Boolean).join(", ")}
      onPressIn={() => setHeld(true)}
      onPressOut={() => setHeld(false)}
      onPress={() => {
        haptic.tick();
        onPress();
      }}
      hitSlop={{ top: 3, bottom: 3 }}
      style={{ height: PLACE, marginHorizontal: EDGE, flexDirection: "row", alignItems: "center" }}
    >
      <Pill here={here} held={held} />
      <View style={{ position: "absolute", left: SLOT_X - EDGE, width: SLOT, alignItems: "center" }}>
        <Icon name={icon} size={19} color={c.text} />
      </View>
      <Text numberOfLines={1} style={[t.row, PLACE_TITLE, { flex: 1, marginLeft: TEXT_X - EDGE, color: c.text }]}>
        {label}
      </Text>
      <View style={{ width: (TRAIL_X - EDGE) * 2, alignItems: "center" }}>
        <Count n={count} urgent={urgent} />
      </View>
    </Pressable>
  );
}

/** The dropdown past the first Chiefs: "Show 2 more ⌄", and "Show fewer" once open. */
export function ShowMoreChiefs({ hidden, open, onPress }: { hidden: number; open: boolean; onPress: () => void }) {
  // With every Chief already showing, it opens to New Chief alone: "More".
  return (
    <QuietRow
      icon={open ? "chevronUp" : "chevronDown"}
      label={open ? "Show fewer" : hidden ? `Show ${hidden} more` : "More"}
      spoken={open ? "Show fewer" : hidden ? `Show ${hidden} more ${hidden === 1 ? "Chief" : "Chiefs"}, and New Chief` : "More: New Chief"}
      expanded={open}
      onPress={onPress}
    />
  );
}

/** New Chief, quietly under the Chiefs: the + where their faces stand, the words in the description grey. */
export function NewChiefRow({ onPress }: { onPress: () => void }) {
  return <QuietRow icon="add" label="New Chief" onPress={onPress} />;
}

/** A quiet line under the places: a small glyph in the faces' slot and grey words, never louder than a Chief. */
function QuietRow({ icon, label, spoken, expanded, onPress }: { icon: IconName; label: string; spoken?: string; expanded?: boolean; onPress: () => void }) {
  const { c, t } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spoken ?? label}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      onPress={() => {
        haptic.tick();
        onPress();
      }}
      hitSlop={{ top: 4, bottom: 4 }}
      style={({ pressed }) => ({ height: 34, marginHorizontal: EDGE, flexDirection: "row", alignItems: "center", opacity: pressed ? 0.55 : 1 })}
    >
      <View style={{ position: "absolute", left: SLOT_X - EDGE, width: SLOT, alignItems: "center" }}>
        <Icon name={icon} size={15} color={c.subtle} stroke={2} />
      </View>
      <Text style={[t.row, { marginLeft: TEXT_X - EDGE, fontSize: 15, lineHeight: 20, color: c.muted }]}>{label}</Text>
    </Pressable>
  );
}

