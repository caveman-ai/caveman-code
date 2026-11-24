// The pieces every Settings section is built from, the desktop's rows.tsx at a phone's size. A section is a stack of
// cards and nothing hand-laid:
//
//   <Card title description action>     a heading and one line above one card of rows
//     <SettingRow label description>{control}</SettingRow>   a switch, a button, a status at the right
//     <SettingRow label stacked>{wide control}</SettingRow>   a segmented control, a gallery, under the words
//     <ChoiceRow label value entries />                       a few choices: the value in grey, a menu from the row
//     <SettingRow label onPress chevron />                    a row that opens something
//
// Rows are the desktop's SettingRow: the label at row size, a short grey line under it, the control at the right, a
// hairline between rows, one card a step above its ground with its hairline edge. A row you can press lights while
// held, as the desktop's lights on hover.
import { Children, createContext, Fragment, isValidElement, type ReactNode, useContext, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Button } from "../../components/ui/Button";
import { Icon, type IconName } from "../../components/Icon";
import { type Anchor, Menu, type MenuEntry, useAnchor } from "../../components/ui/Menu";
import { haptic } from "../../motion";
import { alpha, radius, useTheme } from "../../theme";
import { useCarried } from "../PageStack";
import type { SectionId } from "./sections";

/** What a section can ask of the sheet around it (SettingsSheet provides it). */
export interface SettingsNav {
  /** The page is being swiped away under the finger: a row it began on stays shut. */
  carrying?: () => boolean;
  /** Another section, in place. */
  open: (id: SectionId) => void;
  /** The model picker for new chats on one harness, over Settings. */
  pickModel: (harness: string) => void;
  /** A Chief's own screen (its settings live there, as on the desktop); undefined where the app can't route there. */
  openChief?: (id: string) => void;
  /** The app's toast: what the prototype can't do until it talks to a runtime. */
  notify: (text: string) => void;
}

export const SettingsNavContext = createContext<SettingsNav>({ open: () => {}, pickModel: () => {}, notify: () => {} });
export const useSettingsNav = () => useContext(SettingsNavContext);

/**
 * The greys a card is drawn in. Settings sits on the sheet's grey, as every large sheet does, so in dark a card takes
 * the raised grey a step above it, ruled in the edge grey, and a held row a step above that; in light the cards are
 * white on white with their hairline edge. `well` is a recess inside a card (a subscription tile), the page's grey.
 */
export function useCardGreys() {
  const { c, dark } = useTheme();
  return { fill: dark ? c.raised : c.card, line: dark ? c.edge : c.hairline, held: dark ? alpha(c.text, 0.1) : c.raised, well: c.popover };
}

/** The page under the header: its one line, then its cards. */
export function Page({ description, children }: { description: string; children: ReactNode }) {
  const { t } = useTheme();
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 4, gap: 28 }}>
      <Text style={[t.small, { paddingHorizontal: 4 }]}>{description}</Text>
      {children}
    </View>
  );
}

/** The rows a card holds, with any fragment opened up, so a hairline goes between every two. */
function rows(children: ReactNode): ReactNode[] {
  return Children.toArray(children).flatMap((child) => (isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment ? rows(child.props.children) : [child]));
}

/** A heading and one line above one card of rows; `action` is the card-wide verb, level with the heading (New Chief). */
export function Card({ title, description, action, children }: { title?: string; description?: ReactNode; action?: ReactNode; children: ReactNode }) {
  const { t } = useTheme();
  const greys = useCardGreys();
  const list = rows(children);
  return (
    <View style={{ gap: 10 }}>
      {title || description || action ? (
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 12, paddingHorizontal: 4 }}>
          <View style={{ flex: 1, gap: 2 }}>
            {title ? (
              <Text accessibilityRole="header" style={t.label}>
                {title}
              </Text>
            ) : null}
            {description ? <Text style={t.small}>{description}</Text> : null}
          </View>
          {action}
        </View>
      ) : null}
      {list.length > 0 ? (
        <View style={{ borderRadius: radius.card, borderWidth: 1, borderColor: greys.line, backgroundColor: greys.fill, overflow: "hidden" }}>
          {list.map((row, i) => (
            <View key={i} style={i > 0 ? { borderTopWidth: 1, borderTopColor: greys.line } : undefined}>
              {row}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export interface SettingRowProps {
  label: ReactNode;
  /** A short grey line under the label: what it does, its state. */
  description?: ReactNode;
  /** A leading mark in a 20pt slot: a logo, a pixel icon, a Chief's character. */
  icon?: ReactNode;
  /** The control at the right, or under the words when `stacked`. */
  children?: ReactNode;
  /** A wide control (a segmented choice, a gallery) under the words at full width. */
  stacked?: boolean;
  /** The current choice in grey at the right, before a chevron. */
  value?: string;
  /** A mark before the value: the engine's logo beside its name. */
  valueMark?: ReactNode;
  /** A chevron at the end: the row opens something. */
  chevron?: boolean;
  /** The line runs under the control at full width (the default for a row with a value). */
  under?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
}

/**
 * One setting, as the desktop's SettingRow: label and line at the left, the control at the right. A row whose right
 * holds more than a switch (a value, a button) keeps that on the label's line and lets the line under it run the full
 * width, as the desktop's row wraps its control when the card is narrow.
 */
export function SettingRow({ label, description, icon, children, stacked, value, valueMark, chevron, under, onPress, accessibilityLabel }: SettingRowProps) {
  const { c, t } = useTheme();
  const greys = useCardGreys();
  const nav = useSettingsNav();
  const [held, setHeld] = useState(false);
  // A swipe back that began on the row carries the page: the row doesn't stay lit under the finger.
  const carried = useCarried();
  const name = typeof label === "string" ? <Text style={t.row}>{label}</Text> : label;
  const line = description ? typeof description === "string" ? <Text style={t.small}>{description}</Text> : description : null;
  const lead = icon ? <View style={{ minWidth: 20, alignItems: "center", justifyContent: "center" }}>{icon}</View> : null;
  const wrap = line !== null && (under ?? value !== undefined);
  // On the label's line a small button keeps the line at text height, centred on it and reaching past it, and the
  // line under it steps down to clear it.
  const trail = (
    <>
      {children ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 0, height: wrap ? 22 : undefined }}>{children}</View> : null}
      {value !== undefined || chevron ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0, maxWidth: "55%" }}>
          {valueMark ? <View style={{ marginRight: 4 }}>{valueMark}</View> : null}
          {value !== undefined ? (
            <Text numberOfLines={1} style={[t.row, { color: c.muted, flexShrink: 1 }]}>
              {value}
            </Text>
          ) : null}
          <Icon name="chevronRight" size={16} color={c.muted} />
        </View>
      ) : null}
    </>
  );
  const body = stacked ? (
    <View style={{ gap: 12, paddingHorizontal: 16, paddingVertical: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        {lead}
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          {name}
          {line}
        </View>
      </View>
      {children}
    </View>
  ) : wrap ? (
    <View style={{ gap: 2, minHeight: 56, paddingHorizontal: 16, paddingVertical: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 22 }}>
        {lead}
        <View style={{ flex: 1, minWidth: 0 }}>{name}</View>
        {trail}
      </View>
      <View style={{ paddingLeft: lead ? 32 : 0, paddingRight: 20, marginTop: children ? 6 : 0 }}>{line}</View>
    </View>
  ) : (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingHorizontal: 16, paddingVertical: 12 }}>
      {lead}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        {name}
        {line}
      </View>
      {trail}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? [typeof label === "string" ? label : undefined, value].filter(Boolean).join(", ")}
      onPressIn={() => setHeld(true)}
      onPressOut={() => setHeld(false)}
      onPress={() => {
        if (nav.carrying?.()) return;
        haptic.tick();
        onPress();
      }}
      style={{ backgroundColor: held && !carried.now ? greys.held : undefined }}
    >
      {body}
    </Pressable>
  );
}

/**
 * A setting with a few choices (the desktop's Select): the current one in grey and a chevron, and the choices as a
 * menu hung from the row, the chosen one checked.
 */
export function ChoiceRow({ entries, width, ...row }: Omit<SettingRowProps, "onPress" | "chevron" | "children" | "stacked" | "under"> & { entries: readonly MenuEntry[]; width?: number }) {
  const { ref, measure } = useAnchor();
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <View ref={ref} collapsable={false}>
        <SettingRow
          {...row}
          chevron
          onPress={async () => {
            setAnchor(await measure());
            setOpen(true);
          }}
        />
      </View>
      <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" width={width ?? 280} entries={entries} />
    </>
  );
}

/** One of several, as a menu's rows: each with its line under it where it has one, the current one checked. */
export function choices<T extends string | number | null>(options: readonly { value: T; label: string; description?: string; icon?: ReactNode }[], current: T, onPick: (value: T) => void): MenuEntry[] {
  return options.map((o) => ({ label: o.label, description: o.description, under: !!o.description, icon: o.icon, checked: o.value === current, onPress: () => onPick(o.value) }));
}

/** A small button at a row's right (the desktop's size="sm"): Manage, Sign out, Install, "+ Add". */
export function RowButton({ label, icon, onPress, variant = "secondary", disabled, accessibilityLabel }: { label: string; icon?: IconName; onPress?: () => void; variant?: "primary" | "secondary" | "ghost" | "destructive"; disabled?: boolean; accessibilityLabel?: string }) {
  return <Button label={label} icon={icon} size="small" variant={variant} onPress={onPress} disabled={disabled} accessibilityLabel={accessibilityLabel} />;
}

/** A status led by its dot (Computers' Status): green online or running, red failing, grey asleep or starting. */
export function Status({ tone, children }: { tone: "ok" | "idle" | "bad"; children: string }) {
  const { c, t } = useTheme();
  const dot = tone === "ok" ? c.success : tone === "bad" ? c.destructive : alpha(c.muted, 0.6);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dot }} />
      <Text numberOfLines={1} style={[t.small, { flexShrink: 1 }]}>
        {children}
      </Text>
    </View>
  );
}

/** A plain line inside a card that isn't a row (an empty list, a note), at the rows' inset. */
export function CardLine({ children, tone }: { children: ReactNode; tone?: "bad" }) {
  const { c, t } = useTheme();
  return <Text style={[t.small, { paddingHorizontal: 16, paddingVertical: 14 }, tone === "bad" ? { color: c.destructive } : null]}>{children}</Text>;
}
