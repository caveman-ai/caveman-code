// Share to Caveman (docs/): another app's share sheet opened the app with a link, some
// words or pictures (system/share.ts), and this medium sheet on glass says what came and where it can go, one tap
// each. At the top what came: a link as a card (its host in small grey, then its title, or its address until the title
// has been read), words as a quoted block of up to four lines, pictures as a row of thumbnails. Then where it goes:
// New chat (in the workspace a new chat would use, as the box's own row says it), each Chief by its face ("Tell
// Oona"), then the five chats with the latest news, each as the `+` menu's chats are drawn (engine logo, title, repo).
//
// A tap puts the words in that box's draft after whatever was there (the text, then the link on a line of its own),
// attaches the pictures, puts the sheet away, goes there (as the sidebar would) and gives that box the keyboard, so you
// add a line and send. Nothing is sent for you. The X lets the share go.
import { Image } from "expo-image";
import { current } from "../photos/files";
import { useEffect, useMemo, useState } from "react";
import { Keyboard, ScrollView, Text, View } from "react-native";
import { deviceById, deviceByLabel, THIS_MAC } from "../board/model";
import { PixelIcon } from "../components/Pixel";
import { Icon } from "../components/Icon";
import { Sprite } from "../components/Sprite";
import { EngineLogo } from "../components/ui/EngineLogo";
import { showChat, showChief, showNewChat } from "../nav/ref";
import { useOpened } from "../sidebar/recent";
import { useChiefList, useRows } from "../store/select";
import { chiefScope, getDraft, NEW_CHAT, setDraft } from "../store/sessions";
import { useStore } from "../store/store";
import { dropShare, listenForShares, type Shared, type SharedImage, type SharedLink, shareStore, sharedNow, takeShare, useShared, wordsOf } from "../system/share";
import { alpha, radius, useTheme } from "../theme";
import { attach, attachedOf, MAX_ATTACHED, shotById } from "./composer/attached";
import { deviceShort } from "./composer/ContextRow";
import { ShotThumb } from "./composer/Thumbs";
import { Sheet, SheetGroup, SheetRow } from "./Sheet";
import { closeSheet, focusBoxOf, inStack, notice, openShare, ui, useUi } from "./ui";

/** How many of the latest chats it offers. */
const RECENT = 5;
/** A picture's thumbnail: 72pt square, rounded as a card. */
const THUMB = 72;

/** Where a share can go. */
type Place = { kind: "new" } | { kind: "chief"; id: string } | { kind: "chat"; id: string };

/**
 * The shell listens for shares while it is up (Overlays.tsx): one arriving opens this sheet, the keyboard going down
 * first, and the sheet going any way but a pick (the X, the dim, a swipe) lets the share go.
 */
export function useShareInbox() {
  useEffect(() => {
    const arrive = () => {
      Keyboard.dismiss();
      openShare();
    };
    const offShare = shareStore.watch((next, prev) => {
      if (next && next.id !== prev?.id) arrive();
    });
    const offUi = ui.watch((next, prev) => {
      if (inStack(prev, "share") && !inStack(next, "share")) dropShare();
    });
    if (sharedNow()) arrive();
    const stop = listenForShares();
    return () => {
      stop();
      offShare();
      offUi();
    };
  }, []);
}

export function ShareSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const live = useShared();
  // A pick takes the share as the sheet starts to go: it keeps drawing what it showed until it is gone.
  const [shown, setShown] = useState<Shared | null>(live);
  if (live && live !== shown) setShown(live);
  // Up with nothing to show (a stack left from before), it takes itself away rather than stand empty.
  const missing = open && !shown;
  useEffect(() => {
    if (missing) onClose();
  }, [missing, onClose]);
  return (
    <Sheet open={open && !!shown} onClose={onClose} title="Share to Caveman" closeLabel="Cancel sharing">
      {shown ? <Body shared={shown} /> : null}
    </Sheet>
  );
}

function Body({ shared }: { shared: Shared }) {
  const { c } = useTheme();
  const where = useUi((s) => s.where);
  const device = deviceByLabel(where.computer) ?? deviceById(THIS_MAC);
  // The Chiefs as the sidebar lists them: the ones you opened last first.
  const lines = useChiefList();
  const opened = useOpened();
  const chiefs = useMemo(
    () =>
      lines
        .map((l, i) => ({ chief: l.chief, i, at: opened[l.chief.id] ?? 0 }))
        .sort((a, b) => b.at - a.at || a.i - b.i)
        .map((o) => o.chief),
    [lines, opened],
  );
  const rows = useRows();
  const titles = useStore((s) => s.inbox.titles);
  const recent = useMemo(() => [...rows].sort((a, b) => b.chat.updatedAt - a.chat.updatedAt).slice(0, RECENT), [rows]);

  return (
    <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ paddingBottom: 4 }}>
      <View style={{ paddingHorizontal: 20, paddingTop: 4, gap: 14 }}>
        {shared.url ? <LinkCard link={shared.url} /> : null}
        {shared.text ? <Quote text={shared.text} /> : null}
        {shared.images.length ? <Pictures images={shared.images} /> : null}
      </View>
      <SheetGroup label="Send to">
        <SheetRow icon={<Icon name="compose" size={20} color={c.text} />} label="New chat" detail={`${where.repo} · ${deviceShort(device.name)}`} hint="Puts it in a new chat's box" onPress={() => put({ kind: "new" })} />
        {chiefs.map((chief) => (
          <SheetRow
            key={chief.id}
            icon={<Sprite character={chief.character} tone={chief.tone} size={24} animate={false} />}
            label={chief.name === "Chief" ? "Tell the Chief" : `Tell ${chief.name}`}
            hint={`Puts it in ${chief.name}'s box`}
            onPress={() => put({ kind: "chief", id: chief.id })}
          />
        ))}
      </SheetGroup>
      {recent.length ? (
        <SheetGroup label="Recent chats">
          {recent.map(({ chat }) => (
            <SheetRow key={chat.id} icon={<EngineLogo engine={chat.engine} size={16} />} label={titles[chat.id] ?? chat.title} detail={chat.repo} hint="Puts it in this chat's box" onPress={() => put({ kind: "chat", id: chat.id })} />
          ))}
        </SheetGroup>
      ) : null}
    </ScrollView>
  );
}

/**
 * Puts the share in a box: its words after the draft's, its pictures attached, the sheet away, the box's screen up
 * and the box given the keyboard. Says so when some pictures didn't fit the box's ten.
 */
function put(place: Place) {
  const shared = takeShare();
  if (!shared) return;
  const scope = place.kind === "new" ? NEW_CHAT : place.kind === "chief" ? chiefScope(place.id) : place.id;
  const words = wordsOf(shared);
  if (words) {
    const was = getDraft(scope).replace(/\s+$/, "");
    // The caret lands on a line of its own under what came, for your line.
    setDraft(scope, `${was ? `${was}\n` : ""}${words}\n`);
  }
  // What the box's ten leave room for: a picture already on (the same one shared twice) isn't one that didn't fit.
  const room = Math.max(0, MAX_ATTACHED - attachedOf(scope).length);
  if (shared.images.length) attach(scope, shared.images.map((image) => ({ ...image, source: "share" as const })));
  const missed = Math.max(0, shared.images.length - room);
  closeSheet();
  if (place.kind === "new") showNewChat();
  else if (place.kind === "chief") showChief(place.id);
  else showChat(place.id);
  focusBoxOf(scope);
  if (missed > 0)
    notice({
      id: `share-missed-${Date.now()}`,
      text: room ? `${missed} ${missed === 1 ? "picture didn't" : "pictures didn't"} fit` : "No room for the pictures",
      detail: `A message takes ${MAX_ATTACHED}`,
      tone: "info",
      icon: "photos",
    });
}

// ---------------------------------------------------------------- what came

function LinkCard({ link }: { link: SharedLink }) {
  const { c, t } = useTheme();
  const bare = link.href.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  const name = link.title ?? bare;
  return (
    <View
      accessible
      accessibilityLabel={`Link, ${name}, ${link.host}`}
      style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: radius.card, backgroundColor: alpha(c.text, 0.05), borderWidth: 1, borderColor: alpha(c.text, 0.06) }}
    >
      <View style={{ width: 40, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: alpha(c.text, 0.07) }}>
        <PixelIcon name="artifact-link" size={20} ink={c.muted} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={[t.small, { color: c.subtle }]}>
          {link.host}
        </Text>
        <Text numberOfLines={2} style={[t.label, link.title ? null : { color: c.soft }]}>
          {name}
        </Text>
      </View>
    </View>
  );
}

function Quote({ text }: { text: string }) {
  const { c, t } = useTheme();
  return (
    <View accessible accessibilityLabel={`Text, ${text}`} style={{ flexDirection: "row", gap: 12 }}>
      <View style={{ width: 3, borderRadius: 1.5, backgroundColor: c.edge }} />
      <Text numberOfLines={4} style={[t.body, { flex: 1, fontSize: 15, lineHeight: 22, color: c.soft }]}>
        {text}
      </Text>
    </View>
  );
}

function Pictures({ images }: { images: readonly SharedImage[] }) {
  const n = images.length;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={n === 1 ? "1 picture" : `${n} pictures`} style={{ marginHorizontal: -20 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 20 }} style={{ flexGrow: 0 }}>
        {images.map((image, i) => (
          <Thumb key={`${image.uri}-${image.shot ?? ""}-${i}`} image={image} />
        ))}
      </ScrollView>
    </View>
  );
}

function Thumb({ image }: { image: SharedImage }) {
  const { c } = useTheme();
  const shot = image.shot ? shotById(image.shot) : undefined;
  if (shot) return <ShotThumb shot={shot} width={THUMB} height={THUMB} />;
  return <Image source={{ uri: current(image.uri) }} contentFit="cover" transition={120} style={{ width: THUMB, height: THUMB, borderRadius: radius.card, borderWidth: 1, borderColor: alpha(c.text, 0.08), backgroundColor: alpha(c.text, 0.05) }} />;
}
