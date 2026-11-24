// Release notes: one markdown file per desktop release in releases/ at the
// repository root (releases/README.md says how to write one). The app bundles
// them for What's new; apps/desktop/scripts/release-notes.mjs drafts and checks
// them and turns one into the GitHub release body. Plain TypeScript with no
// imports, so Node runs this file as it is.

export interface ReleaseSection {
  readonly heading: string;
  /** Markdown. */
  readonly body: string;
}

export interface Release {
  readonly version: string;
  /** YYYY-MM-DD. */
  readonly date: string;
  readonly title: string;
  /** A blog post about this release, if there is one. */
  readonly blog?: string;
  /** The post about it on X, if there is one. */
  readonly x?: string;
  /** Not written yet: development builds show it, release builds never do, and the release workflow refuses it. */
  readonly draft: boolean;
  /** Markdown before the first section. */
  readonly intro: string;
  readonly sections: ReadonlyArray<ReleaseSection>;
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const FIELDS = new Set(["version", "date", "title", "blog", "x", "draft"]);

/** Parses one notes file; throws with every problem a writer has to fix. */
export function parseRelease(file: string, source: string): Release {
  const problems: string[] = [];
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n"));
  if (!match) throw new Error(`${file}: starts with a --- block of version, date and title`);
  const fields = new Map<string, string>();
  for (const line of match[1]!.split("\n")) {
    if (!line.trim()) continue;
    const at = line.indexOf(":");
    const key = at < 0 ? line.trim() : line.slice(0, at).trim();
    if (at < 0 || !FIELDS.has(key)) problems.push(`unknown line "${line}" (fields: ${[...FIELDS].join(", ")})`);
    else fields.set(key, line.slice(at + 1).trim().replace(/^(["'])(.*)\1$/, "$2"));
  }

  const version = fields.get("version") ?? "";
  if (!VERSION.test(version)) problems.push(`version "${version}" is not a version like 0.2.0`);
  const name = file.split("/").pop()!;
  if (name !== `${version}.md`) problems.push(`the file is named ${name}; its version says ${version}.md`);
  const date = fields.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) problems.push(`date "${date}" is not YYYY-MM-DD`);
  const title = fields.get("title") ?? "";
  if (!title) problems.push("title is missing");
  else if (title.length > 80) problems.push(`title is ${title.length} characters; keep it under 80`);
  const blog = link(fields.get("blog"), "blog", [], problems);
  const x = link(fields.get("x"), "x", ["x.com", "twitter.com"], problems);
  const draftField = fields.get("draft");
  if (draftField !== undefined && draftField !== "true" && draftField !== "false") problems.push(`draft is "${draftField}"; write true or false`);

  // Split on "## " lines outside code fences.
  const intro: string[] = [];
  const parts: Array<{ heading: string; lines: string[] }> = [];
  let fence = false;
  for (const line of match[2]!.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const heading = fence ? null : /^## +(.*)$/.exec(line);
    if (heading) parts.push({ heading: heading[1]!.trim(), lines: [] });
    else (parts.at(-1)?.lines ?? intro).push(line);
  }
  const sections = parts.map((p) => ({ heading: p.heading, body: p.lines.join("\n").trim() }));
  if (sections.length === 0) problems.push("no ## sections: write one per change people will notice");
  for (const s of sections) {
    if (!s.heading) problems.push("a ## heading is empty");
    else if (!s.body) problems.push(`section "${s.heading}" is empty`);
  }

  if (problems.length) throw new Error(`${file}:\n  - ${problems.join("\n  - ")}`);
  return { version, date, title, ...(blog ? { blog } : {}), ...(x ? { x } : {}), draft: draftField === "true", intro: intro.join("\n").trim(), sections };
}

function link(value: string | undefined, field: string, hosts: ReadonlyArray<string>, problems: string[]): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");
    if (url.protocol === "https:" && (!hosts.length || hosts.some((h) => host === h || host.endsWith(`.${h}`)))) return url.href;
  } catch {
    // Reported below.
  }
  problems.push(`${field} "${value}" is not an https link${hosts.length ? ` on ${hosts.join(" or ")}` : ""}`);
  return undefined;
}

/** What still stops a release: a draft, or the commit list `draft` wrote left in (HTML shows as text). */
export function unfinished(release: Release, source: string): string[] {
  const problems: string[] = [];
  if (release.draft) problems.push("draft: true is still set");
  if (/^\s*<!--/m.test(source)) problems.push("an <!-- --> block is still in it (the commit list from `draft`): rewrite it in your own words, then delete it");
  return problems;
}

/** Semver order: -1, 0 or 1. A prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const pa = VERSION.exec(a);
  const pb = VERSION.exec(b);
  if (!pa || !pb) throw new Error(`not versions: ${a}, ${b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return Math.sign(d);
  }
  if (!pa[4] || !pb[4]) return pa[4] ? -1 : pb[4] ? 1 : 0;
  const xa = pa[4].split(".");
  const xb = pb[4].split(".");
  for (let i = 0; i < Math.min(xa.length, xb.length); i++) {
    const [s, t] = [xa[i]!, xb[i]!];
    if (s === t) continue;
    const [ns, nt] = [/^\d+$/.test(s), /^\d+$/.test(t)];
    if (ns && nt) return Math.sign(Number(s) - Number(t));
    if (ns !== nt) return ns ? -1 : 1;
    return s < t ? -1 : 1;
  }
  return Math.sign(xa.length - xb.length);
}

/**
 * The releases this build may show, newest first: no drafts outside
 * development, nothing newer than the app (notes for the next release can land
 * before it ships). An unversioned build (0.0.0, or a browser) shows them all.
 */
export function shownReleases(all: ReadonlyArray<Release>, appVersion: string | null, dev: boolean): Release[] {
  const versioned = appVersion !== null && appVersion !== "0.0.0" && VERSION.test(appVersion);
  return all
    .filter((r) => (dev || !r.draft) && (!versioned || compareVersions(r.version, appVersion) <= 0))
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** Releases newer than the last one this device looked at. Nothing on a first launch: there was no last time. */
export function unseenReleases(shown: ReadonlyArray<Release>, seen: string | null): Release[] {
  if (seen === null || !VERSION.test(seen)) return [];
  return shown.filter((r) => compareVersions(r.version, seen) > 0);
}

/** The GitHub release body for one release. */
export function releaseMarkdown(r: Release): string {
  const links = [r.blog ? `[Read the post](${r.blog})` : "", r.x ? `[On X](${r.x})` : ""].filter(Boolean).join(" · ");
  return [`# ${r.title}`, r.intro, ...r.sections.map((s) => `## ${s.heading}\n\n${s.body}`), links].filter(Boolean).join("\n\n") + "\n";
}
