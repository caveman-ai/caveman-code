// The model picker on a phone: the desktop's (packages/ui/src/components/model-picker.tsx, STYLE.md 11) with
// its names and its order, at a finger's density. One list under the sheet's search, in
// sections by harness with the sheet's grey heads (the Caveman engine's connections each under their own, "Caveman ·
// Anthropic"), no rail. A row is 52pt: the model's vendor mark at 20, its name at 17, "Default" in grey where new
// chats start on it, and a check on the chat's model. Your favorites lead the list. Older models wait behind one
// "Older models" row at the foot, and search finds every model, older ones too. Effort is the slider under the list,
// a stop for every level the model offers, and a model with a faster speed gets the bolt beside it (the founder,
// 2026-11-06: "make effort a slider as well with a lightning icon next to it"). Nothing
// in a session says what a model costs (spend lives in Settings), so there are no price tiers and no smarts bars.
// Arranging is behind the sheet's Edit: only then does each row offer its star and each favorite its handle, so a
// fling down the list never moves a row. A row's long-press still names the model, stars it or makes it the default.
//
// What it lists is handed to it (`engines`): the scripted catalog, or on the person's own board what the chat's place
// runs (live/engines.ts), so nothing is offered that its computer lacks. While that place has nothing to list, one
// line stands in the list's place and says what it waits for or what to do (`line`); under a Cloud list, why an agent
// Cloud runs is not in it (`missing`).
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, type ScrollViewInstance, Text, useWindowDimensions, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { type CatalogEngine, type Entry, entryKey, findEntry, type Level, matches, modelKey, type ModelRef, moveKey, pickEffort, SCRIPTED, setChoices, speedLabel, STANDARD, startOf, useChoices } from "../../board/catalog";
import { Icon } from "../../components/Icon";
import { BrandMark, type BrandName } from "../../components/ui/BrandMark";
import { effortLabel, EngineLogo, modelVendor, nameBesideMark } from "../../components/ui/EngineLogo";
import { SearchField } from "../../components/ui/Field";
import { type Anchor, Menu, type MenuEntry, useAnchor } from "../../components/ui/Menu";
import { EffortSlider, SpeedToggle } from "../../components/ui/Effort";
import { duration, ease, enter, haptic } from "../../motion";
import { alpha, useTheme } from "../../theme";
import { SheetLabel } from "../Sheet";
import { FadeScroll } from "./parts";

/** A model's row. */
const ROW = 52;

/**
 * A model's mark: its vendor's (Claude for Claude Agent, OpenAI for Codex, the connection's on the Caveman engine and
 * on OpenCode, so Kimi wears Moonshot's), else its harness's own logo. The caveman marks only the Caveman engine's own
 * models (Auto).
 */
function vendorOf(e: Entry): BrandName | undefined {
  if (e.engine.id === "opencode") return modelVendor("caveman", e.model.id) ?? modelVendor(e.engine.id);
  return modelVendor(e.engine.id, e.model.id);
}

/** A section: a harness, or one of the Caveman engine's connections ("Caveman · Anthropic"). */
interface Section {
  key: string;
  title: string;
  entries: Entry[];
}

/**
 * The catalog in the desktop's order, in sections. Caveman's own (Auto, what Caveman credits serve) sit under
 * "Caveman"; a connection of yours under "Caveman · <connection>". An agent that names no model is one row by its
 * own name (live/engines.ts): such rows stand together under no head, which would only say each name twice.
 */
function sectionsOf(engines: readonly CatalogEngine[], keep: (e: Entry) => boolean): Section[] {
  const out = new Map<string, Section>();
  for (const engine of engines)
    for (const model of engine.models) {
      const e = { engine, model };
      if (!keep(e)) continue;
      const own = !model.source || model.source === "Caveman credits" ? null : model.source;
      const bare = model.id === "";
      const key = bare ? "agents" : own ? `${engine.id}:${own}` : engine.id;
      const section = out.get(key) ?? { key, title: bare ? "" : sectionTitle(e), entries: [] };
      out.set(key, section);
      section.entries.push(e);
    }
  return [...out.values()];
}

/** The head a model sits under: its harness, or "Caveman · <connection>". */
const sectionTitle = (e: Entry) => {
  const own = !e.model.source || e.model.source === "Caveman credits" ? null : e.model.source;
  return own ? `${e.engine.label} · ${own}` : e.engine.label;
};

/** A favorite's key back to its model, where what is listed still has it. */
function findFavorite(key: string, engines: readonly CatalogEngine[]): Entry | undefined {
  const [engine, ...rest] = key.split("/");
  const model = rest.join("/");
  const e = engines.find((x) => x.id === engine);
  const m = e?.models.find((x) => x.id === model);
  return e && m ? { engine: e, model: m } : undefined;
}

export interface ModelPickerProps {
  /** The chat's model, by harness id ("claude-agent") and the model's id or name. */
  current: ModelRef | null;
  /** The chat's effort and speed. */
  effort?: string;
  speed?: string;
  onPick: (ref: ModelRef) => void;
  onEffort: (level: Level) => void;
  onSpeed: (speed: string) => void;
  /** What it lists: the place's own agents and models on the person's board; absent, the scripted catalog. */
  engines?: readonly CatalogEngine[];
  /** In the list's place while there is nothing to list: what it waits for, or what to do and where. */
  line?: string | null;
  /** Under the list: why an agent is not in it, one sentence each. */
  missing?: readonly string[];
  /** One harness's models alone, with no favorites and no Edit (Settings > General's model for that harness). */
  only?: string;
  /** "Connect models" at the list's foot: where models are connected (Settings). */
  onManageModels?: () => void;
  /** The sheet's Edit is on: rows offer their star, favorites their handle, and a tap stars. */
  editing?: boolean;
}

export function ModelPicker({ current, effort, speed, onPick, onEffort, onSpeed, engines: listed = SCRIPTED, line = null, missing, only, onManageModels, editing = false }: ModelPickerProps) {
  const { c, t } = useTheme();
  const { height: screen } = useWindowDimensions();
  const choices = useChoices();
  const engines = useMemo(() => (only ? listed.filter((e) => e.id === only) : listed), [listed, only]);
  // A chat on a model its place does not list by name runs on its agent's own: that agent's one row, where it has one.
  const now = current ? (findEntry(current.engine, current.model, engines) ?? findEntry(current.engine, "", engines)) : undefined;
  const [query, setQuery] = useState("");
  const q = query.trim();
  // Older models open on their own when the chat's model is one of them.
  const [older, setOlder] = useState(() => !!now?.model.legacy);
  // The list keeps one height whatever is typed, so the sheet never jumps under the thumb.
  const listHeight = Math.round(Math.min(ROW * 8 + 56, screen * 0.44));
  // It opens with the chat's model in view, as the desktop's opens with it active: once its section and its row have
  // been laid out, the list scrolls it to the middle.
  const scroller = useRef<ScrollViewInstance>(null);
  const spot = useRef({ section: -1, row: -1, done: false });
  const reveal = (part: "section" | "row", y: number) => {
    const s = spot.current;
    s[part] = y;
    if (s.done || s.section < 0 || s.row < 0) return;
    s.done = true;
    const at = s.section + s.row;
    if (at + ROW > listHeight) scroller.current?.scrollTo({ y: Math.max(0, at - (listHeight - ROW) / 2), animated: false });
  };

  const favorites = useMemo(() => (only ? [] : choices.favorites.flatMap((k) => findFavorite(k, engines) ?? [])), [choices.favorites, only, engines]);
  const sections = useMemo(() => sectionsOf(engines, (e) => (q ? matches(e, q) : !e.model.legacy)), [engines, q]);
  const olderSections = useMemo(() => (q ? [] : sectionsOf(engines, (e) => e.model.legacy === true)), [engines, q]);
  const olderCount = olderSections.reduce((n, s) => n + s.entries.length, 0);
  const defaultKey = modelKey(choices.defaultModel);
  const isCurrent = (e: Entry) => !!now && entryKey(e) === entryKey(now);

  // A favorite being carried by its handle: the order as it was, where it is now and how far the finger took it.
  const [drag, setDrag] = useState<{ key: string; start: string[]; from: number; to: number; dy: number } | null>(null);
  const carrying = useRef(drag);
  carrying.current = drag;
  const shownFavorites = drag ? moveKey(drag.start, drag.key, drag.to).flatMap((k) => favorites.find((e) => entryKey(e) === k) ?? []) : favorites;
  const saveOrder = (order: string[]) => setChoices((was) => ({ ...was, favorites: order }));

  const star = (e: Entry) => {
    const key = entryKey(e);
    haptic.tick();
    setChoices((was) => (was.favorites.includes(key) ? { ...was, favorites: was.favorites.filter((k) => k !== key) } : { ...was, favorites: [...was.favorites, key] }));
  };

  // A row's long-press: the desktop's star and its default, for a finger.
  const [rowMenu, setRowMenu] = useState<{ entry: Entry; anchor: Anchor | null } | null>(null);
  const menuEntries = (entry: Entry): MenuEntry[] => {
    const key = entryKey(entry);
    const starred = choices.favorites.includes(key);
    return [
      { label: starred ? "Remove from favorites" : "Add to favorites", icon: <Icon name="star" size={20} color={c.muted} filled={starred} />, onPress: () => star(entry) },
      {
        label: key === defaultKey ? "New chats start here" : "Make it the default",
        description: key === defaultKey ? undefined : "New chats start on it",
        under: true,
        icon: "home",
        disabled: key === defaultKey,
        onPress: () => setChoices((was) => ({ ...was, defaultModel: { engine: entry.engine.id, model: entry.model.id } })),
      },
    ];
  };


  const row = (e: Entry, i: number, favorite: boolean) => {
    const key = entryKey(e);
    const carried = favorite && drag && drag.key === key ? drag.dy - (drag.to - drag.from) * ROW : undefined;
    return (
      <ModelRow
        key={`${favorite ? "fav" : "all"}:${key}`}
        entry={e}
        vendor={vendorOf(e)}
        // A favorite sits outside its harness's section, so it says whose it is.
        harness={favorite ? sectionTitle(e) : undefined}
        divided={i > 0}
        selected={isCurrent(e)}
        isDefault={key === defaultKey}
        starred={choices.favorites.includes(key)}
        editing={editing}
        open={!!rowMenu && entryKey(rowMenu.entry) === key}
        carried={carried}
        grip={
          favorite && editing && !q
            ? {
                onStart: () => {
                  const start = favorites.map(entryKey);
                  const from = start.indexOf(key);
                  setDrag({ key, start, from, to: from, dy: 0 });
                },
                onMove: (dy) => setDrag((d) => (d ? { ...d, dy, to: Math.max(0, Math.min(d.start.length - 1, d.from + Math.round(dy / ROW))) } : d)),
                onEnd: (keep) => {
                  const d = carrying.current;
                  setDrag(null);
                  if (!d || !keep || d.to === d.from) return;
                  haptic.done();
                  saveOrder(moveKey(d.start, d.key, d.to));
                },
                onStep: (by) => {
                  const start = favorites.map(entryKey);
                  saveOrder(moveKey(start, key, start.indexOf(key) + by));
                },
              }
            : undefined
        }
        onPress={() => (editing ? star(e) : onPick({ engine: e.engine.id, model: e.model.id }))}
        onStar={() => star(e)}
        onMenu={(anchor) => setRowMenu({ entry: e, anchor })}
        onLayout={!favorite && isCurrent(e) ? (y) => reveal("row", y) : undefined}
      />
    );
  };

  return (
    <View style={{ flexShrink: 1 }}>
      {/* Nothing to search while the place has listed nothing. */}
      {engines.length ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 4 }}>
          <SearchField variant="capsule" value={query} onChangeText={setQuery} placeholder="Search models" />
        </View>
      ) : null}
      <FadeScroll scrollRef={scroller} style={{ height: listHeight, flexShrink: 1 }} contentContainerStyle={{ paddingBottom: 8 }} scrollEnabled={!drag} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false}>
        {!engines.length && line ? (
          // Nothing to list yet: the one line says what the list waits for, or what to do and where.
          <View accessible accessibilityLiveRegion="polite" style={{ height: listHeight - 16, alignItems: "center", justifyContent: "center", paddingHorizontal: 24 }}>
            <Text style={[t.row, { fontSize: 17, lineHeight: 24, textAlign: "center", color: c.muted }]}>{line}</Text>
          </View>
        ) : q && !sections.length ? (
          <View style={{ height: listHeight - 16, alignItems: "center", justifyContent: "center", paddingHorizontal: 24 }}>
            <Text style={[t.row, { fontSize: 17, textAlign: "center", color: c.muted }]}>{`No model matches “${q}”.`}</Text>
          </View>
        ) : (
          <>
            {!q && shownFavorites.length ? (
              <View>
                <SheetLabel first>Favorites</SheetLabel>
                {shownFavorites.map((e, i) => row(e, i, true))}
              </View>
            ) : null}
            {sections.map((s, i) => (
              <View key={s.key} onLayout={!q && now && s.entries.some(isCurrent) ? (e) => reveal("section", e.nativeEvent.layout.y) : undefined}>
                {s.title ? <SheetLabel first={i === 0 && (q !== "" || !shownFavorites.length)}>{s.title}</SheetLabel> : <View style={{ height: i === 0 ? 4 : 12 }} />}
                {s.entries.map((e, j) => row(e, j, false))}
              </View>
            ))}
            {olderCount ? (
              <>
                <OlderRow count={olderCount} open={older} onPress={() => setOlder((o) => !o)} />
                {older ? (
                  <Animated.View entering={enter.fade}>
                    {olderSections.map((s) => (
                      <View key={`older:${s.key}`}>
                        <SheetLabel>{s.title}</SheetLabel>
                        {s.entries.map((e, j) => row(e, j, false))}
                      </View>
                    ))}
                  </Animated.View>
                ) : null}
              </>
            ) : null}
            {!q && missing?.length ? (
              <View style={{ paddingHorizontal: 20, paddingTop: 16, gap: 6 }}>
                {missing.map((m) => (
                  <Text key={m} style={[t.small, { fontSize: 15, lineHeight: 20, color: c.muted }]}>
                    {m}
                  </Text>
                ))}
              </View>
            ) : null}
            {onManageModels && !q ? <ConnectRow onPress={onManageModels} /> : null}
          </>
        )}
      </FadeScroll>
      {now && !editing ? <Foot entry={now} effort={effort} speed={speed} onEffort={onEffort} onSpeed={onSpeed} /> : null}
      <Menu open={!!rowMenu} onClose={() => setRowMenu(null)} anchor={rowMenu?.anchor} align="start" width={300} header={rowMenu ? <RowCard entry={rowMenu.entry} /> : null} entries={rowMenu ? menuEntries(rowMenu.entry) : []} />
    </View>
  );
}

/** "Older models 4", at the list's foot: a tap shows them, each under its harness. */
function OlderRow({ count, open, onPress }: { count: number; open: boolean; onPress: () => void }) {
  const { c, t } = useTheme();
  const [held, setHeld] = useState(false);
  const turn = useSharedValue(open ? 180 : 0);
  useEffect(() => {
    turn.value = withTiming(open ? 180 : 0, { duration: duration.fast, easing: ease.snap });
  }, [open, turn]);
  const chevron = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value}deg` }] }));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Older models, ${count}`}
      accessibilityState={{ expanded: open }}
      onPressIn={() => setHeld(true)}
      onPressOut={() => setHeld(false)}
      onPress={() => {
        haptic.tick();
        onPress();
      }}
      style={[{ marginTop: 12, height: ROW, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 20, backgroundColor: held ? alpha(c.text, 0.06) : undefined }, { outlineStyle: "none" } as object]}
    >
      <Text style={[t.row, { fontSize: 17, lineHeight: 22, color: c.muted }]}>Older models</Text>
      <Text style={[t.meta, { fontSize: 15 }]}>{count}</Text>
      <View style={{ flex: 1 }} />
      <Animated.View style={chevron}>
        <Icon name="chevronDown" size={16} color={c.subtle} />
      </Animated.View>
    </Pressable>
  );
}

/** Where more models come from: a quiet create row at the list's foot (the desktop rail's +). */
function ConnectRow({ onPress }: { onPress: () => void }) {
  const { c, t } = useTheme();
  const [held, setHeld] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Connect models"
      accessibilityHint="Opens Models in Settings"
      onPressIn={() => setHeld(true)}
      onPressOut={() => setHeld(false)}
      onPress={onPress}
      style={[{ height: ROW, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 20, backgroundColor: held ? alpha(c.text, 0.06) : undefined }, { outlineStyle: "none" } as object]}
    >
      <View style={{ width: 20, alignItems: "center" }}>
        <Icon name="add" size={18} color={c.subtle} />
      </View>
      <Text style={[t.row, { fontSize: 17, lineHeight: 22, color: c.muted }]}>Connect models</Text>
    </Pressable>
  );
}

interface Grip {
  onStart: () => void;
  onMove: (dy: number) => void;
  onEnd: (keep: boolean) => void;
  /** A screen reader's "move up" and "move down". */
  onStep: (by: number) => void;
}

function ModelRow({
  entry,
  vendor,
  harness,
  divided,
  selected,
  isDefault,
  starred,
  editing,
  open,
  carried,
  grip,
  onPress,
  onStar,
  onMenu,
  onLayout,
}: {
  entry: Entry;
  vendor: BrandName | undefined;
  /** Where it runs, in grey after its name, where no section head says so (a favorite). */
  harness?: string;
  divided: boolean;
  selected: boolean;
  /** New chats start on it: "Default" after its name, in grey. */
  isDefault: boolean;
  starred: boolean;
  editing: boolean;
  /** Its long-press menu is open: it stays lit as if held. */
  open: boolean;
  /** While it is being carried: how far it sits from its place. */
  carried: number | undefined;
  grip: Grip | undefined;
  onPress: () => void;
  onStar: () => void;
  onMenu: (anchor: Anchor | null) => void;
  /** Where it sits in its section, for the list to bring it into view. */
  onLayout?: (y: number) => void;
}) {
  const { c, t, dark } = useTheme();
  const { ref, measure } = useAnchor();
  const [held, setHeld] = useState(false);
  const name = nameBesideMark(entry.model.label, vendor);
  const moving = carried !== undefined;
  return (
    <View
      ref={ref}
      collapsable={false}
      onLayout={onLayout ? (e) => onLayout(e.nativeEvent.layout.y) : undefined}
      style={moving ? { zIndex: 2, transform: [{ translateY: carried }], backgroundColor: dark ? "#26262a" : c.popover, shadowColor: "#000", shadowOpacity: dark ? 0.5 : 0.14, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6 } : undefined}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[entry.model.label, entry.engine.label, isDefault ? "default" : null, starred ? "favorite" : null].filter(Boolean).join(", ")}
        accessibilityHint={editing ? (starred ? "Removes it from favorites" : "Adds it to favorites") : "Long-press to star it or make it the default"}
        accessibilityState={{ selected }}
        accessibilityActions={grip ? [{ name: "moveUp", label: "Move up" }, { name: "moveDown", label: "Move down" }] : undefined}
        onAccessibilityAction={(e) => grip?.onStep(e.nativeEvent.actionName === "moveUp" ? -1 : 1)}
        delayLongPress={350}
        onPressIn={() => setHeld(true)}
        onPressOut={() => setHeld(false)}
        onPress={() => {
          haptic.tick();
          onPress();
        }}
        onLongPress={
          editing
            ? undefined
            : async () => {
                haptic.thud();
                onMenu(await measure());
              }
        }
        style={[{ height: ROW, flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 20, paddingRight: editing ? 4 : 20, backgroundColor: held || open ? alpha(c.text, 0.06) : undefined }, { outlineStyle: "none" } as object]}
      >
        {divided && !moving ? <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 52, right: 20, height: 1, backgroundColor: c.hairline }} /> : null}
        <View style={{ width: 20, alignItems: "center" }}>{vendor ? <BrandMark name={vendor} size={20} /> : <EngineLogo engine={entry.engine.id} size={20} />}</View>
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          <Text numberOfLines={1} style={[t.row, { flexShrink: 1, fontSize: 17, lineHeight: 22, color: c.text }]}>
            {name}
          </Text>
          {harness || isDefault ? (
            <Text numberOfLines={1} style={[t.meta, { fontSize: 13, flexShrink: 1 }]}>
              {[harness, isDefault ? "Default" : null].filter(Boolean).join(" · ")}
            </Text>
          ) : null}
        </View>
        {editing ? (
          <Pressable accessibilityRole="button" accessibilityLabel={starred ? `Remove ${entry.model.label} from favorites` : `Add ${entry.model.label} to favorites`} hitSlop={4} onPress={onStar} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
            <Icon name="star" size={20} color={starred ? c.text : c.subtle} filled={starred} />
          </Pressable>
        ) : selected ? (
          <Icon name="check" size={18} color={c.text} stroke={2} />
        ) : null}
        {/* Every row keeps the handle's slot while editing, so the stars line up down the list. */}
        {grip ? <GripHandle grip={grip} lit={held || moving} /> : editing ? <View style={{ width: 44 }} /> : null}
      </Pressable>
    </View>
  );
}

/** A favorite's handle at the row's right, only while editing: a drag moves the row, one place per row it is carried. */
function GripHandle({ grip, lit }: { grip: Grip; lit: boolean }) {
  const { c } = useTheme();
  const pan = usePanGesture({
    minDistance: 0,
    onBegin: () => {
      "worklet";
      scheduleOnRN(grip.onStart);
    },
    onUpdate: (e) => {
      "worklet";
      scheduleOnRN(grip.onMove, e.translationY);
    },
    onFinalize: (e) => {
      "worklet";
      scheduleOnRN(grip.onEnd, !e.canceled);
    },
  });
  return (
    <GestureDetector gesture={pan}>
      <View accessible={false} style={{ width: 44, height: ROW, alignItems: "center", justifyContent: "center" }}>
        <Icon name="grip" size={20} color={lit ? c.text : c.subtle} />
      </View>
    </GestureDetector>
  );
}

/**
 * Under the list: effort on the slider, every level the model offers, with the bolt beside it where the model has a
 * faster speed (components/ui/Effort.tsx). While the chat isn't where its model starts, by effort or by speed, the
 * head offers "Make default", which makes the chat's effort and speed that start. A model with speeds and no choice
 * of effort gets the bolt alone, on its own line.
 */
function Foot({ entry, effort, speed, onEffort, onSpeed }: { entry: Entry; effort?: string; speed?: string; onEffort: (level: Level) => void; onSpeed: (speed: string) => void }) {
  const { c, t } = useTheme();
  const choices = useChoices();
  const { model } = entry;
  const speeds = model.speeds ?? [];
  const start = startOf(entry, choices.starts);
  const level = pickEffort(model.efforts, effort, start.effort);
  const pace = speeds.length ? (speed && (speed === STANDARD || speeds.includes(speed)) ? speed : start.speed) : undefined;
  if (model.efforts.length < 2 && !speeds.length) return null;
  const save = () => {
    haptic.done();
    setChoices((was) => ({ ...was, starts: { ...was.starts, [entryKey(entry)]: { effort: level, speed: pace } } }));
  };
  const away = (level !== undefined && level !== start.effort) || (pace !== undefined && pace !== start.speed);
  const named = [level && effortLabel(level), pace && speedLabel(pace)].filter(Boolean).join(", ");
  const saveLabel = `Make ${named} the default for ${model.label}`;
  const bolt = pace !== undefined ? { speeds, value: pace, onChange: onSpeed } : undefined;
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: c.hairline, paddingTop: 12, paddingHorizontal: 20, paddingBottom: 8 }}>
      {model.efforts.length > 1 && level ? (
        // The bolt stands beside every slider; on a model with one speed it is quiet and inert (Effort.tsx).
        <EffortSlider levels={model.efforts} value={level} start={start.effort} onChange={(l) => onEffort(l as Level)} onSave={away ? save : undefined} saveLabel={saveLabel} speed={bolt ?? { speeds: [], value: STANDARD, onChange: onSpeed }} />
      ) : bolt ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 }}>
          <Text style={[t.row, { fontSize: 15, lineHeight: 20, color: c.subtle }]}>Speed</Text>
          <Text style={[t.row, { fontSize: 15, lineHeight: 20, fontWeight: "600", color: c.text }]}>{speedLabel(pace ?? STANDARD)}</Text>
          <View style={{ flex: 1 }} />
          {away ? (
            <Pressable accessibilityRole="button" accessibilityLabel={saveLabel} hitSlop={10} onPress={save} style={{ minHeight: 28, justifyContent: "center", marginRight: 12 }}>
              <Text style={[t.row, { fontSize: 15, lineHeight: 20, color: c.muted }]}>Make default</Text>
            </Pressable>
          ) : null}
          <SpeedToggle {...bolt} />
        </View>
      ) : null}
    </View>
  );
}

/** Above a row's long-press menu: the model's name and what it is, the desktop's hover title. */
function RowCard({ entry }: { entry: Entry }) {
  const { t } = useTheme();
  return (
    <View style={{ paddingHorizontal: 10, paddingTop: 8, paddingBottom: 6 }}>
      <Text numberOfLines={1} style={[t.row, { fontWeight: "500" }]}>
        {entry.model.label}
      </Text>
      <Text numberOfLines={2} style={t.small}>
        {entry.model.description ?? entry.engine.label}
      </Text>
    </View>
  );
}
