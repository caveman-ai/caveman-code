import { document } from "../testing/dom.ts";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { expect, test, vi } from "vitest";
import { Response } from "./response.tsx";
import { createWordFade, REVEAL_MIN_CPS, rehypeWordFade, revealEnd, revealStep, usePacedText } from "./word-fade.ts";

// Response's file icons use a browser custom-element sprite; these tests exercise text and frame scheduling.
vi.mock("../icons/file-type", () => ({ FileTypeIcon: () => null }));

test("the reveal stops only at whole words: a stream mid-word holds back, a finished one runs out", () => {
  const text = "Three drafts are in the fol";
  expect(revealEnd(text, 3, true)).toBe(5); // "Three"
  expect(revealEnd(text, 5, true)).toBe(5);
  expect(revealEnd(text, 24, true)).toBe(24); // "fol" is still being written
  expect(revealEnd(text, 24, false)).toBe(text.length);
  expect(revealEnd("", 0, true)).toBe(0);
});

test("the reveal closes on what has arrived: a burst spreads over a beat, a trickle never crawls below the floor", () => {
  // A 600-character burst: one 30 ms frame lets out an exponential share of it, more than the floor.
  const afterFrame = revealStep(0, 600, 0.03);
  expect(afterFrame).toBeGreaterThan(REVEAL_MIN_CPS * 0.03);
  expect(afterFrame).toBeLessThan(600 * 0.2);
  // Within a quarter second most of the burst is out; it never overshoots.
  let at = 0;
  for (let i = 0; i < 8; i++) at = revealStep(at, 600, 0.03);
  expect(at).toBeGreaterThan(600 * 0.6);
  expect(revealStep(599, 600, 1)).toBe(600);
  // Little backlog: the floor speed carries it out.
  expect(revealStep(0, 5, 0.03)).toBeCloseTo(REVEAL_MIN_CPS * 0.03);
});

const html = (md: string) => renderToStaticMarkup(<Markdown rehypePlugins={[rehypeWordFade]}>{md}</Markdown>);

test("every prose word is its own fading span; code, links and keys stay whole", () => {
  const out = html("Three **drafts** are in `pilot.md`, see [the deck](https://x.test).");
  expect(out).toContain('<span data-word-fade="">Three</span>');
  expect(out).toContain('<strong><span data-word-fade="">drafts</span></strong>');
  expect(out).toContain("<code>pilot.md</code>");
  expect(out).toContain('<a href="https://x.test">the deck</a>');
  // Whitespace stays text between the spans, so lines wrap as they did.
  expect(out).toContain('<span data-word-fade="">are</span> <span data-word-fade="">in</span>');
});

test("paced: a reply streaming in fades word by word, without the caret; one loaded whole shows whole", () => {
  const live = renderToStaticMarkup(
    <Response streaming paced>
      {"Three drafts are in the folder."}
    </Response>,
  );
  expect(live).toContain("word-fading");
  expect(live).toMatch(/<span data-word-fade="" data-word-born="[\d.]+">drafts<\/span>/);
  expect(live).not.toContain("data-streaming");

  // A reply that arrived while the reader watched plays in from its first word.
  const fresh = renderToStaticMarkup(
    <Response streaming paced revealOnMount>
      {"Three drafts are in the folder."}
    </Response>,
  );
  expect(fresh).not.toContain("drafts");

  // Settled history: no spans, no fade.
  const done = renderToStaticMarkup(<Response paced>{"Three drafts are in the folder."}</Response>);
  expect(done).not.toContain("data-word-fade");
  expect(done).toContain("Three drafts are in the folder.");

  // Not paced (the side panel's reader): the caret rides the stream, no spans.
  const plain = renderToStaticMarkup(<Response streaming>{"Three drafts."}</Response>);
  expect(plain).toContain('data-streaming="true"');
  expect(plain).not.toContain("data-word-fade");
});

test("Markdown reparses preserve each word's fade clock; settled text never starts again", () => {
  let now = 1000;
  const fade = createWordFade(0, () => now);
  const render = (text: string) => renderToStaticMarkup(<Markdown rehypePlugins={[fade.plugin]}>{text}</Markdown>);
  expect(render("One **two**")).toContain('data-word-born="1000">two');
  now = 1070;
  const next = render("One **two three**");
  expect(next).toContain('data-word-born="1000">two');
  expect(next).toContain('data-word-born="1070">three');
  now = 1160;
  const final = render("One **two three** done");
  expect(final).toContain('data-word-settled="">two');
  expect(final).toContain('data-word-born="1070">three');
  expect(final).toContain('data-word-born="1160">done');
});

test("a historical block extended by a live reply keeps its existing text opaque", () => {
  const fade = createWordFade("Already here. ".length, () => 500);
  const out = renderToStaticMarkup(<Markdown rehypePlugins={[fade.plugin]}>Already here. New words.</Markdown>);
  expect(out).toContain('data-word-settled="">Already');
  expect(out).toContain('data-word-settled="">here.');
  expect(out).toContain('data-word-born="500">New');
});

test("opening a running chat seeds already-arrived words as history", () => {
  const out = renderToStaticMarkup(<Response paced streaming revealOnMount={false}>{"Already here.\n\nStill running."}</Response>);
  expect(out).toContain('data-word-settled="">Already');
  expect(out).toContain('data-word-settled="">Still');
  expect(out).not.toContain("data-word-born");
});

test("inline links and code fade as intact semantic units; fenced code keeps its source", () => {
  const out = html("See [the deck](https://example.com) and `src/rain.ts`.\n\n```js\nconst rain = true;\n```");
  expect(out).toContain('<span data-word-fade=""><a href="https://example.com">the deck</a></span>');
  expect(out).toContain('<span data-word-fade=""><code>src/rain.ts</code></span>');
  expect(out).toContain('<pre><code class="language-js">const rain = true;\n</code></pre>');
});

function pacedText(onTestFinished: (cleanup: () => Promise<void>) => void) {
  let now = 0;
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const time = vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    await React.act(() => root.unmount());
    mounted = false;
  };
  onTestFinished(async () => {
    try {
      await unmount();
    } finally {
      host.remove();
      time.mockRestore();
      vi.unstubAllGlobals();
    }
  });
  function Probe({ text, streaming }: { text: string; streaming: boolean }) {
    const paced = usePacedText(text, streaming, true);
    return <output data-revealing={paced.revealing}>{paced.text}</output>;
  }
  return {
    host,
    frames,
    unmount,
    render: (text: string, streaming = true) => root.render(<Probe text={text} streaming={streaming} />),
    frame: (at: number) => {
      now = at;
      const queued = [...frames.values()];
      frames.clear();
      for (const callback of queued) callback(now);
    },
  };
}

test("a chunk batched with the frame that catches up keeps revealing before the stream ends", async ({ onTestFinished }) => {
  const reveal = pacedText(onTestFinished);
  await React.act(() => reveal.render("One "));
  await React.act(() => {
    reveal.frame(100);
    // Both renders still have a backlog, so the effect's `behind` dependency does not change.
    reveal.render("One two ");
  });
  expect(reveal.host.textContent).toBe("One ");
  await React.act(() => reveal.frame(200));
  expect(reveal.host.textContent).toBe("One two ");
  expect(reveal.host.querySelector("output")?.getAttribute("data-revealing")).toBe("false");
  expect(reveal.frames.size).toBe(0);
});

test("ending a stream reveals the pending final word and stops requesting frames", async ({ onTestFinished }) => {
  const reveal = pacedText(onTestFinished);
  await React.act(() => reveal.render("One "));
  await React.act(() => {
    reveal.frame(100);
    reveal.render("One unfinished");
  });
  await React.act(() => reveal.render("One unfinished", false));
  await React.act(() => reveal.frame(300));
  expect(reveal.host.textContent).toBe("One unfinished");
  expect(reveal.host.querySelector("output")?.getAttribute("data-revealing")).toBe("false");
  expect(reveal.frames.size).toBe(0);
});

test("unmounting a paced reply cancels its pending reveal frame", async ({ onTestFinished }) => {
  const reveal = pacedText(onTestFinished);
  await React.act(() => reveal.render("Still arriving"));
  expect(reveal.frames.size).toBe(1);
  await reveal.unmount();
  expect(reveal.frames.size).toBe(0);
});
