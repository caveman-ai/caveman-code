import { describe, expect, it } from "vitest";
import { normalizeReleaseNotes, noteItems } from "../src/updates/releaseNotes.ts";

describe("release notes from the feed", () => {
  it("turn a nightly's commit list into items", () => {
    const note =
      "## New\n- desktop: Stable and Nightly channels\n- runtime: faster start\n\n## Fixed\n- web: the composer keeps its draft";
    expect(normalizeReleaseNotes(note, "0.4.3-nightly.20261109.12", "nightly")).toEqual([
      {
        version: "0.4.3-nightly.20261109.12",
        items: [
          "desktop: Stable and Nightly channels",
          "runtime: faster start",
          "web: the composer keeps its draft",
        ],
        releasedAt: "2026-11-09",
      },
    ]);
  });

  it("reduce HTML and markdown to words, drop front matter and comments, and cap the list", () => {
    expect(noteItems("<ul><li>A <b>bold</b> &amp; <a href='x'>linked</a> fix</li></ul>")).toEqual([
      "A bold & linked fix",
    ]);
    expect(
      noteItems(
        "---\nversion: 0.4.3\ntitle: x\n---\n\nIntro line.\n\n## Card\n\n[Docs](https://caveman.so) here\n<!-- draft -->",
      ),
    ).toEqual(["Intro line.", "Docs here"]);
    expect(noteItems(Array.from({ length: 20 }, (_, i) => `- item ${i}`).join("\n"))).toHaveLength(
      8,
    );
    expect(noteItems(`- ${"x".repeat(400)}`)[0]).toHaveLength(220);
    expect(noteItems(null)).toEqual([]);
  });

  it("keep only the channel's entries, newest first, dated by the feed or the nightly's day", () => {
    const notes = normalizeReleaseNotes(
      [
        { version: "0.4.3", note: "- stable fix" },
        { version: "0.4.3-nightly.20261109.2", note: "- second" },
        { version: "0.4.3-nightly.20261108.1", note: "- first" },
        { version: "0.4.3-nightly.20261107.1", note: "" },
        { bad: true },
      ],
      "0.4.3-nightly.20261109.2",
      "nightly",
      "2026-11-09T06:00:00.000Z",
    );
    expect(notes.map((n) => [n.version, n.releasedAt])).toEqual([
      ["0.4.3-nightly.20261109.2", "2026-11-09T06:00:00.000Z"],
      ["0.4.3-nightly.20261108.1", "2026-11-08"],
    ]);
    expect(normalizeReleaseNotes(42, "0.4.3", "stable")).toEqual([]);
  });
});
