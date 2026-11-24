// A pull request on the phone, for someone signed in, read from Cloud (live/cloud.ts, CONTRACT §12): one pushed page,
// top to bottom as a reviewer reads it. Its title and number; one line of where it stands (open, draft, merged or
// closed, who opened it, what goes into what, and the repository); its checks (how many pass, each failing one by
// name) and who reviewed it; the description; the discussion, oldest first (comments, reviews with something said,
// line threads under their file and line); then its files with their counts, each opening in place to its patch,
// plainly (review/Files.tsx FileDiff draws the lines). No guide, no viewed marks and nothing resolved: Cloud serves
// none of them.
//
// What the person may do stands at the foot, in reach however far they read, and only what GitHub lets them do:
// Approve, Request changes (which asks what should change first), Comment, Merge (asked once, since it cannot be
// undone) and Ask an agent, which starts a chat in Cloud about it. A change on its way is one line with its seconds in
// the buttons' place; once GitHub has it the page is read again and the toast says what happened. One GitHub refuses
// says why in GitHub's own words over the buttons, and what was typed stays in its sheet (and on the phone, as a
// chat's draft does, until it is sent).
import type { PrDetail, PrDiscussionItem, PrSummary } from "@caveman-app/session-protocol";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform, RefreshControl, Text, TextInput, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon, type IconName } from "../components/Icon";
import { PixelIcon } from "../components/Pixel";
import { BottomEdge } from "../components/ProgressiveEdge";
import { Squish } from "../components/Squish";
import { FileTypeMark } from "../components/transcript/FileTypeMark";
import { Markdown } from "../components/transcript/Markdown";
import { Button } from "../components/ui/Button";
import { useLink } from "../live/link";
import { isLive } from "../live/seams";
import { haptic } from "../motion";
import type { ScreenProps } from "../nav/routes";
import { hunksOf } from "../review/diff";
import { FileDiff } from "../review/Files";
import { splitPath } from "../review/model";
import { Counts } from "../review/parts";
import { Page } from "../screens/Page";
import { Avatar, Overlay, useNow } from "../screens/pages/parts";
import { usePane } from "../shell/layout";
import { BAR_HEIGHT, TopBar } from "../shell/TopBar";
import { useDraft } from "../store/sessions";
import { alpha, layout, mono, radius, useTheme } from "../theme";
import { askAgent, connectGitHub, pulls, useCloudStarts, usePerson, usePull } from "./live";
import { type Foot as Offers, footOf, pullKey } from "./model";
import type { PullState, Said } from "./store";
import {
  ageOf,
  ASK_SHORT,
  ASKS,
  BUTTON,
  checksSaid,
  CONNECT_BUTTON,
  DOING,
  FAILING,
  LOADING,
  mergeBar,
  mergeQuestion,
  type MergeMethod,
  NO_COMMENTS,
  NO_PATCH,
  NOBODY,
  PART,
  readable,
  reviewsSaid,
  STATE_WORD,
  stateLine,
  VERDICT_WORD,
  waitLine,
} from "./words";

const STATE_ICON: Record<PrSummary["state"], IconName> = {
  open: "pullRequest",
  draft: "pullRequestDraft",
  merged: "merge",
  closed: "pullRequestClosed",
};

/**
 * Only someone signed in has pull requests here. On the scripted board, or signed out, a link or a kept screen that
 * names one goes back to where it came from.
 */
export function PullRoute({ route, navigation }: ScreenProps<"Pull">) {
  const { owner, name, number } = route.params;
  const account = useLink((s) => s.account);
  const nobody = !isLive() || account === null;
  const leave = useCallback(
    () => (navigation.canGoBack() ? navigation.goBack() : navigation.replace("Home")),
    [navigation],
  );
  useEffect(() => {
    if (nobody) leave();
  }, [nobody, leave]);
  // Not read yet who is signed in: nothing to show for a moment.
  if (nobody || !account) return <View style={{ flex: 1 }} />;
  return (
    <PullScreen
      key={`${owner}/${name}#${number}`}
      repo={`${owner}/${name}`}
      number={Number(number)}
      onBack={leave}
    />
  );
}

/** One line in the page's quiet voice: a wait, or what could not be read. */
function Line({ children, tone = "muted" }: { children: string; tone?: "muted" | "bad" }) {
  const { c, t } = useTheme();
  return (
    <Text
      accessibilityLiveRegion="polite"
      style={[
        t.row,
        { fontSize: 15, lineHeight: 21, color: tone === "bad" ? c.destructive : c.muted },
      ]}
    >
      {children}
    </Text>
  );
}

/** A wait in one line, counting its seconds ("Merging… 3s"). */
function Wait({ doing, since }: { doing: string; since: number }) {
  const now = useNow(1000);
  return (
    <View style={{ minHeight: 44, justifyContent: "center" }}>
      <Line>{waitLine(doing, since, now)}</Line>
    </View>
  );
}

/** What could not be read or done, with the way to GitHub when that is what is missing. */
function Problem({ said, tone }: { said: Said; tone?: "muted" | "bad" }) {
  return (
    <View style={{ gap: 12 }}>
      <Line tone={tone}>{said.words}</Line>
      {said.connect ? (
        <Button label={CONNECT_BUTTON} onPress={() => connectGitHub(said.connect!)} />
      ) : null}
    </View>
  );
}

/** The title and its number, then where the pull request stands, in one line. */
function Head({ pr }: { pr: PrDetail }) {
  const { c, t } = useTheme();
  const tone =
    pr.state === "open"
      ? c.success
      : pr.state === "merged"
        ? alpha(c.text, 0.75)
        : pr.state === "closed"
          ? c.destructive
          : c.muted;
  const line = stateLine(pr);
  return (
    <View style={{ paddingHorizontal: layout.inset, gap: 8 }}>
      <Text accessibilityRole="header" style={t.largeTitle}>
        {pr.title} <Text style={{ color: c.subtle, fontWeight: "400" }}>#{pr.number}</Text>
      </Text>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <View style={{ paddingTop: 2 }}>
          <Icon name={STATE_ICON[pr.state] ?? "pullRequest"} size={15} stroke={2} color={tone} />
        </View>
        <Text style={[t.small, { flex: 1, fontSize: 14, lineHeight: 20 }]}>
          <Text style={{ color: tone, fontWeight: "500" }}>{STATE_WORD[pr.state] ?? ""}</Text>
          {line.author ? ` · ${line.author}` : ""}
          {" · "}
          <Text style={{ fontFamily: mono, fontSize: 13 }}>{line.branches}</Text>
          {` · ${line.repo}`}
        </Text>
      </View>
    </View>
  );
}

/** Its checks (how many pass, each failing one by name), who reviewed it, and what bars a merge when GitHub names something. */
function Checks({ pr }: { pr: PrDetail }) {
  const { c, t } = useTheme();
  const said = checksSaid(pr.checks_list);
  const reviews = reviewsSaid(pr.reviewers);
  const bar = mergeBar(pr);
  if (!said && !reviews && !bar) return null;
  const words = [t.small, { fontSize: 14, lineHeight: 20 }];
  const cross = <Icon name="close" size={15} stroke={2.25} color={c.destructive} />;
  return (
    <View style={{ paddingHorizontal: layout.inset, marginTop: 14, gap: 6 }}>
      {said ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View style={{ width: 16, paddingTop: 2, alignItems: "center" }}>
            {said.mark === "running" ? (
              <PixelIcon name="state-working" size={15} label="Checks running" />
            ) : said.mark === "fail" ? (
              cross
            ) : (
              <Icon name="check" size={15} stroke={2.25} color={c.success} />
            )}
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text style={[words, { color: c.soft }]}>{said.line}</Text>
            {said.failing.length > 0 ? (
              <Text style={words}>
                {FAILING} <Text style={{ color: c.text }}>{said.failing.join(", ")}</Text>
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}
      {reviews ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View style={{ width: 16, paddingTop: 2, alignItems: "center" }}>
            <Icon name="view" size={15} color={c.subtle} />
          </View>
          <Text style={[words, { flex: 1, color: c.soft }]}>{reviews}</Text>
        </View>
      ) : null}
      {bar ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View style={{ width: 16, paddingTop: 2, alignItems: "center" }}>{cross}</View>
          <Text style={[words, { flex: 1, color: c.soft }]}>{bar}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** A quiet head over a part of the page, with its count. */
function Part({ label, count }: { label: string; count?: number }) {
  const { t } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "baseline",
        gap: 8,
        paddingHorizontal: layout.inset,
        marginTop: 28,
        marginBottom: 10,
      }}
    >
      <Text accessibilityRole="header" style={t.heading}>
        {label}
      </Text>
      {count !== undefined ? <Text style={t.meta}>{count}</Text> : null}
    </View>
  );
}

/** What one person said: their mark, their name (and their review's verdict), how long ago, then their words. */
function Words({
  who,
  verdict,
  at,
  body,
  now,
}: {
  who: string;
  verdict?: keyof typeof VERDICT_WORD;
  at: string;
  body: string;
  now: number;
}) {
  const { c, t } = useTheme();
  const text = readable(body);
  const age = ageOf(at, now);
  const tone =
    verdict === "approved" ? c.success : verdict === "changes_requested" ? c.destructive : c.muted;
  return (
    <View style={{ flexDirection: "row", gap: 10 }}>
      <Avatar login={who} size={22} />
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Text style={[t.small, { lineHeight: 22 }]}>
          <Text style={{ color: c.text, fontWeight: "500" }}>{who}</Text>
          {verdict ? <Text style={{ color: tone }}> {VERDICT_WORD[verdict]}</Text> : null}
          {age ? ` · ${age}` : ""}
        </Text>
        {text ? <Markdown text={text} /> : null}
      </View>
    </View>
  );
}

/** The discussion, oldest first. A line thread stands under its file and line, its comments on one rule. */
function Talk({
  items,
  problem,
  now,
}: {
  items: ReadonlyArray<PrDiscussionItem> | null;
  problem: string | null;
  now: number;
}) {
  const { c } = useTheme();
  return (
    <>
      <Part label={PART.discussion} count={items && items.length > 0 ? items.length : undefined} />
      <View style={{ paddingHorizontal: layout.inset, gap: 20 }}>
        {items === null ? (
          <Line>{problem ?? LOADING}</Line>
        ) : items.length === 0 ? (
          <Line>{NO_COMMENTS}</Line>
        ) : (
          items.map((item) =>
            item.type === "comment" ? (
              <Words
                key={item.id}
                who={item.author?.login ?? NOBODY}
                verdict={item.verdict}
                at={item.at}
                body={item.body}
                now={now}
              />
            ) : (
              <View key={item.id} style={{ gap: 10 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Icon name="comment" size={14} color={c.subtle} />
                  <Text
                    numberOfLines={1}
                    ellipsizeMode="head"
                    style={{
                      flex: 1,
                      fontFamily: mono,
                      fontSize: 12.5,
                      lineHeight: 18,
                      color: c.muted,
                    }}
                  >
                    {item.path}
                    {item.line ? `:${item.line}` : ""}
                  </Text>
                </View>
                <View
                  style={{
                    gap: 14,
                    marginLeft: 6,
                    paddingLeft: 12,
                    borderLeftWidth: 2,
                    borderLeftColor: c.hairline,
                  }}
                >
                  {item.comments.map((said) => (
                    <Words
                      key={said.id}
                      who={said.author?.login ?? NOBODY}
                      at={said.at}
                      body={said.body}
                      now={now}
                    />
                  ))}
                </View>
              </View>
            ),
          )
        )}
      </View>
    </>
  );
}

/** The changed files, each a row that opens in place to its patch. The patches are read the first time one opens. */
function Files({
  pr,
  pull,
  open,
  onToggle,
}: {
  pr: PrDetail;
  pull: PullState;
  open: ReadonlySet<string>;
  onToggle: (path: string) => void;
}) {
  const { c, t } = useTheme();
  if (pr.files.length === 0) return null;
  return (
    <>
      <Part label={PART.files} count={pr.files.length} />
      <View style={{ paddingHorizontal: layout.inset - 10 }}>
        {pr.files.map((file) => {
          const shown = open.has(file.path);
          const { dir, name } = splitPath(file.path);
          const patch = pull.diff?.files.find((f) => f.path === file.path);
          return (
            <View key={file.path}>
              <Squish
                label={`${file.path}, ${file.additions} added, ${file.deletions} removed. ${shown ? "Hide" : "Show"} its lines`}
                depth={0.99}
                highlight
                onPress={() => onToggle(file.path)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  minHeight: 52,
                  paddingVertical: 6,
                  paddingHorizontal: 10,
                  borderRadius: radius.control,
                }}
              >
                <FileTypeMark path={file.path} size={15} />
                <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                  <Text
                    numberOfLines={1}
                    ellipsizeMode="middle"
                    style={{ fontFamily: mono, fontSize: 14, lineHeight: 19, color: c.text }}
                  >
                    {name}
                  </Text>
                  {dir ? (
                    <Text
                      numberOfLines={1}
                      ellipsizeMode="head"
                      style={{ fontFamily: mono, fontSize: 12, lineHeight: 17, color: c.subtle }}
                    >
                      {dir.replace(/\/$/, "")}
                    </Text>
                  ) : null}
                </View>
                <Counts add={file.additions} del={file.deletions} />
                <Icon name={shown ? "chevronUp" : "chevronDown"} size={14} color={c.subtle} />
              </Squish>
              {shown ? (
                <View style={{ paddingBottom: 10 }}>
                  {patch && hunksOf(patch).length > 0 ? (
                    <FileDiff file={patch} header={false} />
                  ) : (
                    <Text style={[t.small, { paddingHorizontal: 10, paddingVertical: 6 }]}>
                      {pull.diff ? NO_PATCH : (pull.diffProblem ?? LOADING)}
                    </Text>
                  )}
                </View>
              ) : null}
            </View>
          );
        })}
      </View>
    </>
  );
}

/**
 * What the person may do, over the page's foot. The buttons share each row's width and wrap where a phone is too
 * narrow for them in one. While a change is on its way they give their place to its one line.
 */
function Foot({
  pull,
  offers,
  covered,
  bottom,
  onHeight,
  onApprove,
  onWrite,
  onMerge,
  onAsk,
}: {
  pull: PullState;
  offers: Offers;
  /** A sheet is up over the page and says the wait or the refusal itself: one line for one thing. */ covered: boolean;
  bottom: number;
  onHeight: (h: number) => void;
  onApprove: () => void;
  onWrite: (kind: "changes" | "comment") => void;
  onMerge: () => void;
  onAsk: () => void;
}) {
  const failing = pull.detail?.checks_list.some((check) => check.status === "failed") ?? false;
  // On the narrowest phones Ask an agent is "Ask", as the web says it where it is short of room: with a review to
  // give and a merge to make, five buttons then stand in two rows instead of three.
  const narrow = usePane().width < 360;
  const buttons: { key: string; button: ReactNode }[] = [];
  if (offers.approve)
    buttons.push({
      key: "approve",
      button: <Button label={BUTTON.approve} variant="primary" stretch onPress={onApprove} />,
    });
  if (offers.changes)
    buttons.push({
      key: "changes",
      button: <Button label={BUTTON.changes} stretch onPress={() => onWrite("changes")} />,
    });
  if (offers.comment)
    buttons.push({
      key: "comment",
      button: <Button label={BUTTON.comment} stretch onPress={() => onWrite("comment")} />,
    });
  // The one white action where there is no review to give; never white over failing checks.
  if (offers.merge)
    buttons.push({
      key: "merge",
      button: (
        <Button
          label={BUTTON.merge}
          variant={offers.approve || failing ? "secondary" : "primary"}
          stretch
          onPress={onMerge}
        />
      ),
    });
  if (offers.ask)
    buttons.push({
      key: "ask",
      button: (
        <Button
          label={narrow ? ASK_SHORT : BUTTON.ask}
          accessibilityLabel={BUTTON.ask}
          icon={<PixelIcon name="engine-caveman" size={16} />}
          stretch
          onPress={onAsk}
        />
      ),
    });
  return (
    <View
      onLayout={(e) => onHeight(Math.round(e.nativeEvent.layout.height))}
      style={{ position: "absolute", left: layout.inset, right: layout.inset, bottom, gap: 10 }}
    >
      {pull.refused && !pull.busy && !covered ? (
        <Problem said={pull.refused} tone={pull.refused.connect ? "muted" : "bad"} />
      ) : null}
      {pull.busy && !covered ? (
        <Wait doing={DOING[pull.busy.change]} since={pull.busy.since} />
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {buttons.map(({ key, button }) => (
            <View key={key} style={{ flexGrow: 1 }}>
              {button}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/** What the person types for a comment or a request for changes, in a sheet that rides up on the keyboard. */
function Write({
  kind,
  drafts,
  onChangeText,
  pull,
  onClose,
  onSend,
}: {
  kind: "changes" | "comment" | null;
  drafts: Readonly<Record<"changes" | "comment", string>>;
  onChangeText: (text: string) => void;
  pull: PullState;
  onClose: () => void;
  onSend: () => void;
}) {
  const { c, t } = useTheme();
  const [focused, setFocused] = useState(false);
  // The sheet keeps its words while it slides away.
  const last = useRef(kind);
  if (kind) last.current = kind;
  const now = kind ?? last.current;
  if (!now) return null;
  const text = drafts[now];
  const refused = pull.refused && pull.refused.change === now ? pull.refused : null;
  return (
    <Overlay open={kind !== null} onClose={onClose} title={BUTTON[now]}>
      <View style={{ paddingHorizontal: 20, paddingBottom: 8, gap: 12 }}>
        <TextInput
          value={text}
          onChangeText={onChangeText}
          autoFocus
          multiline
          editable={!pull.busy}
          placeholder={ASKS[now]}
          placeholderTextColor={c.subtle}
          accessibilityLabel={ASKS[now]}
          cursorColor={c.text}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={[
            t.body,
            {
              minHeight: 104,
              maxHeight: 180,
              paddingHorizontal: 14,
              paddingTop: 12,
              paddingBottom: 12,
              borderRadius: radius.control,
              borderWidth: 1,
              borderColor: focused ? c.field : c.hairline,
              backgroundColor: c.panel,
              color: c.text,
              textAlignVertical: "top",
            },
            { outlineStyle: "none" } as object,
          ]}
        />
        {refused && !pull.busy ? (
          <Problem said={refused} tone={refused.connect ? "muted" : "bad"} />
        ) : null}
        {pull.busy ? (
          <Wait doing={DOING[pull.busy.change]} since={pull.busy.since} />
        ) : (
          <Button
            label={BUTTON[now]}
            variant="primary"
            stretch
            disabled={!text.trim()}
            onPress={() => {
              if (text.trim()) onSend();
            }}
          />
        )}
      </View>
    </Overlay>
  );
}

/** Merge, asked once: what goes where, that checks fail when they do, and the method the repository allows. */
function MergeSheet({
  pr,
  method,
  open,
  onClose,
  onMerge,
}: {
  pr: PrDetail;
  method: MergeMethod;
  open: boolean;
  onClose: () => void;
  onMerge: () => void;
}) {
  const { c, t } = useTheme();
  const asks = mergeQuestion(pr, method);
  return (
    <Overlay open={open} onClose={onClose} title={asks.title}>
      <View style={{ paddingHorizontal: 20, paddingBottom: 8, gap: 16 }}>
        <Text style={[t.body, { fontSize: 15, lineHeight: 22, color: c.muted }]}>{asks.line}</Text>
        <Button
          label={asks.confirm}
          variant={asks.failing ? "destructive" : "primary"}
          stretch
          onPress={() => {
            haptic.thud();
            onMerge();
          }}
        />
      </View>
    </Overlay>
  );
}

function PullScreen({
  repo,
  number,
  onBack,
}: {
  repo: string;
  number: number;
  onBack: () => void;
}) {
  const insets = useSafeAreaInsets();
  const person = usePerson();
  const pull = usePull(repo, number);
  const cloud = useCloudStarts();
  const offline = useLink((s) => s.offlineSince !== null);
  const now = useNow(30_000);
  const pr = pull.detail;
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [writing, setWriting] = useState<"changes" | "comment" | null>(null);
  // What was typed stays until GitHub has it, kept as the app keeps a chat's draft: a sheet put away, a change
  // refused, the page left or the app closed loses nothing.
  const [changes, setChanges] = useDraft(`pull:${pullKey(repo, number)}:changes`);
  const [comment, setComment] = useDraft(`pull:${pullKey(repo, number)}:comment`);
  const drafts = { changes, comment };
  const setDraft = { changes: setChanges, comment: setComment };
  const [merging, setMerging] = useState(false);
  const [footHeight, setFootHeight] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [past, setPast] = useState(false);
  const titleEnd = useRef(0);
  const scrollY = useSharedValue(0);

  const read = useCallback(
    () => (person === null ? Promise.resolve() : pulls.open(person, repo, number)),
    [person, repo, number],
  );
  // What could not be read for want of a network is read once the phone is back online; what waits on GitHub being
  // connected, when the person comes back from the browser.
  const unread = pull.problem !== null;
  const connecting = pull.problem?.connect !== undefined;
  useEffect(() => {
    if (unread && !offline) void read();
    // Only the network coming back asks: the first read is the screen's own.
  }, [offline]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!connecting) return;
    const heard = AppState.addEventListener("change", (state) => {
      if (state === "active") void read();
    });
    return () => heard.remove();
  }, [connecting, read]);

  const offers = pr ? footOf(pr, cloud) : null;
  const acts =
    offers !== null &&
    (offers.approve ||
      offers.changes ||
      offers.comment ||
      offers.merge !== null ||
      offers.ask ||
      pull.busy !== null ||
      pull.refused !== null);
  const footBottom = Math.max(insets.bottom, 10);
  const footTop = acts ? footBottom + footHeight : 0;

  const toggle = (path: string) => {
    haptic.tick();
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    void pulls.readDiff(repo, number);
  };
  const send = async () => {
    const kind = writing;
    if (!kind) return;
    const sent = await (kind === "changes"
      ? pulls.requestChanges(repo, number, changes)
      : pulls.comment(repo, number, comment));
    if (!sent) return;
    setDraft[kind]("");
    setWriting(null);
  };

  return (
    <View style={{ flex: 1 }} onAccessibilityEscape={onBack}>
      <Page
        scrollY={scrollY}
        onScroll={(e) => {
          const under =
            titleEnd.current > 0 &&
            e.nativeEvent.contentOffset.y > titleEnd.current - (insets.top + BAR_HEIGHT);
          if (under !== past) setPast(under);
        }}
        contentContainerStyle={{ paddingBottom: footTop + 40 }}
        // Pulling the page down reads the pull request again (a phone's own gesture; the web build has none).
        {...(Platform.OS === "web"
          ? null
          : {
              refreshControl: (
                <RefreshControl
                  refreshing={refreshing}
                  progressViewOffset={insets.top + BAR_HEIGHT}
                  onRefresh={() => {
                    setRefreshing(true);
                    void read().finally(() => setRefreshing(false));
                  }}
                />
              ),
            })}
      >
        {pr ? (
          <>
            {/* Keyed, so it is a view of its own from the start: the web build hears a view's layout only when it was
                asked for as the view was made, and the line this takes the place of asks for none. */}
            <View
              key="head"
              onLayout={(e) =>
                (titleEnd.current = e.nativeEvent.layout.y + e.nativeEvent.layout.height)
              }
            >
              <Head pr={pr} />
            </View>
            <Checks pr={pr} />
            {readable(pr.body) ? (
              <View style={{ paddingHorizontal: layout.inset, marginTop: 20 }}>
                <Markdown text={readable(pr.body)} />
              </View>
            ) : null}
            <Talk items={pull.discussion} problem={pull.discussionProblem} now={now} />
            <Files pr={pr} pull={pull} open={open} onToggle={toggle} />
          </>
        ) : (
          <View key="unread" style={{ paddingHorizontal: layout.inset, paddingTop: 8 }}>
            {pull.problem ? <Problem said={pull.problem} /> : <Line>{LOADING}</Line>}
          </View>
        )}
      </Page>
      <TopBar
        onBack={onBack}
        scrollY={scrollY}
        title={past && pr ? pr.title : undefined}
        subtitle={past && pr ? `#${pr.number} · ${pr.repo}` : undefined}
      />
      {acts ? <BottomEdge floor={footTop} /> : null}
      {pr && offers && acts ? (
        <Foot
          pull={pull}
          offers={offers}
          covered={writing !== null}
          bottom={footBottom}
          onHeight={setFootHeight}
          onApprove={() => void pulls.approve(repo, number)}
          onWrite={setWriting}
          onMerge={() => setMerging(true)}
          onAsk={() => void askAgent(pr)}
        />
      ) : null}
      <Write
        kind={writing}
        drafts={drafts}
        onChangeText={(text) => writing && setDraft[writing](text)}
        pull={pull}
        onClose={() => setWriting(null)}
        onSend={() => void send()}
      />
      {pr && offers?.merge ? (
        <MergeSheet
          pr={pr}
          method={offers.merge}
          open={merging}
          onClose={() => setMerging(false)}
          onMerge={() => {
            setMerging(false);
            void pulls.merge(repo, number);
          }}
        />
      ) : null}
    </View>
  );
}
