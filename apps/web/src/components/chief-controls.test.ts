import type { ChiefProfile } from "@caveman-app/session-protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { AUTONOMY, LevelSlider, levelsOf } from "./ChiefControls.tsx";

const profile = (own: Partial<Pick<ChiefProfile, "autonomy" | "updates">> = {}) =>
  own as Pick<ChiefProfile, "autonomy" | "updates">;

describe("a Chief's levels", () => {
  test("its own autonomy, else Settings', else Start; updates are never read", () => {
    expect(levelsOf(null, null).autonomy.id).toBe(2);
    expect(levelsOf(profile(), { chief_autonomy: 1 }).autonomy.id).toBe(1);
    expect(
      levelsOf(profile({ autonomy: 3, updates: "results" }), { chief_autonomy: 1 }).autonomy.id,
    ).toBe(3);
    // Set back to Settings' (null while the save is under way) reads as unset.
    expect(levelsOf({ autonomy: null } as never, null).autonomy.id).toBe(2);
    expect(Object.keys(levelsOf(profile({ updates: "everything" }), null))).toEqual(["autonomy"]);
  });

  test("each level is the effort slider: a stop per level, the thumb at its stop, its name after the track", () => {
    const html = (value: 1 | 2 | 3) =>
      renderToStaticMarkup(
        createElement(LevelSlider, {
          label: "Autonomy",
          value,
          options: AUTONOMY,
          onChange: () => undefined,
        }),
      );
    expect(html(1)).toContain('aria-valuenow="0"');
    expect(html(2)).toContain('aria-valuetext="Start"');
    expect(html(3)).toContain('aria-valuemax="2"');
    expect(html(3)).toContain("px-notch-2");
    expect(html(3).match(/size-\[3px\]/g)).toHaveLength(3);
    expect(html(2)).toMatch(/<span class="col-start-1 row-start-1 whitespace-nowrap">Start</);
    expect(html(3)).toContain('aria-valuetext="Manage"');
  });
});
