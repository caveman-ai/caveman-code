// Every button is this one (packages/ui/src/components/button.tsx, STYLE.md 5 "One primitive per control"), after the
// New chat button. `primary` is the one white action of a view (the monochrome primary: a light fill with ink on it
// in dark, ink with white on it in light). `secondary` is the raised card, ink at 5% with a hairline, one step above
// whatever it sits on. `quiet` is that card with grey words, a state you can still press ("Connected"). `ghost` is a
// quiet grey verb. `destructive` is red words in a red outline, never a red fill
// at rest. Words at 15pt and 500 (the desktop's 13 at 500), icons 18 in the words' colour. On a phone every button is
// one size and one shape: 44 pt tall and a capsule (radius half its height), 16 pt in from each end, so a near miss
// on Connect lands on Connect, never on the row under it. The 48 pt decision pairs are their own (ui/Choices.tsx);
// radius.control stays for what isn't a button (a code chip, a tile, the Changes pill).
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { alpha, useTheme } from "../../theme";
import { Icon, type IconName } from "../Icon";
import { Squish } from "../Squish";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "ghost" | "destructive";

/** A button's one height on the phone. */
export const BUTTON = 44;

export function Button({
  label,
  icon,
  onPress,
  variant = "secondary",
  disabled,
  stretch = false,
  hitSlop,
  accessibilityLabel,
}: {
  label: string;
  /** A chrome glyph by name, or a node (a pixel icon keeps its own colours). */
  icon?: IconName | ReactNode;
  onPress?: () => void;
  variant?: ButtonVariant;
  /** Kept for the screens that pass it: a phone's buttons are all 44 pt capsules. */
  size?: "default" | "small";
  disabled?: boolean;
  /** Fill the width it is given (a card's one action, a sheet's foot). */
  stretch?: boolean;
  /** Kept for the screens that pass it: every button is a capsule now. */
  round?: boolean;
  /** Touch room past its edges. */
  hitSlop?: number;
  accessibilityLabel?: string;
}) {
  const { c, t, dark } = useTheme();
  const look = {
    primary: { fill: c.primary, edge: undefined, ink: c.onPrimary },
    secondary: { fill: alpha(c.text, dark ? 0.06 : 0.04), edge: c.hairline, ink: c.text },
    // The secondary card with its words gone grey: a state that can still be pressed (Connect's "Connected").
    quiet: { fill: alpha(c.text, dark ? 0.04 : 0.03), edge: c.hairline, ink: c.muted },
    ghost: { fill: undefined, edge: undefined, ink: c.muted },
    destructive: { fill: undefined, edge: alpha(c.destructive, 0.45), ink: c.destructive },
  }[variant];
  return (
    <Squish
      label={accessibilityLabel ?? label}
      onPress={onPress}
      disabled={disabled}
      hitSlop={hitSlop}
      depth={0.97}
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        alignSelf: stretch ? "stretch" : "flex-start",
        height: BUTTON,
        paddingHorizontal: 16,
        borderRadius: BUTTON / 2,
        backgroundColor: look.fill,
        borderWidth: look.edge ? 1 : 0,
        borderColor: look.edge,
        ...(variant === "secondary" && !dark ? { shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } } : null),
      }}
    >
      {typeof icon === "string" ? <Icon name={icon as IconName} size={18} color={look.ink} /> : icon ? <View>{icon}</View> : null}
      <Text numberOfLines={1} style={[t.button, { fontSize: 15, fontWeight: "500", color: look.ink }]}>
        {label}
      </Text>
    </Squish>
  );
}

/**
 * A button that is only a glyph (the desktop's `size="icon"` ghost): 44pt to hit, the glyph in the description grey,
 * a round fill while held. Its label is what a screen reader says.
 */
export function IconButton({ icon, label, onPress, color, size = 20, disabled }: { icon: IconName; label: string; onPress?: () => void; color?: string; size?: number; disabled?: boolean }) {
  const { c } = useTheme();
  return (
    <Squish label={label} onPress={onPress} disabled={disabled} depth={0.88} style={{ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" }}>
      <Icon name={icon} size={size} color={color ?? c.muted} />
    </Squish>
  );
}
