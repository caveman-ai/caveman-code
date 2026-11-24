// A chat's state word, the same on every screen (Search, the lists, a Chief's agents sheet, a parent's, Peek): Needs
// you in `warning` amber, Ready in `success` green, Working, Done and Merged in `muted`, all at 500. It is the one
// coloured word on its line; whatever follows it stays 400 `muted`.
import { Text } from "react-native";
import type { Phase } from "../../board/model";
import { STATE_WORD } from "../../components/ui/WorkLink";
import { useTheme, weight } from "../../theme";

/** The colour a state word wears. */
export function stateInk(phase: Phase, c: ReturnType<typeof useTheme>["c"]): string {
  return phase === "needs" ? c.warning : phase === "ready" ? c.success : c.muted;
}

export function StateWord({ phase, word }: { phase: Phase; /** In place of the state's own word ("Merged", "Waiting for Studio"). */ word?: string }) {
  const { c } = useTheme();
  return <Text style={{ color: stateInk(phase, c), fontWeight: weight.medium }}>{word ?? STATE_WORD[phase]}</Text>;
}
