// The pull requests where what needs a signed-in person is listed: the sidebar's queue (sidebar/Sidebar.tsx), under
// the chats that ask, and the Needs you list (asks/NeedsList.tsx), under the asks. First those that wait on their
// review, then their own open ones, under the web's group names. One row each, at the lists' own
// column: the pull request's mark, its title, where it is and how long ago it changed, and its checks in one mark at
// the right. A row opens the pull request (PullScreen.tsx). While the list is read for the first time it says
// "Loading…"; with no GitHub link it says the one thing to do, with its button; a repository Cloud could not read is
// said once under the rows.
import type { PrSummary } from "@caveman-app/session-protocol";
import { Text, View } from "react-native";

import { Icon } from "../components/Icon";
import { PixelIcon } from "../components/Pixel";
import { Squish } from "../components/Squish";
import { Button } from "../components/ui/Button";
import { openPull } from "../nav/ref";
import { Heading, LIST_X, useNow } from "../screens/pages/parts";
import { layout, radius, useTheme } from "../theme";
import { connectGitHub } from "./live";
import type { ListView } from "./model";
import {
  CHECKS_SAID,
  CONNECT_BUTTON,
  CONNECT_GITHUB,
  GROUP_LABEL,
  LOADING,
  rowLine,
  STATE_WORD,
} from "./words";

/** How a pull request's checks stand, in one mark: a green check, a red cross, the working ring while they run. */
export function ChecksMark({ checks, size = 16 }: { checks: PrSummary["checks"]; size?: number }) {
  const { c } = useTheme();
  if (!checks) return null;
  if (checks === "pending")
    return <PixelIcon name="state-working" size={size} label="Checks running" />;
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={checks === "passing" ? "Checks pass" : "Checks fail"}
    >
      <Icon
        name={checks === "passing" ? "check" : "close"}
        size={size}
        stroke={2.25}
        color={checks === "passing" ? c.success : c.destructive}
      />
    </View>
  );
}

function PullRow({
  pr,
  now,
  onOpen,
}: {
  pr: PrSummary;
  now: number;
  onOpen?: (() => void) | undefined;
}) {
  const { c, t } = useTheme();
  const line = rowLine(pr, now);
  return (
    <Squish
      label={`${pr.title}, ${STATE_WORD[pr.state] ?? ""} pull request, ${line}${pr.checks ? `, ${CHECKS_SAID[pr.checks]}` : ""}`}
      onPress={() => {
        onOpen?.();
        openPull(pr.repo, pr.number);
      }}
      depth={0.985}
      highlight
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: layout.row.double,
        paddingHorizontal: 10,
        paddingVertical: 9,
        borderRadius: radius.control,
      }}
    >
      <View style={{ width: 20, alignItems: "center", alignSelf: "flex-start", paddingTop: 3 }}>
        <Icon name="pullRequest" size={16} color={c.muted} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text numberOfLines={2} style={[t.row, { fontSize: 17, lineHeight: 22 }]}>
          {pr.title}
        </Text>
        <Text numberOfLines={1} ellipsizeMode="middle" style={t.small}>
          {line}
        </Text>
      </View>
      <ChecksMark checks={pr.checks} />
    </Squish>
  );
}

/**
 * `first`: nothing stands over it (no ask), so it starts right under the page's title. `onOpen`: what the place that
 * lists them does as one opens (the sidebar puts itself away).
 */
export function PullRows({
  view,
  first,
  onOpen,
}: {
  view: ListView;
  first: boolean;
  onOpen?: () => void;
}) {
  const { c, t } = useTheme();
  const now = useNow(30_000);
  if (view.kind === "none") return null;
  const top = first ? 4 : 20;
  if (view.kind === "loading" || view.kind === "problem")
    return (
      <Text
        accessibilityLiveRegion="polite"
        style={[
          t.row,
          {
            fontSize: 15,
            lineHeight: 21,
            color: c.muted,
            paddingHorizontal: layout.inset,
            paddingTop: top,
          },
        ]}
      >
        {view.kind === "loading" ? LOADING : view.words}
      </Text>
    );
  if (view.kind === "connect")
    return (
      <View style={{ paddingHorizontal: layout.inset, paddingTop: top, gap: 12 }}>
        <Text style={[t.row, { fontSize: 15, lineHeight: 21, color: c.muted }]}>
          {CONNECT_GITHUB}
        </Text>
        <Button label={CONNECT_BUTTON} onPress={() => connectGitHub(view.url)} />
      </View>
    );
  return (
    // The lists' one column: heads and glyph boxes at x 16 (6 here, 10 in each row), words at 48.
    <View style={{ paddingHorizontal: LIST_X - 10, paddingTop: first ? 0 : 12 }}>
      {view.groups.map((group, i) => (
        <View key={group.id} accessibilityRole="list" accessibilityLabel={GROUP_LABEL[group.id]}>
          <Heading
            label={GROUP_LABEL[group.id]}
            count={group.prs.length}
            dot={group.id === "needs_you"}
            tone="muted"
            first={i === 0}
          />
          {group.prs.map((pr) => (
            <PullRow key={`${pr.repo}#${pr.number}`} pr={pr} now={now} onOpen={onOpen} />
          ))}
        </View>
      ))}
      {view.note ? (
        <Text
          style={[t.small, { paddingHorizontal: 10, paddingTop: view.groups.length > 0 ? 12 : 4 }]}
        >
          {view.note}
        </Text>
      ) : null}
    </View>
  );
}
