import { document } from "../testing/dom.ts";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { Response, splitBlocks } from "./response.tsx";

// The file-type mark draws from an icon library's sprite sheet; no icon is under test.
vi.mock("../icons/file-type", () => ({ FileTypeIcon: () => null }));
// Each render shows what has arrived, as one reveal frame commits it; the fades are under test, not the pace.
vi.mock("./word-fade.ts", async (original) => ({
  ...(await original<typeof import("./word-fade.ts")>()),
  usePacedText: (text: string) => ({ text, revealing: false }),
}));

let now = 0;
vi.spyOn(performance, "now").mockImplementation(() => now);
afterEach(() => void (now = 0));

const PROSE = "Alpha one.\n\nBravo two.\n\nCharlie three.\n\n";

/**
 * A live reply streamed as `[time, text so far]` frames; how `words` show after the last frame, and whether each is
 * still the element it was a frame before. Timers stand still, as the clock does between frames: a paragraph the reply
 * has passed drops its word spans one fade after (Block), which a slow machine would otherwise reach mid-stream.
 */
async function stream(frames: ReadonlyArray<readonly [number, string]>, words: readonly string[]) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    return await streamFrames(frames, words);
  } finally {
    vi.useRealTimers();
  }
}

async function streamFrames(
  frames: ReadonlyArray<readonly [number, string]>,
  words: readonly string[],
) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const render = (text: string) =>
    React.act(() =>
      root.render(
        <Response paced streaming revealOnMount>
          {text}
        </Response>,
      ),
    );
  const find = () =>
    words.map((w) =>
      [...host.querySelectorAll("[data-word-fade]")].find((el) => el.textContent === w)!,
    );
  const shown = (el: Element) =>
    el.hasAttribute("data-word-settled")
      ? "faded in"
      : `fading from ${el.getAttribute("data-word-born")}`;
  let before: Element[] = [];
  for (const [at, text] of frames) {
    before = find();
    now = at;
    await render(text);
  }
  const result = find().map((el, i) => ({ sameWord: el === before[i], shown: shown(el) }));
  await React.act(() => root.unmount());
  host.remove();
  return result;
}

/** A live reply streams three paragraphs and a code block; a second later `line` arrives in the code. */
const streamCodeLine = (line: string) =>
  stream(
    [
      [1000, `${PROSE}\`\`\`ts\ninterface Env {\n`],
      [2000, `${PROSE}\`\`\`ts\ninterface Env {\n  name: string;\n`],
      [3000, `${PROSE}\`\`\`ts\ninterface Env {\n  name: string;\n${line}\n`],
    ],
    ["Bravo", "Charlie"],
  );

const untouched = [
  { sameWord: true, shown: "faded in" },
  { sameWord: true, shown: "faded in" },
];

test("a code line streaming in leaves the paragraphs above it on screen, faded in once", async () => {
  expect(await streamCodeLine("  port: number;")).toEqual(untouched);
});

test("a code line shaped like a link definition is code: the paragraphs above it do not fade in again", async () => {
  expect(await streamCodeLine("  [key: string]: unknown;")).toEqual(untouched);
  expect(await streamCodeLine("[INFO]: listening on 3000")).toEqual(untouched);
  const reply = `${PROSE}\`\`\`ts\ninterface Env {\n  [key: string]: unknown;\n}\n\`\`\`\n\nDone.`;
  expect(splitBlocks(reply).map((b) => b.offset)).toEqual([0, 2, 4, 6, 12]);
  // A real definition still parses the whole reply, so its uses resolve.
  expect(splitBlocks(`${reply}\n\n[docs]: https://x.dev`)).toHaveLength(1);
});

test("a real definition arriving mid-reply parses the reply whole without fading its words in again", async () => {
  const reply = "Alpha one.\n\nBravo two.\n\nCharlie three see [docs][d].\n\nMore";
  for (const definition of ["[d]: https://x.dev", "[^1]: https://x.dev"]) {
    const words = await stream(
      [
        [1000, reply],
        [2900, `${reply} words`],
        [3000, `${reply} words.\n\n${definition}`],
      ],
      ["Bravo", "Charlie", "words."],
    );
    // Regrouped into one block, the settled paragraphs stay faded in and the newest word keeps its own clock.
    expect(words.map((w) => w.shown)).toEqual(["faded in", "faded in", "fading from 2900"]);
  }
  expect(splitBlocks(`${reply} words.\n\n[d]: https://x.dev`)).toHaveLength(1);
});

test("a reply that starts with blank lines keeps each word's place: a definition arriving fades nothing in again", async () => {
  // No block holds the blank lines, so a word's place is read from its block's line, not from the blocks before it.
  const reply = "\n\nAlpha one.\n\nBravo two.\n\nCharlie three see [docs][d].\n\nMore";
  const words = await stream(
    [
      [1000, reply],
      [2900, `${reply} words`],
      [3000, `${reply} words.\n\n[d]: https://x.dev`],
    ],
    ["Bravo", "Charlie", "words."],
  );
  expect(words.map((w) => w.shown)).toEqual(["faded in", "faded in", "fading from 2900"]);
});

test("streamed a character at a time and finished, a reply draws each block once, where the parser puts it", async () => {
  // Display math with a blank line inside: a blank-line splitter cut it into three paragraphs, "$$ x^2", "y" and "$$".
  const reply =
    "Intro paragraph here.\n\n## A heading\n\n- one item\n- two items\n\nPrice $5.\n\n$$\nx^2\n\ny\n$$\n\nAfter the list.";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const mounted = new Set<Element>();
  const frame = async (text: string, streaming: boolean) => {
    await React.act(() =>
      root.render(
        <Response paced={streaming} streaming={streaming} revealOnMount>
          {text}
        </Response>,
      ),
    );
    for (const el of host.querySelector('[data-slot="response"]')!.children) mounted.add(el);
  };
  for (let end = 1; end < reply.length; end++) await frame(reply.slice(0, end), true);
  await frame(reply, false);
  const final = [...host.querySelector('[data-slot="response"]')!.children];
  const rebuilt = [...mounted].filter((el) => !final.includes(el));
  expect(final.map((el) => el.getAttribute("data-slot") ?? el.tagName.toLowerCase())).toEqual([
    "p",
    "h2",
    "ul",
    "p",
    "math",
    "p",
  ]);
  // Nothing that drew is drawn again, but the formula's lines: llm-math reads them as math only once "$$" closes them.
  expect(rebuilt.map((el) => el.textContent)).toEqual(["$$\nx^2", "y\n$"]);
  await React.act(() => root.unmount());
  host.remove();
});

test("a paragraph the reply has moved past draws plain once its words have faded in; the open one keeps its spans", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    now = 1000;
    await React.act(() =>
      root.render(
        <Response paced streaming revealOnMount>
          {`${PROSE}Delta four is still`}
        </Response>,
      ),
    );
    const spans = () => [...host.querySelectorAll("[data-word-fade]")].map((el) => el.textContent);
    // Every word is still fading in: each has its span.
    expect(spans()).toEqual(expect.arrayContaining(["Alpha", "Bravo", "Charlie", "Delta"]));
    now = 1200;
    await React.act(() => vi.advanceTimersByTime(150));
    // Faded in, the closed paragraphs are plain text again; only the paragraph still being written holds spans.
    expect(spans()).toEqual(["Delta", "four", "is", "still"]);
    expect(host.textContent).toContain("Alpha one.");
    expect(host.textContent).toContain("Charlie three.");
    await React.act(() => root.unmount());
    host.remove();
  } finally {
    vi.useRealTimers();
  }
});

test("a paragraph that dropped its spans and is written again (a definition regroups the reply) fades its new words in", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    const render = (text: string, streaming = true) =>
      React.act(() =>
        root.render(
          <Response paced streaming={streaming} revealOnMount>
            {text}
          </Response>,
        ),
      );
    const spans = () =>
      [...host.querySelectorAll("[data-word-fade]:not([data-word-settled])")].map(
        (el) => el.textContent,
      );
    now = 1000;
    await render(`${PROSE}Delta four is still`);
    now = 1200;
    await React.act(() => vi.advanceTimersByTime(150));
    // The paragraphs it has passed are plain text now.
    const reply = `${PROSE}Delta four is still going [see][d].\n\n[d]: https://x.dev`;
    now = 1300;
    await render(reply);
    // A definition makes the reply one block, the one being written: the words since fade in.
    expect(spans()).toEqual(expect.arrayContaining(["going"]));
    await render(reply, false);
    // Finished, its newest words still finish their fade rather than snap to full ink.
    expect(spans()).toEqual(expect.arrayContaining(["going"]));
    await React.act(() => root.unmount());
    host.remove();
  } finally {
    vi.useRealTimers();
  }
});
