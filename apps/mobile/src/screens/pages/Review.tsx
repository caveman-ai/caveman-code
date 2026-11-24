// Review: every open pull request across your projects, as the desktop's queue (apps/web/src/routes/review/Queue.tsx)
// shows it in a phone's width. A search box and a filter menu on top (group by status or repository, and sort); then
// the groups, named by what each asks of you, the one that waits on you marked amber; then rows of one rhythm: the
// state's mark, the title, its number and a failing check, and a quiet line of age, repository and author, with its
// size at the right. Every row opens the same thing, its guide (review/GuideScreen.tsx), pushed over the queue: the
// agent's tour of the change, its code, and the decision at its foot. What you send there is kept while the app runs
// (review-model.ts reviews), so the queue, the shelf's count and the guide opened again all read the same record.
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import Animated from "react-native-reanimated";
import type { Chat } from "../../board/model";
import { Icon, type IconName } from "../../components/Icon";
import { PixelIcon } from "../../components/Pixel";
import { Squish } from "../../components/Squish";
import { Button } from "../../components/ui/Button";
import { PageEmpty } from "../../components/ui/Empty";
import { SearchField } from "../../components/ui/Field";
import { MenuButton, type MenuEntry } from "../../components/ui/Menu";
import { enter, layout } from "../../motion";
import { reviewedAt } from "../../review/guides";
import { guideId } from "../../review/lookup";
import { alpha, radius, useTheme } from "../../theme";
import { GlassButton } from "../../shell/TopBar";
import { ListPage } from "../Page";
import { age, CARD_ROOM, Heading, LIST_X, Stat, useNow } from "./parts";
import { groupByRepo, groupQueue, matches, ME, type Pr, type PrState, prKey, queueOf, repoName, reviews, settled, sizeOf, type Sort, SORTS, sortPrs, type Verdict } from "./review-model";

interface Actions {
  /** Opens a pull request's guide, by its guide id (review/lookup.ts guideId). */
  onGuide: (id: string) => void;
}

const STATE: Record<PrState, { icon: IconName; word: string }> = {
  open: { icon: "pullRequest", word: "Open" },
  draft: { icon: "pullRequestDraft", word: "Draft" },
  merged: { icon: "merge", word: "Merged" },
  closed: { icon: "pullRequestClosed", word: "Closed" },
};

function useStateTone() {
  const { c } = useTheme();
  return (state: PrState) => (state === "open" ? c.success : state === "draft" ? c.muted : state === "merged" ? alpha(c.text, 0.75) : c.destructive);
}

/** The pull request's state as its mark in its colour (parts.tsx StateIcon). */
function StateIcon({ state }: { state: PrState }) {
  const tone = useStateTone();
  return (
    <View accessibilityRole="image" accessibilityLabel={STATE[state].word}>
      <Icon name={STATE[state].icon} size={16} color={tone(state)} />
    </View>
  );
}

/**
 * How its checks stand, in one glyph (ChecksGlyph): a green check, a red cross, the working ring turning while they run
 *. The desktop's running mark is amber; on the phone amber is
 * only ever "this waits on you", so it turns in the ring's own ink.
 */
function ChecksGlyph({ checks, failingOnly = false }: { checks: Pr["checks"]; /** A row: only a failure is worth a mark there. */ failingOnly?: boolean }) {
  const { c } = useTheme();
  if (!checks) return null;
  if (failingOnly && checks !== "failing") return null;
  if (checks === "pending") return <PixelIcon name="state-working" size={14} label="Checks running" />;
  return (
    <View accessibilityRole="image" accessibilityLabel={checks === "passing" ? "Checks pass" : "Checks fail"}>
      <Icon name={checks === "passing" ? "check" : "close"} size={14} stroke={2.25} color={checks === "passing" ? c.success : c.destructive} />
    </View>
  );
}

const REVIEW_WORD: Record<Verdict, { word: string; tone: "success" | "destructive" }> = {
  approved: { word: "Approved", tone: "success" },
  changes_requested: { word: "Changes asked", tone: "destructive" },
};

/**
 * One pull request (Queue.tsx Row): its state's mark, then the title with its number and checks over a quiet line of
 * age, author, repository and branch; its verdict and its size sit at the end of those two lines, and its author's mark
 * at the right. `asks`: sections by repository no longer say what waits on you, so the row does.
 */
function PrRow({ pr, now, asks, onPress }: { pr: Pr; now: number; asks: boolean; onPress: () => void }) {
  const { c, t } = useTheme();
  const closed = pr.state === "merged" || pr.state === "closed";
  const size = sizeOf(pr);
  const verdict = pr.review ? REVIEW_WORD[pr.review] : null;
  const who = pr.author === ME ? "you" : pr.author;
  // What its guide asks of you, so the queue says which to open first: its calls, and how many are risks.
  const stops = closed ? [] : (reviewedAt(pr.repo, pr.branch)?.guide.stops ?? []);
  const calls = stops.filter((s) => s.attention).length;
  const risks = stops.filter((s) => s.attention?.kind === "risk").length;
  const callLine = calls ? ` · ${calls} ${calls === 1 ? "call" : "calls"}${risks ? ` (${risks} ${risks === 1 ? "risk" : "risks"})` : ""}` : "";
  return (
    <Animated.View entering={enter.fade} layout={layout}>
      <Squish
        label={`${pr.title}, #${pr.number}, ${STATE[pr.state].word.toLowerCase()}${asks ? ", needs you" : ""}${callLine ? `, its guide leaves you${callLine.slice(2)}` : ""}${verdict ? `, ${verdict.word.toLowerCase()}` : ""}, by ${who}, ${age(pr.updatedAt, now)}`}
        onPress={onPress}
        depth={0.985}
        highlight
        style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 60, paddingHorizontal: 10, paddingVertical: 9, borderRadius: radius.control }}
      >
        {/* A row carries the title, its number, one meta line and its size: the state's mark in grey, a check only
            when it fails, no branch, no verdict (its sheet has both), and no avatar: the meta line names who, unless it's you. */}
        <View style={{ width: 20, alignItems: "center" }}>
          <Icon name={STATE[pr.state].icon} size={16} color={c.muted} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {/* Row titles are 17/400 in every list (the state mark and line 2 carry the weight). */}
            <Text numberOfLines={1} style={[t.label, { flexShrink: 1, fontSize: 17, lineHeight: 22, fontWeight: "400", color: closed ? c.muted : c.text }]}>
              {pr.title}
            </Text>
            <Text style={t.meta}>#{pr.number}</Text>
            <ChecksGlyph checks={pr.checks} failingOnly />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text numberOfLines={1} style={[t.small, { flex: 1 }]}>
              {asks ? <Text style={{ color: c.warning }}>Needs you · </Text> : null}
              {age(pr.updatedAt, now)} · {repoName(pr.repo)}
              {pr.author === ME ? "" : ` · ${who}`}
              {callLine}
            </Text>
            <Stat add={size.add} del={size.del} />
          </View>
        </View>

      </Squish>
    </Animated.View>
  );
}

/**
 * One repository's section (RepoSection): a band on the card grey that folds it, with "owner / name" (the owner in
 * grey, the name in ink, the owner giving way first), its count, and what waits in it at the right: the amber dot and
 * how many need you, the red cross and how many fail. A phone keeps the figures and gives the words to the screen reader.
 */
function RepoBand({ repo, count, needsYou, failing, folded, onFold }: { repo: string; count: number; needsYou: number; failing: number; folded: boolean; onFold: () => void }) {
  const { c, t } = useTheme();
  const owner = repo.includes("/") ? repo.split("/")[0]! : null;
  return (
    <Squish
      label={`${repo}, ${count}${needsYou ? `, ${needsYou} ${needsYou === 1 ? "needs" : "need"} you` : ""}${failing ? `, ${failing} failing` : ""}. ${folded ? "Show" : "Fold"}`}
      onPress={onFold}
      depth={0.99}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        height: 44,
        marginTop: 16,
        marginBottom: 4,
        paddingHorizontal: 12,
        borderRadius: radius.control,
        borderWidth: 1,
        borderColor: c.hairline,
        backgroundColor: c.card,
      }}
    >
      <View style={{ transform: [{ rotate: folded ? "0deg" : "90deg" }] }}>
        <Icon name="chevronRight" size={14} color={c.muted} />
      </View>
      <Text numberOfLines={1} style={[t.row, { fontSize: 15, flexShrink: 1 }]}>
        {owner ? <Text style={{ color: c.muted }}>{owner} / </Text> : null}
        <Text style={{ fontWeight: "600" }}>{repoName(repo)}</Text>
      </Text>
      <Text style={t.meta}>{count}</Text>
      <View style={{ flex: 1 }} />
      {needsYou ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.warning }} />
          <Text style={[t.small, { color: c.text }]}>{needsYou}</Text>
        </View>
      ) : null}
      {failing ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <ChecksGlyph checks="failing" />
          <Text style={[t.small, { color: c.text }]}>{failing}</Text>
        </View>
      ) : null}
    </Squish>
  );
}

/** `below`: room kept under the last row for what floats over the page's foot (the moment's card, by default). */
export function ReviewScreen({ chats, onGuide, below = CARD_ROOM, onBack, line }: { chats: readonly Chat[]; below?: number; /** The stack's Back: the page wears the list shell (screens/Page.tsx ListPage). */ onBack: () => void; /** Under the title: what waits on you ("2 wait on you"). */ line?: string } & Actions) {
  const { c } = useTheme();
  const [query, setQuery] = useState("");
  // The search circle opens the search, with grouping and sorting beside it; closing it clears what was typed.
  const [searching, setSearching] = useState(false);
  const [grouping, setGrouping] = useState<"status" | "repo">("status");
  const [sort, setSort] = useState<Sort>("updated");
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const sent = reviews.use();
  const done = settled.use();
  const now = useNow(30_000);

  const all = useMemo(() => queueOf(chats, sent, now), [chats, sent, now, done]);
  const shown = useMemo(
    () =>
      sortPrs(
        all.filter((pr) => matches(pr, query)),
        sort,
      ),
    [all, query, sort],
  );
  const manyRepos = new Set(all.map((pr) => pr.repo)).size > 1;
  const byRepo = manyRepos && grouping === "repo";
  // Every row opens its guide: one screen for a chat's pull request and a teammate's alike.
  const press = (pr: Pr) => onGuide(guideId(pr));
  const fold = (repo: string) =>
    setFolded((was) => {
      const next = new Set(was);
      if (next.has(repo)) next.delete(repo);
      else next.add(repo);
      return next;
    });

  const menu: MenuEntry[] = [
    ...(manyRepos
      ? ([
          { type: "heading", label: "Group by" },
          { label: "Status", checked: grouping === "status", onPress: () => setGrouping("status") },
          { label: "Repository", checked: grouping === "repo", onPress: () => setGrouping("repo") },
          { type: "separator" },
        ] as MenuEntry[])
      : []),
    { type: "heading", label: "Sort" },
    ...(Object.keys(SORTS) as Sort[]).map((key) => ({ label: SORTS[key], checked: sort === key, onPress: () => setSort(key) })),
  ];

  const row = (pr: Pr, asks: boolean) => <PrRow key={prKey(pr)} pr={pr} now={now} asks={asks} onPress={() => press(pr)} />;

  return (
    <ListPage
      title="Review"
      line={line}
      onBack={onBack}
      below={below}
      right={
        <GlassButton
          icon={searching ? "close" : "search"}
          label={searching ? "Close search" : "Search pull requests"}
          onPress={() => {
            if (searching) setQuery("");
            setSearching((on) => !on);
          }}
        />
      }
      top={
        searching ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 16, marginBottom: 8 }}>
            <View style={{ flex: 1 }}>
              <SearchField value={query} onChangeText={setQuery} placeholder="Search pull requests" autoFocus />
            </View>
            <MenuButton label="Group and sort" entries={menu} width={240}>
              <View style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
                <Icon name="filter" size={20} color={c.muted} />
              </View>
            </MenuButton>
          </View>
        ) : null
      }
    >
      {/* The lists' one column: heads and glyph boxes at x 16 (6 here, 10 in each row), words at 48. */}
      <View style={{ paddingHorizontal: LIST_X - 10 }}>

      {all.length === 0 ? (
        <View style={{ paddingTop: 72 }}>
          <PageEmpty title="All clear" line="No open pull requests in your projects. New ones show here as agents open them." />
        </View>
      ) : shown.length === 0 ? (
        <View style={{ paddingTop: 72 }}>
          <PageEmpty title="No match" line={`Nothing here matches “${query.trim()}”.`} action={<Button label="Clear search" size="small" onPress={() => setQuery("")} />} />
        </View>
      ) : byRepo ? (
        groupByRepo(shown).map((group) => (
          <View key={group.repo}>
            <RepoBand repo={group.repo} count={group.prs.length} needsYou={group.needsYou} failing={group.failing} folded={folded.has(group.repo)} onFold={() => fold(group.repo)} />
            {folded.has(group.repo) ? null : group.prs.map((pr) => row(pr, pr.asksYou && !pr.mine && pr.state === "open"))}
          </View>
        ))
      ) : (
        groupQueue(shown).map((group, i) => (
          <View key={group.id} accessibilityRole="list" accessibilityLabel={group.label}>
            <Heading label={group.label} count={group.prs.length} dot={group.id === "needs_you"} tone="muted" first={i === 0} />
            {group.prs.map((pr) => row(pr, false))}
          </View>
        ))
      )}

      </View>
    </ListPage>
  );
}
