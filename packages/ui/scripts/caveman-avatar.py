#!/usr/bin/env python3
"""The Caveman mascot and his cast, drawn as ASCII grids (STYLE.md section 10).

One generator for every sprite: the caveman's 16x16 bust and 24x24 body
(scripts/cast/caveman.py) and the body of every other companion
(scripts/cast/<id>.py), each in every pose of src/mascot/poses.ts. A sprite
is a stack of parts (head, torso, arms, club, effects); each part is a grid
with '.' for transparent, so you can see where every pixel sits (helpers in
pixelgrid.py). Colours are the identity tokens of src/styles/pixel.css (the
hex in each token's comment) and nothing else.

Run from the repo root:

  python3 packages/ui/scripts/caveman-avatar.py                     # write the sprites
  python3 packages/ui/scripts/caveman-avatar.py --sheet a.png       # and a contact sheet of the caveman
  python3 packages/ui/scripts/caveman-avatar.py --cast-sheet a.png  # and one of the whole cast
  python3 packages/ui/scripts/caveman-avatar.py --only dino --cast-sheet a.png  # one companion only
  python3 packages/ui/scripts/caveman-avatar.py --client            # print provider-caveman's icon paths

Writes src/assets/caveman.svg (the bust, idle frame 0: the app's face and the
Caveman engine mark), src/mascot/sprites.ts (every pose as SVG path data, one
path per token, frames side by side), src/mascot/cast/<id>.ts (a
companion's body, loaded only once someone picks it) and
packages/shared/src/companionKit.ts (the caveman's build and poses as a plan,
which a companion someone makes in the app plays with its own head). When the bust changes,
paste the --client output into packages/provider-caveman/src/client.ts in the
same commit (client.test.ts fails until you do).

Why a 24x24 body: it is the grid poses.ts fixed, and the right one for a squat
caveman. Half his height is head and hair, so 24 rows still leave the torso 7
and the legs 3; it lands on 48/72/96 px at 2x/3x/4x, every size STYLE.md puts
him at, and a 32 grid would invite detail that turns to mush at 1x.
"""
import importlib
import os
import re
import sys

sys.dont_write_bytecode = True  # it imports pixelgrid and cast/*: leave no __pycache__ in the repo
from cast.caveman import B_FACE, B_HEAD, BODY, BUST, PLAN  # noqa: E402
from pixelgrid import stack  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # packages/ui

# The companions, in the order Settings shows them after the caveman: each is
# scripts/cast/<id>.py with BODY (pose -> frames) and optional PALETTE
# overrides (letter -> token) on top of the letters below. Keep in step with
# CAST in src/mascot/cast.ts.
CAST = (
  'cavewoman', 'elder', 'kid',
  'mammoth', 'sabertooth', 'wolf', 'bear', 'rhino', 'sloth', 'glyptodon',
  'bison', 'elk', 'boar', 'beaver', 'owl', 'bat',
  'dino', 'trike', 'ptero', 'petrock',
)

# Letter -> identity token (pixel.css --id-*). Several letters share a token:
# the letter says what the pixel is, the token which colour it gets.
PALETTE = {
  'O': 'outline', 'e': 'outline',  # e: an eye, shut for a moment to blink
  'H': 'hair', 'h': 'hair-hi',
  # Skin letters paint skin and nothing else: a skin tone (pixel.css
  # .px-skin-*) swaps their four tokens on the whole sprite.
  'S': 'skin', 's': 'skin-shade', 'd': 'skin-edge', 'K': 'skin-light',
  'T': 'tunic', 't': 'tunic-shade', 'D': 'hair-hi',  # D: the leopard spots
  'G': 'bead',
  'W': 'wood', 'w': 'wood-hi', 'V': 'hair-hi',  # the club: wood, lit side, dark side
  'k': 'rock-dark', 'm': 'rock-mid', 'R': 'rock', 'l': 'rock-light',
  'Z': 'rock-light',  # the sleeping z
  '*': 'glint', 'L': 'glint',  # dazed stars, sparks off the rock; teeth
  'B': 'bone', 'b': 'rock-light',  # bone, tusk, white hair; its shade
}


def all_token_hex():
  """Every identity token with a hex comment, :root's value (.px-skin-* tones come later and stay out)."""
  css = open(os.path.join(ROOT, 'src/styles/pixel.css')).read()
  found = {}
  for t, h in re.findall(r'--id-([a-z-]+):[^;]+;\s*/\*\s*(#[0-9a-fA-F]{6})', css):
    found.setdefault(t, h.lower())
  return found


def token_hex(tokens):
  found = all_token_hex()
  missing = sorted({t for t in tokens if t not in found})
  assert not missing, f'pixel.css has no hex comment for --id-{missing}'
  return {t: found[t].lower() for t in tokens}


def pose_budget():
  src = open(os.path.join(ROOT, 'src/mascot/poses.ts')).read()
  return {p: int(n) for p, n in re.findall(r'^\s*(\w+): \{ frames: (\d+)', src, re.M)}


SPRITES = {'bust': BUST, 'body': BODY}
SIZE = {'bust': 16, 'body': 24}


# The gaze (pose `look`): idle frame 0 with the eyes moved one pixel toward
# each of eight directions, centre first. Keep in step with poses.ts.
GAZE = [(0, 0), (0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1)]


def look(frame):
  """Nine stills of the eyes on the pointer. An eye is its `e` pixels plus
  any dark pixel tucked under one (a tall eye). It moves only onto the face's
  own colour (the letter most around it: skin or fur, never a brow, hair, the
  outline or the bead); where it cannot go all the way it goes as far as one
  axis allows, else stays put."""
  n = len(frame)
  get = lambda x, y: frame[y][x] if 0 <= x < n and 0 <= y < n else '.'
  eye = {(x, y) for y, r in enumerate(frame) for x, ch in enumerate(r) if ch == 'e'}
  eye |= {(x, y + 1) for x, y in eye if get(x, y + 1) == 'O' and get(x - 1, y + 1) not in 'O.' and get(x + 1, y + 1) not in 'O.'}
  around = [get(x + dx, y + dy) for x, y in eye for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)) if (x + dx, y + dy) not in eye]
  fill = max((ch for ch in around if ch not in 'O.eG'), key=around.count)
  out = []
  for dx, dy in GAZE:
    for mx, my in ((dx, dy), (dx, 0), (0, dy), (0, 0)):
      to = {(x + mx, y + my) for x, y in eye}
      if all(p in eye or get(*p) == fill for p in to):
        break
    g = [list(r) for r in frame]
    for x, y in eye:
      g[y][x] = fill
    for x, y in eye:
      g[y + my][x + mx] = frame[y][x]
    out.append([''.join(r) for r in g])
  return out


def breath(frames, n=8):
  """Idle is n frames at 4 fps (poses.ts). A two-frame breath, in and out,
  is held two steps a frame and played twice, at the half-second pace it
  was drawn for; a longer idle (a breath and a fidget) is drawn to n."""
  if len(frames) != 2:
    return frames
  a, b = frames
  return [a, a, b, b] * (n // 4)


for poses in (BUST, BODY, PLAN):
  poses['idle'] = breath(poses['idle'])
BUST['look'] = look(BUST['idle'][0])
BODY['look'] = look(BODY['idle'][0])


def blink(frame, lid='d'):
  """Only the pixels that change when the eyes shut: every eye (e) turns lid."""
  return [''.join(lid if ch == 'e' else '.' for ch in row) for row in frame]


# ── Output ───────────────────────────────────────────────────────────────────

def runs(frames, w):
  """[(letter, x, y, length)] across the strip (frame i starts at x = i * w)."""
  out = []
  for i, grid in enumerate(frames):
    for y, row in enumerate(grid):
      x = 0
      while x < len(row):
        n = 1
        while x + n < len(row) and row[x + n] == row[x]:
          n += 1
        if row[x] != '.':
          out.append((row[x], x + i * w, y, n))
        x += n
  return out


def paths(frames, w, palette=PALETTE):
  """[(token, path data)], letters that share a token merged, palette order."""
  d = {}
  for ch, x, y, n in runs(frames, w):
    d.setdefault(palette[ch], []).append(f'M{x} {y}h{n}v1h-{n}z')
  return [(t, ''.join(d[t])) for t in dict.fromkeys(palette.values()) if t in d]


def load_cast(ids):
  """{id: (palette, lid, body)} from scripts/cast/<id>.py."""
  out = {}
  for cid in ids:
    m = importlib.import_module(f'cast.{cid}')
    out[cid] = ({**PALETTE, **getattr(m, 'PALETTE', {})}, getattr(m, 'LID', 'd'), {**m.BODY, 'idle': breath(m.BODY['idle']), 'look': look(m.BODY['idle'][0])})
  return out


def check(name, poses, size, palette, budget):
  assert set(poses) == set(budget), (name, set(poses) ^ set(budget))
  for pose, frames in poses.items():
    assert len(frames) == budget[pose], f'{name}/{pose}: {len(frames)} frames, poses.ts says {budget[pose]}'
    for i, f in enumerate(frames):
      assert len(f) == size and all(len(r) == size for r in f), f'{name}/{pose}[{i}]: not {size}x{size}'
      stray = sorted({ch for r in f for ch in r} - set(palette) - {'.'})
      assert not stray, f'{name}/{pose}[{i}]: letters {stray} have no colour'
      assert sum(r.count('G') for r in f) == 1, f'{name}/{pose}[{i}]: one green bead per frame'
  assert all(any('e' in r for r in f) for f in poses['idle']), f'{name}: every idle frame needs eyes (e) to blink'


def sheet_lines(poses, w, palette, lid, indent):
  fmt = lambda ps: [f'{indent}    ["{t}", "{d}"],' for t, d in ps]
  out = []
  for pose, frames in poses.items():
    out += [f'{indent}{pose}: {{', f'{indent}  paths: [', *fmt(paths(frames, w, palette)), f'{indent}  ],']
    if pose in ('idle', 'look'):
      out += [f'{indent}  blink: [', *fmt(paths([blink(f, lid) for f in frames], w, palette)), f'{indent}  ],']
    out.append(f'{indent}}},')
  return out


def write_ts(path):
  out = [
    '// Generated by packages/ui/scripts/caveman-avatar.py from its ASCII grids. Do not edit by hand.',
    '// A sheet is every frame of a pose side by side (frame i at x = i * width), one path per identity token.',
    'import type { MascotCut, MascotPose } from "./poses";',
    '',
    '/** [identity token (pixel.css --id-*), SVG path data] */',
    'export type MascotPath = readonly [string, string];',
    '',
    'export type MascotSheet = {',
    '  readonly paths: readonly MascotPath[];',
    '  /** Idle only: the shut-eye pixels of each frame, shown for a moment to blink. */',
    '  readonly blink?: readonly MascotPath[];',
    '};',
    '',
    'export const MASCOT_SPRITES: Record<MascotCut, Record<MascotPose, MascotSheet>> = {',
  ]
  for cut, poses in SPRITES.items():
    out += [f'  {cut}: {{', *sheet_lines(poses, SIZE[cut], PALETTE, 'd', '    '), '  },']
  out.append('};')
  open(path, 'w').write('\n'.join(out) + '\n')


def write_cast_ts(cid, palette, lid, body, path):
  out = [
    f'// Generated by packages/ui/scripts/caveman-avatar.py from scripts/cast/{cid}.py. Do not edit by hand.',
    '// The body (24x24) in every pose, laid out like sprites.ts; src/mascot/cast.ts loads it on demand.',
    'import type { MascotPose } from "../poses";',
    'import type { MascotSheet } from "../sprites";',
    '',
    'const body: Record<MascotPose, MascotSheet> = {',
    *sheet_lines(body, 24, palette, lid, '  '),
    '};',
    '',
    'export default body;',
  ]
  open(path, 'w').write('\n'.join(out) + '\n')


def write_kit(path):
  """The caveman's build for companions made in the app (@caveman-app/shared companion.ts):
  each pose's frames as the pixels under the head, the head's place and faces, the pixels
  over it; his own head and faces as the worked example; the letters and the tokens."""
  trim = lambda grid: [r.rstrip('.') for r in grid]
  rows = lambda grid: '[' + ', '.join(f'"{r}"' for r in trim(grid)) + ']'
  head = stack(24, B_HEAD)[:B_HEAD[0] + len(B_HEAD[1])]
  out = [
    '// Generated by packages/ui/scripts/caveman-avatar.py from scripts/cast/caveman.py. Do not edit by hand.',
    '// The caveman\'s build as a plan (companion.ts): every pose\'s frames as the pixels painted under the head,',
    '// where the head goes and with which faces, and the pixels painted over it. Rows end where their pixels do.',
    '',
    '/** Letter -> identity token (pixel.css --id-*). */',
    'export const KIT_LETTERS: Readonly<Record<string, string>> = {',
    *[f'  "{ch}": "{t}",' for ch, t in PALETTE.items()],
    '};',
    '',
    '/** Every identity token and its colour. */',
    'export const KIT_TOKENS: Readonly<Record<string, string>> = {',
    *[f'  "{t}": "{h}",' for t, h in all_token_hex().items()],
    '};',
    '',
    '/** The gaze (pose look): idle frame 0 with the eyes one pixel toward each direction, centre first. */',
    f'export const KIT_GAZE: ReadonlyArray<readonly [number, number]> = [{", ".join(f"[{x}, {y}]" for x, y in GAZE)}];',
    '',
    'export type KitFrame = { readonly under: readonly string[]; readonly faces: readonly string[]; readonly dx: number; readonly dy: number; readonly over: readonly string[] };',
    '',
    'export const KIT_PLAN: Readonly<Record<string, readonly KitFrame[]>> = {',
  ]
  for pose, frames in PLAN.items():
    out.append(f'  {pose}: [')
    for f in frames:
      faces = ', '.join(f'"{x}"' for x in f['faces'])
      out.append(f'    {{ under: {rows(stack(24, *f["under"]))}, faces: [{faces}], dx: {f["dx"]}, dy: {f["dy"]}, over: {rows(stack(24, *f["over"]))} }},')
    out.append('  ],')
  out += [
    '};',
    '',
    '/** The caveman\'s own head (rows from the top of the canvas) and faces ([x, y, letter] on it): the worked example. */',
    'export const KIT_CAVEMAN = {',
    f'  head: {rows(head)},',
    '  faces: {',
    *[f'    {name}: [{", ".join(f"[{x}, {y}, \"{ch}\"]" for x, y, ch in pts)}],' for name, pts in B_FACE.items()],
    '  },',
    '} as const;',
  ]
  open(path, 'w').write('\n'.join(out) + '\n')


def write_svg(grid, hexes, path):
  # Same rect-run shape as before: provider-caveman's client.test.ts parses it.
  size = len(grid)
  rects = ''.join(f'<rect x="{x}" y="{y}" width="{n}" height="1" fill="{hexes[PALETTE[ch]]}"/>' for ch, x, y, n in runs([grid], size))
  open(path, 'w').write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}" '
                        f'shape-rendering="crispEdges"><title>Caveman</title>{rects}</svg>\n')


def to_image(grid, s, palette, hexes):
  from PIL import Image
  im = Image.new('RGBA', (len(grid), len(grid)), (0, 0, 0, 0))
  for y, row in enumerate(grid):
    for x, ch in enumerate(row):
      if ch != '.':
        h = hexes[palette[ch]]
        im.putpixel((x, y), tuple(int(h[i:i + 2], 16) for i in (1, 3, 5)) + (255,))
  return im.resize((len(grid) * s, len(grid) * s), Image.NEAREST)


def contact_sheet(hexes, path):
  """Every pose, every frame, bust and body at 1x, 2x and 4x on the deck's panel."""
  from PIL import Image, ImageDraw
  img = lambda grid, s: to_image(grid, s, PALETTE, hexes)
  scales, gap = (1, 2, 4), 6
  row_h = max(SIZE.values()) * max(scales) + 16
  most = max(len(f) for p, f in BODY.items() if p != 'look')
  col_w = {s: most * (24 * s + gap) + 16 for s in scales}
  W = 100 + sum(col_w.values()) * 2
  H = 16 + len(BODY) * row_h
  out = Image.new('RGBA', (W, H), (18, 18, 19, 255))  # #121213, the dark deck's inset panel
  draw = ImageDraw.Draw(out)
  for r, pose in enumerate(BODY):
    y = 8 + r * row_h
    draw.text((8, y), pose, fill=(138, 143, 152, 255))
    x = 100
    for cut in ('bust', 'body'):
      for s in scales:
        for i, f in enumerate(SPRITES[cut][pose]):
          out.alpha_composite(img(f, s), (x + i * (SIZE[cut] * s + gap), y + row_h - 16 - SIZE[cut] * s))
        x += col_w[s] if cut == 'body' else most * (16 * s + gap) + 16
  out.save(path)


def cast_sheet(hexes, cast, path, s=3):
  """The caveman and the cast side by side: every played pose and frame at
  3x, and idle at 1x and 2x (the sizes the app shows them), on the deck's
  panel. The derived gaze (look) is left out: it is nine stills of idle."""
  from PIL import Image, ImageDraw
  who = {'caveman': (PALETTE, BODY), **{c: (p, b) for c, (p, _, b) in cast.items()}}
  gap, frame_w = 6, 24 * s
  col_w = max(len(f) for p, f in BODY.items() if p != 'look') * (frame_w + gap) + 24
  row_h = frame_w + 18
  out = Image.new('RGBA', (90 + col_w * len(who), 24 + row_h * len(BODY)), (18, 18, 19, 255))
  draw = ImageDraw.Draw(out)
  for c, name in enumerate(who):
    draw.text((90 + c * col_w, 6), name, fill=(200, 200, 205, 255))
  rows = [p for p in BODY if p != 'look']
  for r, pose in enumerate([*rows, 'small']):
    y = 24 + r * row_h
    draw.text((8, y + frame_w // 2), pose, fill=(138, 143, 152, 255))
    for c, (palette, body) in enumerate(who.values()):
      x = 90 + c * col_w
      if pose == 'small':
        for i, k in enumerate((1, 2)):
          out.alpha_composite(to_image(body['idle'][0], k, palette, hexes), (x + i * 40, y + frame_w - 24 * k))
        continue
      for i, f in enumerate(body[pose]):
        out.alpha_composite(to_image(f, s, palette, hexes), (x + i * (frame_w + gap), y))
  out.save(path)


def main():
  args = sys.argv[1:]
  flag = lambda name: args[args.index(name) + 1] if name in args else None
  only = flag('--only')
  assert only is None or only in CAST, f'--only takes one of {CAST}'
  cast = load_cast((only,) if only else CAST)
  hexes = token_hex(dict.fromkeys([*PALETTE.values(), *(t for p, _, _ in cast.values() for t in p.values())]))
  budget = pose_budget()
  for cut, poses in SPRITES.items():
    check(f'caveman/{cut}', poses, SIZE[cut], PALETTE, budget)
  for cid, (palette, _, body) in cast.items():
    check(cid, body, 24, palette, budget)
  if '--client' in args:
    for t, d in paths([BUST['idle'][0]], 16):
      print(f'      px("{d}", "{hexes[t]}"),')
    return
  if not only:  # --only leaves the caveman's files alone, so lanes can draw side by side
    write_svg(BUST['idle'][0], hexes, os.path.join(ROOT, 'src/assets/caveman.svg'))
    write_ts(os.path.join(ROOT, 'src/mascot/sprites.ts'))
    write_kit(os.path.join(ROOT, '../shared/src/companionKit.ts'))
  os.makedirs(os.path.join(ROOT, 'src/mascot/cast'), exist_ok=True)
  for cid, (palette, lid, body) in cast.items():
    write_cast_ts(cid, palette, lid, body, os.path.join(ROOT, f'src/mascot/cast/{cid}.ts'))
  if flag('--sheet'):
    contact_sheet(hexes, flag('--sheet'))
  if flag('--cast-sheet'):
    cast_sheet(hexes, cast, flag('--cast-sheet'))


if __name__ == '__main__':
  main()
