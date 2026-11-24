// A project's logo on a real runtime: project.list carries only its id and mode, project.logo.read its image, what
// project.logo.candidates finds in a checkout (and what it leaves out, and which one is the logo now), project.update's
// logo ("auto", "none", a pick), and calls that answer promptly over a FIFO or a checkout that is gone.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { connect, type Project } from "@caveman-app/session-protocol";
import { afterAll, beforeAll, expect, test } from "vitest";

import { git, makeConfig, makeRepo, startRuntime, tempRoot } from "./testHarness.ts";

const root = tempRoot("sp-project-logo-");
const fifos: Array<string> = [];
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;

beforeAll(async () => {
  runtime = await startRuntime(await makeConfig(), "fake-claude");
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  // A read stuck on a FIFO (the bug the FIFO test guards) would hold a worker thread: a writer that opens and closes
  // ends it.
  for (const fifo of fifos) {
    try {
      fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
    } catch {
      // No reader waiting.
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#e5484d"/></svg>';
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const dataUrl = (type: string, bytes: Buffer | string) =>
  `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
/** ProjectLogo.ts logoId: a short hash of the image's type and bytes. */
const idOf = (type: string, bytes: Buffer | string) =>
  createHash("sha256")
    .update(type)
    .update("\0")
    .update(Buffer.from(bytes))
    .digest("hex")
    .slice(0, 16);
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { error?: { data?: { reason?: string } } }) => error.error?.data?.reason,
  );
const listed = async (id: string): Promise<Project> =>
  (await client.call("project.list", {})).projects.find((p) => p.id === id)!;
/** What the sidebar reads of a project: its logo's id and path, and how it is chosen. */
const shown = async (id: string) => {
  const { logo, logo_mode } = await listed(id);
  return { logo, logo_mode };
};
const current = async (id: string) =>
  (await client.call("project.logo.candidates", { project_id: id })).candidates
    .filter((c) => c.current)
    .map((c) => c.path ?? "avatar");
const fifoTest = process.platform === "win32" ? test.skip : test;
let n = 0;
const req = () => ({ request_id: `logo-${++n}` });

test("candidates: the favicon first (the logo now), then the icon a page declares and tracked files named like a logo; never dependencies, big files, .icns or a link out of the checkout", async () => {
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret-logo.svg"), SVG);
  const repo = makeRepo(root, {
    "favicon.svg": SVG,
    "index.html": '<html><head><link rel="icon" href="/static/mark.svg"></head></html>',
    "public/static/mark.svg": SVG,
    "docs/brand/logo.png": "",
    "docs/big-logo.png": "",
    "node_modules/x/logo.png": "",
    "test/fixtures/logo.png": "",
    "src/close.svg": SVG,
    "Resources/AppIcon.icns": "icns",
  });
  fs.writeFileSync(path.join(repo, "docs/brand/logo.png"), PNG);
  fs.writeFileSync(path.join(repo, "node_modules/x/logo.png"), PNG);
  fs.writeFileSync(path.join(repo, "test/fixtures/logo.png"), PNG);
  fs.writeFileSync(path.join(repo, "docs/big-logo.png"), Buffer.alloc(300 * 1024, 1));
  fs.symlinkSync(path.join(outside, "secret-logo.svg"), path.join(repo, "docs/brand.svg"));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "logos");
  expect(git(repo, "ls-files")).toContain("node_modules/x/logo.png");

  const project = await client.call("project.create", { ...req(), path: repo });
  const { candidates } = await client.call("project.logo.candidates", { project_id: project.id });
  expect(candidates).toEqual([
    { path: "favicon.svg", url: dataUrl("image/svg+xml", SVG), source: "favicon", current: true },
    { path: "public/static/mark.svg", url: dataUrl("image/svg+xml", SVG), source: "favicon" },
    { path: "docs/brand/logo.png", url: dataUrl("image/png", PNG), source: "file" },
  ]);
  expect(
    await failure(client.call("project.logo.candidates", { project_id: "caveman-repo:nope" })),
  ).toBe("not_found");
});

test("candidates in a plain folder: the well-known places only, no git listing", async () => {
  const folder = path.join(root, "plain");
  fs.mkdirSync(path.join(folder, "public"), { recursive: true });
  fs.writeFileSync(path.join(folder, "public/favicon.ico"), PNG);
  fs.writeFileSync(path.join(folder, "brand-logo.png"), PNG);
  const project = await client.call("project.create", { ...req(), path: folder });
  expect(project.no_git).toBe(true);
  const { candidates } = await client.call("project.logo.candidates", { project_id: project.id });
  expect(candidates).toEqual([
    {
      path: "public/favicon.ico",
      url: dataUrl("image/x-icon", PNG),
      source: "favicon",
      current: true,
    },
  ]);
});

test("project.list carries the logo's id, never its bytes; project.logo.read the image behind the id", async () => {
  const repo = makeRepo(root, { "public/favicon.svg": SVG });
  const project = await client.call("project.create", { ...req(), path: repo });
  const auto = { id: idOf("image/svg+xml", SVG), path: "public/favicon.svg", auto: true };
  expect(project.logo).toEqual(auto);
  expect(await shown(project.id)).toEqual({ logo: auto, logo_mode: undefined });
  expect(JSON.stringify((await client.call("project.list", {})).projects)).not.toContain("base64");
  expect(await client.call("project.logo.read", { project_id: project.id })).toEqual({
    id: auto.id,
    url: dataUrl("image/svg+xml", SVG),
  });
});

test("project.update logo: auto shows the favicon, none the folder, a pick itself (its tile current while its file is unchanged); auto again brings the favicon back", async () => {
  const repo = makeRepo(root, { "public/favicon.svg": SVG, "docs/logo.png": "" });
  fs.writeFileSync(path.join(repo, "docs/logo.png"), PNG);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "logo");
  const project = await client.call("project.create", { ...req(), path: repo });
  const auto = { id: idOf("image/svg+xml", SVG), path: "public/favicon.svg", auto: true };
  expect(await current(project.id)).toEqual(["public/favicon.svg"]);

  // None: the folder, and it says so; nothing to read.
  expect(
    await client.call("project.update", { ...req(), project_id: project.id, logo: "none" }),
  ).toMatchObject({ logo_mode: "none" });
  expect(await shown(project.id)).toEqual({ logo: undefined, logo_mode: "none" });
  expect(await failure(client.call("project.logo.read", { project_id: project.id }))).toBe(
    "not_found",
  );
  expect(await current(project.id)).toEqual([]);

  // A pick drawn from docs/logo.png: its tile is the logo while the file holds the bytes it had.
  const drawn = Buffer.concat([PNG, Buffer.from("drawn small")]);
  const pick = { url: dataUrl("image/png", drawn), path: "docs/logo.png" };
  const picked = { id: idOf("image/png", drawn), path: "docs/logo.png" };
  expect(
    await client.call("project.update", { ...req(), project_id: project.id, logo: pick }),
  ).toMatchObject({ logo: picked, logo_mode: "picked" });
  expect(await shown(project.id)).toEqual({ logo: picked, logo_mode: "picked" });
  expect(await client.call("project.logo.read", { project_id: project.id })).toEqual({
    id: picked.id,
    url: pick.url,
  });
  expect(await current(project.id)).toEqual(["docs/logo.png"]);
  fs.writeFileSync(path.join(repo, "docs/logo.png"), Buffer.concat([PNG, Buffer.from([1])]));
  expect(await current(project.id)).toEqual([]);
  // A rename keeps it.
  expect(
    (await client.call("project.update", { ...req(), project_id: project.id, name: "Logo" })).logo,
  ).toEqual(picked);

  // An upload has no path, and marks no tile.
  const upload = { url: dataUrl("image/png", PNG) };
  await client.call("project.update", { ...req(), project_id: project.id, logo: upload });
  expect(await shown(project.id)).toEqual({
    logo: { id: idOf("image/png", PNG) },
    logo_mode: "picked",
  });
  expect(await current(project.id)).toEqual([]);

  await client.call("project.update", { ...req(), project_id: project.id, logo: "auto" });
  expect(await shown(project.id)).toEqual({ logo: auto, logo_mode: undefined });
  // The favicon changed on disk: the next list shows the new one, by a new id.
  const green = SVG.replace("#e5484d", "#30a46c");
  fs.writeFileSync(path.join(repo, "public/favicon.svg"), `${green}\n`);
  expect((await listed(project.id)).logo?.id).toBe(idOf("image/svg+xml", `${green}\n`));
});

test("project.update refuses a pick that is not a small PNG data: URL, or whose path leaves the project", async () => {
  const project = await client.call("project.create", {
    ...req(),
    path: makeRepo(root, { "README.md": "r\n" }),
  });
  const refused = async (logo: { url: string; path?: string }) =>
    failure(client.call("project.update", { ...req(), project_id: project.id, logo }));
  expect(await refused({ url: "https://example.test/logo.png" })).toBe("invalid_params");
  expect(await refused({ url: dataUrl("image/svg+xml", SVG) })).toBe("invalid_params");
  expect(await refused({ url: "data:text/html;base64,PHNjcmlwdD4=" })).toBe("invalid_params");
  expect(await refused({ url: dataUrl("image/png", "not a png") })).toBe("invalid_params");
  expect(await refused({ url: `${dataUrl("image/png", PNG).slice(0, -2)}h=` })).toBe(
    "invalid_params",
  );
  expect(
    await refused({ url: dataUrl("image/png", Buffer.concat([PNG, Buffer.alloc(64 * 1024)])) }),
  ).toBe("invalid_params");
  expect(await refused({ url: dataUrl("image/png", PNG), path: "../outside.png" })).toBe(
    "invalid_params",
  );
  expect(await refused({ url: dataUrl("image/png", PNG), path: "/etc/hosts" })).toBe(
    "invalid_params",
  );
  // A path that names no file is kept as said; it just marks no tile.
  expect(await refused({ url: dataUrl("image/png", PNG), path: "a/logo.png" })).toBe("ok");
  expect(await current(project.id)).toEqual([]);
});

test("auto takes the first favicon it can draw within 64 KiB: an .icns or an oversized favicon.svg never hides a small favicon.png", async () => {
  const icns = await client.call("project.create", {
    ...req(),
    path: makeRepo(root, { "Resources/AppIcon.icns": "icns" }),
  });
  expect(icns.logo).toBeUndefined();
  expect(icns.logo_mode).toBeUndefined();
  const repo = makeRepo(root, {
    "AppIcon.icns": "icns",
    "favicon.svg": `<svg xmlns="http://www.w3.org/2000/svg">${" ".repeat(70 * 1024)}</svg>`,
  });
  fs.writeFileSync(path.join(repo, "favicon.png"), PNG);
  expect((await client.call("project.create", { ...req(), path: repo })).logo).toEqual({
    id: idOf("image/png", PNG),
    path: "favicon.png",
    auto: true,
  });
});

fifoTest(
  "a FIFO where a favicon, a page source or t3.json would be holds nothing up: list, read and candidates answer at once",
  async () => {
    const repo = makeRepo(root, { "README.md": "fifo\n" });
    fs.mkdirSync(path.join(repo, "public"), { recursive: true });
    fs.writeFileSync(path.join(repo, "public/favicon.png"), PNG);
    for (const name of ["favicon.svg", "index.html", "public/index.html", "t3.json"]) {
      execFileSync("mkfifo", [path.join(repo, name)]);
      fifos.push(path.join(repo, name));
    }
    const started = performance.now();
    const project = await client.call("project.create", { ...req(), path: repo });
    expect(project.logo).toEqual({
      id: idOf("image/png", PNG),
      path: "public/favicon.png",
      auto: true,
    });
    expect((await listed(project.id)).logo?.path).toBe("public/favicon.png");
    expect((await client.call("project.logo.read", { project_id: project.id })).url).toBe(
      dataUrl("image/png", PNG),
    );
    expect(
      (await client.call("project.logo.candidates", { project_id: project.id })).candidates.map(
        (c) => c.path,
      ),
    ).toEqual(["public/favicon.png"]);
    expect(performance.now() - started).toBeLessThan(5_000);
  },
);

test("a project whose folder is gone still lists, with its folder; it has no candidates and nothing to read", async () => {
  const repo = makeRepo(root, { "favicon.svg": SVG });
  const project = await client.call("project.create", { ...req(), path: repo });
  expect(project.logo?.path).toBe("favicon.svg");
  fs.rmSync(repo, { recursive: true, force: true });
  expect(await shown(project.id)).toEqual({ logo: undefined, logo_mode: undefined });
  expect(await client.call("project.logo.candidates", { project_id: project.id })).toEqual({
    candidates: [],
  });
  expect(await failure(client.call("project.logo.read", { project_id: project.id }))).toBe(
    "not_found",
  );
});
