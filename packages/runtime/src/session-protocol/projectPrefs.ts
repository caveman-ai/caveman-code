// A project's own settings, private to this computer: the user's instructions
// for the repository, the paths hidden from search and file tools, the user's
// own actions and their pick of its logo. Kept in the Session Protocol store
// beside Settings, keyed by project id.
import * as fs from "node:fs";
import * as path from "node:path";

import { CAVEMANIGNORE } from "@caveman-app/shared/ignorePaths";
import type { AccessMode, ProjectAction } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";

import type { SessionStore } from "./store.ts";

export interface ProjectPrefs {
  readonly instructions?: string;
  readonly ignorePaths?: ReadonlyArray<string>;
  /** Permissions for the project's new chats, over Settings.default_access. */
  readonly default_access?: AccessMode;
  /** The model the project's new chats start on, by engine, over Settings.engines[engine].model. */
  readonly default_models?: Readonly<Record<string, string>>;
  /** The Actions tab's "Just me" list (the team's are in .caveman/actions.toml). */
  readonly actions?: ReadonlyArray<ProjectAction>;
  /**
   * The project's sources beyond its own repository or folder, as this computer knows them (Project.sources): a
   * repository by its key (`host/owner/name`) with where it is checked out here, a checkout with no origin on a git
   * host, a plain folder. `name` is the source's for good: chats keep their checkouts under it.
   */
  readonly sources?: ReadonlyArray<StoredSource>;
  /** The part of the project's own repository it is about (ProjectSource.focus of its first source). */
  readonly focus?: string;
  /**
   * The person's logo for it (project.update `logo`): their image, a value that can travel with the project, or
   * "none" for the folder. Absent: what the checkout shows (Project.logo `auto`).
   */
  readonly logo?: "none" | PickedLogo;
}

/** A logo the person picked, as kept: the PNG the client drew, with the id of its bytes. */
export interface PickedLogo {
  /** A data:image/png;base64, URL of at most 64 KiB. */
  readonly url: string;
  readonly id: string;
  /** The checkout file it was drawn from; absent for an upload or the owner's avatar. */
  readonly path?: string;
  /** The id of that file's bytes when it was picked: its candidate is the logo while they are unchanged. */
  readonly source?: string;
}

export interface StoredSource {
  readonly name: string;
  readonly kind: "repo" | "folder";
  /** `host/owner/name`, lower-case; absent for a folder and for a repository with no origin on a git host. */
  readonly key?: string;
  /** Where it sits on this computer. */
  readonly path?: string;
  readonly focus?: string;
}

/**
 * A patch: a null default_access clears it; default_models replaces the engines it names, a null model clearing one;
 * a null logo goes back to what the checkout shows.
 */
export type ProjectPrefsPatch = Omit<ProjectPrefs, "default_access" | "default_models" | "logo"> & {
  readonly default_access?: AccessMode | null;
  readonly default_models?: Readonly<Record<string, string | null>>;
  readonly logo?: ProjectPrefs["logo"] | null;
};

type Store = SessionStore["Service"];

const keyOf = (projectId: string) => `project_prefs:${projectId}`;

export const readProjectPrefs = (store: Store, projectId: string): Effect.Effect<ProjectPrefs> =>
  store.kvGet(keyOf(projectId)).pipe(Effect.map((raw) => (raw === undefined ? {} : (JSON.parse(raw) as ProjectPrefs))));

/** Each key present replaces that field; an empty value, or a null default_access or model, removes it. */
export const updateProjectPrefs = (store: Store, projectId: string, patch: ProjectPrefsPatch): Effect.Effect<ProjectPrefs> =>
  Effect.gen(function* () {
    const next: { -readonly [K in keyof ProjectPrefs]: ProjectPrefs[K] } = { ...(yield* readProjectPrefs(store, projectId)) };
    if (patch.instructions !== undefined) {
      if (patch.instructions.trim() === "") delete next.instructions;
      else next.instructions = patch.instructions;
    }
    if (patch.ignorePaths !== undefined) {
      const lines = patch.ignorePaths.map((line) => line.trim()).filter((line) => line !== "");
      if (lines.length === 0) delete next.ignorePaths;
      else next.ignorePaths = lines;
    }
    if (patch.actions !== undefined) {
      if (patch.actions.length === 0) delete next.actions;
      else next.actions = patch.actions;
    }
    if (patch.logo === null) delete next.logo;
    else if (patch.logo !== undefined) next.logo = patch.logo;
    if (patch.default_access === null) delete next.default_access;
    else if (patch.default_access !== undefined) next.default_access = patch.default_access;
    if (patch.default_models !== undefined) {
      const models = { ...next.default_models };
      for (const [engine, model] of Object.entries(patch.default_models)) {
        if (model === null || model.trim() === "") delete models[engine];
        else models[engine] = model;
      }
      if (Object.keys(models).length === 0) delete next.default_models;
      else next.default_models = models;
    }
    yield* store.kvSet(keyOf(projectId), JSON.stringify(next));
    return next;
  });

/** Replaces the project's stored sources (and its own repository's focus); an empty list or focus removes it. */
export const writeProjectSources = (store: Store, projectId: string, change: { readonly sources?: ReadonlyArray<StoredSource>; readonly focus?: string }): Effect.Effect<ProjectPrefs> =>
  Effect.gen(function* () {
    const next: { -readonly [K in keyof ProjectPrefs]: ProjectPrefs[K] } = { ...(yield* readProjectPrefs(store, projectId)) };
    if (change.sources !== undefined) {
      if (change.sources.length === 0) delete next.sources;
      else next.sources = change.sources;
    }
    if (change.focus !== undefined) {
      if (change.focus.trim() === "") delete next.focus;
      else next.focus = change.focus.trim();
    }
    yield* store.kvSet(keyOf(projectId), JSON.stringify(next));
    return next;
  });

/** The committed .cavemanignore lines of a checkout; none when it has no such file. */
export function readCavemanignore(root: string): string[] {
  try {
    return fs.readFileSync(path.join(root, CAVEMANIGNORE), "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
}

/** Everything hidden in a checkout of the project: its own list, then the committed file. */
export const hiddenPathsFor = (store: Store, projectId: string | undefined, root: string): Effect.Effect<string[]> =>
  (projectId === undefined ? Effect.succeed<ProjectPrefs>({}) : readProjectPrefs(store, projectId)).pipe(
    Effect.map((prefs) => [...(prefs.ignorePaths ?? []), ...readCavemanignore(root)]),
  );
