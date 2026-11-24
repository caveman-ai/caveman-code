// The Chief's model picker is the composer's own: its stars are the person's favorites, the
// composer's ⌘1..⌘9, saved in Settings.favorite_models. The picker is the real ChiefPicker over the real ModelPicker
// and Radix Popover, on a runtime that keeps what settings.set saves and hands it back on refresh.
import { expect, test } from "vitest";
import { click, mount } from "./chief-browser.fixture.ts";
import { createElement, useMemo, useState, type ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { RuntimeFixture } from "../state/runtime.tsx";
import { ChiefPicker } from "./chief-sheet.tsx";

const engines = [
  { id: "caveman", label: "Caveman", models: [{ id: "auto", label: "Auto", efforts: [] }] },
  {
    id: "claude-agent",
    label: "Claude Agent",
    models: [{ id: "claude-opus-5-5", label: "Opus 5.5", efforts: [] }],
  },
];
// What chief.get offers: the Caveman engine's Auto and a Claude plan's Opus 5.5. The Chief is on Auto (no pick).
const chief = {
  picker: [
    { engine: "caveman", models: ["auto"] },
    { engine: "claude-agent", models: ["claude-opus-5-5"] },
  ],
  model: null,
  setModel: () => Promise.resolve(),
};

async function chiefPicker(favorites: string[]) {
  let saved = { favorite_models: favorites };
  const writes: string[][] = [];
  const client = {
    call: (method: string, params: { settings?: { favorite_models?: string[] } }) => {
      if (method === "settings.set" && params.settings) {
        if (params.settings.favorite_models) writes.push(params.settings.favorite_models);
        saved = { ...saved, ...params.settings };
      }
      return Promise.resolve(saved);
    },
    on: () => () => undefined,
  };
  function Runtime({ children }: { children: ReactNode }) {
    const [settings, setSettings] = useState(saved);
    const value = useMemo(
      () => ({
        client,
        status: "connected",
        connection: 1,
        workspaces: [],
        engines,
        settings,
        refresh: async () => setSettings(saved),
      }),
      [settings],
    );
    return createElement(RuntimeFixture, { value: value as never, children });
  }
  const view = await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(
        Runtime,
        null,
        createElement(ChiefPicker, { chief: chief as never, onError: () => undefined }),
      ),
    ),
  );
  const trigger = [...document.querySelectorAll("button")].find((b) =>
    b.getAttribute("aria-label")?.startsWith("Model:"),
  );
  if (!trigger) throw new Error(`no picker trigger in ${view.container.innerHTML}`);
  await click(trigger);
  const star = () => {
    const button = document.querySelector(
      "button[aria-label='Add Opus 5.5 to favorites'], button[aria-label='Remove Opus 5.5 from favorites']",
    );
    if (!button) throw new Error(`no star on Opus 5.5 in ${document.body.innerHTML}`);
    return button;
  };
  return {
    writes,
    star,
    starred: () => ({
      label: star().getAttribute("aria-label"),
      pressed: star().getAttribute("aria-pressed"),
    }),
    unmount: view.unmount,
  };
}

test("a star in the Chief's model picker saves the model among the person's favorites, and unstars it again", async () => {
  const picker = await chiefPicker(["caveman/auto"]);
  try {
    expect(picker.starred()).toEqual({ label: "Add Opus 5.5 to favorites", pressed: "false" });
    await click(picker.star());
    expect(picker.writes).toEqual([["caveman/auto", "claude-agent/claude-opus-5-5"]]);
    expect(picker.starred()).toEqual({ label: "Remove Opus 5.5 from favorites", pressed: "true" });
    await click(picker.star());
    expect(picker.writes).toEqual([
      ["caveman/auto", "claude-agent/claude-opus-5-5"],
      ["caveman/auto"],
    ]);
    expect(picker.starred()).toEqual({ label: "Add Opus 5.5 to favorites", pressed: "false" });
  } finally {
    await picker.unmount();
  }
});

test("a favorite starred in a chat's picker shows starred in the Chief's", async () => {
  const picker = await chiefPicker(["claude-agent/claude-opus-5-5"]);
  try {
    expect(picker.starred()).toEqual({ label: "Remove Opus 5.5 from favorites", pressed: "true" });
  } finally {
    await picker.unmount();
  }
});
