// The guide itself, as the desktop's Guide tab reads (apps/web/src/routes/review/Guide.tsx), in one column for a
// thumb. First what you came for: the TL;DR, then "Your calls", every judgment the guide leaves you in one place, the
// risk first, each a tap from its chapter, so the risky part is found on the first screen and not three screens down.
// Then "What changes": the writer's why (its what is the TL;DR again, so it goes) and the chapters, each with its call
// named in a word; the behaviour before and after, folded to its head. Then each chapter in the writer's order: where
// it is ("02 / 06"), its title, what it was, what it is, why, its call with "Push back on this", the code that carries
// it, its own files, the questions you might ask the agent and what you asked and its answers, and Mark read, which
// moves on. Mechanical stops fold into one Skim list; the foot says how far you are, who said what on the pull
// request, and who wrote the guide for which commit; the author's own words wait folded under it.
//
// A short change gets no tour (Guide.tsx Short): its TL;DR, its call, a line on why, and the whole diff at once. A
// guide still being written says so where the tour will be ("Caveman is reading the change…") over the files to read
// meanwhile; it is never left resting on "no tour yet".
import { useState } from "react";
import { Text, View } from "react-native";
import { type Chat, ENGINE_NAME } from "../board/model";
import { Icon } from "../components/Icon";
import { Mascot, PixelIcon } from "../components/Pixel";
import { Squish } from "../components/Squish";
import { Markdown } from "../components/transcript/Markdown";
import { Shimmer } from "../components/transcript/Shimmer";
import { EngineLogo } from "../components/ui/EngineLogo";
import { haptic } from "../motion";
import { age, ago, Avatar } from "../screens/pages/parts";
import { ME, type Pr, type Sent } from "../screens/pages/review-model";
import { alpha, mono, useTheme } from "../theme";
import { Excerpt, isResolved, type Threads } from "./Code";
import { FileDiff } from "./Files";
import type { PrReview } from "./guides";
import type { Review } from "./lookup";
import { CALL_WORD, DEFAULT_SHORT_LINES, guideDepth, guideLines, isShortChange, isSkimStop, isStale, overviewOf, pad, type Passage, type PrGuide, type PrGuideAttention, type PrGuideStop } from "./model";
import { CallBox, CallWord, Counts, FileRow, GuideLines, Head, Prose, ReadButton, ReadCheck } from "./parts";
import type { Asked } from "./state";

export interface TourProps {
  pr: Pr;
  chat: Chat | null;
  review: Review;
  read: ReadonlySet<number>;
  onRead: (stop: number, read: boolean) => void;
  onOpenFile: (path: string, line?: number, side?: "new" | "old") => void;
  onAsk: (stop: number | null, passage: Passage | undefined, question: string) => void;
  onJump: (stop: number) => void;
  /** Where each stop's top sits in the tour, for the bar that says where you are. */
  onPlace: (stop: number, y: number) => void;
  onOpenChat?: () => void;
  /** Push back on a chapter's call (or the short change's, null). */
  onPushBack: (stop: number | null) => void;
  /** Write the guide again for the head the pull request is at now. */
  onRewrite: () => void;
  /** What you asked about this pull request and the answers. */
  asked: readonly Asked[];
  onOpenAnswer: (id: string) => void;
  /** Reviews you sent from this phone. */
  sent: readonly Sent[];
  onThread: (id: string) => void;
  threads: Threads;
}

/** Where a chapter is, said as the agent hears it. */
export const whereOf = (index: number, stop: PrGuideStop) => `chapter ${index + 1} of the guide, “${stop.title}”`;

/** The whole change in a sentence, on its own card, the Caveman mark and a mono "TL;DR" leading it. */
export function Tldr({ text, by }: { text: string; by?: PrGuide["by"] }) {
  const { c, t } = useTheme();
  return (
    <View style={{ gap: 8, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 16, borderRadius: 16, backgroundColor: alpha(c.text, 0.04), borderWidth: 1, borderColor: alpha(c.text, 0.06) }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <PixelIcon name="engine-caveman" size={16} />
        <Text style={{ fontFamily: mono, fontSize: 11, letterSpacing: 0.8, color: c.subtle }}>TL;DR{by === "chat" ? "  ·  FROM THE CHAT" : ""}</Text>
      </View>
      <Prose text={text} style={[t.body, { fontSize: 18, lineHeight: 26, color: c.text }]} />
    </View>
  );
}

/** The order calls are listed in: what could hurt first, then what's hard to change later, then the rest. */
const CALL_ORDER: readonly PrGuideAttention["kind"][] = ["risk", "contract", "accessibility", "tradeoff", "product"];

/**
 * Every call the guide leaves you, in one place under the TL;DR (the desktop's rail of call dots, said in words):
 * the kind, the note's first line, and the chapter it is in, a tap away. The risk comes first.
 */
function Calls({ guide, read, onJump }: { guide: PrGuide; read: ReadonlySet<number>; onJump: (i: number) => void }) {
  const { c, t, dark } = useTheme();
  const calls = guide.stops
    .map((stop, i) => ({ stop, i }))
    .filter((x): x is { stop: PrGuideStop & { attention: PrGuideAttention }; i: number } => !!x.stop.attention)
    .sort((a, b) => CALL_ORDER.indexOf(a.stop.attention.kind) - CALL_ORDER.indexOf(b.stop.attention.kind) || a.i - b.i);
  if (!calls.length) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 4 }}>
        <PixelIcon name="state-done" size={14} />
        <Text style={[t.small, { flex: 1 }]}>No calls for you in this one: nothing in it needs a judgment beyond reading the code.</Text>
      </View>
    );
  }
  return (
    <View style={{ borderRadius: 16, backgroundColor: alpha(c.warning, dark ? 0.07 : 0.06), borderWidth: 1, borderColor: alpha(c.warning, dark ? 0.16 : 0.2), overflow: "hidden" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 4 }}>
        <PixelIcon name="state-needs-input" size={14} />
        <Text accessibilityRole="header" style={[t.label, { flex: 1, fontSize: 15, fontWeight: "600" }]}>
          Your {calls.length === 1 ? "call" : `${calls.length} calls`}
        </Text>
      </View>
      {calls.map(({ stop, i }, k) => (
        <Squish
          key={i}
          label={`${CALL_WORD[stop.attention.kind]}, in chapter ${i + 1}: ${stop.attention.note.replace(/`/g, "")}${read.has(i) ? ". Read" : ""}. Go to it`}
          depth={0.99}
          highlight
          onPress={() => onJump(i)}
          style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, minHeight: 56, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: k ? 1 : 0, borderTopColor: alpha(c.warning, dark ? 0.12 : 0.16) }}
        >
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <CallWord kind={stop.attention.kind} size={13} />
              {read.has(i) ? <ReadCheck read size={12} /> : null}
            </View>
            <Prose text={stop.attention.note} lines={3} style={[t.body, { fontSize: 15, lineHeight: 21, color: c.soft }]} />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 2, paddingTop: 1 }}>
            <Text style={[t.meta, { fontSize: 12 }]}>Ch {i + 1}</Text>
            <Icon name="chevronRight" size={12} color={c.subtle} />
          </View>
        </Squish>
      ))}
    </View>
  );
}

/** "What changes": the writer's why (its what is the TL;DR again), then the chapters, a tap jumping to each. */
function WhatChanges({ guide, read, onJump, hasTldr }: { guide: PrGuide; read: ReadonlySet<number>; onJump: (i: number) => void; hasTldr: boolean }) {
  const { c, t } = useTheme();
  const overview = overviewOf(guide);
  const main = guide.stops.map((stop, i) => ({ stop, i })).filter(({ stop }) => !isSkimStop(stop));
  const skimFiles = guide.stops.filter(isSkimStop).reduce((n, s) => n + s.files.length, 0);
  return (
    <View style={{ gap: 12 }}>
      <Head label="What changes" />
      {overview ? <GuideLines text={overview} skip={hasTldr ? "what" : undefined} /> : null}
      <View accessibilityRole="list" style={{ marginTop: 2, marginHorizontal: -12 }}>
        {main.map(({ stop, i }) => {
          const done = read.has(i);
          return (
            <Squish
              key={i}
              label={`Chapter ${i + 1}, ${stop.title}${stop.attention ? `, ${CALL_WORD[stop.attention.kind]}` : ""}${done ? ", read" : ""}`}
              depth={0.99}
              highlight
              onPress={() => onJump(i)}
              style={{ flexDirection: "row", alignItems: "flex-start", gap: 12, minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10 }}
            >
              <Text style={{ minWidth: 22, fontFamily: mono, fontSize: 13, lineHeight: 22, color: done ? c.success : c.subtle, fontVariant: ["tabular-nums"] }}>{pad(i + 1)}</Text>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[t.row, { fontSize: 16, lineHeight: 22, color: done ? c.muted : c.text }]}>{stop.title}</Text>
                {stop.attention ? <CallWord kind={stop.attention.kind} /> : null}
              </View>
            </Squish>
          );
        })}
        {skimFiles ? <Text style={[t.small, { paddingLeft: 46, paddingTop: 4 }]}>+ {skimFiles} {skimFiles === 1 ? "file" : "files"} to skim</Text> : null}
      </View>
    </View>
  );
}

/** The behaviour as rows (BeforeAfter), folded to its head: gone in red, new in green, kept plain, each tied to its chapter. */
function BeforeAfter({ ba, onJump }: { ba: NonNullable<PrGuide["before_after"]>; onJump: (stop: number) => void }) {
  const { c, t } = useTheme();
  const [open, setOpen] = useState(false);
  const gone = ba.rows.filter((r) => r.op === "-").length;
  const made = ba.rows.filter((r) => r.op === "+").length;
  return (
    <View style={{ borderRadius: 16, borderWidth: 1, borderColor: c.hairline, backgroundColor: alpha(c.text, 0.02), overflow: "hidden" }}>
      <Squish
        label={`Before and after: ${ba.title}. ${open ? "Fold" : "Open"}`}
        depth={0.99}
        onPress={() => {
          haptic.tick();
          setOpen(!open);
        }}
        style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 52, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: open ? 1 : 0, borderBottomColor: c.hairline }}
      >
        <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
          <Icon name="chevronRight" size={14} color={c.muted} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[t.label, { fontSize: 15 }]}>Before / after</Text>
          <Prose text={ba.title} lines={1} style={[t.small, { lineHeight: 17 }]} />
        </View>
        <Text style={[t.meta, { fontSize: 12 }]}>
          <Text style={{ color: c.removed }}>{gone} gone</Text> · <Text style={{ color: c.added }}>{made} new</Text>
        </Text>
      </Squish>
      {open ? (
        <View style={{ paddingHorizontal: 8, paddingTop: 8, paddingBottom: 8 }}>
          {ba.rows.map((row, i) => {
            const tone = row.op === "+" ? c.added : row.op === "-" ? c.removed : null;
            return (
              <View key={i} style={{ flexDirection: "row", alignItems: "flex-start", minHeight: 34, borderRadius: 8, backgroundColor: tone ? alpha(tone, 0.09) : undefined, marginBottom: 2 }}>
                <Text style={{ width: 22, textAlign: "center", fontFamily: mono, fontSize: 14, lineHeight: 34, color: tone ?? c.subtle }}>{row.op === "-" ? "−" : row.op.trim()}</Text>
                <Text style={[t.body, { flex: 1, paddingLeft: row.depth * 14, paddingVertical: 6, fontSize: 15, lineHeight: 22, color: row.op === "-" ? c.muted : c.text, fontWeight: row.op === " " ? "500" : "400" }]}>{row.text}</Text>
                {row.stop ? (
                  <Squish label={`Go to chapter ${row.stop}`} depth={0.9} onPress={() => onJump(row.stop! - 1)} style={{ minWidth: 48, height: 34, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" }}>
                    <Text style={[t.meta, { fontSize: 12 }]}>Ch {row.stop}</Text>
                  </Squish>
                ) : (
                  <View style={{ width: 48 }} />
                )}
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

/** What you asked here and what came back: your words, then the agent's answer, or "Reading the code…" until it lands. */
function AskedHere({ items, asker, onOpen }: { items: readonly Asked[]; asker: string; onOpen: (id: string) => void }) {
  const { c, t } = useTheme();
  if (!items.length) return null;
  return (
    <View style={{ gap: 10, paddingHorizontal: 16 }}>
      {items.map((a) => (
        <Squish key={a.id} label={`You asked: ${a.question}. ${a.answer ? `${asker} answered: ${a.answer.replace(/`/g, "")}` : `${asker} is reading the code`}`} depth={0.99} onPress={() => onOpen(a.id)} style={{ gap: 8, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12, backgroundColor: c.card, borderWidth: 1, borderColor: c.edge }}>
          <Text style={[t.small, { color: c.muted }]}>
            <Text style={{ color: c.text, fontWeight: "500" }}>You</Text> · {a.question}
          </Text>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ paddingTop: 2 }}>
              <PixelIcon name={a.answer ? "engine-caveman" : "state-working"} size={16} />
            </View>
            {a.answer ? <Prose text={a.answer} lines={4} style={[t.body, { flex: 1, fontSize: 15, lineHeight: 22, color: c.soft }]} /> : <Shimmer text={`${asker} is reading the code…`} on style={[t.body, { flex: 1, fontSize: 15, lineHeight: 22 }]} />}
          </View>
        </Squish>
      ))}
    </View>
  );
}

/** One chapter (Stop), in one column: its place, its title, its three lines, its call, its code, its files, its questions, Mark read. */
function Chapter({ index, total, stop, review, read, onRead, onOpenFile, onAsk, onPlace, onPushBack, threads, asked, onOpenAnswer, pr }: TourProps & { index: number; total: number; stop: PrGuideStop }) {
  const { c, t } = useTheme();
  const isRead = read.has(index);
  const where = whereOf(index, stop);
  const mine = asked.filter((a) => a.stop === index);
  const asker = pr.agent ? ENGINE_NAME[pr.agent.engine] : "The agent";
  return (
    <View onLayout={(e) => onPlace(index, e.nativeEvent.layout.y)} style={{ paddingTop: 36, paddingBottom: 8, borderTopWidth: 1, borderTopColor: c.hairline, gap: 16 }}>
      <View style={{ gap: 6, paddingHorizontal: 16 }}>
        <Text style={{ fontFamily: mono, fontSize: 12.5, color: c.subtle, fontVariant: ["tabular-nums"] }}>
          {pad(index + 1)} / {pad(total)}
          {isRead ? <Text style={{ fontFamily: undefined, color: c.success }}>{"   "}Read</Text> : null}
        </Text>
        <Text accessibilityRole="header" style={[t.title, { color: isRead ? c.muted : c.text }]}>
          {stop.title}
        </Text>
      </View>
      <View style={{ paddingHorizontal: 16 }}>
        <GuideLines text={stop.summary} />
      </View>
      {stop.attention ? (
        <View style={{ paddingHorizontal: 16 }}>
          <CallBox attention={stop.attention} onPushBack={() => onPushBack(index)} />
        </View>
      ) : null}
      {stop.excerpts.length ? (
        <View style={{ gap: 12, paddingHorizontal: 12 }}>
          {stop.excerpts.map((ex, i) => (
            <Excerpt key={i} excerpt={ex} file={review.files.get(ex.path)} notes={stop.notes} threads={threads} onOpenFile={onOpenFile} />
          ))}
          {index === firstWithCode(review) ? <Text style={[t.meta, { paddingHorizontal: 4 }]}>Hold any line to ask about it, or to ask for a change there.</Text> : null}
        </View>
      ) : null}
      {stop.files.length ? (
        <View style={{ paddingHorizontal: 4 }}>
          {stop.files.map((f) => (
            <FileRow key={f.path} path={f.path} note={f.note} file={review.files.get(f.path)} onPress={() => onOpenFile(f.path)} />
          ))}
        </View>
      ) : null}
      {stop.questions.length ? (
        <View style={{ paddingHorizontal: 4 }}>
          {stop.questions.map((q) => (
            <Squish key={q} label={`Ask ${asker}: ${q}`} depth={0.99} highlight onPress={() => onAsk(index, { where, quote: stop.summary }, q)} style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48, paddingHorizontal: 12, borderRadius: 10 }}>
              <Icon name="comment" size={16} color={c.muted} />
              <Prose text={q} style={[t.row, { flex: 1, fontSize: 15, lineHeight: 21, color: c.soft }]} />
              <Text style={[t.small, { color: c.subtle }]}>Ask</Text>
            </Squish>
          ))}
        </View>
      ) : null}
      <AskedHere items={mine} asker={asker} onOpen={onOpenAnswer} />
      <View style={{ paddingHorizontal: 16, paddingTop: 4 }}>
        <ReadButton read={isRead} last={index === total - 1} onToggle={() => onRead(index, !isRead)} />
      </View>
    </View>
  );
}

/** The first chapter that shows code, where the hint to hold a line goes. */
function firstWithCode(review: Review): number {
  return review.result.guide?.stops.findIndex((s) => s.excerpts.length > 0) ?? -1;
}

/** Mechanical stops, one line each, opened on demand (Skim). */
function Skim({ items, review, read, onRead, onOpenFile, onPlace }: TourProps & { items: readonly { stop: PrGuideStop; i: number }[] }) {
  const { c, t } = useTheme();
  const [open, setOpen] = useState<number | null>(null);
  return (
    <View onLayout={(e) => items.forEach(({ i }) => onPlace(i, e.nativeEvent.layout.y))} style={{ paddingTop: 28, paddingHorizontal: 16, borderTopWidth: 1, borderTopColor: c.hairline }}>
      <Text style={[t.small, { paddingBottom: 6 }]}>Skim: checked, nothing to judge</Text>
      {items.map(({ stop, i }) => {
        const isRead = read.has(i);
        const add = stop.files.reduce((n, f) => n + (review.files.get(f.path)?.additions ?? 0), 0);
        const del = stop.files.reduce((n, f) => n + (review.files.get(f.path)?.deletions ?? 0), 0);
        return (
          <View key={i}>
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <Squish label={isRead ? `${stop.title}, read. Take it back` : `Mark ${stop.title} read`} selected={isRead} depth={0.9} onPress={() => onRead(i, !isRead)} style={{ width: 44, height: 48, alignItems: "flex-start", justifyContent: "center" }}>
                <ReadCheck read={isRead} />
              </Squish>
              <Squish label={`${stop.title}, ${open === i ? "fold" : "open"}`} depth={0.99} onPress={() => setOpen(open === i ? null : i)} style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, height: 48 }}>
                <Text numberOfLines={1} style={[t.row, { flex: 1, fontSize: 15, color: isRead ? c.muted : c.text }]}>
                  {stop.title}
                </Text>
                <Text style={t.meta}>{stop.files.length === 1 ? "1 file" : `${stop.files.length} files`}</Text>
                <Counts add={add} del={del} />
              </Squish>
            </View>
            {open === i ? (
              <View style={{ paddingLeft: 44, paddingBottom: 12, gap: 8 }}>
                <GuideLines text={stop.summary} size={14} />
                {stop.files.map((f) => (
                  <FileRow key={f.path} path={f.path} note={f.note} file={review.files.get(f.path)} onPress={() => onOpenFile(f.path)} />
                ))}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/** How far you are (Done): the count, or the caveman and the call that is yours now. */
function Done({ read, total, verbs }: { read: number; total: number; verbs: string }) {
  const { c, t } = useTheme();
  if (total === 0) return null;
  const all = read >= total;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingTop: 28 }}>
      {all ? <Mascot size={48} label="Done" /> : null}
      <Text style={[t.body, { flex: 1, fontSize: 15, lineHeight: 22, color: all ? c.text : c.muted }]}>{all ? `All read. Your call now: ${verbs}.` : `${read} of ${total} chapters read.`}</Text>
    </View>
  );
}

const VERDICT_WORD: Record<PrReview["verdict"], string> = { approve: "approved", request_changes: "asked for changes", comment: "commented" };

/**
 * Who said what on the pull request (the desktop's Discussion, at the guide's foot): each review with its verdict,
 * yours from this phone included, then every review thread, open ones first, a resolved one folded to its line. A
 * thread opens where it sits in the code.
 */
function Conversation({ review, sent, threads, onThread }: { review: Review; sent: readonly Sent[]; threads: Threads; onThread: (id: string) => void }) {
  const { c, t } = useTheme();
  const reviews: PrReview[] = [...review.reviews, ...sent.map((s) => ({ author: ME, verdict: s.verdict, body: s.body, at: s.at }))];
  const list = [...threads.list].sort((a, b) => Number(isResolved(a, threads.resolved)) - Number(isResolved(b, threads.resolved)));
  if (!reviews.length && !list.length) return null;
  return (
    <View style={{ marginHorizontal: 16, marginTop: 28, paddingTop: 20, borderTopWidth: 1, borderTopColor: c.hairline, gap: 8 }}>
      <Head label="Conversation" />
      {reviews.map((r, i) => (
        <View key={`r${i}`} style={{ flexDirection: "row", gap: 10, paddingVertical: 6 }}>
          <Avatar login={r.author} size={20} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={t.small}>
              <Text style={{ color: c.text, fontWeight: "500" }}>{r.author === ME ? "You" : r.author}</Text> <Text style={{ color: r.verdict === "approve" ? c.success : r.verdict === "request_changes" ? c.destructive : c.muted }}>{VERDICT_WORD[r.verdict]}</Text> · {ago(r.at)}
            </Text>
            {r.body ? <Prose text={r.body} style={[t.body, { fontSize: 15, lineHeight: 21, color: c.soft }]} /> : null}
          </View>
        </View>
      ))}
      {list.map((th) => {
        const done = isResolved(th, threads.resolved);
        const replies = threads.replies[th.id]?.length ?? 0;
        const first = th.comments[0];
        return (
          <Squish key={th.id} label={`${done ? "Resolved thread" : "Open thread"} on ${th.path.split("/").pop()} line ${th.line}: ${first?.body ?? ""}. Go to it`} depth={0.99} highlight onPress={() => onThread(th.id)} style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 52, paddingVertical: 8, paddingHorizontal: 8, marginHorizontal: -8, borderRadius: 10 }}>
            <Icon name={done ? "check" : "comment"} size={15} color={done ? c.success : c.muted} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={[t.row, { fontSize: 15, color: done ? c.muted : c.text }]}>
                {first ? `${first.author}: ${first.body.replace(/`/g, "")}` : "A thread"}
              </Text>
              <Text numberOfLines={1} style={[t.meta, { fontSize: 12 }]}>
                {th.path.split("/").pop()}:{th.line} · {th.comments.length + replies} {th.comments.length + replies === 1 ? "comment" : "comments"}
                {done ? " · resolved" : ""}
              </Text>
            </View>
            <Icon name="chevronRight" size={13} color={c.subtle} />
          </Squish>
        );
      })}
    </View>
  );
}

/** Who wrote the guide, when, and for which commit (WriterLine); the chat that made the change opens from it. */
export function WriterLine({ guide, onOpenChat }: { guide: PrGuide; onOpenChat?: () => void }) {
  const { c, t } = useTheme();
  const what = guide.depth === "tldr" ? "TL;DR" : "Guide";
  const by = guide.model ?? (guide.by === "chat" ? "the chat that opened it" : "a model");
  const when = age(new Date(guide.generated_at).getTime());
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 24, gap: 4 }}>
      <Text style={[t.meta, { lineHeight: 19 }]}>
        {what} by {by} · {when === "now" ? "just now" : `${when} ago`} · for <Text style={{ fontFamily: mono, fontSize: 12 }}>{guide.head_sha.slice(0, 7)}</Text>
      </Text>
      {onOpenChat ? <WriterLink label="Open the chat" onPress={onOpenChat} /> : null}
    </View>
  );
}

/**
 * What the author wrote (AuthorNote), folded to its first line under a tour: for one of your chats, the agent's own
 * closing words; for anyone's, the description. Opened, it reads as the chat does.
 */
export function AuthorNote({ pr, folded = true }: { pr: Pr; folded?: boolean }) {
  const { c, t } = useTheme();
  const [open, setOpen] = useState(!folded);
  if (!pr.body) return null;
  const who = pr.agent ? ENGINE_NAME[pr.agent.engine] : pr.author;
  const first = pr.body.replace(/\*\*|`/g, "").split("\n").find((l) => l.trim()) ?? "";
  return (
    <View style={{ marginHorizontal: 16, marginTop: 24, paddingTop: 16, borderTopWidth: 1, borderTopColor: c.hairline }}>
      <Squish label={`${who} wrote. ${open ? "Fold" : "Read it"}`} depth={0.99} onPress={() => setOpen(!open)} style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 }}>
        {pr.agent ? <EngineLogo engine={pr.agent.engine} size={16} /> : <Avatar login={pr.author} size={18} />}
        <Text numberOfLines={open ? undefined : 1} style={[t.small, { flex: 1, fontSize: 14, lineHeight: 20 }]}>
          <Text style={{ color: c.text, fontWeight: "500" }}>{who}</Text> wrote{open ? "" : ` “${first}”`}
        </Text>
        <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
          <Icon name="chevronRight" size={14} color={c.subtle} />
        </View>
      </Squish>
      {open ? (
        <View style={{ paddingLeft: 26, paddingTop: 4 }}>
          <Markdown text={pr.body} />
        </View>
      ) : null}
    </View>
  );
}

/** A guide being written (Pending): the writer at work where the tour will be, and the files to read meanwhile. */
function Pending({ pr, review, onOpenFile }: { pr: Pr; review: Review; onOpenFile: (path: string) => void }) {
  const { c, t } = useTheme();
  const n = pr.files.length;
  return (
    <View style={{ gap: 20 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginHorizontal: 16, paddingHorizontal: 16, paddingVertical: 14, borderRadius: 16, borderWidth: 1, borderStyle: "dashed", borderColor: c.field }}>
        <PixelIcon name="state-working" size={20} />
        <View style={{ flex: 1, gap: 2 }}>
          <Shimmer text="Caveman is reading the change…" on style={[t.label, { fontSize: 16 }]} />
          <Text style={t.small}>
            {n} {n === 1 ? "file" : "files"}. The guide lands here in a moment; the code is in Files now.
          </Text>
        </View>
      </View>
      {n ? (
        <View style={{ paddingHorizontal: 4 }}>
          {pr.files.map((f) => (
            <FileRow key={f.path} path={f.path} file={review.files.get(f.path) ?? { additions: f.add, deletions: f.del }} onPress={() => onOpenFile(f.path)} />
          ))}
        </View>
      ) : null}
      <AuthorNote pr={pr} folded={false} />
    </View>
  );
}

/** A short change (Short): its call, why there is no tour, and the whole diff, from the first frame. */
function Short(props: TourProps) {
  const { pr, review, onPushBack, asked, onOpenAnswer } = props;
  const { c, t } = useTheme();
  const guide = review.result.guide;
  const lines = guideLines(pr.files);
  const files = [...review.files.values()];
  return (
    <View style={{ gap: 20 }}>
      {guide?.attention ? (
        <View style={{ paddingHorizontal: 16 }}>
          <CallBox attention={guide.attention} onPushBack={() => onPushBack(null)} />
        </View>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16 }}>
        <View accessibilityRole="progressbar" accessibilityLabel={`${lines} of ${DEFAULT_SHORT_LINES} lines`} style={{ width: 44, height: 4, borderRadius: 2, backgroundColor: alpha(c.text, 0.1), overflow: "hidden" }}>
          <View style={{ width: `${Math.min(100, (lines / DEFAULT_SHORT_LINES) * 100)}%`, height: 4, backgroundColor: alpha(c.text, 0.7) }} />
        </View>
        <Text style={[t.small, { flex: 1 }]}>
          <Text style={{ color: c.text, fontVariant: ["tabular-nums"] }}>{lines}</Text> {lines === 1 ? "line" : "lines"} of code and tests, so the diff is the guide
        </Text>
      </View>
      <View style={{ gap: 12, paddingHorizontal: 12 }}>
        {files.map((f) => (
          <FileDiff key={f.path} file={f} threads={props.threads} />
        ))}
        {files.length ? <Text style={[t.meta, { paddingHorizontal: 4 }]}>Hold any line to ask about it, or to ask for a change there.</Text> : null}
      </View>
      <AskedHere items={asked} asker={pr.agent ? ENGINE_NAME[pr.agent.engine] : "The agent"} onOpen={onOpenAnswer} />
      <Conversation review={review} sent={props.sent} threads={props.threads} onThread={props.onThread} />
      <AuthorNote pr={pr} />
      {guide ? <WriterLine guide={guide} onOpenChat={props.onOpenChat} /> : null}
    </View>
  );
}

/** What waits for you once you've read it all, in the verbs the foot offers. */
export const verbsFor = (pr: Pr) => (pr.mine ? "merge it, ask, or send it back" : "approve, ask, or send it back");

/** The guide's body for this pull request: the tour, a short change, or the guide being written. */
export function GuideBody(props: TourProps) {
  const { pr, review, read, onOpenChat, asked } = props;
  const { c, t } = useTheme();
  const { result } = review;
  const guide = result.guide;
  const short = isShortChange(guideLines(pr.files), DEFAULT_SHORT_LINES);
  const depth = guideDepth(guide, short);

  if (pr.state === "merged" || pr.state === "closed") {
    return (
      <View style={{ paddingHorizontal: 16, gap: 8 }}>
        <Text style={[t.body, { color: c.prose }]}>
          {pr.state === "merged" ? "Merged" : "Closed"} {age(pr.updatedAt)} ago{review.files.size ? "." : ", without a guide on this phone."}
        </Text>
        {onOpenChat ? <WriterLink label="Open the chat" onPress={onOpenChat} /> : null}
      </View>
    );
  }
  if (depth === "tldr" && guide) return <Short {...props} />;
  const tour = guide && (guide.depth ?? "tour") === "tour" ? guide : null;
  if (!tour) return <Pending pr={pr} review={review} onOpenFile={(path) => props.onOpenFile(path)} />;

  const stops = tour.stops;
  const main = stops.map((stop, i) => ({ stop, i })).filter(({ stop }) => !isSkimStop(stop));
  const skim = stops.map((stop, i) => ({ stop, i })).filter(({ stop }) => isSkimStop(stop));
  const general = asked.filter((a) => a.stop === null);
  return (
    <View>
      {isStale(result) ? (
        <View style={{ marginHorizontal: 16, marginBottom: 20, paddingLeft: 14, paddingRight: 6, paddingVertical: 6, borderRadius: 12, backgroundColor: alpha(c.text, 0.04), borderWidth: 1, borderColor: alpha(c.text, 0.08), flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Icon name="info" size={16} color={c.muted} />
          <Text style={[t.small, { flex: 1, paddingVertical: 4 }]}>
            Written for <Text style={{ fontFamily: mono, fontSize: 12, color: c.text }}>{tour.head_sha.slice(0, 7)}</Text>; the agent changed it since. The code below is as it is now.
          </Text>
          <Squish label="Write the guide again for the change as it is now" depth={0.95} onPress={props.onRewrite} style={{ height: 44, paddingHorizontal: 10, justifyContent: "center" }}>
            <Text style={[t.small, { color: c.text, fontWeight: "500" }]}>{result.running ? "Writing…" : "Rewrite"}</Text>
          </Squish>
        </View>
      ) : null}
      <View style={{ paddingHorizontal: 16, gap: 24, paddingBottom: 36 }}>
        <Calls guide={tour} read={read} onJump={props.onJump} />
        {general.length ? (
          <View style={{ marginHorizontal: -16 }}>
            <AskedHere items={general} asker={pr.agent ? ENGINE_NAME[pr.agent.engine] : "The agent"} onOpen={props.onOpenAnswer} />
          </View>
        ) : null}
        <WhatChanges guide={tour} read={read} onJump={props.onJump} hasTldr={!!tour.tldr} />
        {tour.before_after?.rows.length ? <BeforeAfter ba={tour.before_after} onJump={props.onJump} /> : null}
      </View>
      {main.map(({ stop, i }) => (
        <Chapter key={i} {...props} index={i} total={stops.length} stop={stop} />
      ))}
      {skim.length ? <Skim {...props} items={skim} /> : null}
      <Done read={read.size} total={stops.length} verbs={verbsFor(pr)} />
      <Conversation review={review} sent={props.sent} threads={props.threads} onThread={props.onThread} />
      <WriterLine guide={tour} onOpenChat={onOpenChat} />
      <AuthorNote pr={pr} />
    </View>
  );
}

function WriterLink({ label, onPress }: { label: string; onPress: () => void }) {
  const { c, t } = useTheme();
  return (
    <Squish label={label} depth={0.97} onPress={onPress} style={{ alignSelf: "flex-start", height: 44, flexDirection: "row", alignItems: "center", gap: 4 }}>
      <Text style={[t.small, { color: c.muted }]}>{label}</Text>
      <Icon name="chevronRight" size={12} color={c.subtle} />
    </Squish>
  );
}
