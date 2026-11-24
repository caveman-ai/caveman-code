import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareVersions, parseRelease, releaseMarkdown, shownReleases, unfinished, unseenReleases, type Release } from "./notes.ts";

const note = (version: string, extra = "", body = "## Queue chats\n\nThe Chief starts them when a slot frees.") =>
  `---\nversion: ${version}\ndate: 2026-10-20\ntitle: The Chief runs your queue\n${extra}---\n\nIntro line.\n\n${body}\n`;

describe("parseRelease", () => {
  it("reads the fields, intro and one card per section", () => {
    const r = parseRelease("releases/0.2.0.md", note("0.2.0", "blog: https://caveman.so/blog/code-0-2\nx: https://x.com/caveman/status/1\n", "## One\n\nFirst.\n\n## Fixes\n\n- a\n- b"));
    expect(r).toMatchObject({ version: "0.2.0", date: "2026-10-20", blog: "https://caveman.so/blog/code-0-2", x: "https://x.com/caveman/status/1", draft: false, intro: "Intro line." });
    expect(r.sections).toEqual([
      { heading: "One", body: "First." },
      { heading: "Fixes", body: "- a\n- b" },
    ]);
  });

  it("lists every problem at once", () => {
    const bad = "---\nversion: 2\ndate: soon\ntitle:\nx: https://evil.example/post\nauthor: me\n---\n\nNo sections.";
    const message = (() => {
      try {
        parseRelease("releases/2.md", bad);
      } catch (e) {
        return (e as Error).message;
      }
    })();
    for (const part of ["not a version", "date", "title is missing", "x.com", "unknown line", "no ## sections"]) expect(message).toContain(part);
  });

  it("refuses a file named for another version and non-https links", () => {
    expect(() => parseRelease("releases/0.3.0.md", note("0.2.0"))).toThrow(/0\.2\.0\.md/);
    expect(() => parseRelease("releases/0.2.0.md", note("0.2.0", "blog: http://caveman.so/b\n"))).toThrow(/https/);
    expect(() => parseRelease("releases/0.2.0.md", note("0.2.0", "blog: javascript:alert(1)\n"))).toThrow(/https/);
  });

  it("keeps ## lines inside code fences, and reads a BOM, single quotes and CRLF", () => {
    const r = parseRelease("releases/0.2.0.md", "\uFEFF" + note("0.2.0", "", "## A\n\n```md\n## not a section\n```").replace("title: The Chief runs your queue", "title: 'Quoted'").replace(/\n/g, "\r\n"));
    expect(r.title).toBe("Quoted");
    expect(r.sections).toEqual([{ heading: "A", body: "```md\n## not a section\n```" }]);
  });

  it("refuses an impossible date and an empty heading", () => {
    expect(() => parseRelease("releases/0.2.0.md", note("0.2.0").replace("2026-10-20", "2026-02-31"))).toThrow(/date/);
    expect(() => parseRelease("releases/0.2.0.md", note("0.2.0", "", "## \n\nText."))).toThrow(/heading is empty/);
  });

  it("calls a draft or a leftover commit list unfinished", () => {
    const source = note("0.2.0", "draft: true\n", "## A\n\nText.\n\n<!--\n- feat: x\n-->");
    expect(unfinished(parseRelease("releases/0.2.0.md", source), source)).toHaveLength(2);
    const done = note("0.2.0", "", "## A\n\nWrite `<!--` in code and it still ships.");
    expect(unfinished(parseRelease("releases/0.2.0.md", done), done)).toEqual([]);
  });

  it("renders the GitHub release body with the links", () => {
    const md = releaseMarkdown(parseRelease("releases/0.2.0.md", note("0.2.0", "blog: https://caveman.so/b\n")));
    expect(md).toBe("# The Chief runs your queue\n\nIntro line.\n\n## Queue chats\n\nThe Chief starts them when a slot frees.\n\n[Read the post](https://caveman.so/b)\n");
  });
});

describe("versions", () => {
  it("orders like semver", () => {
    const sorted = ["1.0.0", "0.10.0", "0.2.0", "1.0.0-rc.2", "1.0.0-rc.10", "1.0.0-beta", "0.2.1"].sort(compareVersions);
    expect(sorted).toEqual(["0.2.0", "0.2.1", "0.10.0", "1.0.0-beta", "1.0.0-rc.2", "1.0.0-rc.10", "1.0.0"]);
  });

  const r = (version: string, draft = false) => ({ version, draft }) as Release;
  const all = [r("0.1.0"), r("0.3.0"), r("0.2.0"), r("0.4.0", true)];

  it("shows nothing newer than the app and no drafts outside development", () => {
    expect(shownReleases(all, "0.2.0", false).map((x) => x.version)).toEqual(["0.2.0", "0.1.0"]);
    expect(shownReleases(all, "0.0.0", false).map((x) => x.version)).toEqual(["0.3.0", "0.2.0", "0.1.0"]);
    expect(shownReleases(all, null, true).map((x) => x.version)).toEqual(["0.4.0", "0.3.0", "0.2.0", "0.1.0"]);
  });

  it("counts what came since the last look, and nothing on a first launch", () => {
    const shown = shownReleases(all, "0.3.0", false);
    expect(unseenReleases(shown, "0.1.0").map((x) => x.version)).toEqual(["0.3.0", "0.2.0"]);
    expect(unseenReleases(shown, "0.3.0")).toEqual([]);
    expect(unseenReleases(shown, null)).toEqual([]);
  });
});

describe("releases/", () => {
  const dir = new URL("../../../../releases/", import.meta.url);
  it("every notes file parses", () => {
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".md") && n !== "README.md")) {
      expect(() => parseRelease(`releases/${name}`, readFileSync(new URL(name, dir), "utf8"))).not.toThrow();
    }
  });
});
