// A project's logo in the sidebar, in Chromium against the scripted runtime: the row draws the image behind
// Project.logo's id (read once per id, then kept) where the pixel folder would be, and the folder when there is none or
// it fails to draw; "Logo…" in the project's menu (a right-click on its row) picks one of the images the runtime found, uploads one, or turns
// Automatic and No logo on, and says so when the runtime is too old to keep a logo.
import type { Project, ProjectLogoCandidate } from "@caveman-app/session-protocol";
import { describe, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mountApp } from "../../test/app.tsx";
import { PROJECT, runtimeFixture, type RuntimeFixture } from "../../test/fixtures.ts";
import { rememberLogo } from "../state/project-logos.ts";
import type { SessionPeer } from "../../test/session-peer.ts";

const svg = (body: string) =>
  `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${body}</svg>`)}`;
const RED = svg('<rect width="16" height="16" rx="3" fill="#e5484d"/>');
const GREEN = svg('<circle cx="8" cy="8" r="7" fill="#30a46c"/>');
const BLUE = svg('<rect width="16" height="16" fill="#3e63dd"/>');
const LIB: Project = { ...PROJECT, id: "p-lib", name: "lib", path: "/Users/test/code/lib" };

const sidebar = () => page.getByRole("complementary", { name: "Sidebar" });
/** A project's row, named by the project: the button that folds its chats. */
const projectRow = (name: string) =>
  sidebar()
    .getByRole("button", { name: new RegExp(`^${name}\\b`) })
    .first();
/** What the row shows as its mark: the logo, or the folder. */
const mark = (name: string) => {
  const row = projectRow(name).element().closest("[data-peek]")!;
  return {
    img: row.querySelector("img")?.getAttribute("src") ?? null,
    folder: row.querySelector(".px-folder") !== null,
  };
};
const dialog = () => page.getByRole("dialog", { name: "Logo for lib" });
async function openLogo() {
  // The project's menu is the row's right-click: it has no ⋯ of its own.
  await userEvent.click(projectRow("lib"), { button: "right", position: { x: 80, y: 16 } });
  await userEvent.click(page.getByRole("menuitem", { name: "Logo…" }));
  await expect.element(dialog()).toBeVisible();
}
/** The size of the image a data: URL holds. */
async function sizeOf(url: string) {
  const image = new Image();
  image.src = url;
  await image.decode();
  return [image.naturalWidth, image.naturalHeight];
}
/** A real PNG file of `width` x `height`, red. */
async function pngFile(width: number, height: number) {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#e5484d";
  context.fillRect(0, 0, width, height);
  return new File([await canvas.convertToBlob({ type: "image/png" })], "mark.png", {
    type: "image/png",
  });
}
/** Chooses `file` in the dialog's file input, as the system's file picker would. */
function choose(file: File) {
  const input = dialog().element().querySelector<HTMLInputElement>('input[type="file"]')!;
  const files = new DataTransfer();
  files.items.add(file);
  input.files = files.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * A runtime that keeps logos as the real one does: an id per image, project.logo.read behind it, the mode on the
 * project, and the candidates' `current` mark for the file the logo was picked from.
 */
function keepLogos(
  peer: SessionPeer,
  fixture: RuntimeFixture,
  files: Record<string, ReadonlyArray<Omit<ProjectLogoCandidate, "current">>>,
) {
  const images = new Map<string, string>();
  let ids = 0;
  const idFor = (url: string) =>
    [...images].find(([, it]) => it === url)?.[0] ??
    (images.set(`img-${++ids}`, url), `img-${ids}`);
  for (const project of fixture.projects)
    if (project.logo)
      images.set(
        project.logo.id,
        files[project.id]?.find((c) => c.path === project.logo!.path)?.url ?? RED,
      );
  peer.on("project.logo.read", (p) => {
    const logo = fixture.projects.find((it) => it.id === p.project_id)?.logo;
    return { id: logo!.id, url: images.get(logo!.id)! };
  });
  peer.on("project.logo.candidates", (p) => {
    const project = fixture.projects.find((it) => it.id === p.project_id)!;
    return {
      candidates: (files[p.project_id] ?? []).map((c) =>
        project.logo?.path === c.path && c.path !== undefined
          ? { ...c, current: true as const }
          : c,
      ),
    };
  });
  peer.on("project.update", (p) => {
    const at = fixture.projects.findIndex((it) => it.id === p.project_id);
    const { logo: _logo, logo_mode: _mode, ...rest } = fixture.projects[at]!;
    const choice = p.logo;
    fixture.projects[at] =
      choice === "none"
        ? { ...rest, logo_mode: "none" }
        : choice === "auto" || choice === undefined
          ? rest
          : {
              ...rest,
              logo: {
                id: idFor(choice.url),
                ...(choice.path !== undefined ? { path: choice.path } : {}),
              },
              logo_mode: "picked",
            };
    return fixture.projects[at]!;
  });
}

describe("a project's logo", () => {
  test("its row draws the logo where the folder was, read once for its id and then kept; a project without one keeps the folder", async () => {
    const fixture = runtimeFixture({
      projects: [
        { ...PROJECT, logo: { id: "red-1", path: "public/favicon.svg", auto: true } },
        LIB,
      ],
    });
    const { peer } = await mountApp("/", fixture);
    peer.on("project.logo.read", () => ({ id: "red-1", url: RED }));
    await expect.poll(() => mark("app")).toEqual({ img: RED, folder: false });
    expect(mark("lib")).toEqual({ img: null, folder: true });
    const size = projectRow("app")
      .element()
      .closest("[data-peek]")!
      .querySelector("img")!
      .getBoundingClientRect();
    expect([size.width, size.height]).toEqual([16, 16]);
    expect(peer.callsOf("project.logo.read").map((c) => c.params)).toEqual([
      { project_id: PROJECT.id },
    ]);
    // Kept by its id, for the next window and the next reload's first frame.
    expect(JSON.parse(localStorage.getItem("caveman.projectLogos")!)).toMatchObject({
      "red-1": RED,
    });
  });

  test("an id already kept draws at once, with no read", async () => {
    rememberLogo("kept-1", RED);
    const { peer } = await mountApp(
      "/",
      runtimeFixture({
        projects: [{ ...PROJECT, logo: { id: "kept-1", path: "public/favicon.svg", auto: true } }],
      }),
    );
    await expect.poll(() => mark("app")).toEqual({ img: RED, folder: false });
    expect(peer.callsOf("project.logo.read")).toEqual([]);
  });

  test("an image that fails to draw shows the folder", async () => {
    const { peer } = await mountApp(
      "/",
      runtimeFixture({ projects: [{ ...PROJECT, logo: { id: "broken-1" } }] }),
    );
    peer.on("project.logo.read", () => ({ id: "broken-1", url: "data:image/png;base64,AAAA" }));
    await expect.poll(() => peer.callsOf("project.logo.read").length).toBe(1);
    await expect.poll(() => mark("app")).toEqual({ img: null, folder: true });
  });

  test("Logo… presses what is on; a tile picks it, drawn at 64px, and the row shows it at once; No logo puts the folder back", async () => {
    const fixture = runtimeFixture({
      projects: [
        { ...PROJECT },
        { ...LIB, logo: { id: "blue-1", path: "public/favicon.svg", auto: true } },
      ],
    });
    const { peer } = await mountApp("/", fixture);
    keepLogos(peer, fixture, {
      [LIB.id]: [
        { path: "public/favicon.svg", url: BLUE, source: "favicon" },
        { path: "docs/logo.svg", url: GREEN, source: "file" },
      ],
    });
    await expect.poll(() => mark("lib").img).toBe(BLUE);

    await openLogo();
    const tile = (path: string) => dialog().getByRole("button", { name: path });
    await expect.element(tile("public/favicon.svg")).toHaveAttribute("aria-pressed", "true");
    await expect.element(tile("docs/logo.svg")).toHaveAttribute("aria-pressed", "false");
    await expect
      .element(dialog().getByRole("button", { name: "Automatic" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect
      .element(dialog().getByRole("button", { name: "No logo" }))
      .toHaveAttribute("aria-pressed", "false");

    await userEvent.click(tile("docs/logo.svg"));
    const { params } = await peer.nextCall("project.update");
    const picked = params.logo as { url: string; path?: string };
    expect(picked.path).toBe("docs/logo.svg");
    expect(picked.url).toMatch(/^data:image\/png;base64,/);
    expect(await sizeOf(picked.url)).toEqual([64, 64]);
    await expect.element(dialog()).not.toBeInTheDocument();
    await expect.poll(() => mark("lib").img).toBe(picked.url);
    // The image it drew is the one the runtime keeps: nothing read for its new id.
    expect(peer.callsOf("project.logo.read").map((c) => c.params.project_id)).toEqual([LIB.id]);
    expect(mark("app")).toEqual({ img: null, folder: true });

    // Picked: its tile is pressed, and neither Automatic nor No logo is.
    await openLogo();
    await expect.element(tile("docs/logo.svg")).toHaveAttribute("aria-pressed", "true");
    await expect
      .element(dialog().getByRole("button", { name: "Automatic" }))
      .toHaveAttribute("aria-pressed", "false");
    await expect
      .element(dialog().getByRole("button", { name: "No logo" }))
      .toHaveAttribute("aria-pressed", "false");
    await userEvent.click(dialog().getByRole("button", { name: "No logo" }));
    await expect.poll(() => peer.callsOf("project.update").at(-1)?.params.logo).toBe("none");
    await expect.element(dialog()).not.toBeInTheDocument();
    await expect.poll(() => mark("lib")).toEqual({ img: null, folder: true });
    await openLogo();
    await expect
      .element(dialog().getByRole("button", { name: "No logo" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect
      .element(dialog().getByRole("button", { name: "Automatic" }))
      .toHaveAttribute("aria-pressed", "false");
  });

  test("Choose image… draws the file at 64px, with no path, and the row shows it; a file over 10 MB is refused before it is read", async () => {
    const fixture = runtimeFixture({ projects: [{ ...LIB }] });
    const { peer } = await mountApp("/", fixture);
    keepLogos(peer, fixture, { [LIB.id]: [] });
    await openLogo();
    await expect.element(dialog().getByText("No images found in lib.")).toBeVisible();

    choose(new File([new Uint8Array(10 * 1024 * 1024 + 1)], "huge.png", { type: "image/png" }));
    await expect
      .element(dialog().getByRole("alert"))
      .toHaveTextContent("That image is over 10 MB.");
    expect(peer.callsOf("project.update")).toEqual([]);

    choose(await pngFile(300, 150));
    const { params } = await peer.nextCall("project.update");
    const uploaded = params.logo as { url: string; path?: string };
    expect(uploaded.path).toBeUndefined();
    expect(await sizeOf(uploaded.url)).toEqual([64, 64]);
    await expect.element(dialog()).not.toBeInTheDocument();
    await expect.poll(() => mark("lib").img).toBe(uploaded.url);

    // An SVG, which createImageBitmap does not decode, goes through an <img> instead.
    await openLogo();
    choose(new File([atob(GREEN.split(",")[1]!)], "mark.svg", { type: "image/svg+xml" }));
    await expect.poll(() => peer.callsOf("project.update").length).toBe(2);
    expect(
      await sizeOf((peer.callsOf("project.update")[1]!.params.logo as { url: string }).url),
    ).toEqual([64, 64]);
  });

  test("a runtime too old to keep a logo is named, and nothing can be saved", async () => {
    // No project.logo.candidates scripted: the runtime answers method not found, as one from before logos does.
    const { peer } = await mountApp("/", runtimeFixture({ projects: [{ ...LIB }] }));
    await openLogo();
    await expect
      .element(dialog().getByText("The runtime on this computer needs an update to keep a logo."))
      .toBeVisible();
    for (const name of ["Choose image…", "No logo", "Automatic"])
      await expect.element(dialog().getByRole("button", { name })).toBeDisabled();
    expect(peer.unscripted.has("project.logo.candidates")).toBe(true);
  });
});
