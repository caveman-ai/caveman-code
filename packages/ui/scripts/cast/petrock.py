"""The pet rock: the most caveman pet there is. A round grey stone, flat on
the bottom, two tall eyes, pink cheeks and a small mouth turned to our left,
and a moss sprout on top whose bud is the green bead. No limbs: it hops,
wobbles and squashes. Rock ramp (rock-light lit edge, rock, rock-mid shade,
rock-dark underside), the moss in teal, the cheeks pink; no skin letters, so a
skin tone never touches it."""
from pixelgrid import at, dots, fx, part, stack, star, z_big, z_small
from cast.caveman import B_ROCK

PALETTE = {'Y': 'teal', 'y': 'teal-light', 'u': 'teal-shade', 'c': 'pink'}
LID = 'm'

# The stone, drawn from the left edge; `pet()` sets it down where it goes.
STONE = part(11, """
......OOOOOO
....OOllluYlOO
...OllRRRRRRRmO
..OlRRRRRRRRRRmO
..OlRRRRRRRRRRRmO
.OlRRRRRRRRRRRRmO
.OlRRRRRRRRRRRRRmO
.ORRRRRRRRRRRRRRmO
.ORRRRRRRRRRRRRmmO
.OmRRRRRRRRRRRmRmO
..OmRRRRRRRRRRRmkO
...OkmmmmmmmmmmkO
....OOOOOOOOOOOOO
""")

# Eyes two pixels tall at (5, 16-17) and (9, 16-17); mouth at (7, 19); cheeks on row 18.
EYES = [(5, 16, 'e'), (5, 17, 'e'), (9, 16, 'e'), (9, 17, 'e')]
FACE = {
  'calm': [(7, 19, 'O'), (3, 18, 'c'), (11, 18, 'c')],
  'smile': [(6, 19, 'O'), (7, 20, 'O'), (8, 19, 'O'), (3, 18, 'c'), (11, 18, 'c')],
  'open': [(6, 19, 'O'), (7, 19, 'O'), (8, 19, 'O'), (7, 20, 'c'), (3, 18, 'c'), (11, 18, 'c')],
  'shut': [(5, 16, 'R'), (9, 16, 'R'), (4, 17, 'O'), (10, 17, 'O'), (8, 17, 'O'), (6, 17, 'O')],
  'happy': [(5, 16, 'O'), (5, 17, 'R'), (4, 17, 'O'), (6, 17, 'O'), (9, 16, 'O'), (9, 17, 'R'), (8, 17, 'O'), (10, 17, 'O')],
  'up': [(5, 15, 'O'), (5, 17, 'R'), (9, 15, 'O'), (9, 17, 'R')],
  'focus': [(5, 16, 'R'), (9, 16, 'R'), (4, 16, 'O'), (10, 16, 'O')],
  'squeeze': [(5, 17, 'R'), (9, 17, 'R'), (4, 15, 'O'), (5, 16, 'O'), (4, 17, 'O'), (10, 15, 'O'), (9, 16, 'O'), (10, 17, 'O')],
  'dazed': [(5, 17, 'R'), (5, 15, 'O'), (9, 16, 'R'), (9, 18, 'O')],
  'wavy': [(6, 20, 'O'), (7, 19, 'O'), (8, 20, 'O')],
  'crack': [(12, 11, 'k'), (12, 12, 'k'), (13, 13, 'k'), (13, 14, 'k'), (12, 15, 'k'), (13, 16, 'k'), (13, 17, 'k')],
}


def face(*faces):
  return dots(STONE, EYES + [p for f in faces for p in FACE[f]])


# The moss sprout on top: two leaves round the bud on its stem.
SPROUT = part(6, """
......OO.O.OO
.....OyYOGOYyO
.....OYYYuYYYO
......OOOuOOO
.........u
""")
# Folded shut round the bud for the night.
SPROUT_SHUT = part(6, """
........O.O
.......OYOYO
.......OyGYO
........OuO
.........u
""")


def lean(layer, d, base=2):
  """Everything but its bottom `base` rows pushed d pixels sideways: it rocks on its flat bottom."""
  y0, rows = layer
  shift = lambda r: ('.' * d + r)[:24] if d >= 0 else (r[-d:] + '.' * -d)
  return (y0, [shift(r) if i < len(rows) - base else r for i, r in enumerate(rows)])


def squash(layer, rows):
  """Rows (canvas y) taken out, the top sinking onto what is left: flatter."""
  y0, grid = layer
  keep = [r for i, r in enumerate(grid) if y0 + i not in rows]
  return (y0 + len(grid) - len(keep), keep)


def stretch(layer, row):
  """One row (canvas y) doubled, the top rising: taller."""
  y0, grid = layer
  i = row - y0
  return (y0 - 1, grid[:i + 1] + grid[i:])


def narrow(layer, col):
  """One column taken out: squeezed from the side."""
  y0, grid = layer
  return (y0, [r[:col] + r[col + 1:] for r in grid])


def pet(stone, dx=3, dy=0, sprout=SPROUT, tilt=0, wag=0, sx=0, fxs=()):
  """The stone (a faced layer) and its sprout set down dx right and dy down; a
  squashed or stretched stone carries the sprout on its top. tilt leans the top
  of the stone, wag the leaves on top of that; sx moves the sprout along a narrowed top."""
  y0, rows = at(stone, dx, dy)
  s = at(sprout, dx + sx, dy + y0 - dy - STONE[0])
  if tilt:
    y0, rows = lean((y0, rows), tilt)
    s = at(s, tilt)
  if wag:
    s = lean(s, wag, base=3)
  return stack(24, (y0, rows), s, *fxs)


SPARKS = fx(24, [(6, 18, '*'), (5, 16, '*'), (2, 15, '*'), (7, 14, '*'), (0, 18, '*')])
SPARKLE = fx(24, [(20, 4, '*'), (19, 5, '*'), (20, 5, '*'), (21, 5, '*'), (20, 6, '*'), (3, 9, '*')])
SPARKLE_2 = fx(24, [(21, 7, '*'), (20, 8, '*'), (21, 8, '*'), (22, 8, '*'), (21, 9, '*'), (2, 11, '*')])

# Squeezed against the rock: two columns narrower and a row taller, eyes screwed shut.
STRIKE = stretch(narrow(narrow(face('squeeze', 'open'), 12), 7), 14)


BODY = {
  'idle': [  # it breathes: the top sinks a pixel
    pet(face('calm')),
    pet(squash(face('calm'), {14})),
  ],
  'working': [  # the strike first: it is the still under reduced motion. It rams the rock.
    pet(STRIKE, dx=6, sx=-1, fxs=[B_ROCK, SPARKS]),
    pet(face('focus', 'calm'), dx=6, tilt=1, fxs=[B_ROCK]),
    pet(squash(face('focus', 'calm'), {14}), dx=6, tilt=1, fxs=[B_ROCK]),
    pet(face('focus', 'calm'), dx=6, dy=-1, tilt=-1, wag=1, fxs=[B_ROCK]),
  ],
  'thinking': [  # head on one side, eyes up
    pet(face('up', 'calm'), tilt=1),
    pet(face('up', 'calm'), tilt=1, wag=1),
  ],
  'done': [  # down, up with a sparkle, and landed proud
    pet(squash(face('happy', 'open'), {14, 20})),
    pet(stretch(face('happy', 'open'), 20), dy=-3, wag=-1, fxs=[SPARKLE]),
    pet(face('happy', 'smile'), fxs=[SPARKLE_2]),
  ],
  'sleeping': [  # settled flat, the sprout folded shut; it snores
    pet(squash(face('shut'), {14}), sprout=SPROUT_SHUT, fxs=[fx(24, z_small(17, 4))]),
    pet(squash(face('shut', 'calm'), {14, 20}), sprout=SPROUT_SHUT, fxs=[fx(24, z_big(20, 0) + z_small(16, 5))]),
  ],
  'error': [  # cracked and seeing stars
    pet(face('dazed', 'wavy', 'crack'), fxs=[fx(24, star(2, 8) + star(20, 5))]),
    pet(face('dazed', 'wavy', 'crack'), tilt=1, fxs=[fx(24, star(1, 6) + star(21, 7))]),
  ],
  'wave': [  # it rocks side to side and the sprout waves
    pet(face('happy', 'smile'), wag=-1),
    pet(face('happy', 'smile'), tilt=-1, wag=-1),
    pet(face('happy', 'smile'), tilt=1, wag=1),
    pet(face('happy', 'smile'), wag=-1),
  ],
}
