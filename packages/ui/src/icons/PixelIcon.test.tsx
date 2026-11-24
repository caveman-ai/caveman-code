import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { appearFrames, GLYPHS, STATE_STRIPS } from "./glyphs";
import { PIXEL_ICON_NAMES } from "./names";
import { PixelAppear, PixelIcon, PixelStrip } from "./PixelIcon";
import { toyFor } from "./toys";

// The two checks are vectors (check.ts), not pixel drawings: they have their own tests below.
const CHECKS = ["state-done", "state-connected"] as const;
const drawn = PIXEL_ICON_NAMES.filter(
  (n): n is Exclude<(typeof PIXEL_ICON_NAMES)[number], "engine-caveman" | (typeof CHECKS)[number]> =>
    n !== "engine-caveman" && !(CHECKS as readonly string[]).includes(n),
);

describe("PixelIcon", () => {
  it.each(drawn)("%s is only its drawing until something can play it", (name) => {
    const html = renderToStaticMarkup(<PixelIcon name={name} />);
    expect(html).toMatch(/<g class="px-rest">/);
    expect(html).not.toMatch(/px-f/);
  });

  it.each(drawn)("%s draws its toy's two flipbooks when it plays", (name) => {
    const toy = toyFor(name);
    const html = renderToStaticMarkup(<PixelIcon name={name} play />);
    expect(html).toMatch(/<g class="px-rest">/);
    expect(html).toContain(`--px-hover:${toy.hover.ms}ms;--px-pop:${toy.pop.ms}ms`);
    expect(html.match(/class="px-f"/g) ?? []).toHaveLength(toy.hover.frames.length + toy.pop.frames.length);
    expect(html.indexOf('class="px-hover"')).toBeLessThan(html.indexOf('class="px-pop"'));
  });
});

describe("the checks", () => {
  it.each(CHECKS)("%s is a vector, round-capped, with no pixel art or toy", (name) => {
    const html = renderToStaticMarkup(<PixelIcon name={name} play />);
    expect(html).toMatch(/stroke-linecap="round"/);
    expect(html).not.toMatch(/px-rest|px-f|crispEdges/);
  });

  it("draws done as the success disc with a white check, which a resting row may flatten to ink", () => {
    const html = renderToStaticMarkup(<PixelIcon name="state-done" />);
    expect(html).toMatch(/<circle[^>]*fill:var\(--px-accent, hsl\(var\(--success\)\)\)/);
    expect(html).toMatch(/stroke="#fff"/);
  });

  it("lands once when it arrives, and rests still otherwise", () => {
    expect(renderToStaticMarkup(<PixelAppear name="state-done" />)).toMatch(/px-check-land/);
    expect(renderToStaticMarkup(<PixelIcon name="state-done" />)).not.toMatch(/px-check-land/);
  });
});

describe("PixelStrip", () => {
  it.each(Object.entries(STATE_STRIPS))("%s draws one path per colour across its frames", (_, strip) => {
    const html = renderToStaticMarkup(<PixelStrip frames={strip.frames} fps={strip.fps} />);
    const styles = (html.match(/<path[^>]*>/g) ?? []).map((tag) => /style="([^"]*)"/.exec(tag)?.[1] ?? "ink");
    expect(styles.length).toBeGreaterThan(0);
    expect(styles.length).toBe(new Set(styles).size);
  });
});

describe("PixelAppear", () => {
  it("plays the dither once and rests on the icon", () => {
    const html = renderToStaticMarkup(<PixelAppear name="state-needs-you" />);
    expect(html).toMatch(/data-play="once"/);
    expect(appearFrames(GLYPHS["state-needs-you"]).at(-1)).toEqual(GLYPHS["state-needs-you"]);
  });
});
