// Release notes for a desktop release: releases/<version>.md at the repository
// root (releases/README.md). The app shows them in What's new; the release
// workflow refuses a version without finished notes and uses them as the
// GitHub release body.
//   node apps/desktop/scripts/release-notes.mjs draft 0.2.0   write a draft with the commits since the last release
//   node apps/desktop/scripts/release-notes.mjs check 0.2.0   exit 1 unless the notes are written and finished
//   node apps/desktop/scripts/release-notes.mjs body 0.2.0    the GitHub release body (checks first)
//   node apps/desktop/scripts/release-notes.mjs nightly 0.2.1-nightly.20261109.3
//                                                            a nightly's notes, generated from its commits (stdout)
// A nightly has no file here and nothing to finish: desktop-nightly.yml puts these in its feed (Settings > General
// lists them) and its run summary. Stable releases still need finished notes.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRelease, releaseMarkdown, unfinished } from "../../web/src/whats-new/notes.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const [command, raw] = process.argv.slice(2);
const version = raw?.replace(/^v/, "");
if (!["draft", "check", "body", "nightly"].includes(command) || !version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: release-notes.mjs draft|check|body|nightly <version>");
  process.exit(2);
}
if (command === "nightly" && !/-nightly\.\d{8}\.\d+$/.test(version)) {
  console.error(`${version} is not a nightly version (<next>-nightly.<YYYYMMDD>.<run>)`);
  process.exit(2);
}
const rel = `releases/${version}.md`;
const file = join(root, rel);

const git = (...args) => {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
};

const NIGHTLY_LINES = 50;

/** `- scope: subject` for each feat, fix and perf commit subject, newest first: what people can notice. */
const noticeable = (subjects) =>
  subjects.flatMap((subject) => {
    const m = /^(feat|fix|perf)(?:\(([^)]*)\))?!?: (.+)$/.exec(subject);
    return m ? [`- ${m[2] ? `${m[2]}: ` : ""}${m[3]}`] : [];
  });

if (command === "nightly") {
  const since = git("describe", "--tags", "--abbrev=0", "--match", "desktop-v*", "HEAD");
  const subjects = git("log", "--no-merges", "--format=%s", since ? `${since}..HEAD` : "HEAD").split("\n").filter(Boolean);
  const lines = noticeable(subjects);
  const head = git("rev-parse", "--short=10", "HEAD");
  // The newest NIGHTLY_LINES only: the notes ride in latest-mac.yml, which every install on Nightly fetches, and
  // Settings > General lists eight.
  const listed = lines.length ? lines.slice(0, NIGHTLY_LINES).join("\n") : `- No feat, fix or perf commits since ${since || "the first commit"}.`;
  const text = `${listed}\n\nBuilt from ${head} on main, ${lines.length} changes since ${since || "the first commit"}.\n`;
  // Exit once it is written: on macOS a pipe takes stdout asynchronously, and exiting at once cuts it at 64 KB.
  await new Promise((done) => process.stdout.write(text, done));
  process.exit(0);
}

if (command === "draft") {
  if (existsSync(file)) {
    console.error(`${rel} exists already`);
    process.exit(1);
  }
  // The last desktop release tag reachable from here; none before the first release.
  const since = git("describe", "--tags", "--abbrev=0", "--match", "desktop-v*", "HEAD");
  const subjects = git("log", "--no-merges", "--format=%s", since ? `${since}..HEAD` : "HEAD").split("\n").filter(Boolean);
  // What people can notice; tests, docs, CI and refactors are not news.
  const kinds = { feat: "New", fix: "Fixed", perf: "Faster" };
  const groups = new Map();
  for (const s of subjects) {
    const m = /^(feat|fix|perf)(?:\(([^)]*)\))?!?: (.+)$/.exec(s);
    if (!m) continue;
    const key = kinds[m[1]];
    groups.set(key, [...(groups.get(key) ?? []), `- ${m[2] ? `${m[2]}: ` : ""}${m[3]}`]);
  }
  const commits = [...groups].map(([k, lines]) => `${k}\n${lines.join("\n")}`).join("\n\n") || "(no feat, fix or perf commits)";
  writeFileSync(
    file,
    `---
version: ${version}
date: ${new Date().toISOString().slice(0, 10)}
title: Caveman Code ${version}
blog:
x:
draft: true
---

One or two sentences: what this release is about, for someone who uses the app.

## The first change people will notice

What it does for them and where to find it. One section per change worth
telling; fold small fixes into a last "Fixes" section as a list.

<!--
Rewrite these for people, then delete this block and the draft line.
Commits since ${since || "the first commit"}:

${commits.replaceAll("--", "- -")}
-->
`,
  );
  console.log(`wrote ${rel}: ${subjects.length} commits since ${since || "the first commit"}`);
  process.exit(0);
}

if (!existsSync(file)) {
  console.error(`${rel} is missing. Every release says what changed: run \`node apps/desktop/scripts/release-notes.mjs draft ${version}\`, write it, commit it.`);
  process.exit(1);
}
const source = readFileSync(file, "utf8");
let release;
try {
  release = parseRelease(rel, source);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const problems = unfinished(release, source);
if (problems.length) {
  console.error(`${rel} is not finished:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
if (command === "check") console.log(`${rel}: ${release.sections.length} sections, ready`);
else process.stdout.write(releaseMarkdown(release));
