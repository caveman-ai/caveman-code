import { companionBody, readCompanion, type CompanionFile } from "@caveman-app/shared/companion";
import { KIT_CAVEMAN } from "@caveman-app/shared/companionKit";
import { MASCOT_SPRITES } from "@caveman-app/ui/mascot/sprites";
import { describe, expect, it } from "vitest";
import { takeCompanionList } from "./companions.ts";

const caveman: CompanionFile = { name: "Caveman", line: "The original.", head: KIT_CAVEMAN.head, faces: KIT_CAVEMAN.faces };
const file = (patch: Record<string, unknown> = {}) => JSON.stringify({ ...caveman, ...patch });

describe("a made companion", () => {
  it("plays the caveman's build exactly as the generator does: his own head gives his sprites, every pose, blink and gaze", () => {
    expect(companionBody(caveman)).toEqual(MASCOT_SPRITES.body);
  });

  it("reads a good file, with its own colours", () => {
    const read = readCompanion("rex", file({ name: "Rex", palette: { H: "ginger", h: "ginger-hi" } }));
    expect("companion" in read && read.companion.name).toBe("Rex");
    const tokens = "companion" in read ? read.companion.body.idle!.paths.map(([t]) => t) : [];
    expect(tokens).toContain("ginger");
    expect(tokens).not.toContain("hair");
  });

  it.each([
    ["file name", "Rex", file()],
    ["not JSON", "rex", "{"],
    ["name", "rex", file({ name: "" })],
    ["head row 3 is 25 wide", "rex", file({ head: [...KIT_CAVEMAN.head.slice(0, 3), "x".repeat(25)] })],
    ['letter "Q" has no colour', "rex", file({ head: ["....Q"] })],
    ['palette letter "S"', "rex", file({ palette: { S: "fur" } })],
    ["is not one of", "rex", file({ palette: { H: "skin" } })],
    ["faces.grin is missing", "rex", file({ faces: { ...KIT_CAVEMAN.faces, grin: undefined } })],
    ["0 green beads", "rex", file({ head: KIT_CAVEMAN.head.map((r) => r.replace("G", "H")) })],
    ["eyes drawn with e", "rex", file({ head: KIT_CAVEMAN.head.map((r) => r.replaceAll("e", "S")) })],
  ])("tells a chat what to fix: %s", (says, id, text) => {
    const read = readCompanion(id, text);
    expect("problem" in read ? read.problem : "").toContain(says);
  });

  it("splits the folder into the drawn and the problems", () => {
    const got = takeCompanionList({ folder: "/home/me/.caveman/companions", files: [{ id: "rex", text: file() }, { id: "big", problem: "too big" }, { id: "bad", text: "{" }] });
    expect(got.problems.map((p) => p.id)).toEqual(["big", "bad"]);
  });
});
