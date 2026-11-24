// The images a chat shows: an engine's markdown image (most often the proof
// screenshot an agent saved after UI work), a screenshot a tool returned, an
// attachment. A data: or web URL loads as it is. A path (absolute on the
// computer, ~/..., file://, or relative to the workspace) is read from the
// runtime over the socket (media.read), so it loads the same through Cloud's
// relay, and is kept as a blob URL: one per image and the reply that showed
// it, so a later reply that overwrote the file shows the new bytes and the
// earlier one keeps its own. An attached image too large to come with its
// message is read by its store id (attachment.read) into the same cache. Past
// a byte cap the least recently used go, but never one a mounted image still
// holds.

import type { Client } from "@caveman-app/session-protocol/client";
import { useEffect, useState } from "react";
import { useRuntimeClient } from "./runtime.tsx";
import { ATTACHMENT_SRC, attachmentSrc } from "./transcript-model.ts";

export type MediaRef = { readonly kind: "url"; readonly url: string } | { readonly kind: "file"; readonly path: string } | { readonly kind: "attachment"; readonly id: string };
/** What is read from the runtime: a file by its path, or a stored attachment by its src (ATTACHMENT_SRC + id). */
const targetOf = (ref: MediaRef | null): string | null => (ref?.kind === "file" ? ref.path : ref?.kind === "attachment" ? attachmentSrc(ref.id) : null);

const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml);/i;

/** Where an image's bytes come from; null for what never loads (javascript:, a bare #, another host's file or share). */
export function mediaRef(src: string): MediaRef | null {
  const ref = classify(src);
  // A network share (\\host\share, //host): reading it would hand the host the person's Windows credentials.
  return ref?.kind === "file" && /^[\\/]{2}/.test(ref.path) ? null : ref;
}

function classify(src: string): MediaRef | null {
  const s = src.trim().replace(/^<(.*)>$/, "$1").trim();
  if (!s || s.startsWith("#")) return null;
  if (s.startsWith(ATTACHMENT_SRC)) return s.length > ATTACHMENT_SRC.length ? { kind: "attachment", id: s.slice(ATTACHMENT_SRC.length) } : null;
  // A data: URL with nothing after the comma is an attachment whose bytes stayed on the runtime.
  if (DATA_IMAGE.test(s)) return s.slice(s.indexOf(",") + 1) ? { kind: "url", url: s } : null;
  if (/^https?:\/\//i.test(s)) return { kind: "url", url: s };
  if (/^file:/i.test(s)) {
    try {
      const url = new URL(s);
      if (url.host && url.host !== "localhost") return null;
      return { kind: "file", path: decodeURIComponent(url.pathname).replace(/^\/([a-z]:)/i, "$1") };
    } catch {
      return null;
    }
  }
  const path = decodePath(s);
  // A drive letter reads like a scheme, so it goes first; the renderer percent-encodes its backslashes (`C:%5Ca.png`).
  if (/^[a-z]:[\\/]/i.test(path)) return { kind: "file", path };
  if (/^[a-z][a-z\d+.-]*:/i.test(s) || s.startsWith("//")) return null;
  return { kind: "file", path };
}

/** Markdown destinations may percent-encode (`%20`); a name that only looks encoded stays as written. */
function decodePath(path: string): string {
  if (!/%[\da-f]{2}/i.test(path)) return path;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** The file name a download or a share gets. */
export function mediaName(src: string, fallback = "image"): string {
  const ref = mediaRef(src);
  if (!ref || ref.kind === "attachment") return fallback;
  // An attachment's bytes come with its own name ("shot.png"): the extension is set, never added twice.
  if (ref.kind === "url" && ref.url.startsWith("data:")) return nameFor(fallback, ref.url.slice(5, ref.url.indexOf(";")));
  const path = ref.kind === "file" ? ref.path : (() => {
    try {
      return decodeURIComponent(new URL(ref.url).pathname);
    } catch {
      return "";
    }
  })();
  return path.split(/[\\/]/).filter(Boolean).pop() || fallback;
}

/** The name with the extension its bytes call for: a save is named for what it holds. */
export function nameFor(name: string, mime: string): string {
  if (!mime.startsWith("image/")) return name;
  return `${name.replace(/\.[a-z\d]{1,10}$/i, "") || "image"}.${extensionOf(mime)}`;
}

function extensionOf(mime: string): string {
  const sub = mime.split("/")[1] ?? "png";
  return sub === "jpeg" ? "jpg" : sub === "svg+xml" ? "svg" : sub === "x-icon" ? "ico" : sub;
}

// --------------------------------------------------------------------- cache

interface Loaded {
  readonly key: string;
  readonly url: string;
  readonly blob: Blob;
  /** Mounted images showing it: its URL is never revoked under them. */
  holders: number;
}

/** Blob bytes kept for images nobody shows; the least recently used go first. */
const CACHE_BYTES = 96 << 20;
const loaded = new Map<string, Loaded>();
/** A read in flight, shared by everyone who asks for that image meanwhile. */
interface Read {
  readonly entry: Promise<Loaded>;
  /** Images waiting to show it: it is held for each of them from the moment it is in the cache. */
  claims: number;
}
const inflight = new Map<string, Read>();
let held = 0;

/** `scope` is the transcript item that showed the image; `target` is what targetOf reads. */
function keyOf(workspaceId: string, scope: string, target: string): string {
  return `${workspaceId}\0${scope}\0${target}`;
}

function touch(key: string): Loaded | undefined {
  const hit = loaded.get(key);
  if (!hit) return undefined;
  loaded.delete(key);
  loaded.set(key, hit);
  return hit;
}

function evict(): void {
  for (const [key, old] of loaded) {
    if (held <= CACHE_BYTES) return;
    if (old.holders > 0) continue;
    loaded.delete(key);
    held -= old.blob.size;
    URL.revokeObjectURL(old.url);
  }
}

/** Drops a read so the next one goes to the runtime; a URL still held is revoked when let go. */
function forget(key: string): void {
  const old = loaded.get(key);
  if (!old) return;
  loaded.delete(key);
  held -= old.blob.size;
  if (old.holders === 0) URL.revokeObjectURL(old.url);
}

function hold(entry: Loaded): Loaded {
  entry.holders++;
  return entry;
}

function letGo(entry: Loaded): void {
  entry.holders--;
  if (entry.holders > 0) return;
  if (loaded.get(entry.key) === entry) evict();
  else URL.revokeObjectURL(entry.url);
}

/**
 * The file's entry, read once for everyone who asks meanwhile. With `claim` it comes held for the caller, who lets it
 * go: held from the moment it is in the cache, so no eviction that runs before the caller's turn (this read's own,
 * another read's in the same burst) revokes the URL it is about to show.
 */
function load(client: Client, workspaceId: string, scope: string, target: string, claim: boolean): Promise<Loaded> {
  const key = keyOf(workspaceId, scope, target);
  const hit = touch(key);
  if (hit) return Promise.resolve(claim ? hold(hit) : hit);
  let read = inflight.get(key);
  if (!read) {
    const started: Read = {
      claims: 0,
      // Out of `inflight` as it settles: a later ask finds the entry, never a read whose claims were already counted.
      entry: (target.startsWith(ATTACHMENT_SRC)
        ? client.call("attachment.read", { workspace_id: workspaceId, attachment_id: target.slice(ATTACHMENT_SRC.length) })
        : client.call("media.read", { workspace_id: workspaceId, path: target })
      ).then(
        (r) => {
          inflight.delete(key);
          // media.read also serves markdown, which is never shown here; audio and video play inline (InlineMedia).
          if (!/^(image|audio|video)\//.test(r.mime_type)) throw new Error(`${target} is not an image, audio or video`);
          const blob = new Blob([fromBase64(r.data)], { type: r.mime_type });
          const entry: Loaded = { key, url: URL.createObjectURL(blob), blob, holders: started.claims };
          loaded.set(key, entry);
          held += blob.size;
          evict();
          return entry;
        },
        (e: unknown) => {
          inflight.delete(key);
          throw e;
        },
      ),
    };
    inflight.set(key, (read = started));
  }
  if (claim) read.claims++;
  return read.entry;
}

/** No fetch(data:): the desktop's CSP keeps connect-src to the runtime. */
export function fromBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------- hook

export type ImageState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly url: string }
  | { readonly status: "error"; readonly message: string };

function initial(ref: MediaRef | null, workspaceId: string | null, scope: string): ImageState {
  if (!ref) return { status: "error", message: "This image can't be shown." };
  if (ref.kind === "url") return { status: "ready", url: ref.url };
  if (!workspaceId) return { status: "error", message: "This image is on the computer that ran the chat." };
  const hit = touch(keyOf(workspaceId, scope, targetOf(ref)!));
  return hit ? { status: "ready", url: hit.url } : { status: "loading" };
}

/**
 * A loadable URL for an image source, shown by the transcript item `scope`.
 * Files are read only while `enabled` (a thumbnail near the view) and held
 * while mounted; a read that fails, or bytes that don't draw, can be retried.
 * `from`: the client to read a file through, for a caller outside the chat's own
 * pane (the notch's feed), whose surroundings name this window's runtime and not
 * the chat's computer.
 */
export function useImage(src: string, workspaceId: string | null, scope: string, enabled = true, from?: Client | null): { state: ImageState; retry: () => void } {
  const around = useRuntimeClient().client;
  const client = from ?? around;
  const key = `${workspaceId ?? ""}\0${scope}\0${src}`;
  const [current, setCurrent] = useState(() => ({ key, state: initial(mediaRef(src), workspaceId, scope) }));
  const [attempt, setAttempt] = useState(0);
  let shown = current;
  if (current.key !== key) {
    shown = { key, state: initial(mediaRef(src), workspaceId, scope) };
    setCurrent(shown);
  }
  const path = targetOf(mediaRef(src));

  useEffect(() => {
    if (!client || !enabled || path === null || !workspaceId) return;
    let live = true;
    let release: (() => void) | null = null;
    /** `entry` is already held for this image. */
    const show = (entry: Loaded) => {
      release = () => letGo(entry);
      setCurrent({ key, state: { status: "ready", url: entry.url } });
    };
    // Already read: held at once, before another read can push it out.
    const hit = touch(keyOf(workspaceId, scope, path));
    if (hit) show(hold(hit));
    else {
      load(client, workspaceId, scope, path, true).then(
        (entry) => (live ? show(entry) : letGo(entry)),
        (e: unknown) => live && setCurrent({ key, state: { status: "error", message: describe(e) } }),
      );
    }
    return () => {
      live = false;
      release?.();
    };
  }, [client, enabled, path, workspaceId, scope, key, attempt]);

  return {
    state: shown.state,
    retry: () => {
      if (path !== null && workspaceId) forget(keyOf(workspaceId, scope, path));
      setCurrent({ key, state: { status: "loading" } });
      setAttempt((n) => n + 1);
    },
  };
}

function describe(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return message || "The image didn't load.";
}

/**
 * The image's bytes, for copy, share, download and open. A file comes from
 * the cache (or is read again). A web image is fetched here when its host
 * allows it (CORS); otherwise the desktop's shell reads it, as an <img> would.
 * In a browser, or when that fails too, it rejects, so callers fall back to
 * its URL.
 */
export async function imageBlob(client: Client | null, src: string, workspaceId: string | null, scope: string): Promise<Blob> {
  const ref = mediaRef(src);
  if (!ref) throw new Error("This image can't be shown.");
  if (ref.kind !== "url") {
    if (!client || !workspaceId) throw new Error("Not connected to the computer that has this image.");
    // A Blob outlives its URL: nothing to hold.
    return (await load(client, workspaceId, scope, targetOf(ref)!, false)).blob;
  }
  if (ref.url.startsWith("data:")) {
    const comma = ref.url.indexOf(",");
    const header = ref.url.slice(5, comma);
    const payload = ref.url.slice(comma + 1);
    const type = header.slice(0, header.indexOf(";"));
    return new Blob([/;base64$/i.test(header) ? fromBase64(payload) : decodeURIComponent(payload)], { type });
  }
  const response = await fetch(ref.url, { referrerPolicy: "no-referrer" }).catch(() => null);
  if (response?.ok) return response.blob();
  // An <img> shows what fetch() may not read: most hosts send no CORS answer to the app's origin, and the desktop's
  // CSP keeps plain http: to localhost.
  const read = typeof window === "undefined" ? undefined : window.cavemanDesktop?.media?.read;
  const native = read ? await read(ref.url).catch(() => null) : null;
  if (native && native.status >= 200 && native.status < 300) return new Blob([new Uint8Array(native.data)], { type: native.mimeType });
  const status = native?.status ?? response?.status;
  if (status !== undefined) throw new Error(`The image didn't load (${status}).`);
  throw new Error(read ? "The image didn't load. Check the connection and try again." : "The image didn't load. Its host may not let the browser read it (CORS).");
}

/**
 * The image as PNG pixels: what the clipboard takes, and the only form that
 * leaves the app to be opened or shared. Re-drawing an SVG drops its scripts:
 * a blob URL opened as a page would run them as this origin.
 */
export async function asPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    // An SVG with no size of its own draws at the default replaced-element box.
    canvas.width = img.naturalWidth || 300;
    canvas.height = img.naturalHeight || 150;
    canvas.getContext("2d")?.drawImage(img, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The image couldn't be converted."))), "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}
