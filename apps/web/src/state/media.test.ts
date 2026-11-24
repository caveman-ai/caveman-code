import { resolveObjectURL } from "node:buffer";
import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { mount } from "./dom.test-support.ts";
import { imageBlob, mediaName, mediaRef, nameFor, type ImageState } from "./media.ts";
import type { RuntimeContextValue } from "./runtime.tsx";

test("where an image's bytes come from", () => {
  expect(mediaRef("/Users/me/shot.png")).toEqual({ kind: "file", path: "/Users/me/shot.png" });
  // An attached image too large to come with its message: read by its store id.
  expect(mediaRef("caveman-attachment:caveman-t-1-png")).toEqual({ kind: "attachment", id: "caveman-t-1-png" });
  expect(mediaRef("caveman-attachment:")).toBeNull();
  expect(mediaName("caveman-attachment:caveman-t-1-png", "shot.png")).toBe("shot.png");
  expect(mediaRef("<~/shots/a b.png>")).toEqual({ kind: "file", path: "~/shots/a b.png" });
  expect(mediaRef("shots/after%20fix.png")).toEqual({ kind: "file", path: "shots/after fix.png" });
  expect(mediaRef("100%.png")).toEqual({ kind: "file", path: "100%.png" });
  expect(mediaRef("file:///Users/me/a%20b.png")).toEqual({ kind: "file", path: "/Users/me/a b.png" });
  expect(mediaRef("file:///C:/shots/a.png")).toEqual({ kind: "file", path: "C:/shots/a.png" });
  expect(mediaRef("C:\\shots\\a.png")).toEqual({ kind: "file", path: "C:\\shots\\a.png" });
  // As the renderer hands it over: percent-encoded.
  expect(mediaRef("C:%5Cshots%5Ca%20b.png")).toEqual({ kind: "file", path: "C:\\shots\\a b.png" });
  expect(mediaRef("https://example.com/a.png")).toEqual({ kind: "url", url: "https://example.com/a.png" });
  expect(mediaRef("data:image/png;base64,iVBOR")).toEqual({ kind: "url", url: "data:image/png;base64,iVBOR" });
});

test("what never loads", () => {
  for (const src of ["", "#", "javascript:alert(1)", "data:text/html;base64,PGI+", "data:image/png;base64,", "//evil.example/a.png", "file://host/share/a.png", "vbscript:x"]) {
    expect(mediaRef(src), src).toBeNull();
  }
  // Network shares: reading one would hand the host the person's Windows credentials.
  for (const src of ["\\\\evil.example\\s\\a.png", "<\\\\evil\\s\\a b.png>", "\\/evil/a.png", "file:////evil/s/a.png", "%5C%5Cevil%5Cs%5Ca.png"]) {
    expect(mediaRef(src), src).toBeNull();
  }
});

test("names for a save or a share", () => {
  expect(mediaName("/Users/me/after fix.png")).toBe("after fix.png");
  expect(mediaName("https://example.com/img/a%20b.webp?x=1")).toBe("a b.webp");
  expect(mediaName("data:image/jpeg;base64,/9j/", "screenshot")).toBe("screenshot.jpg");
  expect(mediaName("data:image/png;base64,iVBOR", "checkout.png")).toBe("checkout.png");
  expect(mediaName("data:image/jpeg;base64,/9j/", "photo.png")).toBe("photo.jpg");
  expect(mediaName("javascript:x")).toBe("image");
  expect(nameFor("shot.png", "image/jpeg")).toBe("shot.jpg");
  expect(nameFor("page.html", "image/bmp")).toBe("page.bmp");
  expect(nameFor("icon", "image/x-icon")).toBe("icon.ico");
});

// ------------------------------------------------------------- the blob cache

const MiB = 1 << 20;
// media.read's own cap is 16 MiB a file (runtime outbox.ts): six inline videos at it fill the 96 MiB cache.
const video = Buffer.alloc(16 * MiB, 7).toString("base64");
const screenshot = Buffer.alloc(200 * 1024, 9).toString("base64");
const read = (path: string) => {
  const mp4 = path.endsWith(".mp4");
  return { path, mime_type: mp4 ? "video/mp4" : "image/png", data: mp4 ? video : screenshot, size: mp4 ? 16 * MiB : 200 * 1024 };
};
/** Whether a blob URL still opens its bytes (a revoked one opens nothing). */
const opens = (url: string) => resolveObjectURL(url)?.size;

/** A fresh cache (it is the module's), the chat's images as useImage shows them, and media.read answered by `answer`. */
async function chat(answer: (path: string) => Promise<ReturnType<typeof read>>) {
  vi.resetModules();
  const { useImage } = await import("./media.ts");
  const { RuntimeContext } = await import("./runtime.tsx");
  const client = { call: async (_: string, params: { path: string }) => answer(params.path), on: () => () => undefined } as never;
  const shown = new Map<string, ImageState>();
  const Image = ({ path }: { path: string }) => {
    shown.set(path, useImage(path, "ws-1", `item:${path}`).state);
    return null;
  };
  const tree = (paths: ReadonlyArray<string>) =>
    createElement(RuntimeContext.Provider, { value: { status: "connected", client, connection: 1 } as unknown as RuntimeContextValue }, paths.map((path) => createElement(Image, { key: path, path })));
  const urlOf = (path: string) => {
    const state = shown.get(path);
    return state?.status === "ready" ? state.url : `${path} is ${state?.status ?? "not shown"}`;
  };
  return { tree, urlOf };
}

const takes = Array.from({ length: 6 }, (_, i) => `/tmp/take-${i}.mp4`);

test("an image read while mounted videos fill the cache keeps its picture", async () => {
  const { tree, urlOf } = await chat(async (path) => read(path));
  const page = await mount(tree(takes));
  await page.settle();
  for (const take of takes) expect(opens(urlOf(take)), take).toBe(16 * MiB);

  // The next reply's proof screenshot, read and shown below them.
  await page.render(tree([...takes, "/tmp/after.png"]));
  await page.settle();
  expect(opens(urlOf("/tmp/after.png")), urlOf("/tmp/after.png")).toBe(200 * 1024);

  // Past the cap the least recently used go once nothing shows them.
  await page.unmount();
  expect(opens(urlOf(takes[0]!))).toBeUndefined();
  for (const path of [...takes.slice(1), "/tmp/after.png"]) expect(opens(urlOf(path)), path).toBeDefined();
});

test("images that arrive together while mounted videos fill the cache all keep their picture", async () => {
  const answers = new Map<string, () => void>();
  const { tree, urlOf } = await chat((path) =>
    path.endsWith(".mp4") ? Promise.resolve(read(path)) : new Promise((resolve) => answers.set(path, () => resolve(read(path)))),
  );
  const page = await mount(tree(takes));
  await page.settle();
  const shots = ["/tmp/before.png", "/tmp/after.png"];
  await page.render(tree([...takes, ...shots]));
  expect([...answers.keys()]).toEqual(shots);
  // A burst through Cloud's relay: the answers open one after another in the same turn.
  for (const answer of answers.values()) answer();
  await page.settle();
  for (const shot of shots) expect(opens(urlOf(shot)), urlOf(shot)).toBe(200 * 1024);
});

test("an image that leaves before its bytes arrive holds nothing: the cache can let them go", async () => {
  const asked: string[] = [];
  const answers: Array<() => void> = [];
  const { tree } = await chat((path) => {
    asked.push(path);
    return path.endsWith(".mp4") ? Promise.resolve(read(path)) : new Promise((resolve) => answers.push(() => resolve(read(path))));
  });
  const page = await mount(tree(takes));
  await page.settle();
  await page.render(tree([...takes, "/tmp/after.png"]));
  // Scrolled past before the read came back.
  await page.render(tree(takes));
  answers.shift()!();
  await page.settle();
  // Mounted videos fill the cache, so bytes nobody shows went: showing it again reads it again.
  await page.render(tree([...takes, "/tmp/after.png"]));
  expect(asked.filter((path) => path === "/tmp/after.png")).toHaveLength(2);
});

test("a caller outside the chat's pane reads through the client it hands over, not this window's own runtime", async () => {
  vi.resetModules();
  const { useImage } = await import("./media.ts");
  const { RuntimeContext } = await import("./runtime.tsx");
  const asked: string[] = [];
  const computer = (name: string) => ({ call: async (_: string, params: { path: string }) => (asked.push(`${name} ${params.path}`), read(params.path)), on: () => () => undefined }) as never;
  const there = computer("the chat's computer");
  const shown: ImageState[] = [];
  // The notch's feed: mounted in the shell, where the runtime around it is this window's.
  const Preview = () => {
    shown.push(useImage("/tmp/proof.png", "ws-1", "item:proof", true, there).state);
    return null;
  };
  const page = await mount(createElement(RuntimeContext.Provider, { value: { status: "connected", client: computer("this window's runtime"), connection: 1 } as unknown as RuntimeContextValue }, createElement(Preview)));
  await page.settle();
  expect(asked).toEqual(["the chat's computer /tmp/proof.png"]);
  expect(shown.at(-1)?.status).toBe("ready");
  await page.unmount();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PNG = [0x89, 0x50, 0x4e, 0x47];
const bytesOf = async (blob: Blob) => [...new Uint8Array(await blob.arrayBuffer())];

test("a web image its host lets the page fetch comes from the page", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array(PNG), { headers: { "content-type": "image/png" } }));
  const read = vi.fn();
  vi.stubGlobal("window", { cavemanDesktop: { media: { read } } });
  expect(await bytesOf(await imageBlob(null, "https://example.com/a.png", null, "item"))).toEqual(PNG);
  expect(fetch).toHaveBeenCalledWith("https://example.com/a.png", { referrerPolicy: "no-referrer" });
  expect(read).not.toHaveBeenCalled();
});

test("a web image the page can't fetch (CORS, CSP) is read by the desktop, so Copy and Save work on it", async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
  const read = vi.fn().mockResolvedValue({ status: 200, mimeType: "image/png", data: new Uint8Array(PNG) });
  vi.stubGlobal("window", { cavemanDesktop: { media: { read } } });
  const blob = await imageBlob(null, "http://example.com/a.png", null, "item");
  expect(read).toHaveBeenCalledWith("http://example.com/a.png");
  expect(blob.type).toBe("image/png");
  expect(await bytesOf(blob)).toEqual(PNG);
});

test("a web image nobody can read rejects, with the host's status when there is one", async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
  vi.stubGlobal("window", { cavemanDesktop: { media: { read: vi.fn().mockResolvedValue({ status: 404, mimeType: "text/html", data: new Uint8Array() }) } } });
  await expect(imageBlob(null, "https://example.com/gone.png", null, "item")).rejects.toThrow("(404)");
  vi.stubGlobal("window", { cavemanDesktop: { media: { read: vi.fn().mockResolvedValue(null) } } });
  await expect(imageBlob(null, "https://example.com/a.png", null, "item")).rejects.toThrow(/connection/);
  // A browser has no desktop to ask.
  vi.stubGlobal("window", {});
  await expect(imageBlob(null, "https://example.com/a.png", null, "item")).rejects.toThrow(/CORS/);
});

test("a large attached image's bytes come from attachment.read, by its id", async () => {
  const call = vi.fn().mockResolvedValue({ mime_type: "image/png", data: btoa(String.fromCharCode(...PNG)), size: PNG.length });
  const client = { call } as unknown as Parameters<typeof imageBlob>[0];
  expect(await bytesOf(await imageBlob(client, "caveman-attachment:caveman-t-2-png", "ws1", "item"))).toEqual(PNG);
  expect(call).toHaveBeenCalledWith("attachment.read", { workspace_id: "ws1", attachment_id: "caveman-t-2-png" });
});
