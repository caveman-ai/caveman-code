// What the viewer does with an image: copy it, share it, save it, open it on
// its own. Whatever leaves the app is PNG pixels (state/media.ts asPng), so a
// hostile SVG never runs as this origin in a tab or a viewer. The desktop
// opens and shares through its shell (a blob: tab is refused there); a
// browser opens a tab and shares through the Web Share API when it takes
// files. The PNG is made when the viewer shows an image (prepare), so a
// click shares or opens it at once: Safari drops a share or a tab that comes
// after a wait.

import type { Client } from "@caveman-app/session-protocol/client";
import { asPng, imageBlob, mediaRef, nameFor } from "../../state/media.ts";

export interface ImageTarget {
  readonly src: string;
  /** File name for a save or share, extension included. */
  readonly name: string;
  readonly workspaceId: string | null;
  /** The transcript item that showed it (state/media.ts useImage). */
  readonly scope: string;
}

const desktop = () => (typeof window === "undefined" ? undefined : window.cavemanDesktop?.media);

/** Shared through the desktop's share menu (macOS) or the Web Share API; else nothing to offer. */
export function canShare(): boolean {
  const media = desktop();
  if (media) return media.canShare;
  if (typeof navigator === "undefined" || !navigator.canShare) return false;
  return navigator.canShare({ files: [new File([new Uint8Array(0)], "image.png", { type: "image/png" })] });
}

/** Opens "in a new tab" in a browser; in the desktop, in the system's image viewer. */
export const openLabel = () => (desktop() ? "Open in Preview" : "Open in new tab");

/** A web image's own address; null for a file or a data: URL. */
const webUrl = (src: string): string | null => {
  const ref = mediaRef(src);
  return ref?.kind === "url" && /^https?:/i.test(ref.url) ? ref.url : null;
};

/** The last few images' PNGs, made ahead of a click. */
const pngs = new Map<string, Promise<Blob>>();
const pngKey = (client: Client | null, t: ImageTarget) => `${t.workspaceId ?? ""}\0${t.scope}\0${t.src}\0${client ? 1 : 0}`;

function png(client: Client | null, target: ImageTarget): Promise<Blob> {
  const key = pngKey(client, target);
  let made = pngs.get(key);
  if (!made) {
    made = imageBlob(client, target.src, target.workspaceId, target.scope).then(asPng);
    // A failed one is made again next time.
    made.catch(() => pngs.delete(key));
    pngs.set(key, made);
    for (const k of pngs.keys()) if (pngs.size > 4 && k !== key) pngs.delete(k);
  }
  return made;
}

/** Makes the image's PNG now, for the click that may come. A web image is left alone: its host decides. */
export function prepare(client: Client | null, target: ImageTarget): void {
  if (webUrl(target.src) === null) png(client, target).catch(() => {});
}

/**
 * The image's bytes to mark up (annotate/Annotator.tsx): its own, or PNG pixels for an SVG, which a canvas keeps no
 * vectors of. A web image whose host refuses to be read can't be drawn into a copy either, so it says so here.
 */
export async function markable(client: Client | null, target: ImageTarget): Promise<Blob> {
  let blob: Blob;
  try {
    blob = await imageBlob(client, target.src, target.workspaceId, target.scope);
  } catch (e) {
    if (webUrl(target.src)) throw new Error("This image's site doesn't let the app read it, so it can't be marked up here.", { cause: e });
    throw e;
  }
  return blob.type === "image/svg+xml" ? asPng(blob) : blob;
}

export async function copyImage(client: Client | null, target: ImageTarget): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("This browser can't copy images.");
  // The item is made inside the click, its bytes resolve later: the clipboard keeps the gesture.
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png(client, target) })]);
}

export async function shareImage(client: Client | null, target: ImageTarget): Promise<void> {
  const bytes = await png(client, target);
  const name = nameFor(target.name, "image/png");
  const media = desktop();
  if (media) return media.share(name, await bytes.arrayBuffer());
  const file = new File([bytes], name, { type: "image/png" });
  try {
    await navigator.share({ files: [file], title: name });
  } catch (e) {
    // Closing the share sheet is not a failure.
    if (e instanceof DOMException && e.name === "AbortError") return;
    throw e;
  }
}

export async function downloadImage(client: Client | null, target: ImageTarget): Promise<void> {
  let blob: Blob;
  try {
    blob = await imageBlob(client, target.src, target.workspaceId, target.scope);
  } catch (e) {
    // A web image nothing here could read (a browser and a host that refuses CORS, or a host that refused); its own
    // page can still save it.
    const url = webUrl(target.src);
    if (url) return void window.open(url, "_blank", "noopener,noreferrer");
    throw e;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  // Named for its bytes, whatever its path said: a file is opened by its extension.
  a.download = nameFor(target.name, blob.type);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function openImage(client: Client | null, target: ImageTarget): Promise<void> {
  // A web image opens at its own address (the desktop hands it to the browser).
  const web = webUrl(target.src);
  if (web) return void window.open(web, "_blank", "noopener,noreferrer");
  const bytes = await png(client, target);
  const media = desktop();
  if (media) return media.open(nameFor(target.name, "image/png"), await bytes.arrayBuffer());
  const url = URL.createObjectURL(bytes);
  window.open(url, "_blank", "noopener");
  // The tab has read it by then; the URL only pins the bytes.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
