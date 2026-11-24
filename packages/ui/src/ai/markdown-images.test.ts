import { expect, test } from "vitest";
import { markdownImages, normalizeImageLinks, sourceKind } from "./markdown-images.ts";

test("a path with spaces and parentheses becomes an image; valid ones stay byte for byte", () => {
  const md = [
    "Done. Proof:",
    "",
    "![After](/Users/me/Library/Application Support/Caveman Code (Dev)/after.png)",
    '![Titled](my shot.png "Caption")',
    "![Plain](/tmp/a.png) and ![Paren](/tmp/(x)/b.png)",
  ].join("\n");
  const out = normalizeImageLinks(md);
  expect(out.split("\n")).toEqual([
    "Done. Proof:",
    "",
    "![After](</Users/me/Library/Application Support/Caveman Code (Dev)/after.png>)",
    '![Titled](<my shot.png> "Caption")',
    "![Plain](/tmp/a.png) and ![Paren](/tmp/(x)/b.png)",
  ]);
  expect(normalizeImageLinks("no images here")).toBe("no images here");
});

test("code is never an image", () => {
  const md = ["```md", "![x](/a b.png)", "```", "`![y](/c d.png)` and ![z](/e f.png)"].join("\n");
  const out = normalizeImageLinks(md);
  expect(out).toContain("```md\n![x](/a b.png)\n```");
  expect(out).toContain("`![y](/c d.png)` and ![z](</e f.png>)");
  expect(markdownImages(out)).toEqual([{ alt: "z", src: "/e f.png", line: 4, column: 21 }]);
});

test("every inline image in order, with its line and column", () => {
  const md = ["Intro", "![one](/tmp/1.png) ![two](<./shots/2 b.png>)", "| a | ![cell](c.png) |", "![](https://example.com/x.png \"t\")"].join("\n");
  expect(markdownImages(md)).toEqual([
    { alt: "one", src: "/tmp/1.png", line: 2, column: 0 },
    { alt: "two", src: "./shots/2 b.png", line: 2, column: 19 },
    { alt: "cell", src: "c.png", line: 3, column: 6 },
    { alt: "", src: "https://example.com/x.png", line: 4, column: 0 },
  ]);
});

test("what `![]()` names: audio and video play, other named files open, pictures and web images draw (T3 #21363)", () => {
  for (const src of ["/tmp/take.mp3", "out/voice.WAV", "<my take.m4a>", "data:audio/ogg;base64,AA"]) expect(sourceKind(src), src).toBe("audio");
  for (const src of ["/tmp/demo.mp4", "clip.webm?x=1", "https://cdn.example.com/a.mov"]) expect(sourceKind(src), src).toBe("video");
  for (const src of ["out/report.pdf", "/tmp/notes.txt", "./data.csv"]) expect(sourceKind(src), src).toBe("file");
  for (const src of ["/tmp/shot.png", "https://example.com/chart.php", "https://img.example.com/abc", "data:image/png;base64,AA", "/tmp/screenshot"]) expect(sourceKind(src), src).toBe("image");
  // The gallery strip takes pictures only; audio, video and other files stay in the text.
  expect(markdownImages("![a](/tmp/a.png) ![b](/tmp/b.mp3) ![c](out/c.pdf)").map((m) => m.src)).toEqual(["/tmp/a.png"]);
});

test("an image line in a fenced README, after a fence indented inside it, is code: kept as written, out of the strip", () => {
  const readme = ["Here is your README:", "", "```markdown", "# Tool", "", "1. Install:", "", "    ```bash", "    npm i tool", "    ```", "", "![Demo](docs/my demo.png)", "```", "", "![After](/tmp/after.png)"].join("\n");
  expect(normalizeImageLinks(readme)).toBe(readme);
  expect(markdownImages(readme)).toEqual([{ alt: "After", src: "/tmp/after.png", line: 15, column: 0 }]);
});
