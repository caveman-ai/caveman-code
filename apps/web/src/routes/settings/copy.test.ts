import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Settings copy is few words (packages/ui/STYLE.md, "Settings"; the founder,
// 2026-11-11: "there's so much yap with it"). A row's line is one short
// sentence, a card's line two at most. This reads every description written
// as a plain string in a Settings section, on a row or in a table of rows, and
// fails on one that runs long, so the next paragraph under a switch is caught
// before it ships. It cannot see a line built by an expression (a ternary, a
// JSX fragment): those are for review.
const dir = new URL("./", import.meta.url);
const sections = [
  ...readdirSync(dir)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => new URL(f, dir)),
  new URL("../../components/RemoteControl.tsx", import.meta.url),
  new URL("../../components/DesktopAppSettings.tsx", import.meta.url),
  new URL("../../components/Devices.tsx", import.meta.url),
  new URL("../Secrets.tsx", import.meta.url),
  new URL("../EngineAccounts.tsx", import.meta.url),
];

/** The most a line may run: about one line of the 720px column. */
const LIMIT = 100;
/**
 * Lines that owe the person a fact and need the room: what is sent off this computer, what Caveman deletes by itself.
 * Each is named here on purpose; a new one needs the same reason.
 */
const KEPT_LONG: ReadonlyArray<RegExp> = [
  // The usage stats disclosure, shared with first run: turn stats count from the moment it has named them.
  /^Which part of the app crashed/,
  // Held by Caveman: what syncs, and who can read a secret once it is turned on.
  /^Names and settings sync by themselves, so Cloud starts set up like/,
  // A problem report: what it is written from, and what is taken out before anything leaves this computer.
  /^Your model writes it up from the last few hours of logs/,
  // The confirm before Cloud deletes everything it holds: it names all that goes.
  /^Cloud deletes your synced settings/,
];

/** Every description="…", description={`…`} and, in a table of rows, description: "…" in a file, as the person reads it. */
export function descriptions(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/description(?:=|:\s*)(?:"([^"]*)"|\{?`([^`]*)`\}?)/g))
    out.push((m[1] ?? m[2] ?? "").replace(/\$\{[^}]*\}/g, "…"));
  return out;
}

it("reads plain and templated descriptions", () => {
  expect(
    descriptions(
      '<SettingRow label="A" description="One short line." />\n<SettingsCard description={`Up to ${MAX}.`}>',
    ),
  ).toEqual(["One short line.", "Up to …."]);
});

it("reads a table of rows too", () => {
  expect(
    descriptions(
      'const ROLES = [{ role: "review", description: "Checks a diff against the task" }, { role: "x", description: `Up to ${MAX}` }];',
    ),
  ).toEqual(["Checks a diff against the task", "Up to …"]);
});

describe("settings copy stays short", () => {
  for (const file of sections) {
    it(file.pathname.split("/").pop()!, () => {
      const long = descriptions(readFileSync(file, "utf8")).filter(
        (d) => d.length > LIMIT && !KEPT_LONG.some((kept) => kept.test(d)),
      );
      expect(
        long,
        `over ${LIMIT} characters: say it in one short sentence, or leave it out`,
      ).toEqual([]);
    });
  }
});
