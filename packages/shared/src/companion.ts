/**
 * Companions people make (Settings > Appearance > Companion > Create): a
 * chat draws a head from an image and saves it to the companions folder
 * (`~/.caveman/companions/<id>.json`); this module reads such a file and
 * plays the head on the caveman's build in every pose, from the plan
 * packages/ui/scripts/caveman-avatar.py writes (companionKit.ts), so a made
 * companion moves and is coloured exactly like the cast. The runtime only
 * lists the folder and keeps its README (companionGuide) current; the client
 * reads, checks and draws each file here.
 *
 * The body comes out as packages/ui's mascot sheets: per pose, one SVG path
 * per identity token with frames side by side, plus the shut-eye pixels
 * (`blink`) on idle and look.
 */
import { KIT_CAVEMAN, KIT_GAZE, KIT_LETTERS, KIT_PLAN, KIT_TOKENS } from "./companionKit.ts";

const SIZE = 24;

/** The expressions a head draws, as pixels on it; the plan puts each where a pose needs it. */
export const COMPANION_FACES = ["closed", "aside", "crossed", "happy", "grunt", "shout", "grin", "wavy"] as const;
export type CompanionFace = (typeof COMPANION_FACES)[number];
const FACE_MEANS: Record<CompanionFace, string> = {
  closed: "eyes shut (sleeping)",
  aside: "eyes looking to one side (thinking)",
  crossed: "dazed eyes (error)",
  happy: "eyes squeezed happy (done)",
  grunt: "a small open mouth (working, sleeping)",
  shout: "a wide open mouth (working, done)",
  grin: "a toothy grin (done, wave)",
  wavy: "a wobbly mouth (error)",
};

/** Letters a companion may point at another token: the hair and the tunic (its spots too). */
const RECOLOURABLE = new Set(["H", "h", "T", "t", "D"]);
/** Tokens a companion's own letters may paint: skin only through the skin letters (a skin tone swaps them), the outline and the bead never. */
const PAINTABLE = Object.keys(KIT_TOKENS).filter((t) => !t.startsWith("skin") && t !== "outline" && t !== "bead");
const LID = "d";

export const COMPANION_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** A companion file bigger than this is not read. */
export const MAX_COMPANION_BYTES = 64 * 1024;
/** The most companion files a folder is read for. */
export const MAX_COMPANIONS = 50;
export const COMPANION_README = "README.md";

export type CompanionPixel = readonly [x: number, y: number, letter: string];
export type CompanionFile = {
  readonly name: string;
  readonly line: string;
  /** Rows from the top of the 24x24 canvas, '.' transparent. */
  readonly head: ReadonlyArray<string>;
  readonly faces: Readonly<Record<CompanionFace, ReadonlyArray<CompanionPixel>>>;
  /** Letter -> identity token, on top of the cast's letters. */
  readonly palette?: Readonly<Record<string, string>>;
};
export type CompanionPath = readonly [token: string, d: string];
export type CompanionSheet = { readonly paths: ReadonlyArray<CompanionPath>; readonly blink?: ReadonlyArray<CompanionPath> };
export type CompanionBody = Readonly<Record<string, CompanionSheet>>;
export type MadeCompanion = { readonly id: string; readonly name: string; readonly line: string; readonly body: CompanionBody };

type Grid = string[][];
const blank = (): Grid => Array.from({ length: SIZE }, () => Array<string>(SIZE).fill("."));
const gridOf = (rows: ReadonlyArray<string>): Grid => {
  const g = blank();
  rows.slice(0, SIZE).forEach((row, y) => [...row.slice(0, SIZE)].forEach((ch, x) => (g[y]![x] = ch)));
  return g;
};
/** `layer` painted onto `g` moved by (dx, dy); what leaves the canvas is cut. */
const paint = (g: Grid, layer: Grid, dx = 0, dy = 0) => {
  layer.forEach((row, y) =>
    row.forEach((ch, x) => {
      if (ch !== "." && y + dy >= 0 && y + dy < SIZE && x + dx >= 0 && x + dx < SIZE) g[y + dy]![x + dx] = ch;
    }),
  );
  return g;
};

/** Every pose's frames (the gaze's nine stills included) as grids of letters. */
function frames(c: CompanionFile): Record<string, Grid[]> {
  const head = gridOf(c.head);
  const withFaces = (faces: ReadonlyArray<string>) => {
    const g = head.map((r) => [...r]);
    for (const f of faces) for (const [x, y, ch] of c.faces[f as CompanionFace]) g[y]![x] = ch;
    return g;
  };
  const out: Record<string, Grid[]> = {};
  for (const [pose, plan] of Object.entries(KIT_PLAN)) {
    out[pose] = plan.map((f) => paint(paint(gridOf(f.under), withFaces(f.faces), f.dx, f.dy), gridOf(f.over)));
  }
  out.look = look(out.idle![0]!);
  return out;
}

/**
 * Nine stills of the eyes on the pointer (caveman-avatar.py `look`): an eye is
 * its `e` pixels plus a dark pixel tucked under one; it moves only onto the
 * face's own colour, as far as it can toward each direction, else stays put.
 */
function look(frame: Grid): Grid[] {
  const get = (x: number, y: number) => frame[y]?.[x] ?? ".";
  const key = (x: number, y: number) => `${x},${y}`;
  const eye: Array<[number, number]> = [];
  frame.forEach((row, y) => row.forEach((ch, x) => ch === "e" && eye.push([x, y])));
  for (const [x, y] of [...eye]) {
    if (get(x, y + 1) === "O" && !"O.".includes(get(x - 1, y + 1)) && !"O.".includes(get(x + 1, y + 1))) eye.push([x, y + 1]);
  }
  const isEye = new Set(eye.map(([x, y]) => key(x, y)));
  const around = eye.flatMap(([x, y]) =>
    [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => !isEye.has(key(x + dx!, y + dy!))).map(([dx, dy]) => get(x + dx!, y + dy!)),
  );
  const count = (ch: string) => around.filter((a) => a === ch).length;
  const fill = around.filter((ch) => !"O.eG".includes(ch)).reduce<string | null>((best, ch) => (best === null || count(ch) > count(best) ? ch : best), null);
  if (eye.length === 0) return KIT_GAZE.map(() => frame); // no eyes: readCompanion says so
  if (fill === null) throw new Error("the eyes (e) need the face's own colour around them");
  return KIT_GAZE.map(([dx, dy]) => {
    const [mx, my] = ([[dx, dy], [dx, 0], [0, dy], [0, 0]] as const).find(([mx, my]) =>
      eye.every(([x, y]) => isEye.has(key(x + mx, y + my)) || get(x + mx, y + my) === fill),
    )!;
    const g = frame.map((r) => [...r]);
    for (const [x, y] of eye) g[y]![x] = fill;
    for (const [x, y] of eye) g[y + my]![x + mx] = frame[y]![x]!;
    return g;
  });
}

/** One path per token across the strip (frame i at x = i * 24), tokens in palette order. */
function paths(strip: ReadonlyArray<Grid>, letters: Readonly<Record<string, string>>): CompanionPath[] {
  const d = new Map<string, string[]>();
  strip.forEach((grid, i) =>
    grid.forEach((row, y) => {
      for (let x = 0; x < row.length; ) {
        let n = 1;
        while (x + n < row.length && row[x + n] === row[x]) n++;
        const ch = row[x]!;
        if (ch !== ".") {
          const t = letters[ch]!;
          d.set(t, [...(d.get(t) ?? []), `M${x + i * SIZE} ${y}h${n}v1h-${n}z`]);
        }
        x += n;
      }
    }),
  );
  return [...new Set(Object.values(letters))].filter((t) => d.has(t)).map((t) => [t, d.get(t)!.join("")] as const);
}

const blinkOf = (g: Grid): Grid => g.map((r) => r.map((ch) => (ch === "e" ? LID : ".")));

/** The body in every pose, laid out like packages/ui's generated sheets. `c` must have passed readCompanion. */
export function companionBody(c: CompanionFile): CompanionBody {
  const letters = { ...KIT_LETTERS, ...c.palette };
  return Object.fromEntries(
    Object.entries(frames(c)).map(([pose, strip]) => [
      pose,
      pose === "idle" || pose === "look" ? { paths: paths(strip, letters), blink: paths(strip.map(blinkOf), letters) } : { paths: paths(strip, letters) },
    ]),
  );
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const oneLine = (v: unknown, max: number) => typeof v === "string" && v.trim() !== "" && v.length <= max && !/[\0\n\r]/.test(v);

/** A file of the companions folder, read and checked: the companion, or what is wrong with it in words a chat can fix. */
export function readCompanion(id: string, text: string): { readonly companion: MadeCompanion } | { readonly problem: string } {
  const problem = (message: string) => ({ problem: message });
  if (!COMPANION_ID.test(id)) return problem("the file name must be lowercase letters, digits and dashes (up to 40), then .json");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return problem(`it is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isRecord(v)) return problem("it must be a JSON object");
  if (!oneLine(v.name, 32)) return problem("name must be one line of 1 to 32 characters");
  if (!oneLine(v.line, 120)) return problem("line must be one line of 1 to 120 characters");
  if (v.palette !== undefined && !isRecord(v.palette)) return problem("palette must be an object of letter -> token");
  const palette = (v.palette ?? {}) as Record<string, unknown>;
  for (const [ch, token] of Object.entries(palette)) {
    if (!/^[A-Za-z]$/.test(ch) || (ch in KIT_LETTERS && !RECOLOURABLE.has(ch))) {
      return problem(`palette letter ${JSON.stringify(ch)}: only H, h, T, t, D or a letter the cast does not use (${Object.keys(KIT_LETTERS).join("")} are taken) may be set`);
    }
    if (typeof token !== "string" || !PAINTABLE.includes(token)) return problem(`palette ${ch}: ${JSON.stringify(token)} is not one of ${PAINTABLE.join(", ")}`);
  }
  const letters = { ...KIT_LETTERS, ...(palette as Record<string, string>) };
  const known = (ch: string) => ch === "." || ch in letters;
  if (!Array.isArray(v.head) || v.head.length === 0 || v.head.length > 17 || !v.head.every((r) => typeof r === "string")) {
    return problem("head must be 1 to 17 rows (strings) from the top of the canvas");
  }
  const head = v.head as string[];
  for (const [y, row] of head.entries()) {
    if (row.length > SIZE) return problem(`head row ${y} is ${row.length} wide; rows are at most ${SIZE}`);
    const stray = [...row].find((ch) => !known(ch));
    if (stray !== undefined) return problem(`head row ${y}: the letter ${JSON.stringify(stray)} has no colour; add it to palette or use a cast letter`);
  }
  if (!isRecord(v.faces)) return problem(`faces must be an object with ${COMPANION_FACES.join(", ")}`);
  const faces = v.faces;
  for (const f of COMPANION_FACES) {
    const pts = faces[f];
    if (!Array.isArray(pts)) return problem(`faces.${f} is missing: ${FACE_MEANS[f]}, as [x, y, letter] pixels on the head`);
    for (const p of pts) {
      const ok = Array.isArray(p) && p.length === 3 && Number.isInteger(p[0]) && Number.isInteger(p[1]) && p[0] >= 0 && p[0] < SIZE && p[1] >= 0 && p[1] < SIZE && typeof p[2] === "string" && p[2].length === 1 && known(p[2]);
      if (!ok) return problem(`faces.${f}: ${JSON.stringify(p)} is not [x 0-23, y 0-23, a letter with a colour]`);
    }
  }
  const unknownFace = Object.keys(faces).find((f) => !(COMPANION_FACES as ReadonlyArray<string>).includes(f));
  if (unknownFace) return problem(`faces.${unknownFace} is not a face; the faces are ${COMPANION_FACES.join(", ")}`);
  const file: CompanionFile = { name: v.name as string, line: v.line as string, head, faces: faces as CompanionFile["faces"], palette: palette as Record<string, string> };
  let all: Record<string, Grid[]>;
  try {
    all = frames(file);
  } catch (e) {
    return problem(e instanceof Error ? e.message : String(e));
  }
  for (const [pose, strip] of Object.entries(all)) {
    for (const [i, g] of strip.entries()) {
      const beads = g.flat().filter((ch) => ch === "G").length;
      if (beads !== 1) return problem(`${pose} frame ${i} shows ${beads} green beads (G); a companion wears exactly one, where no arm or club covers it (near the chin's middle, like the caveman's)`);
    }
  }
  if (!all.idle!.every((g) => g.flat().includes("e"))) return problem("the head needs eyes drawn with e, so it can blink and follow the pointer");
  return { companion: { id, name: file.name, line: file.line, body: companionBody(file) } };
}

/** The companions folder's README: what a chat reads to make a companion from an image. */
export function companionGuide(folder: string): string {
  const example = { name: "Caveman", line: "The original. Bonks the rock until it works.", head: KIT_CAVEMAN.head, faces: KIT_CAVEMAN.faces };
  const tokens = PAINTABLE.map((t) => `${t} ${KIT_TOKENS[t]}`).join(", ");
  return `# Companions

Each \`<id>.json\` here is a companion: a pixel figure the Caveman Code app shows
in Settings > Appearance > Companion, in every state, next to the caveman, the
cavewoman, the elder, the cave kid and the animals (the mammoth, the dino and
the rest of the herd). This file is rewritten by the app.

## Making one from an image

Draw the subject of the image as a **head** in the cast's exact style and save
it as \`${folder}/<id>.json\` (id: lowercase letters, digits and dashes). You
draw the head and its faces only: the app puts it on the caveman's build (his
torso, leopard tunic, arms, legs and club) and plays every state from it:
idle with a blink, working (club on the rock), thinking, done, sleeping, error,
wave, and eyes that follow the pointer. Whatever the image is (a person, a pet,
an object, a logo), it becomes a caveman-style companion, not a new style.

The style:
- A 24x24 canvas, one letter per pixel, \`.\` transparent. Squat: the head and
  its hair or fur are about half the figure. The head sits in columns 5-21 and
  rows 0-16; the shoulders start at row 13, so rows 13-16 are the chin, beard or
  fur over them.
- A 1-pixel \`O\` outline around the head. Flat colours, no gradients, no
  anti-aliasing, a lit side and a shade side at most.
- Eyes are single \`e\` pixels on the face's own colour (row 9 in the example),
  so they blink and follow the pointer. A simple nose or mouth shape, readable
  at 24 px.
- Exactly one green bead \`G\` on the head, near the middle of the chin
  (column 10-13, row 13-14), where no arm or club covers it.
- Only the cast's colours. Letters: ${Object.entries(KIT_LETTERS).map(([ch, t]) => `\`${ch}\` ${t}`).join(", ")}.
  Skin is \`S\` skin, \`s\` its shade, \`d\` its edge, \`K\` its light: the
  person's skin tone setting recolours them. \`palette\` may point \`H\`, \`h\`
  (hair), \`T\`, \`t\`, \`D\` (tunic and its spots) or a letter of your own at one
  of: ${tokens}. Pick the nearest to the image's colours.

## The faces

\`faces\` holds every expression as \`[x, y, letter]\` pixels drawn over the head
(same coordinates as \`head\`): ${COMPANION_FACES.map((f) => `\`${f}\` ${FACE_MEANS[f]}`).join("; ")}.

## The file

The caveman's own head, as the worked example:

\`\`\`json
${JSON.stringify(example, null, 1).replace(/\[\n\s+(-?\d+|"[^"]*"),\n\s+(-?\d+),\n\s+("[^"]*")\n\s+\]/g, "[$1, $2, $3]")}
\`\`\`

Add \`"palette": { "H": "ginger", "h": "ginger-hi" }\` and the like when the
colours change. Then tell the person to pick it in Settings > Appearance >
Companion; a file the app cannot use shows there with what to fix.
`;
}
