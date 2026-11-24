// ), apps/desktop/src/updates/releaseNotes.ts @ 67eebaca23.
// The offered build's notes from its feed (`releaseNotes` in latest-mac.yml / latest.yml, which package.mjs writes
// from CAVEMAN_RELEASE_NOTES_FILE): a short list for Settings > General. Nightly notes are its commit subjects
// (scripts/release-notes.mjs nightly); a stable release's full notes are in What's new. Dropped from T3: GitHub's
// generated-summary layout and the full-changelog grouping, which our feeds never carry.
import { channelOf, nightlyBuildDay, type UpdateChannel } from "./updateChannels.ts";
import type { ReleaseNote } from "./updateMachine.ts";

const MAX_GROUPS = 6;
const MAX_ITEMS = 8;
const MAX_ITEM_LENGTH = 220;

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

const decodeEntity = (entity: string): string => {
  const named = ENTITIES[entity];
  if (named) return named;
  const code = entity.startsWith("#x")
    ? Number.parseInt(entity.slice(2), 16)
    : entity.startsWith("#")
      ? Number.parseInt(entity.slice(1), 10)
      : Number.NaN;
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : `&${entity};`;
};

/** Text with HTML tags and markdown links reduced to their words. */
const plain = (input: string): string =>
  input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(?:p|div|li|h[1-6]|ul|ol|blockquote)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/&([a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/g, (_, entity: string) => decodeEntity(entity));

const truncate = (item: string) =>
  item.length <= MAX_ITEM_LENGTH ? item : `${item.slice(0, MAX_ITEM_LENGTH - 3).trimEnd()}...`;

/** The note's lines as items: headings, front matter and comments dropped, at most MAX_ITEMS. */
export const noteItems = (note: string | null | undefined): ReadonlyArray<string> => {
  if (!note) return [];
  const body = note.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<!--[\s\S]*?-->/g, "");
  const items: string[] = [];
  for (const raw of plain(body).split("\n")) {
    const line = raw
      .trim()
      .replace(/^[-*]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/\s+/g, " ");
    if (line === "" || /^#{1,6}\s/.test(line)) continue;
    items.push(truncate(line));
    if (items.length === MAX_ITEMS) break;
  }
  return items;
};

const isNoteInfo = (value: unknown): value is { version: string; note?: string | null } =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { version?: unknown }).version === "string" &&
  ["string", "undefined"].includes(typeof (value as { note?: unknown }).note);

/**
 * electron-updater's `releaseNotes` (a string for the offered version, or one entry per version) as notes for
 * `channel`, newest first. Entries from another channel are dropped.
 */
export const normalizeReleaseNotes = (
  releaseNotes: unknown,
  offeredVersion: string,
  channel: UpdateChannel,
  releaseDate?: string,
): ReadonlyArray<ReleaseNote> => {
  const entries =
    typeof releaseNotes === "string"
      ? [{ version: offeredVersion, note: releaseNotes }]
      : Array.isArray(releaseNotes)
        ? releaseNotes.filter(isNoteInfo)
        : [];
  return entries
    .filter((entry) => channelOf(entry.version) === channel)
    .flatMap((entry) => {
      const items = noteItems(entry.note);
      if (items.length === 0) return [];
      const releasedAt =
        entry.version === offeredVersion && releaseDate
          ? releaseDate
          : (nightlyBuildDay(entry.version) ?? null);
      return [{ version: entry.version, items, releasedAt }];
    })
    .slice(0, MAX_GROUPS);
};
