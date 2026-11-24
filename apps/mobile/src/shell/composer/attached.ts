// What a box has attached, beside its draft: kept by the same scope as the draft (a chat's id, "new", "chief:<id>"),
// so leaving a chat and coming back finds them where you left them, and sending takes them with the words.
//
// An attachment is a picture: one from the phone's library (the `+` menu's strip of recent photos, or its grid), one
// the system's photo picker or the camera gave back, or one shared into Caveman from another app. The web build has
// no photo library, so its strip shows the prototype's drawn screenshots instead (`SHOTS`); those attach as pictures
// too, with no `uri`, and are drawn wherever a picture would show.
import type { SentImage } from "../../board/model";
import { createStore, shallow, useSelector } from "../../store/core";

/** Where a picture came from. */
export type AttachmentSource = "library" | "picker" | "camera" | "share" | "shot";

export interface Attachment {
  id: string;
  /** What shows it: a library asset (`ph://…`), a file the picker, camera or share extension wrote, a blob on the web. */
  uri: string;
  width?: number;
  height?: number;
  /** The file's own name, when it has one (a shared file, a picked one). */
  name?: string;
  source: AttachmentSource;
  /** The library asset it is, so the strip and the grid show it ticked. */
  asset?: string;
  /** The drawn screenshot it is (`SHOTS`), on the web build. */
  shot?: string;
}

/**
 * A recent screenshot, drawn rather than loaded (Thumbs.tsx `ShotThumb`): what screen it was of, so its thumbnail can
 * look like one, and when it was taken. The web build's strip, where there is no photo library.
 */
export interface Shot {
  id: string;
  /** What it shows, as VoiceOver reads it: "Runs table, dark". */
  title: string;
  /** Minutes ago. */
  ago: number;
  /** Which of the thumbnail's drawings: a list, a chat, a diff, a settings page. */
  look: "list" | "chat" | "diff" | "settings";
  /** Dark or light, as the app was when it was taken. */
  dark: boolean;
}

/** The web build's recent screenshots, newest first. */
export const SHOTS: readonly Shot[] = [
  { id: "shot-runs", title: "Runs table, dark", ago: 2, look: "list", dark: true },
  { id: "shot-thread", title: "A chat with three workers", ago: 6, look: "chat", dark: true },
  { id: "shot-diff", title: "The relay diff", ago: 14, look: "diff", dark: true },
  { id: "shot-settings", title: "Settings, light", ago: 31, look: "settings", dark: false },
  { id: "shot-inbox", title: "Inbox on the web", ago: 58, look: "list", dark: false },
  { id: "shot-review", title: "Review, two files", ago: 95, look: "diff", dark: false },
];

export const shotById = (id: string) => SHOTS.find((s) => s.id === id);

/** At most this many pictures ride on one message, as the share extension and the picker allow. */
export const MAX_ATTACHED = 10;

type Attached = Readonly<Record<string, readonly Attachment[]>>;

const store = createStore<Attached, (s: Attached) => Attached>({}, (s, change) => change(s));
const NONE: readonly Attachment[] = [];

let seq = 0;
const newId = () => `att-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** The pictures attached to a scope, in the order they were added. */
export const useAttached = (scope: string) => useSelector(store, (s) => s[scope] ?? NONE, shallow);
export const attachedOf = (scope: string) => store.get()[scope] ?? NONE;

/** Whether a library asset or a drawn screenshot is on: the strip's and the grid's tick. */
export const isOn = (list: readonly Attachment[], key: { asset?: string; shot?: string }) =>
  list.some((a) => (key.asset ? a.asset === key.asset : key.shot ? a.shot === key.shot : false));

/**
 * Adds pictures after what is there, skipping one already on (the same asset, screenshot or file) and stopping at
 * `MAX_ATTACHED`. Returns how many were added, so a caller can say when some didn't fit.
 */
export function attach(scope: string, items: readonly Omit<Attachment, "id">[]): number {
  let added = 0;
  store.dispatch((s) => {
    const now = [...(s[scope] ?? NONE)];
    for (const item of items) {
      if (now.length >= MAX_ATTACHED) break;
      const same = now.some((a) => (item.asset ? a.asset === item.asset : item.shot ? a.shot === item.shot : a.uri === item.uri && !!item.uri));
      if (same) continue;
      now.push({ ...item, id: newId() });
      added++;
    }
    return added ? { ...s, [scope]: now } : s;
  });
  return added;
}

/** Puts a library asset or a drawn screenshot on, or takes it off when it is already on (the strip's tap). */
export function toggle(scope: string, item: Omit<Attachment, "id">) {
  const key = { asset: item.asset, shot: item.shot };
  if (isOn(attachedOf(scope), key)) {
    store.dispatch((s) => ({ ...s, [scope]: (s[scope] ?? NONE).filter((a) => !(key.asset ? a.asset === key.asset : a.shot === key.shot)) }));
    return false;
  }
  return attach(scope, [item]) > 0;
}

export const detach = (scope: string, id: string) => store.dispatch((s) => ({ ...s, [scope]: (s[scope] ?? NONE).filter((a) => a.id !== id) }));
export const clearAttached = (scope: string) => store.dispatch((s) => (s[scope]?.length ? { ...s, [scope]: NONE } : s));

/** Where a library asset or a drawn screenshot stands among what's attached, from 1 (0: it isn't): the strip's badge. */
export const orderOf = (list: readonly Attachment[], key: { asset?: string; shot?: string }) =>
  list.findIndex((a) => (key.asset ? a.asset === key.asset : key.shot ? a.shot === key.shot : false)) + 1;

/** How many more fit on this message. */
export const roomLeft = (scope: string) => Math.max(0, MAX_ATTACHED - attachedOf(scope).length);

/** What goes with the message: each picture as the chat keeps it (model.ts SentImage), plain JSON. */
export const toSent = (list: readonly Attachment[]): SentImage[] =>
  list.map((a) => ({ uri: a.uri, ...(a.width ? { width: a.width } : null), ...(a.height ? { height: a.height } : null), ...(a.shot ? { shot: a.shot } : null) }));

/**
 * Pictures kept with a message back as attachments (a queued follow-up taken back into the box): a drawn screenshot
 * is one again, a `ph://` uri is its library asset, and anything else is a file, as the picker would have given it.
 */
export const fromSent = (images: readonly SentImage[]): Omit<Attachment, "id">[] =>
  images.map((i) =>
    i.shot ? { uri: "", shot: i.shot, source: "shot" } : i.uri.startsWith("ph://") ? { uri: i.uri, width: i.width, height: i.height, source: "library", asset: i.uri } : { uri: i.uri, width: i.width, height: i.height, source: "picker" },
  );
