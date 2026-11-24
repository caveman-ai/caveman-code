// A project's logo (Project.logo) and the images project.logo.candidates offers for it: files of the checkout a
// browser draws, read only from inside it. Every read is asynchronous and opens the file without blocking, then keeps
// it only when it is a regular file within its cap, so a FIFO or a device where a favicon would be never holds the
// runtime. project.list carries a logo's id, a hash of its bytes; project.logo.read the bytes. SVG is only ever drawn
// as an <img>, which runs no script.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { T3_PROJECT_FILE_NAME } from "@caveman-app/protocol";
import type { ProjectLogoCandidate } from "@caveman-app/session-protocol";
import { parseT3ProjectFile } from "@caveman-app/shared/t3ProjectFile";

import { gitFiles } from "../chief/repos.ts";
import {
  extractIconHref,
  FAVICON_CANDIDATES,
  ICON_SOURCE_FILES,
} from "./ProjectFaviconResolver.ts";

/** What a logo may weigh, kept or served: the rule plugin logos follow (plugins/load.ts MAX_ICON_BYTES). */
export const LOGO_MAX_BYTES = 64 * 1024;
/** A candidate: the client draws the one picked small before it is kept, so it may be bigger. */
const CANDIDATE_MAX_BYTES = 256 * 1024;
/** A page source read for the icon it declares. */
const SOURCE_MAX_BYTES = 1024 * 1024;
const MAX_CANDIDATES = 12;
const AVATAR_TIMEOUT_MS = 3_000;
/** project.logo.candidates answers within this, with what it found so far (a big checkout's git listing can take 15 s). */
const CANDIDATES_BUDGET_MS = 4_000;
/** Auto mode remembers a found logo this long (while its file keeps its mtime and size), and none for a minute. */
const FOUND_TTL_MS = 10 * 60_000;
const NONE_TTL_MS = 60_000;
/** A lookup still running after this (a stuck disk) is not waited on again: the next ask starts a new one. */
const STUCK_MS = 10_000;

/** What a browser draws, by extension. Never .icns. */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_URL = "data:image/png;base64,";

/** A logo's id: a short hash of its type and bytes, the same for the same image wherever it is. */
export const logoId = (type: string, bytes: Uint8Array): string =>
  createHash("sha256").update(type).update("\0").update(bytes).digest("hex").slice(0, 16);

const inside = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};
const slashed = (rel: string) => rel.split(path.sep).join("/");
const sleep = (ms: number) =>
  new Promise<undefined>((resolve) =>
    setTimeout(() => resolve(undefined), Math.max(0, ms)).unref(),
  );
/** `promise`, or undefined once `ms` pass first. */
const within = <A>(promise: Promise<A>, ms: number): Promise<A | undefined> =>
  Promise.race([promise, sleep(ms)]);

/**
 * A regular file's bytes, or none: for a FIFO, a device, a folder, a missing file, an empty one or one over `max`
 * bytes. Opened with O_NONBLOCK, so a FIFO with no writer answers at once instead of waiting for one, and checked on
 * the open handle, so nothing can swap the file in between.
 */
async function readRegular(
  file: string,
  max: number,
): Promise<{ readonly bytes: Buffer; readonly stamp: string } | undefined> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > max) return undefined;
    const bytes = await handle.readFile();
    if (bytes.length === 0 || bytes.length > max) return undefined;
    return { bytes, stamp: `${stat.mtimeMs}:${stat.size}` };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** `file` inside `root` after links, or none. */
async function insideRoot(
  root: string,
  file: string,
): Promise<{ readonly root: string; readonly file: string } | undefined> {
  try {
    const realRoot = await fs.promises.realpath(root);
    const real = await fs.promises.realpath(file);
    return inside(realRoot, real) ? { root: realRoot, file: real } : undefined;
  } catch {
    return undefined;
  }
}

interface Image {
  /** From the root, with forward slashes. */
  readonly path: string;
  /** Where it really is (links followed). */
  readonly real: string;
  readonly type: string;
  readonly bytes: Buffer;
  readonly id: string;
  readonly stamp: string;
}

/** `file` when it is inside `root` after links, an image a browser draws, and a regular file of at most `max` bytes. */
async function readImage(root: string, file: string, max: number): Promise<Image | undefined> {
  const at = await insideRoot(root, file);
  const type = at && IMAGE_TYPES[path.extname(at.file).toLowerCase()];
  if (at === undefined || type === undefined) return undefined;
  const read = await readRegular(at.file, max);
  return read === undefined
    ? undefined
    : {
        path: slashed(path.relative(at.root, at.file)),
        real: at.file,
        type,
        bytes: read.bytes,
        id: logoId(type, read.bytes),
        stamp: read.stamp,
      };
}

const dataUrl = (image: Image) => `data:${image.type};base64,${image.bytes.toString("base64")}`;

/** A text file inside `root` (a page source, t3.json), read as readImage reads an image. */
async function readText(root: string, file: string): Promise<string | undefined> {
  const at = await insideRoot(root, path.resolve(root, file));
  return at === undefined
    ? undefined
    : (await readRegular(at.file, SOURCE_MAX_BYTES))?.bytes.toString("utf8");
}

/**
 * Where a favicon may be, in ProjectFaviconResolver's order: t3.json's iconPath, the well-known places, then the icon
 * each page source declares (under public/ first). Relative to the root; whether each exists is the reader's to see.
 */
async function faviconPlaces(root: string): Promise<string[]> {
  const [project, ...pages] = await Promise.all([
    readText(root, T3_PROJECT_FILE_NAME),
    ...ICON_SOURCE_FILES.map((source) => readText(root, source)),
  ]);
  const iconPath = project === undefined ? undefined : parseT3ProjectFile(project)?.iconPath;
  const declared = pages.flatMap((page) => {
    const href = page === undefined ? null : extractIconHref(page)?.replace(/^\//, "");
    return href ? [path.posix.join("public", href), href] : [];
  });
  return [...(iconPath === undefined ? [] : [iconPath]), ...FAVICON_CANDIDATES, ...declared];
}

/** Each of `places` read in parallel, kept in their order: the ones that are drawable images within `max`. */
async function imagesAt(
  root: string,
  places: ReadonlyArray<string>,
  max: number,
): Promise<Image[]> {
  const images = await Promise.all(
    places.map((place) => readImage(root, path.resolve(root, place), max)),
  );
  return images.filter((image): image is Image => image !== undefined);
}

/** Project.logo in auto mode, with its image. */
export interface FoundLogo {
  readonly id: string;
  readonly path: string;
  /** A data: URL of at most LOGO_MAX_BYTES. */
  readonly url: string;
}

/** Auto mode's answers by root: the logo with where its file really is and its mtime and size, or none. */
const autoCache = new Map<
  string,
  {
    readonly at: number;
    readonly found: {
      readonly logo: FoundLogo;
      readonly real: string;
      readonly stamp: string;
    } | null;
  }
>();
const AUTO_CACHE_MAX = 256;
const looking = new Map<
  string,
  { readonly at: number; readonly promise: Promise<FoundLogo | undefined> }
>();

/**
 * Project.logo in auto mode for the checkout at `root`: the first place in the resolver's order holding an image a
 * browser draws within LOGO_MAX_BYTES, so an .icns or an oversized favicon.svg never hides a small favicon.png
 * after it. Kept 10 minutes while its file keeps its mtime and size (one stat), none for a minute. Never rejects.
 */
export async function autoLogo(root: string): Promise<FoundLogo | undefined> {
  const now = Date.now();
  const kept = autoCache.get(root);
  if (kept !== undefined && now - kept.at < (kept.found === null ? NONE_TTL_MS : FOUND_TTL_MS)) {
    if (kept.found === null) return undefined;
    const stat = await fs.promises.stat(kept.found.real).catch(() => undefined);
    if (stat?.isFile() && `${stat.mtimeMs}:${stat.size}` === kept.found.stamp)
      return kept.found.logo;
  }
  const running = looking.get(root);
  if (running !== undefined && now - running.at < STUCK_MS) return running.promise;
  const promise: Promise<FoundLogo | undefined> = faviconPlaces(root)
    .then((places) => imagesAt(root, places, LOGO_MAX_BYTES))
    .then(([image]) => {
      const logo =
        image === undefined ? undefined : { id: image.id, path: image.path, url: dataUrl(image) };
      // A lookup that got stuck past STUCK_MS and was replaced answers its own callers, but never the cache: its read
      // of the checkout is older than the lookup that replaced it.
      if (looking.get(root)?.promise !== promise) return logo;
      autoCache.delete(root);
      autoCache.set(root, {
        at: Date.now(),
        found: logo === undefined ? null : { logo, real: image!.real, stamp: image!.stamp },
      });
      if (autoCache.size > AUTO_CACHE_MAX) autoCache.delete(autoCache.keys().next().value!);
      return logo;
    })
    .catch(() => undefined)
    .finally(() => {
      if (looking.get(root)?.promise === promise) looking.delete(root);
    });
  looking.set(root, { at: now, promise });
  return promise;
}

/** The id of the image at `file` (from the root) when a candidate would offer it; none otherwise. Never rejects. */
export async function fileLogoId(root: string, file: string): Promise<string | undefined> {
  return (await readImage(root, path.resolve(root, file), CANDIDATE_MAX_BYTES))?.id;
}

/**
 * A picked logo as project.update takes it: the client draws every pick as a PNG, so only a `data:image/png;base64,`
 * URL whose base64 round-trips, whose bytes start with the PNG signature and weigh at most 64 KiB. Its `path` is
 * relative and stays in the project. Answers the image's id, or why it is refused.
 */
export function pickedLogo(
  url: string,
  file: string | undefined,
): { readonly id: string } | { readonly problem: string } {
  const base64 = url.startsWith(PNG_URL) ? url.slice(PNG_URL.length) : undefined;
  const bytes =
    base64 === undefined || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
      ? undefined
      : Buffer.from(base64, "base64");
  if (bytes === undefined || bytes.toString("base64") !== base64)
    return { problem: "logo.url is a data:image/png;base64, URL" };
  if (
    bytes.length < PNG_SIGNATURE.length ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  )
    return { problem: "logo.url is a PNG image" };
  if (bytes.length > LOGO_MAX_BYTES) return { problem: "logo.url is an image of at most 64 KiB" };
  if (
    file !== undefined &&
    (file === "" ||
      file.length > 1024 ||
      path.posix.isAbsolute(file) ||
      path.win32.isAbsolute(file) ||
      file.split(/[\\/]/).includes("..") ||
      /[\0-\x1f]/.test(file))
  ) {
    return { problem: "logo.path is a path inside the project" };
  }
  return { id: logoId("image/png", bytes) };
}

/** Folders a project's own logo never comes from: dependencies, builds, tests and vendored code. */
const SKIP_DIR = new Set([
  "node_modules",
  "bower_components",
  "vendor",
  "vendors",
  "vendored",
  "third_party",
  "third-party",
  "thirdparty",
  "pods",
  "carthage",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".output",
  "test",
  "tests",
  "__tests__",
  "spec",
  "specs",
  "fixtures",
  "__fixtures__",
  "testdata",
  "__snapshots__",
]);
/** How much a word of a file's name says "the project's mark": lower is more. */
const NAMED: Readonly<Record<string, number>> = {
  logo: 0,
  logos: 0,
  logomark: 0,
  wordmark: 0,
  brandmark: 0,
  favicon: 1,
  appicon: 1,
  brand: 2,
  mascot: 2,
  mark: 2,
  icon: 3,
  icons: 3,
};
const EXT_RANK: Readonly<Record<string, number>> = {
  ".svg": 0,
  ".png": 1,
  ".webp": 2,
  ".jpg": 3,
  ".jpeg": 3,
  ".gif": 4,
  ".ico": 5,
};

/** How much a file's name says logo, or none: its words split at punctuation and camelCase. */
function nameScore(file: string): number | undefined {
  const stem = path.posix.basename(file, path.posix.extname(file));
  const flat = stem.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (flat.startsWith("appletouchicon") || flat.startsWith("appicon")) return 1;
  const words = stem
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  const scores = words.flatMap((word) => (NAMED[word] === undefined ? [] : [NAMED[word]]));
  return scores.length === 0 ? undefined : Math.min(...scores);
}

/**
 * Tracked files named like a logo, best first: a name many folders share (each plugin's logo.svg or logo.png) last,
 * then by how much the name says logo, how shallow the file is, and the format.
 */
export function rankLogoFiles(files: ReadonlyArray<string>): string[] {
  const named = files.flatMap((file) => {
    const ext = path.posix.extname(file).toLowerCase();
    if (IMAGE_TYPES[ext] === undefined) return [];
    const dirs = file.split("/").slice(0, -1);
    if (
      dirs.some(
        (dir) => SKIP_DIR.has(dir.toLowerCase()) || (dir.startsWith(".") && dir !== ".github"),
      )
    )
      return [];
    const score = nameScore(file);
    const stem = path.posix.basename(file, path.posix.extname(file)).toLowerCase();
    // Siblings: the same name at the same depth under the same top folder (catalog/plugins/*/assets/logo.*).
    const kin = `${stem}\0${dirs.length}\0${dirs[0] ?? ""}`;
    return score === undefined
      ? []
      : [{ file, score, depth: dirs.length, ext: EXT_RANK[ext]!, kin, dir: dirs.join("/") }];
  });
  // The folders each sibling name is in: one folder's icon.svg, .png and .ico are one mark, not three.
  const shared = new Map<string, Set<string>>();
  for (const { kin, dir } of named) shared.set(kin, (shared.get(kin) ?? new Set()).add(dir));
  const common = (kin: string) => (shared.get(kin)!.size >= 3 ? 1 : 0);
  return named
    .toSorted(
      (a, b) =>
        common(a.kin) - common(b.kin) ||
        a.score - b.score ||
        a.depth - b.depth ||
        a.ext - b.ext ||
        a.file.localeCompare(b.file),
    )
    .map(({ file }) => file);
}

/** A GitHub owner's avatar as a data: URL, or none on any failure (offline, slow, not an image, too big). */
async function ownerAvatar(
  owner: string,
  fetchImpl: typeof fetch,
): Promise<ProjectLogoCandidate | undefined> {
  try {
    const response = await fetchImpl(
      `https://avatars.githubusercontent.com/${encodeURIComponent(owner)}?s=128`,
      { signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS), redirect: "follow" },
    );
    const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (
      !response.ok ||
      type === undefined ||
      !Object.values(IMAGE_TYPES).includes(type) ||
      type === "image/svg+xml"
    )
      return undefined;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > CANDIDATE_MAX_BYTES) return undefined;
    return { url: `data:${type};base64,${bytes.toString("base64")}`, source: "owner" };
  } catch {
    return undefined;
  }
}

/**
 * project.logo.candidates: the favicons in the resolver's order, then (`git`) tracked files named like a logo, then
 * the GitHub `owner`'s avatar. Each at most 256 KiB, read from inside `root` only, once each; at most 12. `current`
 * marks the one that is the logo now: its path, and an id its bytes still have. Answers within `budgetMs` with what
 * it found so far; never rejects.
 */
export async function logoCandidates(input: {
  readonly root: string;
  readonly git: boolean;
  readonly owner?: string;
  readonly current?: { readonly path: string; readonly id: string };
  readonly fetch?: typeof fetch;
  readonly budgetMs?: number;
}): Promise<ProjectLogoCandidate[]> {
  const { root, current } = input;
  const deadline = Date.now() + (input.budgetMs ?? CANDIDATES_BUDGET_MS);
  // Asked at once, beside the checkout's reads; its slot is kept for it.
  const avatar =
    input.owner === undefined
      ? Promise.resolve(undefined)
      : ownerAvatar(input.owner, input.fetch ?? fetch);
  const room = MAX_CANDIDATES - (input.owner === undefined ? 0 : 1);
  const out: ProjectLogoCandidate[] = [];
  const seen = new Set<string>();
  const offer = (image: Image, source: "favicon" | "file") => {
    if (out.length >= room || seen.has(image.path)) return;
    seen.add(image.path);
    const now = current !== undefined && current.path === image.path && current.id === image.id;
    out.push({
      path: image.path,
      url: dataUrl(image),
      source,
      ...(now ? { current: true as const } : {}),
    });
  };
  const scan = (async () => {
    for (const image of await imagesAt(root, await faviconPlaces(root), CANDIDATE_MAX_BYTES))
      offer(image, "favicon");
    if (!input.git || out.length >= room) return;
    for (const file of rankLogoFiles(await gitFiles(root).catch(() => []))) {
      if (out.length >= room || Date.now() > deadline) return;
      const image = await readImage(root, path.resolve(root, file), CANDIDATE_MAX_BYTES);
      if (image !== undefined) offer(image, "file");
    }
  })().catch(() => undefined);
  await within(scan, deadline - Date.now());
  // What it found by now; a scan still running past the budget adds nothing to this answer.
  const found = out.slice(0, room);
  const owner = await within(avatar, deadline - Date.now());
  return owner === undefined ? found : [...found, owner];
}
