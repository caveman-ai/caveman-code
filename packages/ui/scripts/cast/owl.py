"""The owl: a chibi cave owl front on, mostly head. Long ear tufts, a cream
facial disc in two lobes round big orange eyes (the pupils a 2x2 in a 4x4
iris, so the gaze moves them inside it), a small hooked beak, a sand belly
barred in sand-shade with the green bead on it, scalloped brown wings at its
sides and orange feet. Fur-hi, fur and hair-hi make the brown ramp, lit from
the top left. Its wings are its arms: one is the club, both fling up when it's
done. Idle is a breath (the wings settle a beat after the head), then the head
cocks to one side and it blinks slowly. No skin letters: a skin tone never
touches it."""
from pixelgrid import at, dots, flip, fx, part, stack, star, z_big, z_small
from cast.caveman import B_ROCK

# h (hair-hi) is the brown's shade; T and t (tunic) the iris, beak and feet.
PALETTE = {'F': 'fur', 'f': 'fur-hi', 'A': 'sand', 'a': 'sand-shade'}
# The pupils blink to plumage: a feathered lid drops over the iris.
LID = 'F'

HEAD = part(0, """
..OO................OO..
..OfOO............OOFO..
..OffFO..........OFFhO..
..OfffFOOOOOOOOOOFFFhO..
.OffFFfffFFFFFFFFFFFhhO.
.OfFFBBBBBFFFFBBBBBFFhO.
.OfFBBOOOOBFFBOOOOBAFhO.
.OFBBOTTTTOBBOTTTTOBAhO.
.OFBBOTeeTOBBOTeeTOBAhO.
.OFBBOTeeTOBBOTeeTOBAhO.
.OFBBOTTTTOTtOTTTTOAAhO.
.OFFBBOOOOATtBOOOOAAFhO.
..OFFBBBBAAtABBBAAFFhO..
""")
IRIS = ((6, 7), (14, 7))  # each eye's 4x4 iris, top-left corner


def eyes(*rows):
  return [(x0 + i, y0 + j, ch) for x0, y0 in IRIS for j, r in enumerate(rows) for i, ch in enumerate(r) if ch != '.']


def shut(*marks):
  """Ring and iris to disc, then each eye's marks (dx, dy from the iris corner)."""
  ring = [(x0 + i, y0 + j, 'B') for x0, y0 in IRIS for i in range(-1, 5) for j in range(-1, 5)]
  return ring + [(x0 + dx, y0 + dy, 'O') for x0, y0 in IRIS for dx, dy in marks]


FACE = {
  'closed': shut((-1, 1), (0, 2), (1, 2), (2, 2), (3, 2), (4, 1)),
  'happy': shut((-1, 2), (0, 1), (1, 1), (2, 1), (3, 1), (4, 2)),
  'half': eyes('FFFF', 'OeeO'),
  'up': eyes('eeTT', 'eeTT', 'TTTT', 'TTTT'),
  'upr': eyes('TTee', 'TTee', 'TTTT', 'TTTT'),
  'squint': eyes('FFFF', 'OOOO', 'TeeT', 'TTTT'),
  'dazed': eyes('OTTO', 'TOOT', 'TOOT', 'OTTO'),
  'hoot': [(11, 11, 'O'), (12, 11, 'O'), (11, 12, 'T'), (12, 12, 't')],
}


def head(*faces):
  return dots(HEAD, [p for f in faces for p in FACE[f]])


def tilt(h, side=1):
  """The head cocked: one half a row lower than the other."""
  y, rows = h
  w = max(len(r) for r in rows)
  rows = [r.ljust(w, '.') for r in rows]
  keep = (lambda x: x < 12) if side > 0 else (lambda x: x >= 12)
  out = [['.'] * w for _ in range(len(rows) + 1)]
  for j, r in enumerate(rows):
    for x, ch in enumerate(r):
      if ch != '.':
        out[j + (0 if keep(x) else 1)][x] = ch
  return (y, [''.join(r) for r in out])


TORSO = part(13, """
...OFFAAAAAAAAAAAAFhO...
...OFAAAAAAAAAAAAAAhO...
...OFAAaAAaGAaAAaAAhO...
...OFAAAaAAaAAaAAaAhO...
...OFAAAAAAAAAAAAAahO...
...OFAAaAAaAAaAAaAahO...
....OFAAaAAaAAaAAahO....
.....OhhaaaaaaaaahO.....
""")

WING = part(12, """
..OOO...
.OfffO..
.OffFFO.
OfFFFhO.
OfFhFFO.
OFFFhFO.
OfhFFhO.
OFFhFFO.
.OhOhO..
..O.O...
""")

FEET = part(21, """
......OTTO....OTTO......
.....OTtTtO..OtTtTO.....
.....OOOOOO..OOOOOO.....
""")


def mirror(p):
  y, rows = p
  return flip((y, [r.ljust(24, '.') for r in rows]))


def shaded(p):
  y, rows = p
  return (y, [r.replace('f', 'F') for r in rows])


def right(w):
  return shaded(mirror(w))


WING_R = right(WING)


def owl(h=None, wl=WING, wr=WING_R, head_dy=0, wing_dy=0, dx=0, dy=0, over=(), fxs=()):
  """Wings in wl/wr sit under the head; raised ones go in over, on top of it."""
  h = HEAD if h is None else h
  parts = (FEET, TORSO, *(at(w, 0, wing_dy) for w in (wl, wr) if w), at(h, 0, head_dy), *over)
  return stack(24, *(at(p, dx, dy) for p in parts), *fxs)



# Working: one pixel right of the rock; the left wing is the club.
W_HIT = part(12, """
.....OOO
....OfffO
...OffFFO
..OffFFhO
.OfFFFhO.
OfFFFhO..
OFFhhO...
OhOhO....
""")
W_LEVEL = part(13, """
..OOOOOO
.OffffFO
OfFFFFhO
OhFhFhO.
.O.O.O..
""")
W_HIGH = part(0, """
.O......
OfO.....
OfO.....
OffO....
OfFO....
OfFhO...
OFFhO...
OfFhO...
.OFhO...
.OFFhO..
.OFhFO..
..OFFhO.
..OFhFO.
...OOO..
""")
SPARKS = fx(24, [(0, 18, '*'), (6, 18, '*'), (2, 16, '*'), (0, 15, '*')])
FADE = fx(24, [(0, 17, '*'), (6, 19, '*')])


def strike(h, wing, head_dy=0, fxs=()):
  return stack(24, B_ROCK, (0, owl(h, wl=None, head_dy=head_dy, dx=1, over=[wing])), *fxs)


# Thinking: the right wing across the chest, its tip under the beak.
W_CHIN = part(12, """
............OOO.....
...........OfffOO...
............OFFFFOO.
.............OOFFhhO
..............OFFhFO
..............OFhFhO
..............OFFhFO
...............OhOhO
................O.O.
""")

# Done: flung out and up from the shoulder, the primaries fanned.
W_OUT = part(8, """
O.O.....
OfOfO...
OffFO...
OfFFhO..
.OfFhO..
.OFFhhO.
..OFhFO.
...OOO..
""")
# Straight up beside the head (the jump).
W_UP = part(3, """
.O......
OfO.....
OfO.....
OffO....
OfFO....
OfFhO...
OFFhO...
OfFhO...
.OFhO...
.OFFhO..
..OFhO..
...OO...
""")
CHEER = [fx(24, [(0, 4, '*'), (23, 4, '*'), (2, 1, '*'), (21, 1, '*')]),
         fx(24, [(1, 6, '*'), (22, 6, '*')])]

# Waving: the right wing raised beside the head, the tip flapping.
W_WAVE = part(5, """
....................O.O.
...................OfOfO
...................OFfFO
...................OFFhO
...................OFFhO
...................OFhFO
..................OFFhO.
.................OFFhO..
................OFFhO...
...............OOOOO....
""")
W_SIDE = part(11, """
..................OOO...
.................OFFFOOO
................OFFFFhhO
...............OFFFhOhO.
................OOOO.O..
""")

# Asleep: fluffed round, the wings drawn in over the belly.
FLUFF = part(12, """
..OOFFFFFFFFFFFFFFFFOO..
.OfFFAAAAAAAAAAAAAAFhhO.
.OfFAAAAAAAAAAAAAAAAFhO.
.OfFAAaAAaAAaAAaAAaAFhO.
.OfFAAAaAAaAAaAAaAAAFhO.
.OfFAAAAAAAGAAAAAAAAFhO.
.OfFAAaAAaAAaAAaAAaAFhO.
..OFFAAaAAaAAaAAaAaFhO..
...OhhaaaaaaaaaaaaahhO..
....OOOOOOOOOOOOOOOOOO..
""")
W_WRAP = part(12, """
.OOO....
OfffOO..
OffFFFO.
OfFFFhO.
OFFhFFO.
OFhFFhO.
OFFhFhO.
.OhFhO..
..OOO...
""")

def tucked(dy):
  """The head sunk into the fluff, the tufts laid flat, eyes shut."""
  flat = [(x, y, '.') for x in range(24) for y in range(3)] + [(x, 3, 'O') for x in range(3, 21)] + [(2, 3, '.'), (21, 3, '.')]
  return at(dots(head('closed'), flat), 0, dy)


BASE = owl()
TILT = owl(tilt(HEAD))
BODY = {
  'idle': [  # a breath, then the head cocks and it blinks slowly
    BASE, BASE, owl(head_dy=1), owl(head_dy=1, wing_dy=1),
    BASE, TILT, owl(tilt(head('half'))), TILT,
  ],
  'working': [  # the strike first: it is the still under reduced motion
    strike(head('squint'), W_HIT, head_dy=1, fxs=[SPARKS]),
    strike(head('squint'), W_LEVEL, fxs=[FADE]),
    strike(head(), W_HIGH, head_dy=-1),
    strike(head('squint'), W_LEVEL),
  ],
  'thinking': [
    owl(tilt(head('up')), wr=None, over=[W_CHIN]),
    owl(tilt(head('upr')), wr=None, over=[at(W_CHIN, 1, 1)]),
  ],
  'done': [  # a crouch, a hop with the wings up, then wings out
    owl(head('happy'), wl=at(WING, -1), wr=at(right(WING), 1), head_dy=2, wing_dy=1),
    owl(head('happy', 'hoot'), wl=None, wr=None, over=[W_UP, right(W_UP)], dy=-2, fxs=[CHEER[0]]),
    owl(head('happy', 'hoot'), wl=None, wr=None, over=[W_OUT, right(W_OUT)], fxs=[CHEER[1]]),
  ],
  'sleeping': [
    stack(24, FEET, FLUFF, tucked(3), W_WRAP, right(W_WRAP), fx(24, z_small(19, 1))),
    stack(24, FEET, FLUFF, tucked(4), at(W_WRAP, 0, 1), at(right(W_WRAP), 0, 1), fx(24, z_big(18, 0) + z_small(21, 4))),
  ],
  'error': [
    owl(tilt(head('dazed')), wing_dy=1, fxs=[fx(24, star(2, 1) + star(21, 3))]),
    owl(tilt(head('dazed'), -1), wing_dy=1, fxs=[fx(24, star(1, 3) + star(22, 1))]),
  ],
  'wave': [
    owl(head(), wr=None, over=[W_SIDE]),
    owl(tilt(head('happy'), -1), wr=None, over=[W_WAVE]),
    owl(tilt(head('happy'), -1), wr=None, over=[W_SIDE]),
    owl(tilt(head('happy'), -1), wr=None, over=[W_WAVE]),
  ],
}
