// Code as a reviewer reads it on a phone (the desktop's Excerpt.tsx CodeRows, at a thumb's width): coloured by
// review/highlight.ts, the new side's line number on every row that has one (a removed row has no line in the new
// file, so it carries no number rather than an old one among the new), a sign column, added rows on a 10% green wash
// with a 3 pt bar and the words that changed a step deeper, a removed row the same in red. A block that is all added
// (a new file's lines) drops the wash and the signs for one green rule down its side, and its card says "new file":
// a wall of green reads worse than plain code.
//
// Lines wrap by default, so nothing hides past the screen's edge. A wrapped line hangs under its own code: the indent
// is a spacer as wide as its characters, not spaces inside the text, so a continuation never reads as a line of its
// own; and it breaks after a dot, a comma or a bracket rather than inside a name. With Wrap off (the guide's ···) the
// numbers stay put and only the code scrolls sideways, a run at a time, so a note or a thread between runs keeps the
// full width. A long block folds to its first lines with "N more lines". A note sits under the line it explains, on
// the popover's surface with the caveman; a review thread under its line on the card grey with the person's mark.
//
// Holding a line asks what to do with it (ask about it, ask for a change there). A line or a thread the guide sends
// you to unfolds if it must, says where it is so the page can bring it into view, and lights for a moment.
import { createContext, memo, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type HostInstance, Platform, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import { Icon } from "../components/Icon";
import { PixelIcon } from "../components/Pixel";
import { Squish } from "../components/Squish";
import { FileTypeMark } from "../components/transcript/FileTypeMark";
import { ease, haptic } from "../motion";
import { ago, Avatar } from "../screens/pages/parts";
import { ME } from "../screens/pages/review-model";
import { alpha, mono, useTheme } from "../theme";
import { type DiffFile, type DiffLine, intraline, linesOf, type Span } from "./diff";
import { inkOf, languageOf, tokenize } from "./highlight";
import { excerptRows, type PrGuideExcerpt, type PrGuideStop, type PrThread, splitPath } from "./model";
import { Prose } from "./parts";

/** A line of code a reader can act on: its file, its number on the side it lives on, and its text. */
export interface LineAt {
  path: string;
  line: number;
  side: "new" | "old";
  text: string;
}

/** Where the guide sends you: a line, or a thread. `nonce` sends you again to the same place. */
export type Focus = ({ kind: "line"; path: string; line: number; side: "new" | "old" } | { kind: "thread"; id: string }) & { nonce: number };

/** What every block of code reads from the screen it is on. */
export interface CodeSettings {
  /** Lines wrap unless the reader turned it off. */
  wrap: boolean;
  focus: Focus | null;
  /** A focused line or thread found itself, `y` in the window, for the page to scroll it into view. */
  onFound: (y: number) => void;
  /** A line held. */
  onLine?: (at: LineAt) => void;
}

export const CodeContext = createContext<CodeSettings>({ wrap: true, focus: null, onFound: () => {} });

/** Rows shown before a block folds, and how long an excerpt may run before it does. */
const SHOWN = 18;
const FOLD_PAST = 30;
const TAB = "  ";
/** Code grows with Dynamic Type up to this, then wraps more instead of growing on. */
const CODE_MAX = 1.6;
const CODE_SIZE = 12.5;
const LINE = 20;
/** A monospace character's advance, as a share of its size (SF Mono's 0.6 em). */
const ADVANCE = 0.6;

type Note = PrGuideStop["notes"][number];

/** What a thread card needs from the screen: your replies on each thread, the threads you resolved, and the verbs. */
export interface Threads {
  list: readonly PrThread[];
  replies: Readonly<Record<string, readonly { body: string; at: number }[]>>;
  resolved: Readonly<Record<string, boolean>>;
  onReply: (thread: PrThread) => void;
  onResolve: (thread: PrThread, on: boolean) => void;
}

/** Whether a thread is settled, by what you did on this phone over what the host said. */
export const isResolved = (thread: PrThread, resolved: Readonly<Record<string, boolean>>) => resolved[thread.id] ?? thread.resolved;

/** A tint that lights for a moment each time `on` changes to a new number, behind whatever it wraps. */
function Lit({ on, children, radius = 0 }: { on: number; children: ReactNode; radius?: number }) {
  const { c } = useTheme();
  const tint = useSharedValue(0);
  useEffect(() => {
    if (!on) return;
    tint.value = 1;
    tint.value = withDelay(1100, withTiming(0, { duration: 400, easing: ease.fade }));
  }, [on, tint]);
  const style = useAnimatedStyle(() => ({ opacity: tint.value }));
  return (
    <View>
      <Animated.View pointerEvents="none" style={[{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, borderRadius: radius, backgroundColor: alpha(c.target, 0.22) }, style]} />
      {children}
    </View>
  );
}

/** Reports where a view sits in the window once it has laid out, for the page to scroll it into view. */
function useFind(found: boolean, nonce: number) {
  const ref = useRef<HostInstance>(null);
  const { onFound } = useContext(CodeContext);
  useEffect(() => {
    if (!found) return;
    const timer = setTimeout(() => ref.current?.measureInWindow((_x: number, y: number) => onFound(y)), 90);
    return () => clearTimeout(timer);
  }, [found, nonce]); // eslint-disable-line react-hooks/exhaustive-deps -- onFound comes from context, rebuilt each render; measure once per find.
  return ref;
}

/**
 * A review thread under its line (ThreadCard): each comment with its author's mark, login and age, then Reply and
 * Resolve. It is a person talking, not the guide, so it sits on the card grey with an avatar where a note has the
 * caveman. A resolved thread folds to one line that opens it.
 */
function ThreadCard({ thread, threads }: { thread: PrThread; threads: Threads }) {
  const { c, t } = useTheme();
  const { focus } = useContext(CodeContext);
  const replies = threads.replies[thread.id] ?? [];
  const settled = isResolved(thread, threads.resolved);
  const [open, setOpen] = useState(!settled);
  const here = focus?.kind === "thread" && focus.id === thread.id;
  const nonce = here ? focus.nonce : 0;
  const ref = useFind(here, nonce);
  useEffect(() => {
    if (here) setOpen(true);
  }, [here, nonce]);
  const all = [...thread.comments, ...replies.map((r) => ({ author: ME, body: r.body, at: r.at }))];
  const first = all[0];
  return (
    <View ref={ref} collapsable={false} style={{ marginHorizontal: 12, marginVertical: 8 }}>
      <Lit on={nonce} radius={12}>
        <View style={{ borderRadius: 12, backgroundColor: c.card, borderWidth: 1, borderColor: c.edge, overflow: "hidden" }}>
          <Squish label={`${all.length} ${all.length === 1 ? "comment" : "comments"}${settled ? ", resolved" : ""}. ${open ? "Fold" : "Open"}`} depth={0.99} onPress={() => setOpen(!open)} style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36, paddingHorizontal: 12, paddingTop: 4 }}>
            <Icon name={settled ? "check" : "comment"} size={13} color={settled ? c.success : c.subtle} />
            <Text numberOfLines={1} style={[t.meta, { fontSize: 12, flex: 1 }]}>
              {settled ? "Resolved" : `${all.length} ${all.length === 1 ? "comment" : "comments"}`}
              {!open && first ? ` · ${first.author === ME ? "You" : first.author}: ${first.body.replace(/`/g, "")}` : ""}
            </Text>
            <Icon name={open ? "chevronUp" : "chevronDown"} size={13} color={c.subtle} />
          </Squish>
          {open
            ? all.map((m, i) => (
                <View key={i} style={{ flexDirection: "row", gap: 10, paddingHorizontal: 12, paddingTop: i ? 10 : 2 }}>
                  <Avatar login={m.author} size={20} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={t.small}>
                      <Text style={{ color: c.text, fontWeight: "500" }}>{m.author === ME ? "You" : m.author}</Text> · {ago(m.at)}
                    </Text>
                    <Prose text={m.body} style={[t.body, { fontSize: 14, lineHeight: 20, color: c.soft }]} />
                  </View>
                </View>
              ))
            : null}
          {open ? (
            <View style={{ flexDirection: "row", marginTop: 8, borderTopWidth: 1, borderTopColor: c.hairline }}>
              <Squish label="Reply on this thread" depth={0.98} onPress={() => threads.onReply(thread)} style={{ flex: 1, height: 44, paddingHorizontal: 12, justifyContent: "center" }}>
                <Text style={[t.small, { color: c.text }]}>Reply</Text>
              </Squish>
              <Squish
                label={settled ? "Open this thread again" : "Resolve this thread"}
                depth={0.98}
                onPress={() => {
                  haptic.tick();
                  threads.onResolve(thread, !settled);
                  if (!settled) setOpen(false);
                }}
                style={{ height: 44, paddingHorizontal: 14, justifyContent: "center" }}
              >
                <Text style={[t.small, { color: c.muted }]}>{settled ? "Unresolve" : "Resolve"}</Text>
              </Squish>
            </View>
          ) : null}
        </View>
      </Lit>
    </View>
  );
}

const SIGN = { add: "+", del: "−", ctx: " ", hunk: " " } as const;

/** Where a wrapped line may break besides its spaces: before a member after a dot, after a comma or an opening bracket. */
const BREAKS = /[,([{](?=[^\s)\]},;])|\.(?=[A-Za-z_$])/g;
/** The places in a whole line where a break may go, read once across its coloured parts: after each of these characters. */
function breaksOf(line: string): ReadonlySet<number> {
  const at = new Set<number>();
  for (const m of line.matchAll(BREAKS)) at.add(m.index);
  return at;
}
const ZWSP = String.fromCharCode(0x200b);

/** On the web a word with no break in it still breaks rather than push its row past the card; never mid-name otherwise. */
const WRAPPED = { flex: 1, minWidth: 0, ...(Platform.OS === "web" ? ({ overflowWrap: "break-word", wordBreak: "normal" } as object) : null) };

/** One row's text, coloured, with the changed words marked; `from` drops the indent the row's spacer already draws. */
function RowText({ text, language, marks, kind, from, wrap }: { text: string; language: ReturnType<typeof languageOf>; marks?: readonly Span[]; kind: DiffLine["kind"]; from: number; wrap: boolean }) {
  const { c, dark } = useTheme();
  const tabbed = text.replace(/\t/g, TAB);
  // A tab widens the text, so marks (read off the raw line) shift by what each tab before them added.
  const shift = (at: number) => at + (text.slice(0, at).match(/\t/g)?.length ?? 0) * (TAB.length - 1);
  const spans = (marks ?? []).map(([a, b]) => [shift(a), shift(b)] as const);
  const wash = kind === "add" ? alpha(c.added, dark ? 0.26 : 0.22) : alpha(c.removed, dark ? 0.26 : 0.22);
  const parts: { text: string; color: string; marked: boolean; from: number }[] = [];
  let at = 0;
  for (const token of tokenize(tabbed, language)) {
    // What's gone reads in grey, its changed words marked: a green string on a red row would say "added" in the
    // middle of a removal.
    const color = kind === "del" ? (token.kind === "comment" || token.kind === "punct" ? c.subtle : c.muted) : inkOf(token.kind, c, dark);
    let i = 0;
    while (i < token.text.length) {
      const here = at + i;
      const inside = spans.find(([a, b]) => here >= a && here < b);
      const stop = inside ? Math.min(inside[1], at + token.text.length) : Math.min(...spans.map(([a]) => a).filter((a) => a > here), at + token.text.length);
      parts.push({ text: token.text.slice(i, stop - at), color, marked: !!inside, from: here });
      i = stop - at;
    }
    at += token.text.length;
  }
  // The indent the spacer draws comes off the front, part by part.
  let skip = from;
  const shown = parts
    .map((p) => {
      if (skip <= 0) return p;
      const cut = Math.min(skip, p.text.length);
      skip -= cut;
      return { ...p, text: p.text.slice(cut), from: p.from + cut };
    })
    .filter((p) => p.text.length);
  const breaks = wrap ? breaksOf(tabbed) : null;
  const withBreaks = (p: { text: string; from: number }) => {
    if (!breaks?.size) return p.text;
    let out = "";
    for (let k = 0; k < p.text.length; k++) out += breaks.has(p.from + k) ? p.text[k] + ZWSP : p.text[k];
    return out;
  };
  return (
    <>
      {shown.map((p, i) => (
        <Text key={i} style={{ color: p.marked && kind === "del" ? c.soft : p.color, backgroundColor: p.marked ? wash : undefined }}>
          {withBreaks(p)}
        </Text>
      ))}
      {shown.length === 0 ? " " : null}
    </>
  );
}

/** A note under its line: the caveman, what it is, and why, on the popover's surface. */
function NoteCallout({ note }: { note: Note }) {
  const { c, t } = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: 10, marginLeft: 12, marginRight: 12, marginVertical: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, backgroundColor: c.popover, borderWidth: 1, borderColor: c.edge }}>
      <View style={{ paddingTop: 2 }}>
        <PixelIcon name="engine-caveman" size={16} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[t.label, { fontSize: 14, lineHeight: 19, fontWeight: "600" }]}>{note.title}</Text>
        {note.body ? <Prose text={note.body} style={[t.body, { fontSize: 14, lineHeight: 20, color: c.muted }]} /> : null}
      </View>
    </View>
  );
}

/** The size code is drawn at, and its character's width: the system's text size up to CODE_MAX (the web draws at 1). */
function useCodeScale() {
  const { fontScale } = useWindowDimensions();
  const k = Platform.OS === "web" ? 1 : Math.min(fontScale, CODE_MAX);
  return { k, char: CODE_SIZE * ADVANCE * k };
}

interface RowView {
  row: DiffLine;
  index: number;
  /** Its number on the side it lives on: the new file's, or for a removed row the old file's (never drawn). */
  n: number | null;
  notes: readonly Note[];
  talk: readonly PrThread[];
}

/** Diff rows, numbered, coloured, wrapped or not, folded when long, with their notes and threads. */
export const CodeRows = memo(function CodeRows({ rows, path, notes, threads, foldPast = FOLD_PAST }: { rows: readonly DiffLine[]; path: string; notes?: readonly Note[]; /** Review threads, under the lines they are on. */ threads?: Threads; /** How many rows a block may run before it folds; 0 never folds it. */ foldPast?: number }) {
  const { c, t } = useTheme();
  const { wrap, focus, onLine } = useContext(CodeContext);
  const { k, char } = useCodeScale();
  const [open, setOpen] = useState(false);
  const language = languageOf(path);
  const marks = useMemo(() => intraline(rows), [rows]);
  const only = rows.length > 0 && rows.every((r) => r.kind === rows[0]!.kind) && rows[0]!.kind !== "ctx" ? rows[0]!.kind : null;
  const fold = foldPast > 0 && rows.length > foldPast;
  // An excerpt keeps its first lines; a whole file keeps two thirds of what it may run before it folds.
  const keepRows = foldPast > FOLD_PAST ? Math.round((foldPast * 2) / 3) : SHOWN;
  // The line the guide sends you to, if it is in this block: the block opens past its fold to show it.
  const target = focus?.kind === "line" && focus.path === path ? rows.findIndex((r) => r.kind !== "hunk" && (focus.side === "new" ? r.newNo : r.oldNo) === focus.line) : -1;
  const nonce = target >= 0 ? (focus?.nonce ?? 0) : 0;
  useEffect(() => {
    if (target >= keepRows && fold) setOpen(true);
  }, [target, nonce, keepRows, fold]);
  const folds = fold && !open;
  const shown = folds ? rows.slice(0, keepRows) : rows;
  const targetRef = useFind(target >= 0 && (!folds || target < keepRows), nonce);
  const digits = Math.max(2, String(Math.max(...rows.map((r) => r.newNo ?? 0))).length);
  const numberWidth = Math.ceil(digits * 11.5 * ADVANCE * k + 12);
  const signWidth = only ? 6 : Math.ceil(14 * k);
  const bar = (kind: DiffLine["kind"]) => (kind === "add" ? alpha(c.added, 0.55) : kind === "del" ? alpha(c.removed, 0.55) : "transparent");
  const tintOf = (kind: DiffLine["kind"]) => (only ? undefined : kind === "add" ? alpha(c.added, 0.1) : kind === "del" ? alpha(c.removed, 0.1) : undefined);

  const views: RowView[] = shown.map((row, index) => {
    const n = row.kind === "del" ? row.oldNo : row.newNo;
    const here = row.kind === "del" || !notes ? [] : notes.filter((note) => note.path === path && note.line === row.newNo);
    const talk = !threads ? [] : threads.list.filter((th) => th.path === path && (th.side === "new" ? row.kind !== "del" && th.line === row.newNo : row.kind !== "add" && th.line === row.oldNo));
    return { row, index, n, notes: here, talk };
  });

  const said = (v: RowView) => `${v.row.kind === "add" ? "Added" : v.row.kind === "del" ? "Removed" : "Line"}${v.row.kind === "del" ? "" : ` ${v.n ?? ""}`}: ${v.row.text.trim()}${v.notes.length ? ", with a note" : ""}`;
  const hold = (v: RowView) =>
    onLine && v.n !== null
      ? () => {
          haptic.thud();
          onLine({ path, line: v.n!, side: v.row.kind === "del" ? "old" : "new", text: v.row.text });
        }
      : undefined;
  const blank = (v: RowView) => !v.row.text.trim();
  const gutter = (v: RowView) => (
    <>
      <Text maxFontSizeMultiplier={CODE_MAX} style={{ width: numberWidth, paddingRight: 8, textAlign: "right", fontFamily: mono, fontSize: 11.5, lineHeight: LINE, color: v.notes.length ? c.text : c.subtle, fontWeight: v.notes.length ? "600" : "400", fontVariant: ["tabular-nums"] }}>
        {v.row.kind === "del" ? "" : v.n}
      </Text>
      {only ? (
        <View style={{ width: signWidth }} />
      ) : (
        <Text maxFontSizeMultiplier={CODE_MAX} style={{ width: signWidth, fontFamily: mono, fontSize: CODE_SIZE, lineHeight: LINE, color: v.row.kind === "add" ? c.added : c.removed }}>
          {SIGN[v.row.kind]}
        </Text>
      )}
    </>
  );
  const codeStyle = { fontFamily: mono, fontSize: CODE_SIZE, lineHeight: LINE, opacity: only === "del" ? 0.7 : 1 } as const;
  const lit = (v: RowView) => (v.index === target ? nonce : 0);
  const extras = (v: RowView) => (
    <>
      {v.notes.map((note, i) => (
        <NoteCallout key={i} note={note} />
      ))}
      {threads ? v.talk.map((th) => <ThreadCard key={th.id} thread={th} threads={threads} />) : null}
    </>
  );
  const a11y = (v: RowView) => ({
    accessible: !blank(v),
    accessibilityElementsHidden: blank(v),
    importantForAccessibility: blank(v) ? ("no-hide-descendants" as const) : ("yes" as const),
    accessibilityLabel: said(v),
    accessibilityHint: onLine ? "Hold to ask about this line" : undefined,
    onLongPress: hold(v),
    delayLongPress: 380,
  });

  /** A row's indent in characters, drawn as a spacer (a blank row has none). */
  const indentOf = (v: RowView) => {
    const tabbed = v.row.text.replace(/\t/g, TAB);
    return tabbed.trim() ? tabbed.length - tabbed.trimStart().length : 0;
  };

  let body: ReactNode;
  if (wrap) {
    body = (
      <View style={{ paddingVertical: 6 }}>
        {views.map((v) => {
          const indent = indentOf(v);
          return (
            <View key={v.index} ref={v.index === target ? targetRef : undefined} collapsable={false}>
              <Lit on={lit(v)}>
                <Pressable {...a11y(v)} style={{ flexDirection: "row", backgroundColor: tintOf(v.row.kind), borderLeftWidth: 3, borderLeftColor: only ? "transparent" : bar(v.row.kind) }}>
                  {gutter(v)}
                  {indent ? <View style={{ width: indent * char }} /> : null}
                  <Text selectable maxFontSizeMultiplier={CODE_MAX} style={[codeStyle, { paddingRight: 12 }, WRAPPED]}>
                    <RowText text={v.row.text} language={language} marks={marks.get(v.index)} kind={v.row.kind} from={indent} wrap />
                  </Text>
                </Pressable>
              </Lit>
              {extras(v)}
            </View>
          );
        })}
      </View>
    );
  } else {
    // Runs of rows between the notes and threads: the numbers stand still and only each run's code scrolls.
    const runs: RowView[][] = [[]];
    views.forEach((v) => {
      runs[runs.length - 1]!.push(v);
      if (v.notes.length || v.talk.length) runs.push([]);
    });
    body = (
      <View style={{ paddingVertical: 6 }}>
        {runs.map((run, r) => {
          const last = run[run.length - 1];
          if (!last) return null;
          return (
            <View key={r}>
              <View style={{ flexDirection: "row" }}>
                <View>
                  {run.map((v) => (
                    <View key={v.index} ref={v.index === target ? targetRef : undefined} collapsable={false} style={{ flexDirection: "row", height: LINE * k, backgroundColor: tintOf(v.row.kind), borderLeftWidth: 3, borderLeftColor: only ? "transparent" : bar(v.row.kind) }}>
                      {gutter(v)}
                    </View>
                  ))}
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ flexGrow: 1 }} style={{ flex: 1 }}>
                  <View style={{ flexGrow: 1 }}>
                    {run.map((v) => (
                      <Lit key={v.index} on={lit(v)}>
                        <Pressable {...a11y(v)} style={{ flexDirection: "row", height: LINE * k, paddingRight: 24, backgroundColor: tintOf(v.row.kind) }}>
                          {indentOf(v) ? <View style={{ width: indentOf(v) * char }} /> : null}
                          <Text selectable numberOfLines={1} maxFontSizeMultiplier={CODE_MAX} style={codeStyle}>
                            <RowText text={v.row.text} language={language} marks={marks.get(v.index)} kind={v.row.kind} from={indentOf(v)} wrap={false} />
                          </Text>
                        </Pressable>
                      </Lit>
                    ))}
                  </View>
                </ScrollView>
              </View>
              {extras(last)}
            </View>
          );
        })}
      </View>
    );
  }

  return (
    <View style={{ borderLeftWidth: only ? 3 : 0, borderLeftColor: only ? bar(only) : undefined }}>
      {body}
      {fold ? (
        <Squish
          label={open ? "Show less" : `Show ${rows.length - keepRows} more lines`}
          depth={0.99}
          onPress={() => {
            haptic.tick();
            setOpen(!open);
          }}
          style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 44, paddingHorizontal: 14, borderTopWidth: 1, borderTopColor: alpha(c.text, 0.07) }}
        >
          <Icon name={open ? "chevronUp" : "chevronDown"} size={14} color={c.muted} />
          <Text style={[t.small, { color: c.muted }]}>{open ? "Show less" : `${rows.length - keepRows} more lines`}</Text>
        </Squish>
      ) : null}
    </View>
  );
});

/** The card code sits in: ink at 3% inside a 10% edge, rounded 12 (CodeBlock's shell). */
export function CodeCard({ children }: { children: ReactNode }) {
  const { c } = useTheme();
  return <View style={{ borderRadius: 12, borderWidth: 1, borderColor: alpha(c.text, 0.1), backgroundColor: alpha(c.text, 0.03), overflow: "hidden" }}>{children}</View>;
}

/**
 * One excerpt of a stop (ExcerptView): its file's mark and name, the folder in grey ("new file" for one), "L42 ›" that
 * opens Files on that line, the caption under them, then the lines. VoiceOver hears the card's head as one summary
 * ("apns.ts, lines 51 to 63, 3 added, 2 notes"), then reads into its lines.
 */
export function Excerpt({ excerpt, file, notes, threads, onOpenFile }: { excerpt: PrGuideExcerpt; file: DiffFile | undefined; notes: readonly Note[]; threads?: Threads; onOpenFile: (path: string, line?: number, side?: "new" | "old") => void }) {
  const { c, t } = useTheme();
  const rows = useMemo(() => (file ? excerptRows(linesOf(file), excerpt.side, excerpt.start, excerpt.end) : []), [file, excerpt]);
  const { dir, name } = splitPath(excerpt.path);
  const adds = rows.filter((r) => r.kind === "add").length;
  const dels = rows.filter((r) => r.kind === "del").length;
  const noted = notes.filter((n) => n.path === excerpt.path && n.line >= excerpt.start && n.line <= excerpt.end).length;
  const isNew = file?.status === "added";
  const summary = `${name}, lines ${excerpt.start} to ${excerpt.end}${isNew ? ", a new file" : ""}${adds ? `, ${adds} added` : ""}${dels ? `, ${dels} removed` : ""}${noted ? `, ${noted} ${noted === 1 ? "note" : "notes"}` : ""}. ${excerpt.caption}`;
  return (
    <CodeCard>
      <View style={{ paddingLeft: 12, paddingTop: 4, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: alpha(c.text, 0.07) }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 40 }}>
          <View accessible accessibilityLabel={summary} style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 }}>
            <FileTypeMark path={excerpt.path} size={14} />
            <Text numberOfLines={1} style={{ flexShrink: 0, maxWidth: "62%", fontFamily: mono, fontSize: 13, color: c.text }}>
              {name}
            </Text>
            <Text numberOfLines={1} ellipsizeMode="head" style={{ flex: 1, fontFamily: mono, fontSize: 11.5, color: isNew ? c.added : c.subtle }}>
              {isNew ? "new file" : dir.replace(/\/$/, "")}
            </Text>
          </View>
          <Squish label={`Open ${excerpt.path} at line ${excerpt.start} in Files`} depth={0.92} hitSlop={2} onPress={() => onOpenFile(excerpt.path, excerpt.start, excerpt.side)} style={{ height: 40, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 3 }}>
            <Text style={{ fontFamily: mono, fontSize: 12, color: c.muted, fontVariant: ["tabular-nums"] }}>L{excerpt.start}</Text>
            <Icon name="chevronRight" size={12} color={c.subtle} />
          </Squish>
        </View>
        {excerpt.caption ? (
          <Text style={[t.small, { paddingRight: 12, marginTop: -4 }]}>
            {excerpt.caption}
            {excerpt.side === "old" ? " · removed lines" : ""}
          </Text>
        ) : null}
      </View>
      {rows.length ? <CodeRows rows={rows} path={excerpt.path} notes={notes} threads={threads} /> : <Text style={[t.small, { padding: 14 }]}>The change moved since the guide was written, so these lines aren't in it now. Files has the code as it is.</Text>}
    </CodeCard>
  );
}
