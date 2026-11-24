import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, BrowserWindow: class {}, nativeImage: {}, ShareMenu: class {}, shell: {} }));
const { pictureStem, pngSize, readWebMedia, MAX_PICTURE_PIXELS } = await import("../src/media.ts");

describe("pictureStem", () => {
  it("keeps the person's name, never a folder, an extension or odd characters", () => {
    expect(pictureStem("style guide (phone).png")).toBe("style guide (phone)");
    expect(pictureStem("/Users/me/../../etc/passwd")).toBe("passwd");
    expect(pictureStem("..\\..\\evil.command")).toBe("evil");
    expect(pictureStem(".hidden.png")).toBe("hidden");
    expect(pictureStem("a;rm -rf ~.png")).toBe("a_rm -rf _");
    expect(pictureStem("x".repeat(200) + ".png")).toHaveLength(80);
  });
  it("names anything else 'image'", () => {
    expect(pictureStem("")).toBe("image");
    expect(pictureStem("...")).toBe("image");
    expect(pictureStem(42)).toBe("image");
  });
});

describe("pngSize", () => {
  const header = (w: number, h: number) => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "latin1");
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  };
  it("reads the size before anything decodes it, so a bomb is refused unopened", () => {
    expect(pngSize(header(1440, 900))).toEqual({ width: 1440, height: 900 });
    const bomb = pngSize(header(30_000, 30_000))!;
    expect(bomb.width * bomb.height).toBeGreaterThan(MAX_PICTURE_PIXELS);
  });
  it("is null for anything that is not a PNG", () => {
    expect(pngSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(30).fill(0)]))).toBeNull();
    expect(pngSize(Buffer.from("#!/bin/sh\nrm -rf ~\n".padEnd(40)))).toBeNull();
  });
});

describe("readWebMedia", () => {
  const mib = new Uint8Array(1024 * 1024);
  const fetch = vi.fn(async (url: string, _init: RequestInit) => {
    if (url.endsWith("/missing.png")) return new Response("Not Found", { status: 404 });
    if (url.endsWith("/small.png")) return new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/png" } });
    if (url.endsWith("/offline.png")) throw new TypeError("fetch failed");
    let sent = 0;
    // 257 MiB from one reused chunk: past the cap without holding it.
    return new Response(new ReadableStream<Uint8Array>({ pull: (c) => (sent++ < 257 ? c.enqueue(mib) : c.close()) }));
  });

  it("reads only http(s) addresses", async () => {
    for (const url of ["file:///etc/passwd", "caveman-code://app/", "data:image/png;base64,AA==", "javascript:alert(1)", "not a url", 42, undefined]) {
      expect(await readWebMedia(url, fetch)).toBeNull();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("brings back the bytes and type, with the session's cookies, as an <img> would", async () => {
    expect(await readWebMedia("https://example.com/small.png", fetch)).toEqual({ status: 200, mimeType: "image/png", data: Buffer.from([1, 2]) });
    expect(fetch).toHaveBeenLastCalledWith("https://example.com/small.png", { credentials: "include" });
  });

  it("answers a refusal with its status and no bytes, a body past 256 MB with 413, and a network failure with null", async () => {
    expect(await readWebMedia("http://example.com/missing.png", fetch)).toEqual({ status: 404, mimeType: "text/plain;charset=UTF-8", data: new Uint8Array() });
    expect(await readWebMedia("https://example.com/huge.mp4", fetch)).toEqual({ status: 413, mimeType: "", data: new Uint8Array() });
    expect(await readWebMedia("https://example.com/offline.png", fetch)).toBeNull();
  });
});
