// Where the phone's work lives, off the screen: what a field holds, which computer can take a project, where a chat in
// it settles, and that a project added once is one project everywhere.
import { describe, expect, it } from "vitest";
import { deviceById, DEVICES, THIS_MAC } from "./model";
import {
  addProject,
  blocked,
  candidates,
  isProject,
  macReachable,
  pairedMac,
  placeOf,
  projects,
  readTyped,
  searchNote,
  settle,
} from "./places";
import { world } from "./world";

const cloud = DEVICES.find((d) => d.kind === "cloud")!;
const studio = DEVICES.find((d) => d.kind === "mac" && !d.self)!;

describe("readTyped", () => {
  it("reads a folder's path, a GitHub link or owner/name, and words to search by", () => {
    expect(readTyped("~/code/notes/")).toEqual({
      kind: "path",
      place: { name: "notes", path: "~/code/notes" },
      needle: "~/code/notes",
    });
    expect(readTyped("https://github.com/caveman-ai/caveman-v4.git")).toMatchObject({
      kind: "repo",
      place: { name: "caveman-v4", github: "caveman-ai/caveman-v4" },
    });
    expect(readTyped("acme/docs-site")).toMatchObject({
      kind: "repo",
      place: { github: "acme/docs-site" },
    });
    expect(readTyped("  relay ")).toEqual({ kind: "search", needle: "relay" });
  });
});

describe("the scripted world", () => {
  it("runs every chat where its project can: nothing runs in Cloud or on another Mac from a folder on no GitHub", () => {
    const chats = world(Date.parse("2026-11-10T09:00:00.000Z")).chats;
    expect(chats.length).toBeGreaterThan(10);
    const wrong = chats
      .filter((c) => blocked(placeOf(c.repo), deviceById(c.device)) !== null)
      .map((c) => `${c.id}: ${c.repo} on ${c.device}`);
    expect(wrong).toEqual([]);
    // So the box's default place, the last chat's, is one a new chat can start on.
    const last = chats
      .filter((c) => !c.parent)
      .reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
    expect(blocked(placeOf(last.repo), deviceById(last.device))).toBeNull();
  });
});

describe("which computer can take a project", () => {
  it("is the paired Mac, by its name, never This Mac", () => {
    expect(pairedMac()?.id).toBe(THIS_MAC);
    expect(pairedMac()?.name).not.toMatch(/this mac/i);
  });

  it("keeps a folder on no GitHub on the paired Mac, and lets a GitHub repository run anywhere", () => {
    const folder = addProject({ name: "notes", path: "~/Documents/notes" });
    const repo = placeOf("caveman-code");
    expect(folder?.github).toBeUndefined();
    expect(blocked(folder, cloud)).toBe("Cloud needs this project on GitHub.");
    expect(blocked(folder, studio)).toMatch(/folder on/);
    expect(blocked(folder, deviceById(THIS_MAC))).toBeNull();
    for (const device of DEVICES) expect(blocked(repo, device)).toBeNull();
  });

  it("moves a chat in a folder off a computer that can't take it, and keeps one that can", () => {
    expect(settle(placeOf("notes"), cloud).id).toBe(THIS_MAC);
    expect(settle(placeOf("caveman-code"), cloud).id).toBe(cloud.id);
  });
});

describe("adding a project", () => {
  it("adds a repository once, wherever it is added, and finds it again by link or name", () => {
    const before = projects.get().length;
    const site = addProject({ name: "docs-site", github: "acme/docs-site" });
    expect(projects.get()).toHaveLength(before + 1);
    const typed = readTyped("github.com/acme/docs-site");
    expect(typed.kind === "repo" && addProject(typed.place)).toBe(site);
    expect(isProject({ name: "docs-site" }, projects.get())).toBe(true);
    expect(projects.get()).toHaveLength(before + 1);
    // Only on GitHub and the Mac answers: it is cloned onto the Mac.
    expect(site.path).toBe(macReachable() ? "~/code/docs-site" : undefined);
  });

  it("searches the Mac's checkouts while it answers, and says nothing over the list", () => {
    expect(macReachable()).toBe(true);
    expect(searchNote()).toBeNull();
    expect(candidates().some((p) => !p.github)).toBe(true);
  });
});
