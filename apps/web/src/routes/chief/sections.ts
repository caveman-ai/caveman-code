// A Chief's /clear changes its local view only (docs/chief.md). Event cursors, never clocks or array positions,
// separate earlier work from new messages. Live items remain visible until they finish, including after reopening.
import type { SessionModel } from "../../state/transcript.ts";
import type { TranscriptItem } from "../../state/transcript-model.ts";

export interface Cleared {
  /** Browser time labels the section only. */
  readonly at: string;
  readonly cursor: number;
  /** Absent on runtimes that do not report journal epochs. */
  readonly epoch?: number;
  readonly live: readonly string[];
}

/** Stable session identity: the optional epoch belongs to the mark, so late metadata cannot hide its lookup. */
export function sectionKey(
  runtime: string | null | undefined,
  chief: string | undefined,
  session: string | undefined,
): string | null {
  if (!runtime || !chief || !session) return null;
  const url = new URL(runtime);
  // Credentials, query strings and fragments never belong in a storage key.
  return JSON.stringify([url.origin, url.pathname, chief, session]);
}
const key = (scope: string) => `caveman.chief.cleared.v2.${scope}`;

function decode(raw: string | null, legacyEpoch?: number): Cleared | null {
  const parsed: unknown = JSON.parse(raw ?? "null");
  if (!parsed || typeof parsed !== "object") return null;
  const mark = parsed as Cleared;
  const epoch = mark.epoch ?? legacyEpoch;
  return typeof mark.at === "string" &&
    Number.isFinite(Date.parse(mark.at)) &&
    Number.isSafeInteger(mark.cursor) &&
    mark.cursor >= 0 &&
    (epoch === undefined || (Number.isSafeInteger(epoch) && epoch >= 0)) &&
    Array.isArray(mark.live) &&
    mark.live.every((id) => typeof id === "string")
    ? {
        at: mark.at,
        cursor: mark.cursor,
        live: mark.live,
        ...(epoch === undefined ? {} : { epoch }),
      }
    : null;
}

/** Reads the previous epoch-in-key format without requiring that metadata to have arrived yet. */
function previousMark(scope: string, epoch: number | undefined): Cleared | null {
  const prefix = key(scope.slice(0, -1) + ",");
  let found: Cleared | null = null;
  for (let i = 0; i < localStorage.length; i++) {
    const name = localStorage.key(i);
    if (!name?.startsWith(prefix) || !name.endsWith("]")) continue;
    const previousEpoch = Number(name.slice(prefix.length, -1));
    if (
      !Number.isSafeInteger(previousEpoch) ||
      previousEpoch < 0 ||
      (epoch !== undefined && previousEpoch !== epoch)
    )
      continue;
    const mark = decode(localStorage.getItem(name), previousEpoch);
    if (mark && (!found || (mark.epoch ?? -1) > (found.epoch ?? -1))) found = mark;
  }
  return found;
}

export function readCleared(scope: string | null, epoch?: number): Cleared | null {
  if (scope === null) return null;
  try {
    const raw = localStorage.getItem(key(scope));
    const mark = raw === null ? previousMark(scope, epoch) : decode(raw);
    // Unknown metadata must keep the boundary. A known different epoch is a rewritten journal.
    return mark && (epoch === undefined || mark.epoch === undefined || epoch === mark.epoch)
      ? mark
      : null;
  } catch {
    /* An unavailable or invalid mark reads as no mark. */
  }
  return null;
}

export function saveCleared(scope: string, mark: Cleared): void {
  try {
    localStorage.setItem(key(scope), JSON.stringify(mark));
  } catch {
    /* Clearing the mounted view still works without storage. */
  }
}

export function markCleared(
  scope: string,
  items: readonly TranscriptItem[],
  cursor: number,
  at = new Date().toISOString(),
  epoch?: number,
): Cleared {
  const live = items
    .filter(
      (item) =>
        ("streaming" in item && item.streaming) ||
        ((item.kind === "tool" || item.kind === "subagent") && item.status === "running") ||
        (item.kind === "ask" && item.resolution === null) ||
        (item.kind === "user" && item.pending),
    )
    .map((item) => item.id);
  const cleared: Cleared = {
    at,
    cursor: Math.max(0, cursor),
    live,
    ...(epoch === undefined ? {} : { epoch }),
  };
  saveCleared(scope, cleared);
  return cleared;
}

export function sinceCleared(
  items: readonly TranscriptItem[],
  cleared: Cleared | null,
  model: Pick<SessionModel, "itemCursor"> | null,
): readonly TranscriptItem[] {
  if (!cleared) return items;
  const live = new Set(cleared.live);
  return items.filter(
    (item) =>
      live.has(item.id) ||
      (item.kind === "user" && item.pending) ||
      (model?.itemCursor(item.id) ?? -1) > cleared.cursor,
  );
}
