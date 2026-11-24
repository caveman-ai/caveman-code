// Deny and Allow where an ask sits inline (a Needs you row; any inline ask): the one pair (components/ui/Choices.tsx)
// at its 44 pt inline height, Deny on the control grey and Allow the one primary, sharing the width 8 apart.
// Neither hears a tap for ARM_MS after it appears, or after `armed` says the list just moved under the thumb, so a
// tap meant for something else (or the second of a double tap) never answers. Once answered, the pair gives way to
// the resolved line: what it is doing, and Undo standing where Allow was, for as long as Undo holds.
import { View } from "react-native";
import { RESOLVED_HEIGHT, ResolvedLine as Resolved, ApprovalPair as SharedPair } from "../../components/ui/Choices";

/** The pair's height, and the resolved line's: the row keeps its height when one becomes the other. */
export const PAIR_HEIGHT = 44;

export function ApprovalPair({
  command,
  onDeny,
  onAllow,
  armed,
}: {
  /** What it asks to run, for VoiceOver. */
  command: string;
  onDeny: () => void;
  onAllow: () => void;
  /** Whether a tap now is meant, given when the pair appeared; by default only the pair's own ARM_MS. */
  armed?: (since: number) => boolean;
}) {
  // The one pair (components/ui/Choices.tsx), at its inline height.
  return <SharedPair size="inline" command={command} onDeny={onDeny} onAllow={onAllow} armed={armed} />;
}

/**
 * What an answered ask says while Undo holds: the one resolved line (components/ui/Choices.tsx), the same in the
 * thread's dock and the Chief's deck. In a row it stands in the pair's 44 pt, so the row keeps its height.
 */
export function ResolvedLine({ yes, command, onUndo }: { yes: boolean; command: string; onUndo: () => void }) {
  return (
    <View style={{ marginVertical: (PAIR_HEIGHT - RESOLVED_HEIGHT) / 2 }}>
      <Resolved yes={yes} what={command} onUndo={onUndo} />
    </View>
  );
}
