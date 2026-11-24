// iOS: the system switch, through Expo UI (SwiftUI), so it feels exactly like Settings, tinted the monochrome primary
// as the desktop's switch is (switch.tsx: on is the primary, ink in light, white in dark); green stays a state.
// Disabled, SwiftUI dims it and lets no touch through.
import { Host, Toggle as SwiftToggle } from "@expo/ui/swift-ui";
import { disabled as off, labelsHidden, tint } from "@expo/ui/swift-ui/modifiers";
import { useTheme } from "../theme";

export function Toggle({ value, onChange, label, disabled = false }: { value: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  const { c, scheme } = useTheme();
  return (
    <Host matchContents colorScheme={scheme}>
      <SwiftToggle isOn={value} onIsOnChange={onChange} label={label} modifiers={[labelsHidden(), tint(c.primary), off(disabled)]} />
    </Host>
  );
}
