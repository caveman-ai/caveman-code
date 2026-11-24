// What the Chief knows about each repository it can start chats in, read from the checkout: its origin remote and
// package.json description (what tells two clones or namesakes apart), and a profile of what the code is (a README
// summary, its languages, its main areas, and an index of the words its paths use). prompt.ts turns the profile into
// the Projects section and matches a note's words against the index (projectEvidence). Profiles are cached per
// checkout and built again when the repository changes (its HEAD or its index moved).
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** What tells a checkout from a namesake: its origin remote and its package.json description. */
export interface RepoFacts {
  readonly remote?: string;
  readonly description?: string;
}

/** Where a term shows up in a repository: how many files' paths carry it, and where most of them are (folders, else a file). */
export interface TermHit {
  readonly files: number;
  readonly at: ReadonlyArray<string>;
}

/** A repository at a glance, built from its file list and README (profileOf). */
export interface RepoProfile {
  /** Its README's opening paragraph, else its package.json description, flattened and short. */
  readonly summary?: string;
  /** Its main languages by file count, largest first: "TypeScript 91%". */
  readonly languages: ReadonlyArray<string>;
  /** Its main modules with the areas inside them, largest first: "packages/runtime (chief, voice, store)". */
  readonly areas: ReadonlyArray<string>;
  /** Every term its paths use (tokens of directory and file names, stemmed), with how many files carry it. */
  readonly terms: ReadonlyMap<string, TermHit>;
  /** How many files it was built from. */
  readonly files: number;
}

const read = (file: string) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

/** A checkout's git directory and the common one (a worktree's .git is a file pointing at its own gitdir). */
const gitDirs = (root: string) => {
  let gitDir = path.join(root, ".git");
  const pointer = read(gitDir)?.match(/^gitdir:\s*(.+)$/m);
  if (pointer) gitDir = path.resolve(root, pointer[1]!.trim());
  const commonDir = read(path.join(gitDir, "commondir"))?.trim();
  return { gitDir, commonDir: commonDir === undefined ? gitDir : path.resolve(gitDir, commonDir) };
};

/** Its origin remote (.git/config, never a credential) and its package.json description: two small reads, no git. */
export const repoFacts = (root: string): RepoFacts => {
  const config = read(path.join(gitDirs(root).commonDir, "config")) ?? "";
  // Never a credential in the prompt: an https remote can carry a token as its user (https://x:token@host/…).
  const origin = /^\[remote "origin"\]\s*\n(?:[ \t]+.*\n?)*?[ \t]+url\s*=\s*(.+)$/m.exec(config)?.[1]?.trim().replace(/^([a-z][\w+.-]*:\/\/)[^/@]*@/i, "$1");
  let description: string | undefined;
  try {
    const parsed = JSON.parse(read(path.join(root, "package.json")) ?? "null") as { description?: unknown } | null;
    if (typeof parsed?.description === "string" && parsed.description.trim() !== "") description = parsed.description.trim();
  } catch {
    // No package.json, or not JSON: no description.
  }
  return { ...(origin ? { remote: origin } : {}), ...(description ? { description } : {}) };
};

/** One repository however it is cloned: "git@github.com:a/b.git" and "https://github.com/a/b" are both github.com/a/b. */
export const sameRemote = (remote: string) =>
  remote
    .trim()
    .toLowerCase()
    .replace(/^[a-z][\w+.-]*:\/\//, "")
    .replace(/^[^/@]*@/, "")
    .replace(/^([^/:]+):(?!\d)/, "$1/")
    .replace(/\.git\/?$|\/+$/g, "");

/**
 * What changes when the repository does: its HEAD (a commit or a branch switch) and its index (a checkout, an add,
 * a commit). Two small reads; undefined for a folder that is no git checkout.
 */
export const repoKey = (root: string) => {
  const { gitDir } = gitDirs(root);
  const head = read(path.join(gitDir, "HEAD"))?.trim();
  if (head === undefined) return undefined;
  let index = 0;
  try {
    index = fs.statSync(path.join(gitDir, "index")).mtimeMs;
  } catch {
    // A repository with no index yet.
  }
  return `${head}|${index}`;
};

/** When the checkout last changed (its index), as ISO: how recently someone worked in it outside any chat. */
export const repoTouchedAt = (root: string) => {
  try {
    return fs.statSync(path.join(gitDirs(root).gitDir, "index")).mtime.toISOString();
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------- terms

/** Words that say nothing about where work belongs: English filler, and what every codebase's paths are made of. */
const STOP = new Set(
  (
    "the and for with that this these those from into onto over under about after before then than when where which who whom what why how " +
    "let lets make made makes should would could can cant will wont must may might need needs want wants just also only even still very really " +
    "they them their themselves our ours ourselves you your yours yourself its itself his her him she are was were been being have has had " +
    "not but all any some each every one two three more most less few other others same such own like idk thing things stuff way ways " +
    "get gets got put set use used using work works working done doing please now new old there here out off too yes yeah okay " +
    "src lib dist build out bin test tests spec specs mock mocks fixture fixtures index main mod module modules type types util utils " +
    "helper helpers common shared core misc tmp temp file files folder dir code repo repository project projects app apps package packages " +
    "json yaml yml toml lock txt readme license changelog gitignore ts tsx js jsx mjs cjs md mdx css scss html svg png jpg py go rs " +
    "chat chats change changes fix fixes add adds update updates"
  ).split(" "),
);
/** Directories never read: what a build or an install made, and dot folders. */
const SKIP_DIR = new Set(["node_modules", "dist", "build", "out", "target", "vendor", ".git", ".next", ".turbo", "coverage", "__pycache__", ".venv", "venv"]);

/** "chiefs" and "chief", "replies" and "reply" are one term. */
const stem = (word: string) => (word.length > 4 && word.endsWith("ies") ? `${word.slice(0, -3)}y` : word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word);

/** The terms in a piece of text or a path: words split at punctuation and camelCase, lowercased, stemmed, filler gone. */
export const termsOf = (text: string): ReadonlyArray<string> => {
  const out = new Set<string>();
  // "PR" is how people say pull request, and how code never names it.
  for (const raw of text.replace(/\bPRs?\b/gi, " pull request ").replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(/[^A-Za-z\d]+/)) {
    const word = raw.toLowerCase();
    if (word.length < 3 || /^\d+$/.test(word) || STOP.has(word)) continue;
    const stemmed = stem(word);
    if (!STOP.has(stemmed)) out.add(stemmed);
  }
  return [...out];
};

// ---------------------------------------------------------------- profile

const LANGUAGES: Readonly<Record<string, string>> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", go: "Go", rs: "Rust", swift: "Swift", kt: "Kotlin", java: "Java", rb: "Ruby", php: "PHP", cs: "C#", c: "C", h: "C",
  cc: "C++", cpp: "C++", hpp: "C++", m: "Objective-C", mm: "Objective-C", dart: "Dart", ex: "Elixir", exs: "Elixir", lua: "Lua", zig: "Zig",
  css: "CSS", scss: "CSS", html: "HTML", vue: "Vue", svelte: "Svelte", astro: "Astro", sql: "SQL", sh: "Shell", md: "Markdown", mdx: "Markdown",
};
/** Folders that hold modules: their children are the modules (apps/web, packages/runtime). */
const CONTAINERS = new Set(["apps", "packages", "crates", "services", "libs", "modules", "plugins", "extensions", "cmd", "internal", "pkg", "projects", "workers"]);
/** Folders inside a module that say nothing of its areas: the area is the folder below them. */
const PLAIN = new Set(["src", "lib", "source", "sources", "main", "java", "kotlin", "swift", "app", "test", "tests", "__tests__", "spec", "specs"]);

const flat = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** A README's opening paragraph of prose: no headings, badges, images, HTML or code. */
export const readmeSummary = (readme: string) => {
  const paragraphs = readme.replace(/```[\s\S]*?```/g, "").split(/\n\s*\n/);
  for (const paragraph of paragraphs) {
    const text = paragraph
      .split("\n")
      .filter((line) => !/^\s*(#|<|!\[|\[!\[|>|---|\||[-*_]{3,}\s*$)/.test(line))
      .join(" ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[`*_]/g, "")
      .trim();
    if (text.length >= 12) return flat(text, 200);
  }
  return undefined;
};

/** A repository's profile from its file list (paths relative to its root) and its README. Pure, so tests read it. */
export const profileOf = (files: ReadonlyArray<string>, readme?: string, description?: string): RepoProfile => {
  const languages = new Map<string, number>();
  const modules = new Map<string, { files: number; areas: Map<string, number> }>();
  const terms = new Map<string, number>();
  /** Per term, the folders it names and how many files sit under each; else the first file whose name has it. */
  const places = new Map<string, Map<string, number>>();
  const firstFile = new Map<string, string>();
  let counted = 0;
  for (const file of files) {
    const parts = file.split("/");
    if (parts.some((p) => SKIP_DIR.has(p) || (p.startsWith(".") && p !== parts.at(-1)))) continue;
    counted++;
    const name = parts.at(-1)!;
    const language = LANGUAGES[name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : ""];
    if (language !== undefined) languages.set(language, (languages.get(language) ?? 0) + 1);
    // Its module: a container's child (packages/runtime), else its top folder; a file at the root has none.
    const depth = CONTAINERS.has(parts[0]!) && parts.length > 2 ? 2 : parts.length > 1 ? 1 : 0;
    if (depth > 0) {
      const root = parts.slice(0, depth).join("/");
      const module = modules.get(root) ?? { files: 0, areas: new Map<string, number>() };
      module.files++;
      const area = parts.slice(depth, -1).find((p) => !PLAIN.has(p.toLowerCase()));
      if (area !== undefined) module.areas.set(area, (module.areas.get(area) ?? 0) + 1);
      modules.set(root, module);
    }
    // Its terms, each once per file: where a folder names it, that folder is where it lives; else the file is.
    const seen = new Set<string>();
    parts.forEach((part, i) => {
      const isDir = i < parts.length - 1;
      for (const term of termsOf(isDir ? part : part.replace(/\.[^.]+$/, ""))) {
        if (isDir) {
          const at = parts.slice(0, i + 1).join("/");
          const counts = places.get(term) ?? new Map<string, number>();
          counts.set(at, (counts.get(at) ?? 0) + 1);
          places.set(term, counts);
        } else if (!firstFile.has(term)) firstFile.set(term, file);
        if (seen.has(term)) continue;
        seen.add(term);
        terms.set(term, (terms.get(term) ?? 0) + 1);
      }
    });
  }
  const summary = (readme === undefined ? undefined : readmeSummary(readme)) ?? (description === undefined ? undefined : flat(description, 200));
  // What the README and description say counts as a few files' worth.
  for (const term of termsOf(`${summary ?? ""} ${description ?? ""}`)) {
    terms.set(term, (terms.get(term) ?? 0) + 3);
    if (!places.has(term) && !firstFile.has(term)) firstFile.set(term, "README");
  }
  const totalLanguages = [...languages.values()].reduce((a, b) => a + b, 0);
  return {
    ...(summary === undefined ? {} : { summary }),
    languages: [...languages.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .filter(([, n]) => n / totalLanguages >= 0.03)
      .map(([language, n]) => `${language} ${Math.round((n / totalLanguages) * 100)}%`),
    areas: [...modules.entries()]
      .sort((a, b) => b[1].files - a[1].files)
      .slice(0, 8)
      .map(([root, m]) => {
        const inside = [...m.areas.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([a]) => a);
        return inside.length === 0 ? root : `${root} (${inside.join(", ")})`;
      }),
    terms: new Map(
      [...terms.entries()].map(([term, files]) => {
        const folders = [...(places.get(term) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);
        // The two folders holding most of it, never one inside the other.
        const at: Array<string> = [];
        for (const [folder] of folders) {
          if (at.length === 2) break;
          if (!at.some((a) => folder.startsWith(`${a}/`) || a.startsWith(`${folder}/`))) at.push(folder);
        }
        return [term, { files, at: at.length > 0 ? at : [firstFile.get(term) ?? "README"] }];
      }),
    ),
    files: counted,
  };
};

/** The profile as the Projects section shows it: one line, its summary, languages and areas. */
export const profileLine = (profile: RepoProfile) =>
  [
    ...(profile.summary ? [profile.summary.replace(/[.\s]*$/, ".")] : []),
    ...(profile.languages.length > 0 ? [`Languages: ${profile.languages.join(", ")}.`] : []),
    ...(profile.areas.length > 0 ? [`Areas: ${profile.areas.join("; ")}.`] : []),
  ].join(" ");

// ---------------------------------------------------------------- reading a checkout

const MAX_FILES = 50_000;

/** Its tracked files (git ls-files): paths relative to the root. Fails when git can't list them (too slow, or no git). */
export const gitFiles = (root: string) =>
  new Promise<ReadonlyArray<string>>((resolve, reject) => {
    execFile("git", ["-C", root, "ls-files", "-z"], { maxBuffer: 64 * 1024 * 1024, timeout: 15_000 }, (error, stdout) =>
      error === null ? resolve(stdout.split("\0").filter(Boolean).slice(0, MAX_FILES)) : reject(error),
    );
  });

/**
 * A folder that is no git checkout: a bounded walk of its folders, asynchronous so a large one (a home folder) never
 * holds the runtime's event loop.
 */
const walkFiles = async (root: string) => {
  const out: Array<string> = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= MAX_FILES || depth > 6) return;
    const entries = await fs.promises.readdir(path.join(root, dir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      if (entry.name.startsWith(".") || SKIP_DIR.has(entry.name)) continue;
      const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(rel, depth + 1);
      else if (entry.isFile()) out.push(rel);
    }
  };
  await walk("", 0);
  return out;
};

/** Its README, whichever way it is spelled. */
const readmeOf = (root: string) => {
  for (const name of ["README.md", "readme.md", "Readme.md", "README.markdown", "README.txt", "README"]) {
    const text = read(path.join(root, name));
    if (text !== undefined) return text;
  }
  return undefined;
};

/** How long a read waits for a changed checkout's new profile before it takes the last one (a rebuild is ~50ms). */
const REBUILD_WAIT_MS = 1_000;

/**
 * Profiles by checkout, built again when its repository changed (repoKey). A checkout's first profile is waited for;
 * after a change a read waits for the new one at most REBUILD_WAIT_MS and otherwise keeps the last, so a note's turn
 * (and the admission lock that reads the evidence) never waits long on a large checkout. One build per change. When
 * git can't list a checkout's files the last profile stays and the next read tries again (an empty listing is never
 * taken for its code); a folder that is gone has no profile; neither ever fails the Chief.
 */
export const makeRepoProfiles = () => {
  const cache = new Map<string, { key: string | undefined; build: Promise<RepoProfile | undefined>; last?: RepoProfile | undefined; built: boolean }>();
  return (root: string): Promise<RepoProfile | undefined> => {
    const key = repoKey(root);
    const cached = cache.get(root);
    // A folder that is no git checkout keeps its first profile: it has nothing to say it changed.
    if (cached !== undefined && cached.key === key) return cached.built ? Promise.resolve(cached.last) : cached.build;
    const entry = { key, build: Promise.resolve<RepoProfile | undefined>(undefined), last: cached?.last, built: cached?.built ?? false };
    entry.build = (async () => {
      if (!fs.existsSync(root)) return undefined;
      const files = key === undefined ? await walkFiles(root) : await gitFiles(root);
      return profileOf(files, readmeOf(root), repoFacts(root).description);
    })().then(
      (profile) => {
        // Only the newest build lands: an older one finishing late never overwrites it.
        if (cache.get(root) === entry) {
          entry.last = profile;
          entry.built = true;
        }
        return profile;
      },
      () => {
        // A listing that failed is no profile of the code: keep the last one, and the next read tries again.
        if (cache.get(root) === entry) entry.key = `${key}|failed`;
        return entry.last;
      },
    );
    cache.set(root, entry);
    if (!entry.built) return entry.build;
    const stale = entry.last;
    return Promise.race([entry.build, new Promise<RepoProfile | undefined>((resolve) => setTimeout(() => resolve(stale), REBUILD_WAIT_MS).unref())]);
  };
};
