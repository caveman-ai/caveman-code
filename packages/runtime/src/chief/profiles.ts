// Each Chief's profile (chief_profiles, chief/schema.ts): its name, its pixel character, its role, the model
// it thinks with, the permissions of the chats it starts, the projects it works in (none listed: every project),
// its soul, and its own autonomy and update levels (absent: Settings'). Keyed by its workspace (kind chief). A
// removed Chief keeps its row, marked removed.
import type { ChiefAutonomyLevel, ChiefAvatar, ChiefProfile, ChiefUpdates } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import type { WorkspaceRecord } from "../session-protocol/store.ts";

/** A profile as the runtime keeps it: the wire profile, and when it was removed. */
export interface StoredProfile extends ChiefProfile {
  readonly removed_at?: string;
}

export const DEFAULT_AVATAR: ChiefAvatar = { character: "caveman", tone: "medium-light" };

const STANDING = "- (Anything it should always keep in mind.)";
const CREW = "- (Goes to every chat it starts.)";
/** A new Chief's soul: two headings to fill in. Its placeholder lines never reach a prompt. */
export const STARTER_SOUL = `# Soul\n\n## Standing instructions\n${STANDING}\n\n## Crew rules\n${CREW}\n`;
const PLACEHOLDERS = new Set([STANDING, CREW]);

/** The soul without the starter's placeholder lines. */
export const withoutPlaceholders = (soul: string) =>
  soul
    .split("\n")
    .filter((line) => !PLACEHOLDERS.has(line.trim()))
    .join("\n");

/**
 * What of a soul goes in the Chief's prefix (its "Soul" section): the soul without its placeholders and
 * without a leading "# Soul" heading; nothing when all that is left is headings.
 */
export const soulSection = (soul: string) => {
  const text = withoutPlaceholders(soul)
    .replace(/^\s*#\s*soul\s*\n/i, "")
    .trim();
  return text.split("\n").some((line) => line.trim() !== "" && !/^#{1,6}\s/.test(line.trim())) ? text : "";
};

interface ProfileRow {
  id: string;
  name: string;
  avatar: string;
  model: string | null;
  access: string | null;
  project_ids: string;
  soul: string;
  autonomy: number | null;
  updates: string | null;
  topics: string | null;
  home: number;
  removed_at: string | null;
  project_id: string | null;
  project_default: number;
  role: string | null;
  created_at: string;
  updated_at: string;
}

/** The groups a Chief manages, as stored: an unreadable value is none, never a failure on every profile read. */
const topicsOf = (raw: string | null): string[] => {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
};

const profileOf = (row: ProfileRow): StoredProfile =>
  ({
    id: row.id,
    name: row.name,
    avatar: JSON.parse(row.avatar),
    model: row.model === null ? null : JSON.parse(row.model),
    access: row.access,
    // For older clients only (a Chief made 2026-11-15 to 17): nothing routes by them.
    ...(row.project_id === null ? {} : { project_id: row.project_id }),
    ...(row.project_default === 1 ? { project_default: true } : {}),
    // The projects it works in: the stored list, empty for every project.
    project_ids: JSON.parse(row.project_ids),
    ...(row.role === null || row.role === "" ? {} : { role: row.role }),
    soul: row.soul,
    ...(row.autonomy === null ? {} : { autonomy: row.autonomy as ChiefAutonomyLevel }),
    ...(row.updates === null ? {} : { updates: row.updates as ChiefUpdates }),
    ...(topicsOf(row.topics).length === 0 ? {} : { topics: topicsOf(row.topics) }),
    home: row.home === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.removed_at === null ? {} : { removed_at: row.removed_at }),
  }) as StoredProfile;

/** Whether a Chief works in `projectId` (sees and starts chats there): every project when it lists none, else the ones it lists. */
export const inProjects = (profile: Pick<ChiefProfile, "project_ids">, projectId: string | undefined) =>
  projectId !== undefined && (profile.project_ids.length === 0 || profile.project_ids.includes(projectId));

/** How many projects a Chief works in, for picking the most specific: every project counts as most. */
export const breadth = (profile: Pick<ChiefProfile, "project_ids">) => (profile.project_ids.length === 0 ? Number.POSITIVE_INFINITY : profile.project_ids.length);

/**
 * A profile with a new project list. The one-project fields of 2026-11-15 to 17 (project_id, project_default) stay only
 * while the list is still just that project: older clients read them as the Chief's one project.
 */
export const withProjects = (profile: StoredProfile, projectIds: ReadonlyArray<string>): StoredProfile => {
  const { project_id: one, project_default: first, ...rest } = profile;
  const still = one !== undefined && projectIds.length === 1 && projectIds[0] === one;
  return { ...rest, project_ids: [...projectIds], ...(still ? { project_id: one, ...(first ? { project_default: first } : {}) } : {}) } as StoredProfile;
};

/** The wire profile: never when it was removed. */
/**
 * The wire profile: never when it was removed, nor `project_default`, which only a runtime that refused to remove a
 * project's default Chief sends (a client offers no Remove on one): here any Chief can be removed. `project_id`, for
 * older clients that show a Chief under one project: its one project, when it lists exactly one.
 */
export const toWireProfile = (profile: StoredProfile): ChiefProfile => {
  const { removed_at: _removed, project_default: _default, project_id: _one, ...wire } = profile;
  return { ...wire, ...(profile.project_ids.length === 1 ? { project_id: profile.project_ids[0]! } : {}) };
};

export type ProfileStore = ReturnType<typeof makeProfileStore>;

export const makeProfileStore = (sql: SqlClient.SqlClient) => {
  /** Every Chief not removed, oldest first. */
  const live = sql<ProfileRow>`SELECT * FROM chief_profiles WHERE removed_at IS NULL ORDER BY created_at, id`.pipe(
    Effect.map((rows) => rows.map(profileOf)),
    Effect.orDie,
  );
  /** One Chief's profile, removed or not. */
  const get = (id: string) => sql<ProfileRow>`SELECT * FROM chief_profiles WHERE id = ${id}`.pipe(Effect.map((rows) => (rows[0] === undefined ? undefined : profileOf(rows[0]))), Effect.orDie);
  /** The home Chief's profile (a runtime's one Chief from before Chiefs had profiles), unless there is none. */
  const home = sql<ProfileRow>`SELECT * FROM chief_profiles WHERE home = 1 AND removed_at IS NULL ORDER BY created_at LIMIT 1`.pipe(
    Effect.map((rows) => (rows[0] === undefined ? undefined : profileOf(rows[0]))),
    Effect.orDie,
  );
  const put = (profile: StoredProfile) =>
    sql`INSERT INTO chief_profiles (id, name, avatar, model, access, project_ids, soul, autonomy, updates, topics, home, removed_at, created_at, updated_at, project_id, project_default, role)
      VALUES (${profile.id}, ${profile.name}, ${JSON.stringify(profile.avatar)}, ${profile.model === null ? null : JSON.stringify(profile.model)}, ${profile.access},
              ${JSON.stringify(profile.project_ids)}, ${profile.soul}, ${profile.autonomy ?? null}, ${profile.updates ?? null}, ${profile.topics?.length ? JSON.stringify(profile.topics) : null}, ${profile.home ? 1 : 0}, ${profile.removed_at ?? null}, ${profile.created_at}, ${profile.updated_at},
              ${profile.project_id ?? null}, ${profile.project_default ? 1 : 0}, ${profile.role ?? null})
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar, model = excluded.model, access = excluded.access,
        project_ids = excluded.project_ids, soul = excluded.soul, autonomy = excluded.autonomy, updates = excluded.updates, topics = excluded.topics, home = excluded.home, removed_at = excluded.removed_at, updated_at = excluded.updated_at,
        project_id = excluded.project_id, project_default = excluded.project_default, role = excluded.role`.pipe(Effect.asVoid, Effect.orDie);
  /** Back to Auto when its pick is still `pick` (its account is gone): true when this call changed it, so it is said once. */
  const clearModel = (id: string, pick: string, at: string) =>
    sql<{ id: string }>`UPDATE chief_profiles SET model = NULL, updated_at = ${at} WHERE id = ${id} AND model = ${pick} RETURNING id`.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.orDie,
    );
  return { live, get, home, put, clearModel };
};

/** One Chief: its workspace (kind chief) and its profile. */
export interface OneChief {
  readonly record: WorkspaceRecord;
  readonly profile: StoredProfile;
}
