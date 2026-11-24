// What `+` opens, in the keyboard's place (place.ts; "opening the chat menu should push the
// text up so you can see it"). It rises from the screen's foot at the keyboard's own height, opaque, its top corners
// rounded as a sheet's, and the box rides 12pt over it as it rides over the keyboard, so the chat above stays in view
// and readable. With the keyboard up it is already there under it as the keyboard goes, so the swap moves nothing. It
// is coloured as the keyboard is: in dark a sheet's grey with lighter tiles, in light a pale grey with white tiles.
//
// Its first page is laid out to be seen whole at a keyboard's height, without scrolling: the phone's recent photos
// (screenshots among them), one tap each to attach (an ink ring and its number on what is), ending in "See all"
// (photos/Strip.tsx); then Mode, Plan, Grill me and Goal side by side, the one on lit; then Add: Photos (the system's
// picker), Camera, Files, another chat and Plugins as five tiles. The chat's settings (Permissions, a screen's own rows)
// follow under them. A Chief's box attaches nothing and has no modes: its page is its chats and its settings. Deeper
// pages (the whole library, the chats to name, a setting's choices) are pushed in place with a back chevron, and a
// swipe from the left brings the page before back. Plugins opens the Connect sheet, which is about something else, so
// it covers.
//
// A mode or an Add puts the menu away and hands the field back (Photos and Camera after their picker); a photo keeps it
// up for another.
import { type ReactNode, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import Animated, { type SharedValue, useAnimatedStyle } from "react-native-reanimated";
import { Icon } from "../../components/Icon";
import { ModeGlyph, PhoneGlyph, PixelIcon } from "../../components/Pixel";
import { Squish } from "../../components/Squish";
import { EngineLogo } from "../../components/ui/EngineLogo";
import { useInSheetFill } from "../../components/ui/Floating";
import type { MenuEntry, MenuRowItem } from "../../components/ui/Menu";
import { haptic } from "../../motion";
import { GRID_TITLE, PhotoGrid, PhotoStrip } from "../../photos/Strip";
import { pluginStore } from "../../screens/pages/plugins-model";
import { alpha, layout, sans, useTheme } from "../../theme";
import { PageStack } from "../PageStack";
import { SheetRow, useSheetFill } from "../Sheet";
import { openConnect } from "../ui";
import { type Attach, type ChatRef, GOAL, GRILL, type Mode, PLAN } from "./menus";

const MODES: readonly (Mode & { line: string })[] = [
  { ...PLAN, line: "Plan the change first, then build it on your go" },
  { ...GRILL, line: "Answer its questions before it builds" },
  { ...GOAL, line: "Keep pursuing one goal until it's met" },
];

/** At most this many chats to name: on their own page, and on a Chief's page. */
const CHATS = 8;
const CHIEF_CHATS = 6;
/** The tiles under Mode and Add. */
const TILE = 44;
const ADD_TILE = 62;
/** The menu's top corners: a sheet's, so it reads as the same family as what rises over a screen. */
const CORNER = 28;

/** What the menu stands on, and what its tiles do: the keyboard's colours (a pale grey under white keys in light). */
function useGround() {
  const { c, dark } = useTheme();
  const sheet = useSheetFill("half");
  return dark ? sheet : c.raised;
}
function useTileFill() {
  const { c, dark } = useTheme();
  const inSheet = useInSheetFill();
  return dark ? inSheet : c.panel;
}

type Page = { key: string } & ({ kind: "main" } | { kind: "shots" } | { kind: "chats" } | { kind: "menu"; title: string; entries: readonly MenuEntry[] });
const MAIN: Page = { key: "main", kind: "main" };

interface Props {
  /** It is up (or handing over to the keyboard, which rises over it). */
  open: boolean;
  /** How tall it stands from the screen's foot: the keyboard's height (place.ts menuHeight). */
  height: number;
  /** How far it has risen, 0 to `height`, on the UI thread: the box rides on the same number. */
  risen: SharedValue<number>;
  /** The home indicator's room at its foot. */
  foot: number;
  onClose: () => void;
  /** Where attachments are kept: the box's draft scope. */
  scope: string;
  /** A Chief's box: chats and settings only. */
  chief: boolean;
  mode: Mode | null;
  onMode: (mode: Mode | null) => void;
  /** Files, which the board answers for until a runtime is connected. */
  onFiles: (kind: Attach) => void;
  /** Photos (the system's picker) and Camera: the box puts the menu away and holds itself open around the picker. */
  onPick: (kind: "Images" | "Camera") => void;
  chats: readonly ChatRef[];
  self?: string;
  onMention: (name: string) => void;
  /** The chat's settings, as the desktop's menu rows (menus.tsx settingsEntries). */
  settings: readonly MenuEntry[];
}

/** A group's grey head ("Mode", "Add"): 15 regular, close over what it heads. */
function Head({ label, first = false }: { label: string; first?: boolean }) {
  const { c } = useTheme();
  return (
    <Text accessibilityRole="header" style={{ fontFamily: sans, fontSize: 15, lineHeight: 20, color: c.subtle, paddingHorizontal: 20, marginTop: first ? 0 : 14, marginBottom: 8 }}>
      {label}
    </Text>
  );
}

/** A deeper page's head: the back chevron at the left, its name in the middle. */
function PageHead({ title, onBack }: { title: string; onBack: () => void }) {
  const { c, t } = useTheme();
  const fill = useTileFill();
  return (
    <View style={{ height: 52, flexDirection: "row", alignItems: "center", paddingHorizontal: 12 }}>
      <Squish label={`Back from ${title}`} onPress={onBack} depth={0.88} hitSlop={4}>
        <View style={{ width: 36, height: 36, borderRadius: 18, margin: 4, backgroundColor: fill, alignItems: "center", justifyContent: "center" }}>
          <Icon name="chevronLeft" size={18} color={c.text} />
        </View>
      </Squish>
      <Text accessibilityRole="header" numberOfLines={1} style={[t.row, { flex: 1, textAlign: "center", fontSize: 17, lineHeight: 22, fontWeight: "600", color: c.text, marginRight: 44 }]}>
        {title}
      </Text>
    </View>
  );
}

/** A mode, side by side with the other two: its glyph and word on the in-sheet fill, lit while it is on. */
function ModeTile({ mode, on, onPress }: { mode: (typeof MODES)[number]; on: boolean; onPress: () => void }) {
  const { c, t } = useTheme();
  const fill = useTileFill();
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <Squish label={mode.label} selected={on} onPress={onPress} depth={0.95}>
        <View accessibilityHint={mode.line} style={{ height: TILE, borderRadius: 12, backgroundColor: on ? alpha(c.text, 0.16) : fill, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 8 }}>
          <ModeGlyph name={mode.icon} ink={on ? c.text : c.muted} />
          <Text numberOfLines={1} style={[t.row, { fontSize: 15, lineHeight: 20, color: on ? c.text : c.muted, flexShrink: 1 }]}>
            {mode.label}
          </Text>
        </View>
      </Squish>
    </View>
  );
}

/** Something to add: its pixel glyph over its word, five to a row. */
function AddTile({ label, glyph, count, hint, onPress }: { label: string; glyph: ReactNode; count?: number; hint?: string; onPress: () => void }) {
  const { c, t } = useTheme();
  const fill = useTileFill();
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <Squish label={count ? `${label}, ${count} on` : label} onPress={onPress} depth={0.94}>
        <View accessibilityHint={hint} style={{ height: ADD_TILE, borderRadius: 12, backgroundColor: fill, alignItems: "center", justifyContent: "center", gap: 6 }}>
          {glyph}
          <Text numberOfLines={1} style={[t.micro, { fontSize: 12, lineHeight: 15, color: c.muted }]}>
            {label}
          </Text>
          {count ? (
            <View pointerEvents="none" style={{ position: "absolute", top: 6, right: 6, minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, backgroundColor: alpha(c.text, 0.12), alignItems: "center", justifyContent: "center" }}>
              <Text style={[t.micro, { fontSize: 11, lineHeight: 14, color: c.text }]}>{count}</Text>
            </View>
          ) : null}
        </View>
      </Squish>
    </View>
  );
}

/** A menu row as a sheet row: its value or description under the label, a check or a chevron at the right. */
function EntryRow({ item, onOpen, onBack, onDone }: { item: MenuRowItem; onOpen: (title: string, entries: readonly MenuEntry[]) => void; onBack: () => void; onDone: () => void }) {
  const { c, t } = useTheme();
  // Every row keeps the icon slot, so labels line up whether or not a screen gave its row a glyph.
  const icon = typeof item.icon === "string" ? <Icon name={item.icon as never} size={20} color={c.muted} /> : (item.icon ?? <View style={{ width: 20 }} />);
  const right =
    item.submenu || item.value ? (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 }}>
        {item.value ? (
          <Text numberOfLines={1} style={[t.row, { color: c.muted, flexShrink: 1 }]}>
            {item.value}
          </Text>
        ) : null}
        <Icon name="chevronRight" size={16} color={c.subtle} />
      </View>
    ) : item.checked ? (
      <Icon name="check" size={18} stroke={2.2} color={c.text} />
    ) : undefined;
  return (
    <SheetRow
      icon={icon}
      label={item.label}
      detail={item.submenu || item.value ? undefined : item.description}
      hint={item.value}
      selected={item.checked}
      right={right}
      onPress={
        item.disabled
          ? undefined
          : () => {
              if (item.submenu) return onOpen(item.label, item.submenu);
              item.onPress?.();
              // A choice goes back to the list it was chosen for; anything else is done with the menu.
              if (item.keepOpen) return;
              if (item.checked !== undefined) onBack();
              else onDone();
            }
      }
    />
  );
}

function Entries({ entries, onOpen, onBack, onDone }: { entries: readonly MenuEntry[]; onOpen: (title: string, entries: readonly MenuEntry[]) => void; onBack: () => void; onDone: () => void }) {
  return (
    <>
      {entries.map((e, i) =>
        e.type === "heading" ? <Head key={`h${i}`} label={e.label} /> : e.type === "separator" ? <View key={`s${i}`} style={{ height: 12 }} /> : <EntryRow key={`${e.label}${i}`} item={e} onOpen={onOpen} onBack={onBack} onDone={onDone} />,
      )}
    </>
  );
}

export function ContextPanel({ open, height, risen, foot, onClose, scope, chief, mode, onMode, onFiles, onPick, chats, self, onMention, settings }: Props) {
  const { t } = useTheme();
  const { plugins } = pluginStore.use();
  const ground = useGround();
  const tileFill = useTileFill();
  const [pages, setPages] = useState<readonly Page[]>([MAIN]);
  // Each time it comes up it opens on its first page.
  useEffect(() => {
    if (open) setPages([MAIN]);
  }, [open]);

  const refs = chats.filter((ch) => ch.id !== self).slice(0, CHATS);
  const on = plugins.filter((p) => p.installed && p.enabled).length;
  const push = (next: Page) => setPages((was) => [...was, next]);
  const back = () => {
    haptic.tick();
    setPages((was) => (was.length > 1 ? was.slice(0, -1) : was));
  };
  const toMain = () => setPages([MAIN]);
  const openMenu = (title: string, entries: readonly MenuEntry[]) => push({ key: `menu:${title}`, kind: "menu", title, entries });
  const add = (kind: Attach) => {
    if (kind === "Images" || kind === "Camera") return onPick(kind);
    onClose();
    onFiles(kind);
  };

  const chatRows = (rows: readonly ChatRef[]) =>
    rows.map((ch) => (
      <SheetRow
        key={ch.id}
        icon={<EngineLogo engine={ch.engine} size={16} />}
        label={ch.title}
        detail={ch.repo}
        onPress={() => {
          onClose();
          onMention(ch.title);
        }}
      />
    ));

  const titleOf = (p: Page) => (p.kind === "shots" ? GRID_TITLE : p.kind === "chats" ? "Another chat" : p.kind === "menu" ? p.title : "Context");

  const main = chief ? (
    <>
      <Head label="Chats" first />
      {refs.length ? chatRows(refs.slice(0, CHIEF_CHATS)) : <Text style={[t.small, { paddingHorizontal: 20, paddingVertical: 12 }]}>No chats to name yet</Text>}
      {settings.length ? (
        <>
          <Head label="Settings" />
          <Entries entries={settings} onOpen={openMenu} onBack={toMain} onDone={onClose} />
        </>
      ) : null}
    </>
  ) : (
    <>
      <PhotoStrip scope={scope} fill={tileFill} onSeeAll={() => push({ key: "shots", kind: "shots" })} onPhotos={() => onPick("Images")} />
      <Head label="Mode" />
      <View accessibilityRole="radiogroup" style={{ flexDirection: "row", gap: 8, paddingHorizontal: layout.inset }}>
        {MODES.map((m) => {
          const picked = mode?.icon === m.icon;
          return (
            <ModeTile
              key={m.icon}
              mode={m}
              on={picked}
              onPress={() => {
                onMode(picked ? null : { icon: m.icon, label: m.label });
                onClose();
              }}
            />
          );
        })}
      </View>
      <Head label="Add" />
      <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: layout.inset }}>
        <AddTile label="Photos" glyph={<PhoneGlyph name="photo" size={20} />} onPress={() => add("Images")} />
        <AddTile label="Camera" glyph={<PhoneGlyph name="camera" size={20} />} onPress={() => add("Camera")} />
        <AddTile label="Files" glyph={<PixelIcon name="attach" size={20} />} onPress={() => add("Files")} />
        {refs.length ? <AddTile label="Chat" hint="Name one of your chats in what you write" glyph={<PhoneGlyph name="chat" size={20} />} onPress={() => push({ key: "chats", kind: "chats" })} /> : null}
        <AddTile label="Plugins" count={on} glyph={<PixelIcon name="spaces" size={20} />} onPress={() => openConnect("plugins")} />
      </View>
      {settings.length ? (
        <>
          <Head label="Settings" />
          <Entries entries={settings} onOpen={openMenu} onBack={toMain} onDone={onClose} />
        </>
      ) : null}
    </>
  );

  const body = (p: Page) => {
    if (p.kind === "chats") return chatRows(refs);
    if (p.kind === "menu") return <Entries entries={p.entries} onOpen={openMenu} onBack={toMain} onDone={onClose} />;
    return main;
  };
  const byKey = new Map(pages.map((p) => [p.key, p]));

  const style = useAnimatedStyle(() => ({ transform: [{ translateY: Math.max(0, height - risen.value) }] }));
  return (
    <Animated.View
      pointerEvents={open ? "auto" : "none"}
      accessibilityViewIsModal={false}
      aria-hidden={!open}
      style={[
        {
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height,
          borderTopLeftRadius: CORNER,
          borderTopRightRadius: CORNER,
          backgroundColor: ground,
          overflow: "hidden",
        },
        style,
      ]}
    >
      <PageStack
        pages={pages.map((p) => p.key)}
        render={(key) => {
          const p = byKey.get(key);
          if (!p) return null;
          return (
            <View style={{ flex: 1 }}>
              {p.kind === "main" ? null : <PageHead title={titleOf(p)} onBack={back} />}
              {/* The library scrolls itself, reading the next page as it nears its end. */}
              {p.kind === "shots" ? (
                <PhotoGrid scope={scope} fill={tileFill} foot={foot} />
              ) : (
                <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: p.kind === "main" ? 18 : 4, paddingBottom: foot + 12 }} showsVerticalScrollIndicator={false}>
                  {body(p)}
                </ScrollView>
              )}
            </View>
          );
        }}
        onBack={back}
        ground={ground}
      />
    </Animated.View>
  );
}
