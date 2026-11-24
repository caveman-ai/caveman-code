/**
 * Model families and which of a family's models is the newest, so a new version takes its predecessor's place with
 * no list to edit: the Caveman engine's picker and Auto (provider-caveman providers.ts), and a maker's new release
 * found on models.dev beside an engine's own catalog (ModelCatalog.ts `withSuccessors`).
 *
 * A family is a model id with its version taken out (`gpt-6.1-sol` is `gpt-sol` 6.1, `claude-opus-5-5` is
 * `claude-opus` 5.5, `accounts/fireworks/models/glm-5p3` is `glm` 5.3). A gateway's maker prefix, a Bedrock vendor
 * prefix and suffixes after `@` or `:` (`@default`, `:batch`, `:free`) are not part of it; a Bedrock geography
 * (`us.`) is, because a cross-region profile is a different id to call.
 *
 * @module engine-core/server/modelLine
 */

export interface ModelLine {
  readonly family: string;
  /** Version numbers in id order: `[6, 1]` for gpt-6.1-sol. */
  readonly version: ReadonlyArray<number>;
  /** A date stamp (`-20250929`, `-2512`, `-0813`), which only orders models of one version. */
  readonly date?: number;
  /** `-latest` and `~` ids follow whatever their maker points them at. */
  readonly alias: boolean;
  readonly preview: boolean;
}

const GEO = /^(us|eu|apac|au|jp|ca|global)\./;
const QUALIFIERS = new Set(["preview", "exp", "experimental", "beta"]);

/** Each id's line, parsed once and shared (frozen): the Caveman engine weighs every models.dev id against every family. */
const lines = new Map<string, ModelLine>();

/** A model id's family and version. */
export function modelLine(id: string): ModelLine {
  let line = lines.get(id);
  if (line === undefined) {
    line = parseLine(id);
    Object.freeze(line.version);
    lines.set(id, Object.freeze(line));
  }
  return line;
}

function parseLine(id: string): ModelLine {
  const last = id.slice(id.lastIndexOf("/") + 1);
  let core = last.toLowerCase().replace(/[@:].*$/, "");
  const geo = GEO.exec(core)?.[0] ?? "";
  core = core.slice(geo.length).replace(/^[a-z-]+\.(?=[a-z])/, "");
  let date: number | undefined;
  // Calendar dates first, so their parts never read as version numbers.
  core = core
    .replace(/-(\d{4})-(\d{2})-(\d{2})(?=-|$)/, (_, y, m, d) => ((date = Number(`${y}${m}${d}`)), ""))
    .replace(/-(\d{2})-(\d{4})(?=-|$)/, (_, m, y) => ((date = Number(`${y}${m}`)), ""));
  const family: Array<string> = [];
  const version: Array<number> = [];
  let alias = last.startsWith("~");
  let preview = false;
  for (const token of core.split("-")) {
    let match: RegExpExecArray | null;
    if (/^\d{4}$|^\d{6}$|^\d{8}$/.test(token)) date = Number(token);
    else if ((match = /^(\d{1,3})(?:[.p](\d+))?(?:\.(\d+))?$/.exec(token))) version.push(...match.slice(1).filter((n) => n !== undefined).map(Number));
    // A revision after the version (`claude-opus-4-6-v1`) names the same model.
    else if (version.length > 0 && /^v\d+$/.test(token)) continue;
    else if ((match = /^([a-z]+)(\d+(?:[.p]\d+)*)$/.exec(token))) {
      family.push(match[1]!);
      version.push(...match[2]!.split(/[.p]/).map(Number));
    } else if (token === "latest") alias = true;
    else if (QUALIFIERS.has(token)) preview = true;
    else if (token !== "") family.push(token);
  }
  return { family: geo + family.join("-"), version, ...(date === undefined ? {} : { date }), alias, preview };
}

/**
 * A version part's rank. After the major one, parts read as decimals, the way makers have numbered releases: xAI
 * shipped Grok 4.20 between 4.1 and 4.3, so 4.20 ranks below 4.7. A maker going from x.9 to x.10 would read as older;
 * none has yet, and lineup.test.ts pins the choice.
 */
const versionRank = (version: ReadonlyArray<number>, i: number) => {
  const part = version[i];
  return part === undefined ? -1 : i === 0 ? part : Number(`0.${part}`);
};

/** Negative when `a` is the newer model of its family. */
export function compareLines(a: ModelLine, b: ModelLine): number {
  for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
    const diff = versionRank(b.version, i) - versionRank(a.version, i);
    if (diff !== 0) return diff;
  }
  if (a.alias !== b.alias) return a.alias ? 1 : -1;
  if (a.preview !== b.preview) return a.preview ? 1 : -1;
  // One version, dated and not: the undated id is the one that stays current.
  if ((a.date === undefined) !== (b.date === undefined)) return a.date === undefined ? -1 : 1;
  return (b.date ?? 0) - (a.date ?? 0);
}

/**
 * For each family, in `families` order, the newest model `models` has that is not `retired` (models.dev's deprecated
 * flag, modelsDev.ts). A family with nothing left lists nothing.
 */
export function newestOfFamilies<M extends { readonly id: string }>(
  models: ReadonlyArray<M>,
  families: ReadonlyArray<string>,
  retired: (id: string) => boolean = () => false,
): Array<M> {
  const lines = models.filter((model) => !retired(model.id)).map((model) => ({ model, line: modelLine(model.id) }));
  return families.flatMap((family) => {
    const newest = lines
      .filter((entry) => entry.line.family === family)
      .sort((a, b) => compareLines(a.line, b.line) || a.model.id.length - b.model.id.length || a.model.id.localeCompare(b.model.id))[0];
    return newest === undefined ? [] : [newest.model];
  });
}
