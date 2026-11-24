import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CAST, DEFAULT_COMPANION, parseCompanion, type MascotBody } from "./cast";
import bat from "./cast/bat";
import bear from "./cast/bear";
import beaver from "./cast/beaver";
import bison from "./cast/bison";
import boar from "./cast/boar";
import cavewoman from "./cast/cavewoman";
import dino from "./cast/dino";
import elder from "./cast/elder";
import elk from "./cast/elk";
import glyptodon from "./cast/glyptodon";
import kid from "./cast/kid";
import mammoth from "./cast/mammoth";
import owl from "./cast/owl";
import petrock from "./cast/petrock";
import ptero from "./cast/ptero";
import rhino from "./cast/rhino";
import sabertooth from "./cast/sabertooth";
import sloth from "./cast/sloth";
import trike from "./cast/trike";
import wolf from "./cast/wolf";
import { Mascot } from "./Mascot";
import { MASCOT_POSES, type CastCharacter } from "./poses";

const generated: Record<Exclude<CastCharacter, "caveman">, MascotBody> = {
  cavewoman,
  elder,
  kid,
  mammoth,
  sabertooth,
  wolf,
  bear,
  rhino,
  sloth,
  glyptodon,
  bison,
  elk,
  boar,
  beaver,
  owl,
  bat,
  dino,
  trike,
  ptero,
  petrock,
};

describe("parseCompanion", () => {
  it.each([null, "", "{", "[]", "42", '{"character":"robot","tone":"green"}'])("falls back to the caveman for %j", (raw) => {
    expect(parseCompanion(raw)).toEqual(DEFAULT_COMPANION);
  });

  it("keeps a known pick and resets only the part it does not know", () => {
    expect(parseCompanion('{"character":"dino","tone":"dark"}')).toEqual({ character: "dino", tone: "dark" });
    expect(parseCompanion('{"character":"elder","tone":"blue"}')).toEqual({ character: "elder", tone: DEFAULT_COMPANION.tone });
  });
});

describe("the cast's generated bodies", () => {
  it.each(CAST.filter((c) => c.id !== "caveman"))("$id: every pose in its frame budget, a blink, skin only if toned", ({ id, skin }) => {
    const body = generated[id as keyof typeof generated];
    expect(Object.keys(body).sort()).toEqual(Object.keys(MASCOT_POSES).sort());
    for (const [pose, sheet] of Object.entries(body)) {
      const width = MASCOT_POSES[pose as keyof typeof MASCOT_POSES].frames * 24;
      for (const [, d] of sheet.paths) {
        for (const [, x, y, n] of d.matchAll(/M(\d+) (\d+)h(\d+)/g)) {
          expect(Number(x) + Number(n), `${id}/${pose} draws past its last frame`).toBeLessThanOrEqual(width);
          expect(Number(y)).toBeLessThan(24);
        }
      }
    }
    expect(body.idle.blink?.length).toBeGreaterThan(0);
    const tokens = Object.values(body).flatMap((s) => s.paths.map(([t]) => t));
    expect(tokens.some((t) => t.startsWith("skin"))).toBe(skin);
  });
});

describe("Mascot", () => {
  it("puts a skin tone on the body and never on the bust (the app's face)", () => {
    expect(renderToStaticMarkup(<Mascot tone="dark" />)).toContain("px-skin-dark");
    expect(renderToStaticMarkup(<Mascot tone={DEFAULT_COMPANION.tone} />)).not.toContain("px-skin-");
    expect(renderToStaticMarkup(<Mascot cut="bust" tone="dark" />)).not.toContain("px-skin-");
  });

  it("holds a companion's space, empty, until its sheet has loaded", () => {
    const html = renderToStaticMarkup(<Mascot character="dino" scale={2} />);
    expect(html).toContain("--px-w:24");
    expect(html).not.toContain("<svg");
  });
});
