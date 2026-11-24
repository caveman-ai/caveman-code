// The guide's small pieces, as the desktop draws them (apps/web/src/routes/review/parts.tsx and Guide.tsx) at a
// phone's measure: guide prose with its `code` in mono chips, the before/after/why lines with their labels in a mono
// column, the "+12 −3" of a change, the reviewer's call on its amber wash (a call is the one thing a guide asks of
// you, so it is the one amber thing on the page), the stop's Mark read, and a stop's own files.
import { useRef } from "react";
import { Text, type TextStyle, View } from "react-native";
import { Icon } from "../components/Icon";
import { PixelIcon, StateMark } from "../components/Pixel";
import { Squish } from "../components/Squish";
import { FileTypeMark } from "../components/transcript/FileTypeMark";
import { haptic } from "../motion";
import { alpha, mono, useFontScale, useTheme } from "../theme";
import type { DiffFile } from "./diff";
import { CALL_WORD, guideLinesOf, type PrGuideAttention, proseRuns, splitPath } from "./model";

/** Guide prose: its `code` as mono chips on the control fill, the rest in the style it is given. */
export function Prose({ text, style, lines }: { text: string; style: TextStyle | TextStyle[]; lines?: number }) {
  const { c } = useTheme();
  const flat = (Array.isArray(style) ? Object.assign({}, ...style) : style) as TextStyle;
  const size = (flat.fontSize ?? 16) - 2;
  return (
    <Text style={style} numberOfLines={lines}>
      {proseRuns(text).map((run, i) =>
        run.code ? (
          // A narrow no-break space at each end stands in for the chip's padding (Markdown.tsx's inline code).
          <Text key={i} style={{ fontFamily: mono, fontSize: size, color: c.text, backgroundColor: c.control }}>
            {" "}
            {run.text}
            {" "}
          </Text>
        ) : (
          run.text
        ),
      )}
    </Text>
  );
}

/**
 * A guide's lines in its format (GuideLines): `before:` in grey, `after:` in ink, `why:` in the prose grey, each with
 * its label in a quiet mono column, so the eye runs down the column and reads the change as three steps. At the
 * largest text sizes the column would break its labels ("bef/ore"), so each label stands over its line instead.
 */
export function GuideLines({ text, size = 16, skip }: { text: string; size?: number; /** A label to leave out (the overview's `what:` when the TL;DR says it). */ skip?: string }) {
  const { c, t } = useTheme();
  const stacked = useFontScale() > 1.35;
  const tone: Record<string, string> = { before: c.muted, after: c.text, why: c.prose, what: c.text, checked: c.prose };
  const line = Math.round(size * 1.5);
  return (
    <View style={{ gap: 8 }}>
      {guideLinesOf(text).filter((l) => !skip || l.label !== skip).map((l, i) =>
        l.label ? (
          <View key={i} style={{ flexDirection: stacked ? "column" : "row", gap: stacked ? 0 : 10 }}>
            <Text style={{ width: stacked ? undefined : 54, fontFamily: mono, fontSize: 12, lineHeight: stacked ? 18 : line, color: c.subtle }}>{l.label}</Text>
            <View style={{ flex: 1 }}>
              <Prose text={l.text} style={[t.body, { fontSize: size, lineHeight: line, color: tone[l.label] ?? c.prose }]} />
            </View>
          </View>
        ) : (
          <Prose key={i} text={l.text} style={[t.body, { fontSize: size, lineHeight: line, color: c.prose }]} />
        ),
      )}
    </View>
  );
}

/** Lines added and removed in the diff inks, a true minus, a zero saying nothing; K past a thousand. */
export function Counts({ add, del, size = 13 }: { add: number; del: number; size?: number }) {
  const { c } = useTheme();
  const short = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K` : String(n));
  if (!add && !del) return null;
  return (
    <Text style={{ fontSize: size, lineHeight: Math.round(size * 1.4), fontWeight: "500", fontVariant: ["tabular-nums"] }}>
      {add ? <Text style={{ color: c.added }}>+{short(add)}</Text> : null}
      {add && del ? " " : null}
      {del ? <Text style={{ color: c.removed }}>−{short(del)}</Text> : null}
    </Text>
  );
}

/**
 * The one call the reviewer should make here (CallBox): what kind of judgment, then the note, on an amber wash; and
 * "Push back on this", which opens Request changes with the call already said, so disagreeing is two taps.
 */
export function CallBox({ attention, onPushBack }: { attention: PrGuideAttention; onPushBack?: () => void }) {
  const { c, t, dark } = useTheme();
  return (
    <View style={{ borderRadius: 12, backgroundColor: alpha(c.warning, dark ? 0.1 : 0.08), overflow: "hidden" }}>
      <View accessible accessibilityLabel={`Your call, ${CALL_WORD[attention.kind]}: ${attention.note.replace(/`/g, "")}`} style={{ flexDirection: "row", gap: 12, paddingHorizontal: 14, paddingTop: 12, paddingBottom: onPushBack ? 4 : 12 }}>
        <View style={{ paddingTop: 3 }}>
          <PixelIcon name="state-needs-input" />
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={[t.label, { fontSize: 15, lineHeight: 20, fontWeight: "600" }]}>
            Your call <Text style={{ fontWeight: "400", color: c.muted }}>· {CALL_WORD[attention.kind]}</Text>
          </Text>
          <Prose text={attention.note} style={[t.body, { fontSize: 15, lineHeight: 22, color: c.soft }]} />
        </View>
      </View>
      {onPushBack ? (
        <Squish label={`Push back on this ${CALL_WORD[attention.kind].toLowerCase()}`} depth={0.97} onPress={onPushBack} style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 44, marginLeft: 42, paddingRight: 14 }}>
          <Text style={[t.small, { color: c.text, fontWeight: "500" }]}>Push back on this</Text>
          <Icon name="chevronRight" size={12} color={c.muted} />
        </Squish>
      ) : null}
    </View>
  );
}

/** A call's kind in a word, in amber: the one thing a chapter asks of you, said where the chapter is listed. */
export function CallWord({ kind, size = 12 }: { kind: PrGuideAttention["kind"]; size?: number }) {
  const { c } = useTheme();
  return (
    <Text numberOfLines={1} style={{ fontSize: size, lineHeight: Math.round(size * 1.4), fontWeight: "500", color: c.warning }}>
      {CALL_WORD[kind]}
    </Text>
  );
}

/** A pixel box that fills with the done tick: still when it was read before, drawn once when it is ticked now. */
export function ReadCheck({ read, size = 16 }: { read: boolean; size?: number }) {
  const { c } = useTheme();
  // Only a tick made while it shows plays; one already there on arrival rests.
  const was = useRef(read);
  const live = read && !was.current;
  if (!read) was.current = false;
  if (read) return live ? <StateMark key="live" name="state-done" size={size} /> : <PixelIcon name="state-done" size={size} />;
  return <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}><View style={{ width: size - 4, height: size - 4, borderWidth: 2, borderColor: c.subtle }} /></View>;
}

/**
 * The end of a stop (ReadButton): one 48 pt target that marks it read, its check drawing itself, and moves on to the
 * next. Pressed again it takes the mark back.
 */
export function ReadButton({ read, last, onToggle }: { read: boolean; last: boolean; onToggle: () => void }) {
  const { c, t } = useTheme();
  return (
    <Squish
      label={read ? "Read. Tap to take it back" : "Mark read"}
      selected={read}
      depth={0.98}
      onPress={() => {
        if (read) haptic.tick();
        else haptic.done();
        onToggle();
      }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        height: 56,
        paddingHorizontal: 16,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: read ? alpha(c.success, 0.35) : c.hairline,
        backgroundColor: read ? alpha(c.success, 0.08) : alpha(c.text, 0.03),
      }}
    >
      <ReadCheck read={read} size={18} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[t.label, { fontSize: 16, lineHeight: 20, fontWeight: "600", color: read ? c.success : c.text }]}>{read ? "Read" : "Mark read"}</Text>
        <Text numberOfLines={1} style={[t.small, { lineHeight: 17 }]}>
          {read ? "Tap to take it back" : last ? "Last chapter" : "Then on to the next chapter"}
        </Text>
      </View>
    </Squish>
  );
}

/** A file as a row of the guide (FileList): its type's mark, its name in mono, its note or folder, its counts. */
export function FileRow({ path, note, file, onPress, viewed = false }: { path: string; note?: string; file?: DiffFile | { additions: number; deletions: number }; onPress?: () => void; viewed?: boolean }) {
  const { c, t } = useTheme();
  const { dir, name } = splitPath(path);
  const body = (
    <>
      <FileTypeMark path={path} size={15} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text numberOfLines={1} style={{ fontFamily: mono, fontSize: 14, lineHeight: 19, color: viewed ? c.muted : c.text, textDecorationLine: viewed ? "line-through" : "none" }}>
          {name}
        </Text>
        {note || dir ? (
          <Text numberOfLines={1} ellipsizeMode={note ? "tail" : "head"} style={note ? [t.small, { lineHeight: 17 }] : { fontFamily: mono, fontSize: 12, lineHeight: 17, color: c.subtle }}>
            {note ?? dir.replace(/\/$/, "")}
          </Text>
        ) : null}
      </View>
      {file ? <Counts add={file.additions} del={file.deletions} /> : null}
      {onPress ? <Icon name="chevronRight" size={14} color={c.subtle} /> : null}
    </>
  );
  const style = { flexDirection: "row" as const, alignItems: "center" as const, gap: 10, minHeight: 52, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 10 };
  return onPress ? (
    <Squish label={`${path}${note ? `, ${note}` : ""}. Open in Files`} depth={0.99} highlight onPress={onPress} style={style}>
      {body}
    </Squish>
  ) : (
    <View style={style}>{body}</View>
  );
}

/** A quiet head over a part of the guide ("What changes", "Skim"), at the section tier. */
export function Head({ label, right }: { label: string; right?: React.ReactNode }) {
  const { t } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", minHeight: 24 }}>
      <Text accessibilityRole="header" style={[t.heading, { flex: 1 }]}>
        {label}
      </Text>
      {right}
    </View>
  );
}
