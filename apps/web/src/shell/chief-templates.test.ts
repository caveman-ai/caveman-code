// The ready-made Chiefs under the Chiefs section's +: four, each a character of its own, a role the runtime takes as
// it is (one line, at most 140 characters, so the greeting knows it again), a soul in the starter's headings and three
// missions. A second one of a kind is made under a free name, since the runtime refuses a taken one.
import { ChiefAvatar } from "@caveman-app/session-protocol";
import * as Schema from "effect/Schema";
import { describe, expect, test } from "vitest";
import { CHIEF_TEMPLATES, freeName, templateOf } from "./chief-templates.ts";

/** The runtime's limit on a role (packages/runtime/src/chief/Chief.ts ROLE_MAX). */
const ROLE_MAX = 140;

describe("CHIEF_TEMPLATES", () => {
  test("are the Maintainer, the Reviewer, the Technical Writer and Triage, in that order", () => {
    expect(CHIEF_TEMPLATES.map((t) => t.name)).toEqual([
      "Maintainer",
      "Reviewer",
      "Technical Writer",
      "Triage",
    ]);
  });

  test("have unique ids, names and characters, each one the protocol accepts", () => {
    const unique = (values: ReadonlyArray<string>) => new Set(values).size === values.length;
    expect(unique(CHIEF_TEMPLATES.map((t) => t.id))).toBe(true);
    expect(unique(CHIEF_TEMPLATES.map((t) => t.name.toLowerCase()))).toBe(true);
    expect(unique(CHIEF_TEMPLATES.map((t) => t.avatar.character))).toBe(true);
    for (const t of CHIEF_TEMPLATES)
      expect(Schema.decodeUnknownSync(ChiefAvatar)(t.avatar)).toEqual(t.avatar);
  });

  test("each name and line read whole on one row of the + menu", () => {
    // About what fits beside the character in its 300px menu at 13px (measured in the running app).
    for (const t of CHIEF_TEMPLATES)
      expect(t.name.length + t.line.length, t.name).toBeLessThanOrEqual(36);
  });

  test("each role is one first-person line of at most 140 characters, kept by the runtime as written", () => {
    for (const t of CHIEF_TEMPLATES) {
      expect(t.role.length, t.name).toBeLessThanOrEqual(ROLE_MAX);
      expect(t.role, t.name).toMatch(/^I /);
      // The runtime keeps a role trimmed with its spaces collapsed (cleanRole): written so, it comes back equal.
      expect(t.role.replace(/\s+/g, " ").trim(), t.name).toBe(t.role);
    }
    expect(new Set(CHIEF_TEMPLATES.map((t) => t.role)).size).toBe(CHIEF_TEMPLATES.length);
  });

  test("each soul fills the starter's two headings with short lines", () => {
    for (const t of CHIEF_TEMPLATES) {
      expect(t.soul, t.name).toMatch(/^# Soul\n\n## Standing instructions\n- /);
      expect(t.soul, t.name).toMatch(/\n## Crew rules\n- /);
      const lines = t.soul.split("\n").filter((l) => l.startsWith("- "));
      expect(lines.length, t.name).toBeGreaterThanOrEqual(6);
      // Texting length: no line runs on.
      for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(100);
    }
  });

  test("each offers three missions: a short title, one line under it, and the note sent", () => {
    for (const t of CHIEF_TEMPLATES) {
      expect(t.missions, t.name).toHaveLength(3);
      expect(new Set(t.missions.map((m) => m.title)).size, t.name).toBe(3);
      for (const m of t.missions) {
        expect(m.title.length, m.title).toBeLessThanOrEqual(30);
        expect(m.line.length, m.line).toBeLessThanOrEqual(50);
        expect(m.note.trim(), m.title).not.toBe("");
        expect(m.icon, m.title).toBeDefined();
      }
    }
  });
});

describe("templateOf", () => {
  test("knows a Chief made from a template by its role, and not once the person edits it", () => {
    for (const t of CHIEF_TEMPLATES) expect(templateOf(t.role)).toBe(t);
    const maintainer = CHIEF_TEMPLATES[0]!;
    expect(templateOf(` ${maintainer.role} `)).toBe(maintainer);
    expect(templateOf(`${maintainer.role} And the deploys.`)).toBeUndefined();
    expect(templateOf(undefined)).toBeUndefined();
    expect(templateOf("")).toBeUndefined();
  });
});

describe("freeName", () => {
  test("keeps the name while no Chief has it, else numbers it as the runtime numbers Chiefs", () => {
    expect(freeName("Maintainer", ["Ugg", "Thog"])).toBe("Maintainer");
    // Taken, compared trimmed and case-blind as the runtime compares names.
    expect(freeName("Maintainer", [" maintainer "])).toBe("Maintainer 2");
    expect(freeName("Maintainer", ["Maintainer", "MAINTAINER 2"])).toBe("Maintainer 3");
    expect(freeName("Triage", ["Maintainer", "Triage 2"])).toBe("Triage");
  });
});
