// Share to Caveman (docs/): what another app's share sheet hands the app. The share
// extension (expo-sharing, app.json) writes what came into the App Group and opens the app on caveman://expo-sharing;
// this reads it as the app starts, when that link arrives and whenever the app comes to the front, as one share: its
// words, its one link, its pictures. The pictures are copied into the app's own documents, so they outlive the App
// Group's files (which go once copied), and the extension's inbox is cleared as it is read, so nothing comes twice.
// shell/ShareSheet.tsx shows it and puts it in a box; nothing here sends anything.
//
// It is off on the web, and wherever the native module or the App Group isn't there (Expo Go, a build without the
// extension): every native call is guarded, and failing only means nothing was shared. In development the web build's
// `?share=link`, `?share=text` or `?share=photos` opens the sheet on a sample instead (the end of this file).
//
// .ts and incoming-share-model.ts at
// ab3a3cd162 (MIT, THIRD_PARTY_NOTICES): the App Group check, the text's de-duplication and the owned-files rule, much
// reduced (no environments, no files or video, no stored inbox).
import type { SharePayload } from "expo-sharing";
import { AppState, Image, Linking, Platform } from "react-native";
import { createStore, useSelector } from "../store/core";

/** A shared web link: its address, its host without "www.", and the page's title once it has been read. */
export interface SharedLink {
  href: string;
  host: string;
  title?: string;
}

/** A shared picture: a file in the app's documents (or, failing the copy, where the extension left it). */
export interface SharedImage {
  uri: string;
  width?: number;
  height?: number;
  name?: string;
  /** Development only: one of the web build's drawn screenshots (shell/composer/attached.ts SHOTS), with no file. */
  shot?: string;
}

/** One share, as the sheet shows it. */
export interface Shared {
  id: string;
  text?: string;
  url?: SharedLink;
  images: readonly SharedImage[];
}

const store = createStore<Shared | null, Shared | null>(null, (_, next) => next);

/** The share waiting for a place to go, or null. `watch` it to hear one arrive. */
export const shareStore = store;
export const useShared = () => useSelector(store, (s) => s);
export const sharedNow = () => store.get();

/** A share came: it replaces any still waiting (whose copied pictures go), and its link's title is read behind it. */
export function receive(shared: Shared) {
  const was = store.get();
  if (was && was.id !== shared.id) void forget(was);
  store.dispatch(shared);
  if (shared.url && !shared.url.title) void titleLater(shared.id, shared.url.href);
}

/** The share, taken to be put in a box: it is no longer waiting, and its pictures are the box's now. */
export function takeShare(): Shared | null {
  const shared = store.get();
  if (shared) store.dispatch(null);
  return shared;
}

/** The share, let go (the sheet's X): its copied pictures go with it. */
export function dropShare() {
  const shared = store.get();
  if (!shared) return;
  store.dispatch(null);
  void forget(shared);
}

/** The words a share puts in a box: its text, then its link on a line of its own unless the text already holds it. */
export function wordsOf(shared: Pick<Shared, "text" | "url">): string {
  const text = shared.text?.trim() ?? "";
  const href = shared.url?.href;
  return [text, href && !text.includes(href) ? href : ""].filter(Boolean).join("\n");
}

/** The link the extension opens the app with (caveman://expo-sharing): not a screen, only "look at what came". */
export const isShareLink = (url: string) => /^[a-z][\w+.-]*:\/\/expo-sharing(?:[/?#]|$)/i.test(url);

// ---------------------------------------------------------------- what came, in one shape

const LINK_ONLY = /^https?:\/\/\S+$/i;

/** A web address as a link, or undefined for anything else. */
export function linkOf(href: string): SharedLink | undefined {
  const value = href.trim();
  const host = LINK_ONLY.test(value) ? value.match(/^https?:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i)?.[1] : undefined;
  return host ? { href: value, host: host.toLowerCase().replace(/^www\./, "") } : undefined;
}

/**
 * The words and the link of what came. Texts are joined once each, a blank line between (upstream sharedText); a text that
 * is only an address (Chrome shares a page so) is the link when no link came.
 */
export function wordsAndLink(payloads: readonly SharePayload[]): Pick<Shared, "text" | "url"> {
  let url = payloads.map((p) => (p.shareType === "url" ? linkOf(p.value) : undefined)).find(Boolean);
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const p of payloads) {
    if (p.shareType !== "text") continue;
    const value = p.value.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const link = !url ? linkOf(value) : undefined;
    if (link) url = link;
    else if (value !== url?.href) texts.push(value);
  }
  const text = texts.join("\n\n");
  return { ...(text ? { text } : {}), ...(url ? { url } : {}) };
}

// ---------------------------------------------------------------- reading the extension's inbox

/** The pictures' own folder in the app's documents. */
const FOLDER = "share";
/** Expo's error when the build has no App Group (a personal team's build): there is no inbox, so stop asking. */
const NO_APP_GROUP = "ERR_FAILED_TO_RESOLVE_APP_GROUP_ID";

let off = Platform.OS === "web";
let busy: Promise<void> | null = null;

/** Looks for a share now. Overlapping calls (the link and the app coming to the front, together) read it once. */
export function checkShares(): Promise<void> {
  if (off) return Promise.resolve();
  busy ??= ingest().finally(() => {
    busy = null;
  });
  return busy;
}

async function ingest() {
  let sharing: typeof import("expo-sharing");
  try {
    sharing = await import("expo-sharing");
  } catch {
    off = true;
    return;
  }
  let payloads: SharePayload[];
  try {
    payloads = sharing.getSharedPayloads();
  } catch (error) {
 // .ts at ab3a3cd162 (MIT, THIRD_PARTY_NOTICES).
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : null;
    if (code === NO_APP_GROUP || Platform.OS !== "ios") off = true;
    return;
  }
  if (!payloads.length) return;
  const pictures = payloads.filter((p) => p.shareType === "image").slice(0, 10);
  // Android hands content:// addresses; resolved, they point at a copy the app can read. Resolving reads the inbox, so
  // it goes before the inbox is cleared.
  const resolved = Platform.OS === "android" && pictures.length ? await sharing.getResolvedSharedPayloadsAsync().catch(() => []) : [];
  try {
    sharing.clearSharedPayloads();
  } catch {}
  const stamp = Date.now().toString(36);
  const images = (await Promise.all(pictures.map((p, i) => keep(resolved.find((r) => r.value === p.value)?.contentUri ?? p.value, i, stamp)))).filter((x): x is SharedImage => !!x);
  const { text, url } = wordsAndLink(payloads);
  if (!text && !url && !images.length) return;
  receive({ id: `share-${stamp}`, ...(text ? { text } : {}), ...(url ? { url } : {}), images });
}

/** A shared picture copied into the app's documents, its App Group original deleted; on failure, the original. */
async function keep(uri: string, index: number, stamp: string): Promise<SharedImage | null> {
  if (!uri) return null;
  try {
    const { Directory, File, Paths } = await import("expo-file-system");
    const folder = new Directory(Paths.document, FOLDER);
    folder.create({ idempotent: true, intermediates: true });
    const from = new File(uri);
    const name = from.name || `Picture ${index + 1}.jpg`;
    const to = new File(folder, `${stamp}-${index}-${name.replace(/[^\w.-]+/g, "_")}`);
    await from.copy(to);
    const groups = Object.values(Paths.appleSharedContainers ?? {}).map((d) => d.uri);
    if (underOwnedRoots(uri, groups)) {
      try {
        from.delete();
      } catch {}
    }
    return { uri: to.uri, name, ...(await sizeOf(to.uri)) };
  } catch {
    // Not copied (a provider's own address, a full disk): the original shows while it lasts.
    return { uri, ...(await sizeOf(uri)) };
  }
}

const sizeOf = (uri: string): Promise<{ width?: number; height?: number }> =>
  Image.getSize(uri).then(
    ({ width, height }) => ({ width, height }),
    () => ({}),
  );

/** A dropped share's pictures, deleted, if they are the ones this file copied. */
async function forget(shared: Shared) {
  if (off || !shared.images.some((i) => i.uri)) return;
  try {
    const { Directory, File, Paths } = await import("expo-file-system");
    const root = new Directory(Paths.document, FOLDER).uri;
    for (const image of shared.images) {
      if (!underOwnedRoots(image.uri, [root])) continue;
      try {
        const file = new File(image.uri);
        if (file.exists) file.delete();
      } catch {}
    }
  } catch {}
}

/**
 * Whether a file:// address lies strictly inside one of these folders, so it is the app's to delete. An app sharing
 * "in place" hands over its own file, and deleting that would destroy the person's document.
 */
// .ts at ab3a3cd162 (MIT, THIRD_PARTY_NOTICES).
export function underOwnedRoots(uri: string, roots: readonly string[]): boolean {
  const path = filePath(uri);
  if (path === null) return false;
  return roots.some((root) => {
    const base = filePath(root);
    if (base === null) return false;
    const dir = base.endsWith("/") ? base : `${base}/`;
    return path.startsWith(dir) && path.length > dir.length;
  });
}

/** A file:// address's path, /private dropped so /var and /private/var compare equal; null if it isn't one or climbs. */
function filePath(uri: string): string | null {
  if (!/^file:\/\//i.test(uri)) return null;
  let path: string;
  try {
    path = decodeURIComponent(uri.replace(/^file:\/\/(?:localhost)?/i, "").replace(/[?#].*$/, ""));
  } catch {
    return null;
  }
  if (!path.startsWith("/") || path.split("/").includes("..")) return null;
  return path.startsWith("/private/var/") ? path.slice("/private".length) : path;
}

// ---------------------------------------------------------------- the link's title

/** Reads the page's title behind the sheet (its og:title, else its <title>) and puts it on the card if it is still up. */
async function titleLater(id: string, href: string) {
  const title = await titleOf(href);
  const now = store.get();
  if (title && now?.id === id && now.url) store.dispatch({ ...now, url: { ...now.url, title } });
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const unescape = (s: string) =>
  s.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });

async function titleOf(href: string): Promise<string | undefined> {
  // A browser can't read another site's page; a phone can, as iOS's own share sheet does for its preview.
  if (Platform.OS === "web") return undefined;
  // A link with a query or a fragment may be good once (a sign-in or reset link carries its token there): opening it
  // to read a title would use it up, so it keeps its bare address.
  if (/[?#]/.test(href)) return undefined;
  const stop = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => stop?.abort(), 4000);
  try {
    const res = await fetch(href, { signal: stop?.signal, headers: { Accept: "text/html" } });
    if (!res.ok || !/html/i.test(res.headers.get("content-type") ?? "")) return undefined;
    const html = (await res.text()).slice(0, 300_000);
    const og =
      html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1] ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i)?.[1];
    const raw = og ?? html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
    const title = raw ? unescape(raw).replace(/\s+/g, " ").trim() : "";
    return title || undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- listening

/** Starts listening for shares (the shell, once); returns how to stop. */
export function listenForShares(): () => void {
  if (Platform.OS === "web") return devShare();
  void checkShares();
  const app = AppState.addEventListener("change", (state) => {
    if (state === "active") void checkShares();
  });
  const link = Linking.addEventListener("url", ({ url }) => {
    if (isShareLink(url)) void checkShares();
  });
  return () => {
    app.remove();
    link.remove();
  };
}

// ---------------------------------------------------------------- development: ?share= on the web
//
// No share extension runs in a browser, so in development `?share=link`, `?share=text` or `?share=photos` on the web
// build's address opens the sheet on a sample share, to see and screenshot it without a phone. None of it ships.

const SAMPLES: Record<string, Omit<Shared, "id">> = {
  link: {
    url: { href: "https://github.com/caveman-ai/caveman-code/issues/412", host: "github.com", title: "Relay drops the session when the phone sleeps · Issue #412 · caveman-ai/caveman-code" },
    images: [],
  },
  text: {
    text: "The runs table jumps when a run finishes while you're scrolling: the row re-sorts before its new status lands, so it moves twice. Can we hold the order until the scroll settles? It happens in Safari and Chrome, and it's worst on the phone, where the table is one column and every jump is a full row.",
    images: [],
  },
  // Two of the web build's drawn screenshots (shell/composer/attached.ts SHOTS), as a photo app would share them.
  photos: {
    images: [
      { uri: "", shot: "shot-runs", name: "Runs table, dark" },
      { uri: "", shot: "shot-diff", name: "The relay diff" },
    ],
  },
};

/** Read as this file loads: the navigator's linking writes the address over (to "/") before the shell listens. */
const DEV_SAMPLE = typeof __DEV__ !== "undefined" && __DEV__ && Platform.OS === "web" && typeof location !== "undefined" ? SAMPLES[new URLSearchParams(location.search).get("share") ?? ""] : undefined;

function devShare(): () => void {
  const sample = DEV_SAMPLE;
  if (!sample) return () => {};
  // A beat after the first frame, as a share opening the app would land.
  const timer = setTimeout(() => receive({ id: `share-dev-${Date.now().toString(36)}`, ...sample }), 600);
  return () => clearTimeout(timer);
}
