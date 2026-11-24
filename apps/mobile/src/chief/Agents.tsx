// The Chief's floating row, in the composer's `above` slot (thread-C s4; native "3 Agents" pill and jump circle,
// IMG_5348/5349): one glass capsule at the left, at x 16 as in every chat, that says how its chats stand, and the
// jump-to-latest circle at the right while you're scrolled back. Between them stands the Chief, on the box's edge by
// the mic (Perch.tsx), so the capsule stops short of it. However many chats a Chief runs this stays one line, and a tap
// opens all of them in the agents sheet.
//
// The capsule says it in words with verbs, never a fraction: "1 working · 1 ready", counted from the one status
// function over this Chief's own chats (store/select.ts chiefList), so it, Home's row and the rosters in its chat never
// disagree. While an ask is docked the row isn't drawn at all (the dock says it); when one waits and isn't docked (you
// put the dock away, or you're on a call) a "Needs you" segment leads in amber, naming it, and a tap docks it again.
// While you tell an asking chat what to do instead, the capsule says who your words go to, with ✕ to take the ask back.
// While the Chief thinks, its thought takes the capsule's place. Just after its own last ask is answered while others
// wait anywhere, the capsule says for a few seconds which is next, on a thread's rules ("Next · Deploy the site to
// production? ›  1 of 2"). While a Ready card sits on the box its "1 of 2" is the count, so the counts make way.
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { Icon } from "../components/Icon";
import { PixelIcon } from "../components/Pixel";
import { Squish } from "../components/Squish";
import { Frost, GlassCircle } from "../components/ui/Floating";
import { alpha, layout, useTheme } from "../theme";
import { boxWidth, perchRoom, Thought } from "./Perch";
import { usePane } from "../shell/layout";

export interface Counts {
  needs: number;
  ready: number;
  working: number;
  total: number;
}

/** What the capsule says: "1 working · 1 ready"; with neither, how many are done; with nothing, nothing. */
export function workLine({ working, ready, total }: Counts): string | null {
  const parts = [working ? `${working} working` : "", ready ? `${ready} ready` : ""].filter(
    Boolean,
  );
  if (parts.length) return parts.join(" · ");
  return total ? `${total} done` : null;
}

interface Props {
  counts: Counts;
  /** What waits on you and isn't docked: the asking chat's name, and how to bring it back. */
  waiting: { name: string; onPress: () => void } | null;
  /** Telling an asking chat what to do instead: who the words go to, and how to go back to the ask. */
  instead: { name: string; onCancel: () => void } | null;
  /** What the Chief is thinking: its thought bubble shows here instead. */
  thought: string | null;
  /** For a few seconds after its last ask is answered: the next one waiting on another Chief or chat. */
  next?: { question: string; index: number; total: number; onPress: () => void } | null;
  /** A Ready card is up and says the count: the counts aren't drawn. */
  quiet?: boolean;
  /** Scrolled back from the latest line: the jump circle shows. */
  away: boolean;
  onAgents: () => void;
  onJump: () => void;
}

/** The row's height: one floating control. */
export const ROW = layout.float;

export function AgentsRow({
  counts,
  waiting,
  instead,
  thought,
  next = null,
  quiet = false,
  away,
  onAgents,
  onJump,
}: Props) {
  const { c, t } = useTheme();
  const { width } = usePane();
  const label = quiet ? null : workLine(counts);
  const seg = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 7,
    height: ROW,
    paddingHorizontal: 14,
  };
  const capsule = {
    height: ROW,
    borderRadius: ROW / 2,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    overflow: "hidden" as const,
    flexShrink: 1,
  };

  let left: ReactNode = null;
  if (instead) {
    left = (
      <Frost style={capsule}>
        <View
          style={[seg, { flexShrink: 1, paddingRight: 4 }]}
          accessible
          accessibilityLabel={`Your words go to ${instead.name}, in place of its ask`}
        >
          <Icon name="rename" size={16} color={c.muted} />
          <Text numberOfLines={1} style={[t.label, { flexShrink: 1, color: c.muted }]}>
            To {instead.name}
          </Text>
        </View>
        <Squish
          label="Back to the ask"
          onPress={instead.onCancel}
          depth={0.88}
          style={{ width: ROW, height: ROW, alignItems: "center", justifyContent: "center" }}
        >
          <Icon name="close" size={16} color={c.muted} />
        </Squish>
      </Frost>
    );
  } else if (thought) {
    left = (
      // Close to the Chief, its puffs trailing to its head; the lane keeps it from running under the character.
      <View
        style={{
          flex: 1,
          minWidth: 0,
          flexDirection: "row",
          justifyContent: "flex-end",
          paddingRight: 16,
        }}
      >
        <Thought text={thought} />
      </View>
    );
  } else if (next) {
    left = (
      <Frost interactive style={capsule}>
        {/* The press sits in a box that gives way, so a long question ellipsizes inside the capsule, never past it. */}
        <View style={{ flexShrink: 1, minWidth: 0 }}>
          <Squish
            label={`Next: ${next.question}, ${next.index} of ${next.total}. Open it`}
            onPress={next.onPress}
            depth={0.96}
            style={seg}
          >
            <Text numberOfLines={1} style={[t.label, { flexShrink: 1, color: c.text }]}>
              Next · {next.question}
            </Text>
            <Icon name="chevronRight" size={14} color={c.subtle} />
            <Text
              numberOfLines={1}
              style={[t.label, { flexShrink: 0, color: c.muted, fontVariant: ["tabular-nums"] }]}
            >
              {next.index} of {next.total}
            </Text>
          </Squish>
        </View>
      </Frost>
    );
  } else if (label || waiting) {
    // Glass never fades (Liquid Glass renders wrong under opacity): it is simply there, or not.
    left = (
      <Frost style={capsule}>
        {/* Amber only for what needs you: a wash over the glass, never a fill of its own. */}
        {waiting ? (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: alpha(c.warning, 0.14),
            }}
          />
        ) : null}
        {waiting ? (
          <>
            <Squish
              label={`Needs you: ${waiting.name}. Show the ask`}
              onPress={waiting.onPress}
              depth={0.96}
              style={[seg, { flexShrink: 1 }]}
            >
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: c.warning }} />
              <Text numberOfLines={1} style={[t.label, { flexShrink: 1, color: c.warning }]}>
                Needs you · {waiting.name}
              </Text>
            </Squish>
            {label ? (
              <View style={{ width: 1, height: 18, backgroundColor: alpha(c.warning, 0.3) }} />
            ) : null}
          </>
        ) : null}
        {label ? (
          <Squish
            label={`${label}. Show its agents`}
            onPress={onAgents}
            depth={0.96}
            style={[seg, waiting ? { flexShrink: 0 } : { flexShrink: 1 }]}
          >
            {waiting ? null : (
              <PixelIcon
                name={counts.working ? "state-working" : "state-done"}
                size={16}
                ink={counts.working ? c.muted : c.success}
                animate={!!counts.working}
              />
            )}
            <Text
              numberOfLines={1}
              style={[t.label, { flexShrink: 1, color: c.muted, fontVariant: ["tabular-nums"] }]}
            >
              {label}
            </Text>
          </Squish>
        ) : null}
      </Frost>
    );
  }

  return (
    <View
      pointerEvents="box-none"
      style={{ height: ROW, flexDirection: "row", alignItems: "center" }}
    >
      {/* The capsule's lane stops short of where the Chief stands. */}
      <View
        pointerEvents="box-none"
        style={{
          flexDirection: "row",
          alignItems: "center",
          width: boxWidth(width) - perchRoom(boxWidth(width)),
        }}
      >
        {left}
      </View>
      <View style={{ flex: 1 }} />
      {away ? (
        <GlassCircle icon="chevronDown" label="Go to the latest" onPress={onJump} size={22} />
      ) : null}
    </View>
  );
}
