import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadWallpaperBlob } from "./image-cache.ts";

const records = new Map<string, Response>();
const key = (value: RequestInfo | URL) =>
  typeof value === "string" ? value : value instanceof URL ? value.href : value.url;
const cache = {
  match: async (request: RequestInfo | URL) => records.get(key(request))?.clone(),
  delete: async (request: RequestInfo | URL) => records.delete(key(request)),
  put: async (request: RequestInfo | URL, response: Response) => {
    records.set(key(request), response.clone());
  },
  keys: async () => [...records.keys()].map((url) => new Request(url)),
};
async function asset(id = "one") {
  const blob = new Blob([`wallpaper:${id}`], { type: "image/webp" });
  const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return {
    blob,
    image: `https://download.caveman.so/code/wallpapers/v1/${id}.webp`,
    bytes: blob.size,
    sha256: [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join(""),
  };
}
const signal = () => new AbortController().signal;
beforeEach(() => {
  records.clear();
  vi.stubGlobal("caches", { open: async () => cache });
});
afterEach(() => vi.unstubAllGlobals());

test("a selected picture downloads anonymously once and remains available offline", async () => {
  const art = await asset();
  const fetcher = vi.fn().mockResolvedValue(new Response(art.blob));
  vi.stubGlobal("fetch", fetcher);
  expect((await loadWallpaperBlob(art, signal())).size).toBe(art.bytes);
  expect(fetcher).toHaveBeenCalledWith(
    art.image,
    expect.objectContaining({ credentials: "omit", cache: "no-store" }),
  );
  fetcher.mockRejectedValue(new Error("offline"));
  expect((await loadWallpaperBlob(art, signal())).size).toBe(art.bytes);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("recently used pictures survive cache eviction while older downloads are removed", async () => {
  const arts = await Promise.all(Array.from({ length: 9 }, (_, i) => asset(String(i))));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => new Response(arts.find((a) => a.image === url)!.blob)),
  );
  for (const art of arts.slice(0, 8)) await loadWallpaperBlob(art, signal());
  await loadWallpaperBlob(arts[0]!, signal());
  await loadWallpaperBlob(arts[8]!, signal());
  expect(records.size).toBe(8);
  expect(records.has(arts[0]!.image)).toBe(true);
  expect(records.has(arts[1]!.image)).toBe(false);
});

test("corrupt cached bytes are replaced and invalid downloads are never saved", async () => {
  const art = await asset();
  records.set(art.image, new Response("wrong bytes"));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(art.blob)));
  expect(await (await loadWallpaperBlob(art, signal())).text()).toBe(await art.blob.text());
  records.clear();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("wrong bytes")));
  await expect(loadWallpaperBlob(art, signal())).rejects.toThrow("incomplete");
  expect(records.size).toBe(0);
});

test("large downloads respect the byte budget before reaching the file-count limit", async () => {
  const blob = new Blob([new Uint8Array(6 * 1024 * 1024)]);
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(blob)),
  );
  for (let i = 0; i < 7; i++)
    await loadWallpaperBlob(
      { image: `https://download.caveman.so/large-${i}.webp`, bytes: blob.size, sha256 },
      signal(),
    );
  expect(records.size).toBe(5);
  expect(
    [...records.values()].reduce(
      (sum, response) => sum + Number(response.headers.get("X-Wallpaper-Bytes")),
      0,
    ),
  ).toBeLessThanOrEqual(32 * 1024 * 1024);
});

test("missing or full persistent storage still permits displaying a downloaded picture", async () => {
  const art = await asset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(art.blob)),
  );
  vi.stubGlobal("caches", undefined);
  expect((await loadWallpaperBlob(art, signal())).size).toBe(art.bytes);
  vi.stubGlobal("caches", {
    open: async () => ({
      ...cache,
      put: async () => {
        throw new Error("quota");
      },
    }),
  });
  expect((await loadWallpaperBlob(art, signal())).size).toBe(art.bytes);
});

test("cancelled selections and failed HTTP requests do not fill cache", async () => {
  const art = await asset();
  const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", fetcher);
  const controller = new AbortController();
  controller.abort();
  await expect(loadWallpaperBlob(art, controller.signal)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  await expect(loadWallpaperBlob(art, signal())).rejects.toThrow("could not be downloaded");
  expect(records.size).toBe(0);
});

test("HTTP LAN clients verify downloads without SubtleCrypto", async () => {
  const art = await asset();
  vi.stubGlobal("crypto", {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(art.blob)),
  );
  expect((await loadWallpaperBlob(art, signal())).size).toBe(art.bytes);
  records.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("corrupt")),
  );
  await expect(loadWallpaperBlob(art, signal())).rejects.toThrow("incomplete");
});

test("a quota failure while refreshing a cache hit preserves the verified offline image", async () => {
  const art = await asset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(art.blob)),
  );
  await loadWallpaperBlob(art, signal());
  vi.stubGlobal("caches", {
    open: async () => ({
      ...cache,
      put: async () => {
        throw new Error("quota");
      },
    }),
  });
  const offline = vi.fn().mockRejectedValue(new Error("offline"));
  vi.stubGlobal("fetch", offline);
  expect((await loadWallpaperBlob(art, signal())).size).toBe(art.bytes);
  expect((await loadWallpaperBlob(art, signal())).size).toBe(art.bytes);
  expect(records.has(art.image)).toBe(true);
  expect(offline).not.toHaveBeenCalled();
});
