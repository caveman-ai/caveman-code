// Settings, from Profile: the desktop's Settings on a phone (apps/web/src/routes/Settings.tsx:
// Settings opens on its list of sections, then one with the way back). A large sheet (Sheet.tsx) that opens on the
// sections, grouped You, App and Work under a search, each a row with its pixel mark, or straight on the one it was
// asked for (a Chief's settings, Models). A section is pushed in place (PageStack.tsx): the head stays, its X turning
// into the back chevron and its title into the section's name, and the list waits beneath, a swipe from the left
// taking the section away under your finger. General's model rows push the model picker for that engine the same way.
// Pushed over another sheet straight onto a section (Profile's Devices, the model picker's "Connect models"), the
// section is its first page and Back goes back to that sheet. Each section is a file under ./settings/, built from the
// desktop's cards and rows (settings/kit.tsx). What the prototype can't do until it talks to a runtime is said in the
// app's toast, which sits in the sheet's head row while the sheet covers the bar.
import { type ComponentType, useMemo, useRef, useState } from "react";
import { type NativeScrollEvent, type NativeSyntheticEvent, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { startOf, useChoices } from "../board/catalog";
import { PhoneGlyph, PixelIcon } from "../components/Pixel";
import { SearchField } from "../components/ui/Field";
import { haptic } from "../motion";
import { useTheme } from "../theme";
import { useMe } from "./me";
import { PageStack } from "./PageStack";
import { ModelPicker } from "./pickers/ModelPicker";
import { AboutSettings } from "./settings/About";
import { AccountSettings } from "./settings/Account";
import { AppearanceSettings } from "./settings/Appearance";
import { CavemanMcpSettings } from "./settings/CavemanMcp";
import { ChiefsSettings } from "./settings/Chiefs";
import { ComputersSettings } from "./settings/Computers";
import { GeneralSettings } from "./settings/General";
import { type SettingsNav, SettingsNavContext } from "./settings/kit";
import { ModelsSettings } from "./settings/Models";
import { NotificationsSettings } from "./settings/Notifications";
import { findSettings, groupsFor, listed, SECTIONS, type SectionId } from "./settings/sections";
import { newChatModel, setModelStart, setNewChatModel, useSettings } from "./settings/store";
import { Sheet, SheetGroup, SheetRow, useSheetPage } from "./Sheet";
import { notice } from "./ui";

export type { SectionId } from "./settings/sections";

/** One file per section; its words live in settings/sections.ts. */
const BODIES: Record<SectionId, ComponentType<{ description: string }>> = {
  account: AccountSettings,
  general: GeneralSettings,
  notifications: NotificationsSettings,
  appearance: AppearanceSettings,
  chief: ChiefsSettings,
  models: ModelsSettings,
  "caveman-mcp": CavemanMcpSettings,
  computers: ComputersSettings,
  about: AboutSettings,
};

/** The list's page, and a model picker's ("model:<harness>"); every other page is a section by its id. */
const LIST = "list";
const MODEL = "model:";

const titleOf = (key: string) => (key === LIST ? "Settings" : key.startsWith(MODEL) ? "Model" : (SECTIONS.find((x) => x.id === key)?.label ?? "Settings"));

export function SettingsSheet({ open, onClose, section, onOpenChief }: { open: boolean; onClose: () => void; section?: SectionId; onOpenChief?: (id: string) => void }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  // Over another sheet, a section asked for is the first page, so Back goes back to that sheet.
  const over = (useSheetPage()?.index ?? 0) > 0;
  // A section this board does not list (the scripted world's, asked for on a person's own) opens the list instead.
  const scripted = useMe().scripted;
  const asked = section && SECTIONS.some((x) => x.id === section && listed(x, scripted)) ? section : undefined;
  const first = (): string[] => (asked ? (over ? [asked] : [LIST, asked]) : [LIST]);
  const [pages, setPages] = useState<string[]>(first);
  const [scrolled, setScrolled] = useState<Record<string, boolean>>({});

  // Settings opens on its list each time, as the desktop's /settings does on a phone, or on the section it was opened
  // for: set as it opens, before the first frame, so the last section never flashes.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPages(first());
      setScrolled({});
    }
  }

  const push = (key: string) => {
    setScrolled((was) => ({ ...was, [key]: false }));
    setPages((was) => [...was, key]);
  };
  const back = () => {
    haptic.tick();
    setPages((was) => (was.length > 1 ? was.slice(0, -1) : was));
  };

  // While the page is carried, and a moment after, the row the swipe began on doesn't open: the finger let go of the
  // page, not the row. (A native gesture cancels the row's touch itself; this covers the web build too.)
  const carriedAt = useRef(0);
  const carry = (on: boolean) => {
    // A touch that never became a swipe ends too; only a page that was carried holds its rows a moment longer.
    if (on) carriedAt.current = Number.POSITIVE_INFINITY;
    else if (carriedAt.current === Number.POSITIVE_INFINITY) carriedAt.current = Date.now();
  };

  const nav = useMemo<SettingsNav>(
    () => ({
      carrying: () => Date.now() - carriedAt.current < 250,
      open: push,
      pickModel: (harness) => push(`${MODEL}${harness}`),
      openChief: onOpenChief,
      notify: (text) => notice({ id: `settings-${Date.now()}`, text, tone: "info", icon: "info" }),
    }),
    // push and back only set state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onOpenChief],
  );

  const watch = (key: string) => (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const past = e.nativeEvent.contentOffset.y > 2;
    setScrolled((was) => (!!was[key] === past ? was : { ...was, [key]: past }));
  };
  const scroll = { scrollEventThrottle: 32, keyboardShouldPersistTaps: "handled" as const, keyboardDismissMode: "on-drag" as const, contentContainerStyle: { paddingBottom: insets.bottom + 40 } };
  const top = pages[pages.length - 1] ?? LIST;
  const under = pages[pages.length - 2];

  const page = (key: string) => {
    if (key === LIST)
      return (
        <ScrollView {...scroll} onScroll={watch(key)}>
          <SectionList onOpen={push} />
        </ScrollView>
      );
    if (key.startsWith(MODEL)) return <ModelPage harness={key.slice(MODEL.length)} onPicked={back} onManage={() => push("models")} />;
    const found = SECTIONS.find((x) => x.id === key && listed(x, scripted));
    const Body = found ? BODIES[found.id] : null;
    if (!found || !Body) return null;
    return (
      <ScrollView {...scroll} contentContainerStyle={{ ...scroll.contentContainerStyle, paddingTop: 4 }} onScroll={watch(key)}>
        <Body description={found.description} />
      </ScrollView>
    );
  };

  return (
    <SettingsNavContext.Provider value={nav}>
      <Sheet
        open={open}
        onClose={onClose}
        detent="large"
        title={titleOf(top)}
        closeLabel="Close Settings"
        back={under ? { label: `Back to ${titleOf(under)}`, onPress: back, title: titleOf(under) } : undefined}
        depth={pages.length - 1}
        // A hairline under the head once the page scrolls under it.
        divided={!!scrolled[top]}
      >
        {/* A section slides over the list on the sheet's own grey (Sheet.tsx's large fill), so it hides the list beneath. */}
        <PageStack pages={pages} render={page} onBack={back} ground={c.popover} onCarry={carry} />
      </Sheet>
    </SettingsNavContext.Provider>
  );
}

/**
 * The model picker for new chats on one engine, pushed from General's model row: that engine's models alone. Its pick
 * is the model new chats there start on, and takes you back; its slider and bolt are where that model starts.
 */
function ModelPage({ harness, onPicked, onManage }: { harness: string; onPicked: () => void; onManage: () => void }) {
  const [s] = useSettings();
  const picks = useChoices();
  const entry = newChatModel(harness, s.engine_models, picks);
  if (!entry) return null;
  const start = startOf(entry, picks.starts);
  return (
    <View style={{ flexShrink: 1, paddingTop: 4 }}>
      <ModelPicker
        only={harness}
        current={{ engine: harness, model: entry.model.id }}
        effort={start.effort ?? "medium"}
        speed={start.speed}
        onPick={(ref) => {
          if (ref.model !== entry.model.id) setNewChatModel(harness, ref.model);
          onPicked();
        }}
        onEffort={(level) => setModelStart(entry, { effort: level, speed: start.speed })}
        onSpeed={(speed) => setModelStart(entry, { effort: start.effort, speed })}
        onManageModels={onManage}
      />
    </View>
  );
}

/** The sections under a search, grouped as the desktop's Settings nav groups them; a search keeps the groups it hits. */
function SectionList({ onOpen }: { onOpen: (id: SectionId) => void }) {
  const { t } = useTheme();
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  const scripted = useMe().scripted;
  const found = findSettings(query, scripted);
  const groups = groupsFor(scripted)
    .map((g) => ({ ...g, sections: searching ? g.sections.filter((s) => found.includes(s)) : g.sections }))
    .filter((g) => g.sections.length > 0);
  const open = (id: SectionId) => {
    setQuery("");
    onOpen(id);
  };
  return (
    <View>
      <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12 }}>
        <SearchField variant="capsule" value={query} onChangeText={setQuery} placeholder="Search settings" accessibilityLabel="Search settings" onSubmitEditing={() => found[0] && open(found[0].id)} />
      </View>
      {groups.map((g, i) => (
        // The last group (About) has no head: a little room sets it apart instead.
        <View key={g.label ?? "end"} style={g.label ? undefined : { marginTop: 24 }}>
          <SheetGroup label={g.label ?? undefined} first={i === 0}>
            {g.sections.map((s) => (
              <SheetRow key={s.id} icon={s.id === "notifications" ? <PhoneGlyph name="bell" /> : <PixelIcon name={s.icon} mono />} label={s.label} chevron onPress={() => open(s.id)} />
            ))}
          </SheetGroup>
        </View>
      ))}
      {groups.length === 0 ? <Text style={[t.small, { paddingHorizontal: 20, paddingTop: 20 }]}>No setting matches “{query.trim()}”</Text> : null}
    </View>
  );
}
