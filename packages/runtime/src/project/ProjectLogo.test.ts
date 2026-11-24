// ProjectLogo: which file auto mode shows, which tracked files read as a project's own mark, the GitHub owner's avatar
// as the last candidate, what a pick must be, and reads that never wait on a FIFO or a slow source.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, expect, test, vi } from "vitest";

import {
  autoLogo,
  fileLogoId,
  logoCandidates,
  logoId,
  pickedLogo,
  rankLogoFiles,
} from "./ProjectLogo.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-logo-"));
const fifos: Array<string> = [];
afterAll(() => {
  // A read stuck on a FIFO (the bug these tests guard) would hold a worker thread: a writer that opens and closes
  // ends it, so the process can exit either way.
  for (const fifo of fifos) {
    try {
      fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
    } catch {
      // No reader waiting: nothing to release.
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const SVG = "<svg xmlns='http://www.w3.org/2000/svg'/>";
const folder = (files: Record<string, string | Buffer>) => {
  const at = fs.mkdtempSync(path.join(root, "checkout-"));
  for (const [name, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(at, name)), { recursive: true });
    fs.writeFileSync(path.join(at, name), bytes);
  }
  return at;
};
const fifo = (at: string, name: string) => {
  const file = path.join(at, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync("mkfifo", [file]);
  fifos.push(file);
};
/** How long `run` takes, in ms. */
const timed = async <A>(run: () => Promise<A>) => {
  const started = performance.now();
  const value = await run();
  return { value, ms: performance.now() - started };
};
const fifoTest = process.platform === "win32" ? test.skip : test;

test("auto takes the first favicon it can draw within 64 KiB, in the resolver's order: an .icns or a big favicon.svg never hides a small favicon.png", async () => {
  const at = folder({
    "AppIcon.icns": "icns",
    "favicon.svg": `<svg xmlns='http://www.w3.org/2000/svg'>${" ".repeat(70 * 1024)}</svg>`,
    "favicon.png": PNG,
  });
  expect(await autoLogo(at)).toEqual({
    id: logoId("image/png", PNG),
    path: "favicon.png",
    url: `data:image/png;base64,${PNG.toString("base64")}`,
  });
  // t3.json's iconPath comes before the well-known places, as in the resolver.
  const named = folder({
    "t3.json": JSON.stringify({ iconPath: "brand/mark.svg" }),
    "brand/mark.svg": SVG,
    "favicon.png": PNG,
  });
  expect((await autoLogo(named))?.path).toBe("brand/mark.svg");
  // A file that changes is read again: a new id.
  fs.writeFileSync(path.join(named, "brand/mark.svg"), `${SVG}\n`);
  expect((await autoLogo(named))?.id).toBe(logoId("image/svg+xml", Buffer.from(`${SVG}\n`)));
  expect(await autoLogo(folder({ "README.md": "none" }))).toBeUndefined();
  expect(await autoLogo(path.join(root, "gone"))).toBeUndefined();
});

test("a lookup replaced after it got stuck never writes its older answer over the newer one in the cache", async () => {
  // Only favicon.png at first; the first lookup is held at its read of it, as on a stuck disk.
  const at = folder({ "favicon.png": PNG });
  const png = path.join(fs.realpathSync(at), "favicon.png");
  const realOpen = fs.promises.open.bind(fs.promises);
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held = false;
  const spy = vi
    .spyOn(fs.promises, "open")
    .mockImplementation(async (file: fs.PathLike, flags?: string | number, mode?: fs.Mode) => {
      if (!held && String(file) === png) {
        held = true;
        await gate;
      }
      return realOpen(file, flags, mode);
    });
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const stuck = autoLogo(at);
    await vi.waitFor(() => expect(held).toBe(true));
    // Meanwhile a favicon.svg, which comes first, is added, and the stuck lookup is past STUCK_MS: a new one starts.
    fs.writeFileSync(path.join(at, "favicon.svg"), SVG);
    vi.setSystemTime(Date.now() + 11_000);
    expect((await autoLogo(at))?.path).toBe("favicon.svg");
    // The stuck one ends: its own caller gets what it read, and the cache keeps the newer answer.
    release();
    expect((await stuck)?.path).toBe("favicon.png");
    expect((await autoLogo(at))?.path).toBe("favicon.svg");
  } finally {
    vi.useRealTimers();
    spy.mockRestore();
  }
});

fifoTest(
  "a FIFO where a favicon, a page source or t3.json would be is skipped at once, by auto and by candidates",
  async () => {
    const at = folder({ "public/favicon.png": PNG });
    fifo(at, "favicon.svg");
    fifo(at, "index.html");
    fifo(at, "public/index.html");
    fifo(at, "t3.json");
    const auto = await timed(() => autoLogo(at));
    expect(auto.value?.path).toBe("public/favicon.png");
    expect(auto.ms).toBeLessThan(2_000);
    const candidates = await timed(() => logoCandidates({ root: at, git: false }));
    expect(candidates.value.map((c) => c.path)).toEqual(["public/favicon.png"]);
    expect(candidates.ms).toBeLessThan(2_000);
    expect(await fileLogoId(at, "favicon.svg")).toBeUndefined();
  },
);

test("candidates answer within their budget with what they found, without an avatar that never comes", async () => {
  const at = folder({ "favicon.svg": SVG });
  const never = (() => new Promise<Response>(() => undefined)) as typeof fetch;
  const { value, ms } = await timed(() =>
    logoCandidates({ root: at, git: false, owner: "acme", fetch: never, budgetMs: 300 }),
  );
  expect(value.map((c) => c.path)).toEqual(["favicon.svg"]);
  expect(ms).toBeLessThan(1_500);
});

test("current marks the file that is the logo, while its bytes are the ones noted", async () => {
  const at = folder({ "favicon.svg": SVG, "public/favicon.png": PNG });
  const id = (await fileLogoId(at, "public/favicon.png"))!;
  const marked = async () =>
    (await logoCandidates({ root: at, git: false, current: { path: "public/favicon.png", id } }))
      .filter((c) => c.current)
      .map((c) => c.path);
  expect(await marked()).toEqual(["public/favicon.png"]);
  fs.writeFileSync(path.join(at, "public/favicon.png"), Buffer.concat([PNG, Buffer.from([0])]));
  expect(await marked()).toEqual([]);
});

test("a pick is a PNG data: URL whose base64 round-trips, with the PNG signature, of at most 64 KiB, from a path inside the project", () => {
  const png = (bytes: Buffer) => `data:image/png;base64,${bytes.toString("base64")}`;
  expect(pickedLogo(png(PNG), "public/logo.png")).toEqual({ id: logoId("image/png", PNG) });
  expect(pickedLogo(png(PNG), undefined)).toEqual({ id: logoId("image/png", PNG) });
  const refused = (url: string, file?: string) => "problem" in pickedLogo(url, file);
  expect(refused(`data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}`)).toBe(true);
  expect(refused(png(PNG).replace("data:image/png", "data:image/jpeg"))).toBe(true);
  // Base64 that does not round-trip (a stray bit in the padding), and bytes that are no PNG.
  expect(refused(`${png(PNG).slice(0, -2)}h=`)).toBe(true);
  expect(refused(png(Buffer.from("not a png at all")))).toBe(true);
  expect(refused(png(Buffer.concat([PNG, Buffer.alloc(64 * 1024)])))).toBe(true);
  expect(refused(png(Buffer.concat([PNG, Buffer.alloc(64 * 1024 - PNG.length)])))).toBe(false);
  for (const file of ["../outside.png", "/etc/hosts", "C:\\x.png", "a/../../b.png", ""])
    expect(refused(png(PNG), file)).toBe(true);
});

test("tracked files: a name sibling folders share last (whatever its format), then logo before favicon before brand before icon, shallow first; never dependencies, builds, tests or vendored code", () => {
  expect(
    rankLogoFiles([
      "catalog/plugins/a/assets/logo.svg",
      "catalog/plugins/b/assets/logo.svg",
      "catalog/plugins/c/assets/logo.svg",
      "catalog/plugins/d/assets/logo.png",
      "apps/desktop/resources/icon.svg",
      "apps/desktop/resources/icon.png",
      "apps/web/public/apple-touch-icon.png",
      "docs/brand/logo-dark.svg",
      "src/components/BookmarkButton.svg",
      "src/AppIcon.png",
      "node_modules/pkg/logo.svg",
      "dist/logo.svg",
      "vendor/lib/logo.png",
      "test/fixtures/logo.png",
      "packages/x/__tests__/logo.png",
      ".cache/logo.png",
      ".github/logo.png",
      "assets/logo.icns",
      "README.md",
    ]),
  ).toEqual([
    ".github/logo.png",
    "docs/brand/logo-dark.svg",
    "src/AppIcon.png",
    "apps/web/public/apple-touch-icon.png",
    "apps/desktop/resources/icon.svg",
    "apps/desktop/resources/icon.png",
    "catalog/plugins/a/assets/logo.svg",
    "catalog/plugins/b/assets/logo.svg",
    "catalog/plugins/c/assets/logo.svg",
    "catalog/plugins/d/assets/logo.png",
  ]);
});

test("a GitHub owner's avatar comes last, fetched as an image; any failure leaves it out", async () => {
  const at = folder({ "favicon.svg": SVG });
  const asked: Array<string> = [];
  const avatar = (response: Response | Error) =>
    (async (url: string | URL | Request) => {
      asked.push(String(url));
      if (response instanceof Error) throw response;
      return response;
    }) as typeof fetch;
  const png = new Uint8Array([137, 80, 78, 71]);
  const found = await logoCandidates({
    root: at,
    git: false,
    owner: "acme",
    fetch: avatar(new Response(png, { headers: { "content-type": "image/png" } })),
  });
  expect(found.map((c) => [c.source, c.path ?? null])).toEqual([
    ["favicon", "favicon.svg"],
    ["owner", null],
  ]);
  expect(found[1]!.url).toBe(`data:image/png;base64,${Buffer.from(png).toString("base64")}`);
  expect(asked).toEqual(["https://avatars.githubusercontent.com/acme?s=128"]);

  for (const failing of [
    new Error("offline"),
    new Response("nope", { status: 404 }),
    new Response("<html/>", { headers: { "content-type": "text/html" } }),
  ]) {
    const without = await logoCandidates({
      root: at,
      git: false,
      owner: "acme",
      fetch: avatar(failing),
    });
    expect(without.map((c) => c.source)).toEqual(["favicon"]);
  }
});
