// Settings > Appearance (apps/web/src/routes/settings/Appearance.tsx and Themes.tsx): light or dark, the desktop's
// theme gallery with a thumbnail of the app in each theme, and your companion with its skin tone. Text size, the code font and density stay on the desktop: a phone's
// text follows the system's own size.
import { CAST, SKIN_TONES, setCompanion, useCompanion } from "@caveman-app/ui/mascot/cast";
import type { SkinTone } from "@caveman-app/ui/mascot/poses";
import { useContext } from "react";
import { Pressable, Text, useColorScheme, View } from "react-native";
import { Icon } from "../../components/Icon";
import { Sprite } from "../../components/Sprite";
import { Segmented } from "../../components/ui/Segmented";
import { haptic } from "../../motion";
import { alpha, type Appearance, AppearanceContext, radius, useTheme } from "../../theme";
import { Card, CardLine, Page, SettingRow, useCardGreys } from "./kit";
import { useSettings } from "./store";
import { BUILT_IN_THEMES, type ColorTheme, onlyAppearance, type ThemeAppearance, type ThemePalette, themeHalf } from "./themes";

const MODES: readonly { value: Appearance; label: string }[] = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

/** Each tone's skin, for its swatch (pixel.css .px-skin-*, as Sprite.tsx draws it). */
const SKIN: Record<SkinTone, string> = { light: "#f7d4b6", "medium-light": "#f1b582", medium: "#d39563", "medium-dark": "#a5683f", dark: "#80593f" };

export function AppearanceSettings({ description }: { description: string }) {
  const { appearance, setAppearance } = useContext(AppearanceContext);
  const system = useColorScheme();
  const [s, save] = useSettings();
  const wanted: ThemeAppearance = appearance === "system" ? (system === "light" ? "light" : "dark") : appearance;
  const selected = BUILT_IN_THEMES.find((th) => th.id === s.color_theme) ?? BUILT_IN_THEMES[0]!;
  const only = onlyAppearance(selected);
  return (
    <Page description={description}>
      <Card title="Theme" description="Colours for the whole app: chats, code, diffs and the terminal.">
        <SettingRow label="Light or dark" description={only ? `${selected.name} is ${only} only, so it stays ${only}.` : "System follows your phone's light or dark setting."} stacked>
          <Segmented label="Light or dark" options={MODES} value={appearance} onChange={setAppearance} />
        </SettingRow>
        <View accessibilityRole="radiogroup" accessibilityLabel="Colour theme" style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, padding: 16 }}>
          {BUILT_IN_THEMES.map((theme) => (
            <ThemeTile key={theme.id} theme={theme} wanted={wanted} checked={theme.id === selected.id} onSelect={() => save({ color_theme: theme.id })} />
          ))}
        </View>
        {selected.id === "caveman" ? null : <CardLine>Every device on your runtime wears {selected.name}. This phone does once it's connected.</CardLine>}
      </Card>
      <Companion />
    </Page>
  );
}

/** A theme: a thumbnail of the app in it, its name, Dark or Light where it has only one, and a check on the pick. */
function ThemeTile({ theme, wanted, checked, onSelect }: { theme: ColorTheme; wanted: ThemeAppearance; checked: boolean; onSelect: () => void }) {
  const { c, t } = useTheme();
  const greys = useCardGreys();
  const only = onlyAppearance(theme);
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={theme.name}
      accessibilityState={{ checked }}
      onPress={() => {
        haptic.tick();
        onSelect();
      }}
      style={({ pressed }) => ({
        width: "47.5%",
        flexGrow: 1,
        gap: 6,
        padding: 6,
        borderRadius: radius.control,
        borderWidth: 1,
        // Chosen is the held grey and the check; no ring (nothing on the phone is chosen by a ring).
        borderColor: greys.line,
        backgroundColor: checked || pressed ? greys.held : undefined,
      })}
    >
      <ThemePreview p={themeHalf(theme, wanted)} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4, paddingBottom: 2 }}>
        <Text numberOfLines={1} style={[t.small, { flex: 1, color: c.text }]}>
          {theme.name}
        </Text>
        {only ? <Text style={[t.micro, { fontWeight: "400" }]}>{only === "dark" ? "Dark" : "Light"}</Text> : null}
        {checked ? <Icon name="check" size={15} stroke={2} color={c.text} /> : null}
      </View>
    </Pressable>
  );
}

/** A thumbnail of the app in a palette: the shell with a selected row, the panel with a few lines of code and a button. */
function ThemePreview({ p }: { p: ThemePalette }) {
  const line = (color: string, width: `${number}%`) => <View style={{ height: 3, borderRadius: 2, backgroundColor: color, width }} />;
  return (
    <View aria-hidden style={{ flexDirection: "row", height: 66, overflow: "hidden", borderRadius: 6, borderWidth: 1, borderColor: p.border, backgroundColor: p.shell }}>
      <View style={{ width: "27%", gap: 5, paddingHorizontal: 6, paddingVertical: 8 }}>
        {line(p.dim, "70%")}
        <View style={{ marginHorizontal: -2, paddingHorizontal: 2, paddingVertical: 3, borderRadius: 3, backgroundColor: p.hover }}>{line(p.text, "85%")}</View>
        {line(p.dim, "55%")}
        {line(p.dim, "65%")}
      </View>
      <View style={{ flex: 1, gap: 5, marginVertical: 4, marginRight: 4, paddingHorizontal: 8, paddingVertical: 8, borderRadius: 4, borderWidth: 1, borderColor: p.border, backgroundColor: p.panel }}>
        <View style={{ flexDirection: "row", gap: 4 }}>
          {line(p.purple, "22%")}
          {line(p.blue, "34%")}
        </View>
        <View style={{ flexDirection: "row", gap: 4, paddingLeft: 8 }}>
          {line(p.text, "18%")}
          {line(p.green, "40%")}
        </View>
        <View style={{ flexDirection: "row", gap: 4, paddingLeft: 8 }}>
          {line(p.orange, "14%")}
          {line(p.dim, "30%")}
        </View>
        <View style={{ marginTop: "auto", flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 4 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: p.red }} />
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: p.yellow }} />
          <View style={{ width: 24, height: 9, borderRadius: 5, backgroundColor: p.accent }} />
        </View>
      </View>
    </View>
  );
}

/** Who stands in the new chat, the empty states and the working line, and their skin tone (the cast's own store). */
function Companion() {
  const { c, t } = useTheme();
  const greys = useCardGreys();
  const { character, tone } = useCompanion();
  const current = CAST.find((m) => m.id === character) ?? CAST[0]!;
  const groups = [
    { label: "People", members: CAST.filter((m) => m.skin) },
    { label: "Animals", members: CAST.filter((m) => !m.skin) },
  ];
  return (
    <Card title="Companion" description={`${current.name}: ${current.line}`}>
      <View accessibilityRole="radiogroup" accessibilityLabel="Companion" style={{ gap: 12, padding: 16 }}>
        {groups.map((g) => (
          <View key={g.label} style={{ gap: 6 }}>
            <Text style={t.group}>{g.label}</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 10, rowGap: 6 }}>
              {g.members.map((m) => {
                const on = m.id === character;
                return (
                  <Pressable
                    key={m.id}
                    accessibilityRole="radio"
                    accessibilityLabel={m.name}
                    accessibilityState={{ checked: on }}
                    onPress={() => {
                      haptic.tick();
                      setCompanion({ character: m.id });
                    }}
                    style={({ pressed }) => ({
                      width: 56,
                      height: 56,
                      borderRadius: radius.row,
                      borderWidth: 1,
                      borderColor: on ? alpha(c.text, 0.4) : "transparent",
                      backgroundColor: on || pressed ? greys.held : undefined,
                      alignItems: "center",
                      justifyContent: "center",
                    })}
                  >
                    <Sprite character={m.id} tone={tone} pose="wave" size={32} animate={false} />
                  </Pressable>
                );
              })}
            </View>
          </View>
        ))}
      </View>
      <SettingRow label="Skin tone" description={current.skin ? undefined : `${current.name} has no skin tone.`}>
        <View accessibilityRole="radiogroup" accessibilityLabel="Skin tone" style={{ flexDirection: "row", gap: 2 }}>
          {SKIN_TONES.map((tn, i) => {
            const on = tn === tone;
            return (
              <Pressable
                key={tn}
                accessibilityRole="radio"
                accessibilityLabel={`Skin tone ${i + 1} of ${SKIN_TONES.length}`}
                accessibilityState={{ checked: on, disabled: !current.skin }}
                disabled={!current.skin}
                onPress={() => {
                  haptic.tick();
                  setCompanion({ tone: tn });
                }}
                style={{ width: 36, height: 44, alignItems: "center", justifyContent: "center", opacity: current.skin ? 1 : 0.4 }}
              >
                <View style={{ width: 30, height: 30, borderRadius: radius.row, borderWidth: 1, borderColor: on ? alpha(c.text, 0.4) : "transparent", alignItems: "center", justifyContent: "center" }}>
                  <View style={{ width: 18, height: 18, borderRadius: 3, backgroundColor: SKIN[tn] }} />
                </View>
              </Pressable>
            );
          })}
        </View>
      </SettingRow>
    </Card>
  );
}
