import type { WallpaperArtwork } from "../state/wallpaper-catalog.ts";
import { sha256 } from "@noble/hashes/sha2";

const CACHE = "caveman-wallpapers-v1";
const MAX_FILES = 8;
const MAX_BYTES = 32 * 1024 * 1024;
type Asset = Pick<WallpaperArtwork, "image" | "bytes" | "sha256">;
let touched = 0;

async function verified(blob: Blob, asset: Asset): Promise<boolean> {
  if (blob.size !== asset.bytes || blob.size > MAX_BYTES) return false;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Ordinary HTTP LAN clients do not expose SubtleCrypto.
  const hash =
    typeof crypto !== "undefined" && crypto.subtle
      ? new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
      : sha256(bytes);
  return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("") === asset.sha256;
}

async function keep(cache: Cache, url: string, blob: Blob): Promise<void> {
  // Cache.put replaces atomically. A quota error must preserve the old offline copy.
  touched = Math.max(Date.now(), touched + 1);
  await cache.put(
    url,
    new Response(blob, {
      headers: {
        "Content-Type": "image/webp",
        "X-Wallpaper-Bytes": String(blob.size),
        "X-Wallpaper-Used": String(touched),
      },
    }),
  );
  const keys = await cache.keys();
  const entries = await Promise.all(
    keys.map(async (key) => {
      const response = await cache.match(key);
      return {
        key,
        size: Number(response?.headers.get("X-Wallpaper-Bytes") ?? MAX_BYTES),
        used: Number(response?.headers.get("X-Wallpaper-Used") ?? 0),
      };
    }),
  );
  entries.sort((a, b) => a.used - b.used);
  let bytes = entries.reduce((total, entry) => total + entry.size, 0);
  for (
    let i = 0;
    i < entries.length && (entries.length - i > MAX_FILES || bytes > MAX_BYTES);
    i++
  ) {
    await cache.delete(entries[i]!.key);
    bytes -= entries[i]!.size;
  }
}

/** Only the selected artwork is downloaded. Its immutable bytes survive offline within a bounded cache. */
export async function loadWallpaperBlob(asset: Asset, signal: AbortSignal): Promise<Blob> {
  const cache = typeof caches === "undefined" ? null : await caches.open(CACHE).catch(() => null);
  const cached = await cache?.match(asset.image).catch(() => undefined);
  if (cached) {
    const blob = await cached.blob();
    signal.throwIfAborted();
    if (await verified(blob, asset)) {
      await keep(cache!, asset.image, blob).catch(() => undefined);
      return blob;
    }
    await cache!.delete(asset.image).catch(() => undefined);
  }
  signal.throwIfAborted();
  const response = await fetch(asset.image, {
    credentials: "omit",
    // The explicitly bounded Cache Storage is the only durable copy, not the HTTP cache too.
    cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  if (!response.ok) throw new Error("The wallpaper could not be downloaded.");
  const blob = await response.blob();
  signal.throwIfAborted();
  if (!(await verified(blob, asset))) throw new Error("The wallpaper download was incomplete.");
  // A device without persistent storage can still display the downloaded picture.
  if (cache) await keep(cache, asset.image, blob).catch(() => undefined);
  return blob;
}
