"""The bat: a chibi cave bat front on, all ears. A round slate head with a
slate-light face, tall ears with pink insides, bean eyes, a pink nose and a
little smile between two bone fangs; a small furry body with the green bead on
its chest and tiny dangling feet. Its wings are purple membrane (dino lit,
dino-shade in shade) stretched on slate finger struts from a high wrist to a
scalloped edge, spread behind it like an M. The ramp is lit from the top left
(the right wing in shade). It hovers: idle is a bob with the wings a beat
behind, then an ear flicks twice. Thinking and asleep it wraps itself in its
wings like a cloak; asleep it hangs upside down from the cave roof. No skin
letters: a skin tone never touches it."""
from pixelgrid import at, dots, flip, fx, layer, part, stack, star, z_big, z_small
from cast.caveman import B_ROCK

PALETTE = {'Y': 'slate', 'y': 'slate-shade', 'X': 'slate-light', 'P': 'pink', 'U': 'dino-shade', 'u': 'dino'}
# An eye is an 'e' over an 'O': the blink turns the 'e' to face and leaves
# the lower pixel as the shut lid.
LID = 'X'

HEAD = part(-1, """
.....O............O.....
.....OO..........OO.....
.....OXO........OYO.....
.....OXPO......OPyO.....
.....OXPPO....OPPyO.....
.....OXPPYOOOOYPPyO.....
.....OXPPYYYYYYPPyO.....
.....OXXYYYYYYYYyyO.....
.....OXYXXXYYXXXYyO.....
.....OYXXXXXXXXXXyO.....
.....OYXeXXXXXXeXyO.....
.....OYXOXXXXXXOXyO.....
.....OYXXXXPPXXXXyO.....
.....OYYXXOXXOXXyyO.....
......OYYXBOOBXyyO......
.......OOyYYYYyOO.......
""")

TORSO = part(14, """
........OYXXXXXyO.......
........OYXXXXXyO.......
.........OYGXXyO........
.........OyyyyyO........
.........OyO.OyO........
.........O.O.O.O........
""")

WING = part(3, """
OO........
OXO.......
OyXO......
OuyXO.....
OuUyXO....
OuUuyXO...
OuyUuyYO..
OuyUuuyYO.
OuyUuuuyYO
OuUyUuuuyO
OuUyUUuuyO
OuUUyUUuyO
OuUUyUUuyO
.OUUyUUUyO
.OUUOyUUyO
..OO.OyUO.
......OO..
""")


# Expressions, as pixels on HEAD: each eye an 'e' over an 'O' at (8, 9) and
# (15, 9); the smile at rows 12-13 between the fangs.
EYE_X = (8, 15)


def both(*pts):
  return [(x + dx, y, ch) for x in EYE_X for dx, y, ch in pts]


FACE = {
  'closed': both((0, 9, 'X'), (-1, 10, 'O'), (1, 10, 'O')),
  'happy': both((0, 9, 'O'), (-1, 10, 'O'), (0, 10, 'X'), (1, 10, 'O')),
  'up': both((0, 8, 'e'), (0, 9, 'O'), (0, 10, 'X')),
  'upr': both((0, 9, 'X'), (0, 10, 'X'), (1, 8, 'e'), (1, 9, 'O')),
  'squint': both((-1, 9, 'O'), (0, 9, 'O'), (1, 9, 'O'), (0, 10, 'X')),
  'dazed': both((-1, 8, 'O'), (1, 8, 'O'), (0, 9, 'O'), (-1, 10, 'O'), (1, 10, 'O'), (0, 10, 'X')),
  'open': [(11, 12, 'O'), (12, 12, 'O'), (11, 13, 'P'), (12, 13, 'P')],
  'grit': [(11, 12, 'O'), (12, 12, 'O'), (11, 13, 'B'), (12, 13, 'B')],
  'wavy': [(10, 12, 'X'), (13, 12, 'X'), (11, 12, 'O'), (11, 13, 'X'), (12, 13, 'O')],
}


def head(*faces):
  return dots(HEAD, [p for f in faces for p in FACE[f]])


# An ear flick: the right ear's tip folds out and down.
FLICK = [(17, 0, '.'), (18, 0, '.'), (16, 1, '.'), (17, 1, '.'), (18, 1, 'O'), (19, 1, 'O'), (20, 1, 'O'),
         (16, 2, 'O'), (17, 2, 'O'), (18, 2, 'Y'), (19, 2, 'y'), (20, 2, 'O'),
         (17, 3, 'P'), (18, 3, 'y'), (19, 3, 'O')]


def tilt(h, side=1):
  """The head cocked: one half a row lower than the other."""
  y, rows = h
  w = max(len(r) for r in rows)
  rows = [r.ljust(w, '.') for r in rows]
  out = [['.'] * w for _ in range(len(rows) + 1)]
  for j, r in enumerate(rows):
    for x, ch in enumerate(r):
      if ch != '.':
        out[j + int((x >= 12) == (side > 0))][x] = ch
  return (y, [''.join(r) for r in out])


def mirror(p):
  y, rows = p
  return flip((y, [r.ljust(24, '.') for r in rows]))


def shaded(p):
  y, rows = p
  return (y, [r.replace('u', 'U').replace('X', 'Y') for r in rows])


def right(w):
  return shaded(mirror(w))


W_UP = part(0, """
.OO......
OXYO.....
OyXYO....
OuyXO....
OuuyXO...
OuUuyXO..
.OuUuyYO.
.OuUUuyO.
..OuUUyO.
..OOuUyO.
....OOUO.
......O..
""")
W_DOWN = part(8, """
..........
.OO.......
OXYO......
OyXYO.....
OuyXYO....
OuUyXYO...
OuUuyyYO..
OuyUuuyYO.
OuyUuuuyO.
OuUyUuuyO.
.OUyOUuyO.
.OUO.OUyO.
..O...OO..
""")
W_HIT = part(11, """
......OO.
.....OXYO
....OXyuO
...OXyuuO
..OXyuUuO
.OXyuUUO.
OXyuUUyO.
OyuUUyO..
OOOOOO...
""")
W_LEVEL = part(9, """
O........
OXOOOOO..
OyXXXXYOO
OuyyyyyyO
OuUuUuUO.
.OUOUOUO.
..O.O.O..
""")
W_DROOP = part(9, """
.....OO...
....OXYO..
...OXyuO..
...OyuUO..
..OXyuUO..
..OyuUUO..
..OyuUyO..
..OuUUyO..
...OUOyO..
...O..O...
""")
# The cloak: both wings wrapped round the body (thinking, asleep).
WRAP_L = part(12, """
.....OOO....
....OXuUO...
....OuuUUO..
....OuUyUUO.
....OuUyUUUy
....OuUyUUUy
....OuUyUUUy
.....OUyUUUy
......OOUUUy
........OOOO
.........O.O
""")
WRAP = dots(layer(WRAP_L, right(WRAP_L)), [(11, 17, 'G')])

WING_R = right(WING)


def bat(h=None, wl=WING, wr=WING_R, dx=0, dy=0, wing_dy=0, fxs=()):
  """Hovering: dy bobs the body, wing_dy the wings on top of that."""
  h = HEAD if h is None else h
  parts = (*(at(w, 0, wing_dy) for w in (wl, wr) if w), TORSO, h)
  return stack(24, *(at(p, dx, dy + 1) for p in parts), *fxs)


SPARKS = fx(24, [(0, 18, '*'), (6, 18, '*'), (1, 16, '*'), (7, 16, '*')])
FADE = fx(24, [(0, 17, '*'), (7, 18, '*')])
CHEER = [fx(24, [(0, 1, '*'), (23, 1, '*'), (2, 21, '*'), (21, 21, '*')]),
         fx(24, [(1, 3, '*'), (22, 3, '*')])]


def strike(h, wing, dy=0, fxs=()):
  return stack(24, B_ROCK, (0, bat(h, wl=wing, dx=2, dy=dy)), *fxs)


def vflip(grid):
  return (0, grid[::-1])


LEDGE = part(0, """
..OkmRmmkmRRmkmmRmkmRO..
""")


def hanging(dy, zs):
  b = vflip(stack(24, WRAP, at(head('closed'), 0, 1)))
  return stack(24, at(b, 0, dy), LEDGE, fx(24, zs))


BODY = {
  'idle': [  # hovering: a bob (the wings a beat behind), then the right ear flicks twice
    bat(), bat(), bat(dy=1, wing_dy=-1), bat(dy=1),
    bat(), bat(dots(HEAD, FLICK)), bat(), bat(dots(HEAD, FLICK)),
  ],
  'working': [  # the strike first: it is the still under reduced motion
    strike(head('squint', 'grit'), W_HIT, dy=1, fxs=[SPARKS]),
    strike(head('squint', 'grit'), W_LEVEL, fxs=[FADE]),
    strike(head(), W_UP, dy=-1),
    strike(head('squint'), W_LEVEL),
  ],
  'thinking': [  # wrapped in its cloak, eyes up, the head cocked
    stack(24, at(WRAP, 0, 1), at(tilt(head('up')), 0, 1)),
    stack(24, at(WRAP, 0, 1), at(tilt(head('upr')), 0, 1)),
  ],
  'done': [  # wings down to gather, a big flap up, then spread wide
    bat(head('happy'), wl=W_DOWN, wr=right(W_DOWN), dy=1),
    bat(head('happy', 'open'), wl=W_UP, wr=right(W_UP), dy=-2, fxs=[CHEER[0]]),
    bat(head('happy', 'open'), fxs=[CHEER[1]]),
  ],
  'sleeping': [  # hung upside down from the roof, snoring
    hanging(0, z_small(19, 14)),
    hanging(1, z_big(18, 9) + z_small(21, 15)),
  ],
  'error': [
    bat(tilt(head('dazed', 'wavy')), wl=W_DROOP, wr=right(W_DROOP), dy=1, fxs=[fx(24, star(2, 2) + star(21, 4))]),
    bat(tilt(head('dazed', 'wavy'), -1), wl=W_DROOP, wr=right(W_DROOP), dy=2, fxs=[fx(24, star(1, 4) + star(22, 2))]),
  ],
  'wave': [
    bat(head(), wr=at(right(W_UP), 0, 3)),
    bat(head('happy'), wr=right(W_UP)),
    bat(head('happy'), wr=at(right(W_UP), -1, 1)),
    bat(head('happy'), wr=right(W_UP)),
  ],
}
