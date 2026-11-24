import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";

// The drag engine's store reads `window` on load; nothing here drags.
vi.mock("../../panes/drag.ts", () => ({}));
import { RuntimeContext, type RuntimeContextValue } from "../../state/runtime.tsx";
import { ChiefSettings } from "./Chief.tsx";

const render = (settings: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(RuntimeContext.Provider, { value: { client: null, settings, engines: [], workspaces: [], refresh: async () => undefined } as unknown as RuntimeContextValue }, createElement(ChiefSettings))),
  );
const switchOn = (html: string, id: string) => new RegExp(`<button[^>]*id="${id}-on"[^>]*aria-checked="true"|<button[^>]*aria-checked="true"[^>]*id="${id}-on"`).test(html);

test("Settings > Chief holds the daily turn guard beside the dollar cap, at the value in force", () => {
  const settings = { chief_max_concurrent: 4, chief_ask_above_chats: 3, chief_daily_cap_usd: 20, chief_daily_turns: 150 };
  const html = renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(RuntimeContext.Provider, { value: { client: null, settings, engines: [], workspaces: [], refresh: async () => undefined } as unknown as RuntimeContextValue }, createElement(ChiefSettings))),
  );
  expect(html).toContain("Daily cap, US dollars");
  expect(html).toContain("Turns a day");
  expect(html).toMatch(/id="chief-turns"[^>]*value="150"|value="150"[^>]*id="chief-turns"/);
});

test("Settings > Chief: the chat and daily limits are off by default, with no number to edit", () => {
  const html = render({ chief_ask_above_chats: 3 });
  for (const id of ["chief-concurrent", "chief-cap", "chief-turns"]) {
    expect(html).toContain(`id="${id}-on"`);
    expect(switchOn(html, id)).toBe(false);
    expect(html).not.toContain(`id="${id}"`);
  }
  // Ask first above N is its own setting, unchanged.
  expect(html).toMatch(/id="chief-ask"[^>]*value="3"|value="3"[^>]*id="chief-ask"/);
});

test("Settings > Chief: a limit the person set shows on, at their value", () => {
  const html = render({ chief_max_concurrent: 6, chief_daily_turns: 0 });
  expect(switchOn(html, "chief-concurrent")).toBe(true);
  expect(html).toMatch(/id="chief-concurrent"[^>]*value="6"|value="6"[^>]*id="chief-concurrent"/);
  expect(switchOn(html, "chief-turns")).toBe(false);
});

test("Settings > Chief's defaults are one Autonomy slider at the level in force, Start when unset; Updates is gone", () => {
  const at = (html: string) => [...html.matchAll(/role="slider"[^>]*aria-label="([^"]+)"[^>]*aria-valuetext="([^"]+)"/g)].map((m) => `${m[1]}: ${m[2]}`);
  expect(at(render({}))).toEqual(["Autonomy: Start"]);
  expect(at(render({ chief_autonomy: 3, chief_updates: "results" }))).toEqual(["Autonomy: Manage"]);
});
