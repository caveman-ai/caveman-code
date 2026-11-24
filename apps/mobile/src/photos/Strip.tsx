// The `+` menu's photos (composer/ContextPanel.tsx): the strip of the phone's recent photos at the top of its first page,
// and the whole library as a grid on the page See all pushes in place. A tap attaches a photo or takes it off again;
// what's on wears the ink ring and its place among the attachments (1, 2, 3, in the order attached), and the strip stays
// up for another. The grid reads the next page as it nears its end.
//
// The strip is as tall whatever it shows, so the page under it never moves: before access is asked, one wide tile asks
// ("Show your recent photos here"); with limited access, the photos given and a last "Choose more" that opens the
// system's chooser; denied, a tile that opens Settings. The web build has no library and shows the prototype's drawn
// screenshots instead (attached.ts SHOTS).
import type { ReactNode } from "react";
import { FlatList, Platform, ScrollView, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import * as script from "../board/script";
import { Icon } from "../components/Icon";
import { PhoneGlyph } from "../components/Pixel";
import { Squish } from "../components/Squish";
import { enter, exit, haptic } from "../motion";
import { type Attachment, isOn, MAX_ATTACHED, orderOf, SHOTS, type Shot, toggle, useAttached } from "../shell/composer/attached";
import { usePane } from "../shell/layout";
import { layout, sans, useTheme } from "../theme";
import { askForPhotos, chooseMorePhotos, morePhotos, openPhotoSettings, type Photo, useRecentPhotos } from "./library";
import { Picture } from "./Picture";
import { ShotThumb, shotRadius } from "./ShotThumb";

/** The strip's tiles, at a phone's proportions; five and a bit show across. */
export const STRIP_W = 66;
export const STRIP_H = 88;
/** At most this many recent photos in the strip; See all has the rest. */
const STRIP_COUNT = 24;
/** The grid: three across, square, hairline-close as a photo library is. */
const GRID_GAP = 4;
const GRID_CORNER = 8;
/** The web's drawn screenshots keep a phone's shape in their grid, a little further apart. */
const SHOT_GAP = 8;

/** "2 min ago", "3 h ago", "yesterday", "4 days ago", then the date. */
export function agoOf(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", ...(days > 300 ? { year: "numeric" } : null) });
}

const photoItem = (p: Photo): Omit<Attachment, "id"> => ({ uri: p.id, width: p.width || undefined, height: p.height || undefined, source: "library", asset: p.id });
const shotItem = (s: Shot): Omit<Attachment, "id"> => ({ uri: "", shot: s.id, source: "shot" });

/** A tap on a photo or a screenshot: on, or off again; a full message says so instead. */
function useToggle(scope: string) {
  const attached = useAttached(scope);
  return (item: Omit<Attachment, "id">) => {
    const key = { asset: item.asset, shot: item.shot };
    if (!isOn(attached, key) && attached.length >= MAX_ATTACHED) {
      script.notify(`A message takes ${MAX_ATTACHED} pictures at most`);
      return;
    }
    haptic.tick();
    toggle(scope, item);
  };
}

/** A picture to attach, with its ring and number while it is on. */
function PickTile({ label, order, width, height, radius, onPress, children }: { label: string; order: number; width: number; height: number; radius: number; onPress: () => void; children: ReactNode }) {
  const { c } = useTheme();
  const on = order > 0;
  return (
    <Squish label={label} selected={on} onPress={onPress} depth={0.96}>
      {children}
      {on ? (
        <>
          <Animated.View entering={enter.fade} exiting={exit.gone} pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, width, height, borderRadius: radius, borderWidth: 2, borderColor: c.text }} />
          <Animated.View
            entering={enter.fade}
            exiting={exit.gone}
            pointerEvents="none"
            style={{ position: "absolute", top: 5, right: 5, minWidth: 22, height: 22, paddingHorizontal: 5, borderRadius: 11, backgroundColor: c.primary, borderWidth: 1.5, borderColor: c.onPrimary, alignItems: "center", justifyContent: "center" }}
          >
            <Text style={{ fontFamily: sans, fontSize: 12, lineHeight: 15, fontWeight: "600", color: c.onPrimary, fontVariant: ["tabular-nums"] }}>{order}</Text>
          </Animated.View>
        </>
      ) : null}
    </Squish>
  );
}

function PhotoTile({ photo, order, width, height, radius, onPress }: { photo: Photo; order: number; width: number; height: number; radius: number; onPress: () => void }) {
  const kind = photo.screenshot ? "screenshot" : "photo";
  const age = photo.at ? `, ${agoOf(photo.at)}` : "";
  return (
    <PickTile label={`${order ? `Detach ${kind} ${order}` : `Attach ${kind}`}${age}`} order={order} width={width} height={height} radius={radius} onPress={onPress}>
      <Picture image={{ uri: photo.id, width: photo.width, height: photo.height }} width={width} height={height} radius={radius} />
    </PickTile>
  );
}

function ShotTile({ shot, order, width, height, onPress }: { shot: Shot; order: number; width: number; height: number; onPress: () => void }) {
  const age = shot.ago < 60 ? `${shot.ago} min ago` : `${Math.round(shot.ago / 60)} h ago`;
  return (
    <PickTile label={`${order ? `Detach screenshot ${order}` : "Attach screenshot"}: ${shot.title}, ${age}`} order={order} width={width} height={height} radius={shotRadius(width)} onPress={onPress}>
      <ShotThumb shot={shot} width={width} height={height} />
    </PickTile>
  );
}

/** A tile with a word or two on the strip's fill: See all, Choose more. */
function WordTile({ label, words, icon, width, height, radius, fill, onPress }: { label: string; words: string; icon: "chevronRight" | "add"; width: number; height: number; radius: number; fill: string; onPress: () => void }) {
  const { c, t } = useTheme();
  return (
    <Squish label={label} onPress={onPress} depth={0.96}>
      <View style={{ width, height, borderRadius: radius, backgroundColor: fill, alignItems: "center", justifyContent: "center", gap: 2, paddingHorizontal: 4 }}>
        {icon === "add" ? <Icon name="add" size={18} color={c.muted} /> : null}
        <Text numberOfLines={2} style={[t.row, { fontSize: 14, lineHeight: 18, color: c.muted, textAlign: "center" }]}>
          {words}
        </Text>
        {icon === "chevronRight" ? <Icon name="chevronRight" size={14} color={c.subtle} /> : null}
      </View>
    </Squish>
  );
}

/** The strip as one wide tile: asking for access, Settings, nothing yet. */
function WideTile({ title, line, width, fill, onPress }: { title: string; line?: string; width: number; fill: string; onPress?: () => void }) {
  const { c, t } = useTheme();
  const body = (
    <View style={{ width, height: STRIP_H, borderRadius: shotRadius(STRIP_W), backgroundColor: fill, flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 18 }}>
      <PhoneGlyph name="photo" size={24} ink={c.muted} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={[t.row, { fontSize: 15, lineHeight: 20, color: c.text }]}>
          {title}
        </Text>
        {line ? (
          <Text numberOfLines={1} style={t.small}>
            {line}
          </Text>
        ) : null}
      </View>
      {onPress ? <Icon name="chevronRight" size={16} color={c.subtle} /> : null}
    </View>
  );
  if (!onPress) {
    return (
      <View accessible accessibilityLabel={line ? `${title}. ${line}` : title}>
        {body}
      </View>
    );
  }
  return (
    <Squish label={line ? `${title}. ${line}` : title} onPress={onPress} depth={0.98}>
      {body}
    </Squish>
  );
}

/**
 * The strip at the top of the menu's first page. `onSeeAll` pushes the grid; `onPhotos` opens the system picker, for
 * when the library itself can't be read.
 */
export function PhotoStrip({ scope, fill, onSeeAll, onPhotos }: { scope: string; fill: string; onSeeAll: () => void; onPhotos: () => void }) {
  // The pane's width: on the Duo unfolded the menu stands in the chat's column, not across both (shell/layout.tsx).
  const { width } = usePane();
  const lib = useRecentPhotos();
  const attached = useAttached(scope);
  const tap = useToggle(scope);
  const wide = width - layout.inset * 2;
  const radius = shotRadius(STRIP_W);

  let tiles;
  if (lib.access === "web") {
    tiles = (
      <>
        {SHOTS.slice(0, 5).map((s) => (
          <ShotTile key={s.id} shot={s} order={orderOf(attached, { shot: s.id })} width={STRIP_W} height={STRIP_H} onPress={() => tap(shotItem(s))} />
        ))}
        <WordTile label={`See all ${SHOTS.length} screenshots`} words="See all" icon="chevronRight" width={STRIP_W} height={STRIP_H} radius={radius} fill={fill} onPress={onSeeAll} />
      </>
    );
  } else if (lib.access === "checking") {
    // Not known yet (a beat on the first open): the strip's shape, empty, so nothing moves when it fills.
    tiles = Array.from({ length: 6 }, (_, i) => <View key={i} aria-hidden style={{ width: STRIP_W, height: STRIP_H, borderRadius: radius, backgroundColor: fill }} />);
  } else if (lib.access === "ask") {
    tiles = <WideTile title="Show your recent photos here" width={wide} fill={fill} onPress={() => void askForPhotos()} />;
  } else if (lib.access === "denied") {
    tiles = <WideTile title="Photos are off for Caveman Code" line="Turn them on in Settings" width={wide} fill={fill} onPress={openPhotoSettings} />;
  } else if (lib.access === "unavailable") {
    tiles = <WideTile title="Choose photos" line="Your recent photos can't be read here" width={wide} fill={fill} onPress={onPhotos} />;
  } else if (!lib.photos.length) {
    tiles =
      lib.access === "limited" ? (
        <WideTile title="Choose photos to show here" line="Only the ones you choose" width={wide} fill={fill} onPress={() => void chooseMorePhotos()} />
      ) : (
        <WideTile title="No photos yet" line="Photos and screenshots you take show here" width={wide} fill={fill} />
      );
  } else {
    const shown = lib.photos.slice(0, STRIP_COUNT);
    tiles = (
      <>
        {shown.map((p) => (
          <PhotoTile key={p.id} photo={p} order={orderOf(attached, { asset: p.id })} width={STRIP_W} height={STRIP_H} radius={radius} onPress={() => tap(photoItem(p))} />
        ))}
        {lib.photos.length > STRIP_COUNT || !lib.end ? <WordTile label="See all photos" words="See all" icon="chevronRight" width={STRIP_W} height={STRIP_H} radius={radius} fill={fill} onPress={onSeeAll} /> : null}
        {lib.access === "limited" ? <WordTile label="Choose more photos to show here" words="Choose more" icon="add" width={STRIP_W} height={STRIP_H} radius={radius} fill={fill} onPress={() => void chooseMorePhotos()} /> : null}
      </>
    );
  }
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityLabel={lib.access === "web" ? "Recent screenshots" : "Recent photos"} contentContainerStyle={{ gap: 8, paddingHorizontal: layout.inset }} style={{ flexGrow: 0, height: STRIP_H }}>
      {tiles}
    </ScrollView>
  );
}

/** The See all page's title. */
export const GRID_TITLE = Platform.OS === "web" ? "Screenshots" : "Photos";

type GridCell = { kind: "photo"; photo: Photo } | { kind: "shot"; shot: Shot } | { kind: "more" };

/**
 * The whole library, three across, in place of the menu's page (it scrolls itself, so it can read the next page as it
 * nears its end). The web's grid is its drawn screenshots.
 */
export function PhotoGrid({ scope, fill, foot }: { scope: string; fill: string; foot: number }) {
  // The pane's width: on the Duo unfolded the menu stands in the chat's column, not across both (shell/layout.tsx).
  const { width } = usePane();
  const lib = useRecentPhotos();
  const attached = useAttached(scope);
  const tap = useToggle(scope);
  const web = lib.access === "web";
  const gap = web ? SHOT_GAP : GRID_GAP;
  const cell = Math.floor((width - layout.inset * 2 - gap * 2) / 3);
  const tall = web ? Math.round(cell * 1.3) : cell;
  const cells: GridCell[] = web
    ? SHOTS.map((shot) => ({ kind: "shot", shot }))
    : [...lib.photos.map((photo): GridCell => ({ kind: "photo", photo })), ...(lib.access === "limited" ? [{ kind: "more" } as const] : [])];
  return (
    <FlatList
      data={cells}
      numColumns={3}
      keyExtractor={(c) => (c.kind === "photo" ? c.photo.id : c.kind === "shot" ? c.shot.id : "more")}
      extraData={attached}
      columnWrapperStyle={{ gap }}
      contentContainerStyle={{ gap, paddingHorizontal: layout.inset, paddingTop: 4, paddingBottom: foot + 12 }}
      showsVerticalScrollIndicator={false}
      onEndReached={() => void morePhotos()}
      onEndReachedThreshold={1.5}
      initialNumToRender={21}
      windowSize={7}
      renderItem={({ item }) =>
        item.kind === "photo" ? (
          <PhotoTile photo={item.photo} order={orderOf(attached, { asset: item.photo.id })} width={cell} height={tall} radius={GRID_CORNER} onPress={() => tap(photoItem(item.photo))} />
        ) : item.kind === "shot" ? (
          <ShotTile shot={item.shot} order={orderOf(attached, { shot: item.shot.id })} width={cell} height={tall} onPress={() => tap(shotItem(item.shot))} />
        ) : (
          <WordTile label="Choose more photos to show here" words="Choose more" icon="add" width={cell} height={tall} radius={GRID_CORNER} fill={fill} onPress={() => void chooseMorePhotos()} />
        )
      }
    />
  );
}
