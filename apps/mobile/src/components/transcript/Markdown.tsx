// An answer's markdown, set as the desktop's Response sets it (packages/ui/src/ai/response.tsx) at the phone's measure
// (DECISIONS.md "Type"): prose at 16 on 25 in the prose grey, so bold (600) and headings in full ink stand out; 12
// between paragraphs, 6 between list items; list markers in the tertiary grey; task lists with ink checkboxes; quotes
// on a faint rule; tables in the code block's tinted shell; fences as code blocks; inline code in mono 14 on the
// control fill; links underlined. A chat named in it ([[chat-id]]) is the desktop's thread pill: the blue ink inside
// the target's tint, led by the chat's engine mark, opening the chat.
//
// While an answer streams it has no caret: each new word fades in from when it was let out (thread/pace.ts). The answer
// is set in chunks at its blank lines, and every chunk but the last is settled and kept (memo), so a long answer
// re-sets only the paragraph that is still arriving.
import { createContext, Fragment, memo, type ReactNode, useContext, useRef, useState } from "react";
import { Linking, ScrollView, Text, type TextStyle, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useReducedMotion } from "../../motion";
import { alpha, mono, rhythm, useTheme } from "../../theme";
import { Icon } from "../Icon";
import { WorkLink } from "../ui/WorkLink";
import { CodeBlock } from "./CodeBlock";
import { type Block, type Inline, parse } from "./markdown-parse";

/** What a [[chat-id]] names: its title and engine, and how to open it. Without a provider, the id shows as words. */
export interface ThreadRefs {
  resolve: (id: string) => { title: string; engine: string } | null;
  open: (id: string) => void;
}
export const ThreadRefContext = createContext<ThreadRefs | null>(null);

/**
 * A chat named in running text: the desktop's thread pill (styles.css .thread-pill), its engine's mark first. It is the
 * one pill the Chief's chat draws too (components/ui/WorkLink.tsx), standing in the line as a word does.
 */
export function ThreadPill({ title, engine, onPress, size = 16, inline = true }: { title: string; engine: string; onPress?: () => void; size?: number; inline?: boolean }) {
  return <WorkLink chat={{ id: title, title, engine }} onOpen={() => onPress?.()} inline={inline} size={size} />;
}

/**
 * Inline runs with their marks. `fade` is where the words still fading begin among this chunk's words, and the ink of
 * each, oldest first.
 */
function Runs({ runs, base, fade, seen }: { runs: Inline[]; base: TextStyle; fade: { from: number; inks: readonly number[] } | null; seen: { n: number } }) {
  const { c } = useTheme();
  const refs = useContext(ThreadRefContext);
  const ink = (base.color as string) ?? c.prose;
  const faded = (text: string, style: TextStyle | null, key: string): ReactNode => {
    if (!fade) return style ? <Text key={key} style={style}>{text}</Text> : text;
    const words = text.split(/(\s+)/);
    return (
      <Fragment key={key}>
        {words.map((w, j) => {
          if (!w.trim()) return w;
          const index = seen.n++;
          if (index < fade.from) return style ? <Text key={j} style={style}>{w}</Text> : w;
          // Each word on its own clock, from nothing to full ink over 150ms.
          const a = fade.inks[index - fade.from] ?? 1;
          return (
            <Text key={j} style={[style, { color: alpha((style?.color as string) ?? ink, Math.max(0, Math.min(1, a))) }]}>
              {w}
            </Text>
          );
        })}
      </Fragment>
    );
  };
  return (
    <>
      {runs.map((run, i) => {
        const key = String(i);
        switch (run.kind) {
          case "bold":
            return faded(run.text, { fontWeight: "600", color: c.text }, key);
          case "italic":
            return faded(run.text, { fontStyle: "italic" }, key);
          case "code": {
            // React Native can't pad an inline span, so a narrow space in the prose's face (a mono one is a whole
            // cell wide) sits inside the fill at each end and stands in for its padding. The pad is a narrow no-break
            // space (U+202F), which binds to the code beside it but still lets the line break on the prose's own space
            // before it, so a line never ends on an empty grey pad with the code gone on to the next.
            const chip: TextStyle = { fontFamily: mono, fontSize: (base.fontSize ?? 16) - 2, color: c.text, backgroundColor: c.control };
            const pad = <Text style={{ fontFamily: base.fontFamily, fontSize: 14 }}>{"\u202f"}</Text>;
            return (
              <Text key={key} style={chip}>
                {pad}
                {faded(run.text, null, "c")}
                {pad}
              </Text>
            );
          }
          case "ref": {
            seen.n++;
            const named = refs?.resolve(run.text);
            if (!named) return <Text key={key}>{run.text}</Text>;
            return <ThreadPill key={key} title={named.title} engine={named.engine} onPress={() => refs?.open(run.text)} size={(base.fontSize ?? 16) as number} />;
          }
          case "link":
            return (
              <Text
                key={key}
                accessibilityRole="link"
                onPress={run.href && /^https?:\/\//.test(run.href) ? () => void Linking.openURL(run.href!) : undefined}
                style={{ color: c.text, textDecorationLine: "underline", textDecorationColor: alpha(c.muted, 0.5) }}
              >
                {faded(run.text, null, "l")}
              </Text>
            );
          default:
            return faded(run.text, null, key);
        }
      })}
    </>
  );
}

const countWords = (runs: Inline[]) => runs.reduce((n, r) => n + (r.kind === "ref" ? 1 : r.text.split(/\s+/).filter(Boolean).length), 0);

const HEADING: Record<number, TextStyle> = {
  1: { fontSize: 22, lineHeight: 28, letterSpacing: -0.3 },
  2: { fontSize: 19, lineHeight: 26, letterSpacing: -0.2 },
  3: { fontSize: 17, lineHeight: 24 },
  4: { fontSize: 16, lineHeight: 24 },
};

/** The prose's type: 16 on 25 in the prose grey (`ink` sets it in full ink, for a card that isn't an answer). */
export function useProse(ink = false): TextStyle {
  const { c, t } = useTheme();
  return { ...t.prose, fontSize: 16, lineHeight: 25, color: ink ? c.text : c.prose };
}

/** Blocks, set. `fades` is the ink of these blocks' newest words still fading in, oldest first; while they do, it streams. */
function Blocks({ blocks, fades, ink = false }: { blocks: Block[]; fades?: readonly number[]; ink?: boolean }) {
  const { c } = useTheme();
  const body = useProse(ink);
  let total = 0;
  for (const b of blocks) {
    if (b.kind === "p" || b.kind === "h" || b.kind === "quote") total += countWords(b.inlines);
    else if (b.kind === "list") for (const it of b.items) total += countWords(it.inlines);
  }
  const fade = fades?.length ? { from: Math.max(0, total - fades.length), inks: fades.slice(Math.max(0, fades.length - total)) } : null;
  const seen = { n: 0 };
  return (
    <View style={{ gap: rhythm.paragraph }}>
      {blocks.map((block, b) => {
        switch (block.kind) {
          case "p":
            return (
              <Text key={b} selectable style={body}>
                <Runs runs={block.inlines} base={body} fade={fade} seen={seen} />
              </Text>
            );
          case "h":
            return (
              <Text key={b} accessibilityRole="header" style={[body, HEADING[block.level], { fontWeight: "600", color: c.text, marginTop: b ? 6 : 0 }]}>
                <Runs runs={block.inlines} base={{ ...body, color: c.text }} fade={fade} seen={seen} />
              </Text>
            );
          case "quote":
            return (
              <View key={b} style={{ borderLeftWidth: 3, borderLeftColor: alpha(c.text, 0.15), paddingLeft: 14 }}>
                <Text style={[body, { color: c.muted }]}>
                  <Runs runs={block.inlines} base={{ ...body, color: c.muted }} fade={fade} seen={seen} />
                </Text>
              </View>
            );
          case "hr":
            return <View key={b} style={{ height: 1, marginVertical: 6, backgroundColor: c.hairline }} />;
          case "code":
            return <CodeBlock key={b} code={block.code} language={block.language} file={block.file} />;
          case "table":
            return <Table key={b} head={block.head} rows={block.rows} streaming={fades !== undefined} />;
          case "list":
            return (
              <View key={b} style={{ gap: rhythm.listItem }}>
                {block.items.map((item, i) => (
                  <View key={i} style={{ flexDirection: "row", gap: 6, paddingLeft: item.depth * 22 }}>
                    {item.checked !== undefined ? (
                      <View style={{ width: 22, height: 25, justifyContent: "center" }}>
                        <View style={{ width: 16, height: 16, borderRadius: 4, borderWidth: 1, borderColor: item.checked ? c.text : c.field, backgroundColor: item.checked ? c.text : undefined, alignItems: "center", justifyContent: "center" }}>
                          {item.checked ? <Icon name="check" size={12} stroke={3} color={c.panel} /> : null}
                        </View>
                      </View>
                    ) : (
                      <Text style={[body, { width: 22, textAlign: block.ordered ? "right" : "center", color: c.subtle, fontVariant: ["tabular-nums"] }]}>{block.ordered ? `${block.start + i}.` : item.depth ? "◦" : "•"}</Text>
                    )}
                    <Text selectable style={[body, { flex: 1 }]}>
                      <Runs runs={item.inlines} base={body} fade={fade} seen={seen} />
                    </Text>
                  </View>
                ))}
              </View>
            );
        }
      })}
    </View>
  );
}

/** A finished chunk: set once, and again only if its words change. */
const Settled = memo(function Settled({ text, ink }: { text: string; ink: boolean }) {
  return <Blocks blocks={parse(text)} ink={ink} />;
});

/** The answer cut at its blank lines, never inside a code fence. */
export function chunksOf(text: string): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && !line.trim()) {
      if (current.length) chunks.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length) chunks.push(current.join("\n"));
  return chunks;
}

/**
 * The answer, set. `streaming` with `fades` fades its newest words in; every chunk before the last is settled. `ink`
 * sets it in full ink, for text that isn't an answer (a card, a page). `wordMs` is kept for callers that pass it.
 */
export function Markdown({ text, streaming = false, fades, ink = false }: { text: string; streaming?: boolean; fades?: readonly number[]; wordMs?: number; ink?: boolean }) {
  const chunks = chunksOf(text);
  return (
    <View style={{ gap: rhythm.paragraph }}>
      {chunks.map((chunk, i) =>
        streaming && i === chunks.length - 1 ? <Blocks key={i} blocks={parse(chunk)} fades={fades ?? []} ink={ink} /> : <Settled key={i} text={chunk} ink={ink} />,
      )}
    </View>
  );
}

/** A table, or a row of one, arriving mid-stream grows in over this, fading in with it: never its whole height in a frame. */
const GROW_MS = 150;
const GROW_EASE = Easing.bezier(0.33, 1, 0.68, 1);

/**
 * Grows from nothing to its own height as it fades in, when it arrives while the answer streams (`on` as it mounts);
 * then it is just its own height, so a cell that wraps as its words arrive grows it a line at a time. Under Reduce
 * Motion, and for anything already there, it is simply there.
 */
function Grow({ on, children }: { on: boolean; children: ReactNode }) {
  const still = useReducedMotion();
  const [grows] = useState(on && !still);
  const height = useSharedValue(grows ? 0 : -1);
  const ink = useSharedValue(grows ? 0 : 1);
  const started = useRef(!grows);
  const style = useAnimatedStyle(() => (height.value < 0 ? { opacity: ink.value } : { height: height.value, opacity: ink.value, overflow: "hidden" }));
  return (
    <Animated.View style={style}>
      <View
        onLayout={(e) => {
          if (started.current) return;
          started.current = true;
          const to = e.nativeEvent.layout.height;
          ink.value = withTiming(1, { duration: GROW_MS, easing: GROW_EASE });
          height.value = withTiming(to, { duration: GROW_MS, easing: GROW_EASE }, (done) => {
            if (done) height.value = -1;
          });
        }}
      >
        {children}
      </View>
    </Animated.View>
  );
}

/**
 * A table in the code block's shell, scrolling sideways; each column as wide as its longest cell needs, and never
 * narrower than its header's words. While rows stream in it keeps those widths, each only ever growing, and spreads
 * out to the answer's width once it has all arrived, so nothing already set narrows or reflows. Arriving mid-stream,
 * the table and then each row grow in over 150ms as they fade in; the row still arriving fills in word by word.
 */
function Table({ head, rows, streaming = false }: { head: Inline[][]; rows: Inline[][][]; streaming?: boolean }) {
  const { c, t } = useTheme();
  const [room, setRoom] = useState(0);
  const grown = useRef<number[]>([]);
  const plain = (runs: Inline[]) => runs.map((r) => r.text).join("");
  const natural = head.map((h, col) => {
    const longest = Math.max(...rows.map((r) => plain(r[col] ?? []).length), 0);
    // The header is 13pt semibold: its words get their room whole, so it never wraps mid-word.
    const header = plain(h).length * 7.4 + 26;
    return Math.max(header, Math.min(260, Math.max(64, longest * 7.6 + 26)));
  });
  // As wide as the answer when it fits (the desktop's w-full), the spare width shared out; wider, it scrolls.
  const sum = natural.reduce((a, b) => a + b, 0);
  const fitted = room > sum && !streaming ? natural.map((w) => (w * (room - 2)) / sum) : natural;
  const widths = fitted.map((w, col) => Math.max(w, grown.current[col] ?? 0));
  grown.current = widths;
  const cell: TextStyle = { ...t.small, fontSize: 14, lineHeight: 20, color: c.text, fontVariant: ["tabular-nums"] };
  const none = { n: 0 };
  return (
    <Grow on={streaming}>
      <View onLayout={(e) => setRoom(e.nativeEvent.layout.width)} style={{ borderRadius: 12, borderWidth: 1, borderColor: alpha(c.text, 0.1), backgroundColor: alpha(c.text, 0.035), overflow: "hidden" }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View>
            <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: alpha(c.text, 0.1) }}>
              {head.map((h, col) => (
                <Text key={col} style={[cell, { width: widths[col], paddingHorizontal: 12, paddingVertical: 8, fontWeight: "600", fontSize: 13 }]}>
                  <Runs runs={h} base={cell} fade={null} seen={none} />
                </Text>
              ))}
            </View>
            {rows.map((row, r) => (
              <Grow key={r} on={streaming}>
                <View style={{ flexDirection: "row", borderBottomWidth: r === rows.length - 1 ? 0 : 1, borderBottomColor: alpha(c.text, 0.06) }}>
                  {head.map((_, col) => (
                    <Text key={col} style={[cell, { width: widths[col], paddingHorizontal: 12, paddingVertical: 8 }]}>
                      <Runs runs={row[col] ?? []} base={cell} fade={null} seen={none} />
                    </Text>
                  ))}
                </View>
              </Grow>
            ))}
          </View>
        </ScrollView>
      </View>
    </Grow>
  );
}
