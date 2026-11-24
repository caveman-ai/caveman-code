import { useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, onTestFinished, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mountApp } from "../../../test/app.tsx";
import { runtimeFixture } from "../../../test/fixtures.ts";
import { allThemes } from "../../state/themes.ts";
import { WALLPAPERS } from "../../state/wallpaper-catalog.ts";
import { setWallpaper } from "../../wallpaper/store.ts";
import { ThemeGallery } from "./ThemeGallery.tsx";
import "../../styles.css";

test("arrow keys traverse the whole shelf across completed selection renders", async () => {
  const host = document.createElement("div");
  host.style.width = "720px";
  document.body.append(host);
  const root = createRoot(host);
  onTestFinished(() => {
    root.unmount();
    host.remove();
  });
  function Shelf() {
    const [selected, setSelected] = useState("caveman");
    return (
      <ThemeGallery
        themes={allThemes()}
        selected={selected}
        wanted="dark"
        error={null}
        onSelect={setSelected}
        onRemove={() => undefined}
      />
    );
  }
  root.render(<Shelf />);
  const group = page.getByRole("radiogroup", { name: "Colour theme" });
  const start = group.getByRole("radio", { name: "Caveman", exact: true });
  await expect.element(start).toBeVisible();
  await userEvent.click(start);
  for (const name of [
    "Dune above Blue Sea",
    "Midnight Currents",
    "Mint Drift",
    "Painted Twilight",
    "Pixel River Valley",
    "Caveman",
  ]) {
    await userEvent.keyboard("{ArrowRight}");
    const next = group.getByRole("radio", { name, exact: true });
    await expect.element(next).toHaveAttribute("aria-checked", "true");
    await expect.element(next).toHaveFocus();
  }
});

test("the theme picture remains available after None, and returning keeps its effect and blur", async () => {
  const fixture = runtimeFixture();
  fixture.settings = { ...fixture.settings, color_theme: "super-visuals-mint-drift" };
  await mountApp("/settings/appearance", fixture);
  setWallpaper({ source: "theme", effect: "glass", blur: 8 });
  const pictures = page.getByRole("radiogroup", { name: "Picture", exact: true });
  const mint = pictures.getByRole("radio", { name: "Mint Drift", exact: true });
  await expect.element(mint).toHaveAttribute("aria-checked", "true");
  await userEvent.click(mint);
  await expect
    .element(page.getByRole("switch", { name: "Use matching wallpaper", exact: true }))
    .toBeChecked();
  await userEvent.click(pictures.getByRole("radio", { name: "None", exact: true }));
  await expect.element(mint).toBeVisible();
  await expect.element(mint).toHaveAttribute("aria-checked", "false");
  await userEvent.click(mint);
  await expect.element(mint).toHaveAttribute("aria-checked", "true");
  await expect.element(page.getByRole("slider", { name: "Blur", exact: true })).toHaveValue("8");
  await expect
    .element(page.getByRole("combobox", { name: "Effect", exact: true }))
    .toHaveTextContent("Reeded glass");
});

test("wallpaper browsing changes only the picture, later theme picks keep it, and matching can be restored", async () => {
  const fixture = runtimeFixture();
  fixture.settings = { ...fixture.settings, color_theme: "super-visuals-dune-above-blue-sea" };
  await mountApp("/settings/appearance", fixture);
  setWallpaper({ source: "theme", effect: "glass", blur: 8 });
  const browse = page.getByRole("button", { name: `View all ${WALLPAPERS.length}`, exact: true });
  await userEvent.click(browse);
  const gallery = page.getByRole("dialog", { name: "Wallpapers", exact: true });
  await expect.element(gallery).toBeVisible();
  expect(gallery.element().querySelectorAll('[role="radio"]')).toHaveLength(WALLPAPERS.length);
  await userEvent.click(gallery.getByRole("radio", { name: "Mint Drift", exact: true }));
  await userEvent.keyboard("{Escape}");
  await expect.element(browse).toHaveFocus();
  const colors = page.getByRole("radiogroup", { name: "Colour theme" });
  await expect
    .element(colors.getByRole("radio", { name: "Dune above Blue Sea", exact: true }))
    .toHaveAttribute("aria-checked", "true");
  const matching = page.getByRole("switch", { name: "Use matching wallpaper", exact: true });
  await expect.element(matching).not.toBeChecked();
  await userEvent.click(colors.getByRole("radio", { name: "Midnight Currents", exact: true }));
  const pictures = page.getByRole("radiogroup", { name: "Picture", exact: true });
  await expect
    .element(pictures.getByRole("radio", { name: "Mint Drift", exact: true }))
    .toHaveAttribute("aria-checked", "true");
  await expect.element(page.getByRole("slider", { name: "Blur", exact: true })).toHaveValue("8");
  await userEvent.click(matching);
  await expect.element(matching).toBeChecked();
  await expect
    .element(pictures.getByRole("radio", { name: "Midnight Currents", exact: true }))
    .toHaveAttribute("aria-checked", "true");
});

test("gallery browsing downloads no originals; selecting an unavailable picture offers a retry", async () => {
  setWallpaper({ source: "none" });
  await mountApp("/settings/appearance", runtimeFixture());
  const fetchBefore = globalThis.fetch;
  const originals: string[] = [];
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://download.caveman.so/code/wallpapers/v1/")) {
      originals.push(url);
      throw new Error("offline");
    }
    return fetchBefore(input, init);
  });
  onTestFinished(() => fetcher.mockRestore());
  await userEvent.click(
    page.getByRole("button", { name: `View all ${WALLPAPERS.length}`, exact: true }),
  );
  const gallery = page.getByRole("dialog", { name: "Wallpapers", exact: true });
  await expect.element(gallery).toBeVisible();
  await userEvent.click(gallery.getByRole("button", { name: "Dark wallpapers", exact: true }));
  await expect
    .element(gallery.getByRole("radio", { name: "Atmospheric Glow", exact: true }))
    .toBeVisible();
  expect(originals).toHaveLength(0);
  await userEvent.click(gallery.getByRole("radio", { name: "Atmospheric Glow", exact: true }));
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => originals.length).toBe(1);
  const retry = page.getByRole("button", { name: "Retry", exact: true });
  await expect.element(retry).toBeVisible();
  await userEvent.click(retry);
  await expect.poll(() => originals.length).toBe(2);
});
