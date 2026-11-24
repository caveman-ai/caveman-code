// The small pieces the Chief's dock, Ready card, peek and agents sheet share, each drawn as the desktop draws it: the
// command an approval waits on (the "waits on" box, and the dock's one-line chip), a change's files with their counts
// in the diff inks (TurnChanges), the facts of a change in one line, the one yes-and-no pair every place answers with,
// and the Undo bar that takes the pair's place in a sheet's row or a peek.
import { Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { type Moment, totals } from "../board/model";
import { Icon } from "../components/Icon";
import { enter } from "../motion";
import { ApprovalPair, ARM_MS, CommandChip, PAIR_HEIGHT, RESOLVED_HEIGHT, ResolvedLine } from "../components/ui/Choices";
import { mono, radius, useTheme } from "../theme";
import { type Pending, pendingWords } from "./decide";

/** Lines added and removed in the diff inks, with a true minus; a zero says nothing. */
export function Counts({ add, del, size = 12 }: { add: number; del: number; size?: number }) {
  const { c } = useTheme();
  const style = { fontSize: size, lineHeight: size + 5, fontWeight: "600" as const, fontVariant: ["tabular-nums" as const] };
  return (
    <View style={{ flexDirection: "row", gap: 6 }}>
      {add ? <Text style={[style, { color: c.added }]}>+{add}</Text> : null}
      {del ? <Text style={[style, { color: c.removed }]}>−{del}</Text> : null}
    </View>
  );
}

/** What an approval lets run: the same command chip as the docks and the Needs you list. */
export function CommandBox({ command }: { command: string }) {
  return <CommandChip command={command} />;
}

/** A change's files, each with its counts in their own column, under a hairline-edged card (TurnChanges' list). */
export function Files({ moment, max = 4 }: { moment: Moment; max?: number }) {
  const { c } = useTheme();
  const files = moment.files.slice(0, max);
  const rest = moment.files.length - files.length;
  return (
    <View style={{ borderWidth: 1, borderColor: c.hairline, borderRadius: radius.row, paddingVertical: 4 }}>
      {files.map((file) => (
        <View key={file.path} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 30, paddingHorizontal: 10 }}>
          {/* The folder gives way before the file's own name does. */}
          <View style={{ flex: 1, flexDirection: "row", minWidth: 0 }}>
            <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: mono, fontSize: 12.5, color: c.subtle }}>
              {file.path.slice(0, file.path.lastIndexOf("/") + 1)}
            </Text>
            <Text numberOfLines={1} style={{ flexShrink: 0, fontFamily: mono, fontSize: 12.5, color: c.soft }}>
              {file.path.slice(file.path.lastIndexOf("/") + 1)}
            </Text>
          </View>
          <Counts add={file.add} del={file.del} />
        </View>
      ))}
      {rest > 0 ? <Text style={{ fontSize: 12, lineHeight: 26, paddingHorizontal: 10, color: c.subtle }}>{rest} more</Text> : null}
    </View>
  );
}

/** A change in one line: its files and their counts, what holds, and its branch in mono (left out where a line of its own names it). */
export function Facts({ moment, branch = true }: { moment: Moment; branch?: boolean }) {
  const { c, t } = useTheme();
  const sum = totals(moment.files);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 6, rowGap: 2 }}>
      <Text style={t.small}>
        {moment.files.length} {moment.files.length === 1 ? "file" : "files"}
      </Text>
      <Counts add={sum.add} del={sum.del} size={13} />
      <Text style={t.small}>· {moment.checks}</Text>
      {branch ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginLeft: 4, flexShrink: 1 }}>
          <Icon name="branch" size={14} color={c.muted} />
          <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: mono, fontSize: 12.5, lineHeight: 18, color: c.muted }}>
            {moment.branch}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** How long the pair stays deaf after its card arrives or pages, so a tap meant for what was there never decides. */
export { ARM_MS };

/**
 * The one yes-and-no pair, everywhere the Chief's screen asks (the dock, the Ready card, a peek, a row of its agents):
 * 48pt capsules on the reference buttons' classes (ui/Button.tsx), the no at the left as the raised secondary, the yes
 * at the right as the one white action (DECISIONS.md: Deny | Allow, Later | Ship it). `armedAt` is when taps start to
 * count: before it, a press does nothing.
 */
export function Pair({ kind, onDecide, armedAt, size = "standard", command }: { kind: "ask" | "ready"; onDecide: (yes: boolean) => void; armedAt?: { current: number }; /** Inline in a sheet's row: 44. */ size?: "standard" | "inline"; command?: string }) {
  return (
    <ApprovalPair
      size={size}
      allow={kind === "ask" ? "Allow" : "Ship it"}
      deny={kind === "ask" ? "Deny" : "Later"}
      command={command}
      armed={(since) => (armedAt ? Date.now() >= armedAt.current : Date.now() - since >= ARM_MS)}
      onAllow={() => onDecide(true)}
      onDeny={() => onDecide(false)}
    />
  );
}

/** The pair's height, which the Undo bar keeps so nothing under it moves. */
const PAIR = PAIR_HEIGHT.standard;

/**
 * A decision waiting behind its Undo, drawn where its buttons were in a sheet's row or a peek: the one resolved line
 * (components/ui/Choices.tsx), the same as a Needs you row's and the thread's dock's, with an ask's whole command cut
 * from the middle. It stands on the sheet itself, in the pair's height, so nothing under it moves.
 */
export function UndoBar({ pending, onUndo }: { pending: Pending; onUndo: () => void }) {
  const { verb, what, code } = pendingWords(pending);
  // An ask says the exact command its chip showed, not a gist of it.
  const said = pending.card.kind === "ask" && pending.card.chat.ask ? pending.card.chat.ask : what;
  return (
    <Animated.View entering={enter.fade} style={{ marginVertical: (PAIR - RESOLVED_HEIGHT) / 2 }}>
      <ResolvedLine yes={pending.yes} verb={verb} what={said} code={code} onUndo={onUndo} />
    </Animated.View>
  );
}

/** The command an ask would run: the one command chip (components/ui/Choices.tsx), wrapping whole beside Allow. */
export { CommandChip };
