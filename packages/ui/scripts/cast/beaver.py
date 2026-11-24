"""The beaver: a giant Ice Age beaver sat up, facing left. A big round head
(wood-hi lit, wood, hair-hi shade) with a small ear, a sand muzzle and dark
nose, and huge orange buck teeth (tunic, tunic-shade); a sand belly with
the green bead beside it, forepaws tucked under the chin, a flat hind foot
and a broad flat paddle of a tail on the floor, cross-hatched in slate.
Idle breathes, then lifts the paddle and slaps the floor; it works by
slapping the rock with the paddle, chews a birch stick to think and hops
for a slap and a grin when done. No skin letters, so a skin tone never
touches it."""
from pixelgrid import at, dots, fx, part, stack, star, z_big, z_small
from cast.caveman import B_ROCK

PALETTE = {'F': 'wood', 'f': 'wood-hi', 'v': 'hair-hi', 'c': 'sand', 'u': 'sand-shade',
           'Y': 'slate', 'y': 'slate-shade', 'C': 'slate-light', 'p': 'pink'}
LID = 'v'

HEAD = part(0, """
...........OOO
......OOOOOOfvO
....OOfffffFOvO
...OfffffFFFFFvO
..OffFFFFFFFFFvO
..OfFFeFFFFFFFvvO
.OcfFFeFFFFFFFvvO
OccccFFFFFFFFFvvO
OHcccccFFFFFFFvO
OcccccccFFFFFvvO
.OccccOvFFFvvvO
..OTTtOOvvvvOO
..OTTtO.OOOO
..OTTtO
..OTOtO
...O.O
""")

# The eye is two pixels tall at (6, 5) and (6, 6); the teeth hang from row 11.
FACE = {
  'closed': [(6, 5, 'F'), (5, 6, 'O'), (6, 6, 'O'), (7, 6, 'O')],
  'happy': [(6, 6, 'F'), (5, 6, 'O'), (6, 5, 'O'), (7, 6, 'O')],
  'up': [(6, 6, 'F'), (6, 4, 'O'), (6, 5, 'O')],
  'squint': [(6, 6, 'F'), (5, 5, 'O'), (7, 6, 'O')],
  'dazed': [(6, 6, 'F'), (6, 5, 'O'), (5, 4, 'O'), (7, 4, 'O'), (5, 6, 'O'), (7, 6, 'O')],
  'open': [(6, 11, 'p'), (7, 11, 'O'), (6, 12, 'p'), (7, 12, 'O'), (6, 13, 'O')],
}


def head(*faces):
  return dots(HEAD, [p for f in faces for p in FACE[f]])


BODY_SIT = part(9, """
........OOOOOO
......OOfFFFFFvO
.....OfFFFFFFFFvO
....OfccccFFFFFFvO
...OfcccccFFFFFFvvO
...OfccccccFFFFFFvO
..OfcccccccFGFFFFvvO
..OfcccccccFFFFFFvvO
..OfccccccuFFFFFFvvO
..OFccccccuFFFFFFvO
...OFccccuuFFFFFvvO
...OvFuuuuFFFFFvvO
....OOvvvvvvvvvOO
.....OOOOOOOOOOO
""")
PAWS = part(13, """
......OOO
.....OffFO
.....OfFvO
......OOO
""")
FOOT = part(21, """
..OOOOOOOO
.OffFFFFFvO
.OOOOOOOOOO
""")
TAIL = part(17, """
................OOOOOO
..............OOCyCyYyOO
.............OCyCyYyYyYO
.............OyyyyyyyyyO
.............OCyCyYyYyyO
..............OOyyyyyyOO
................OOOOOO
""")


# The far paw up by the cheek, waving; tilted out on the beat.
PAW_UP = part(3, """
...............OOOO
..............OffFvO
..............OfFFvO
..............OfFvvO
...............OFvO
...............OFvO
..............OfFvO
.............OfFvO
.............OOOO
""")
# The paddle lifted off the floor (wound up) and the dust when it lands.
TAIL_UP = part(12, """
.....................OOO
...................OOCyO
.................OOCyCyYO
...............OOyCyYyYyO
..............OyyyyyyyyO
..............OCyYyYyyOO
...............OOyyyOO
.................OOO
""")
DUST = fx(24, [(12, 22, '*'), (23, 16, '*'), (13, 20, '*')])
# A birch stick across the teeth, held in both paws, to nibble while it thinks.
STICK = part(13, """
OOOOOOOOOOOO
BkBBBkBBBkBO
OOOOOOOOOOOO
""")
# Up on the rock (working) and the sparks when it slaps down.
TAIL_HIT = at(TAIL, 0, -2)
SLAP = fx(24, [(17, 14, '*'), (21, 13, '*'), (23, 15, '*')])
CHEER = [fx(24, [(19, 2, '*'), (22, 6, '*'), (17, 0, '*')]), fx(24, [(20, 1, '*'), (23, 4, '*'), (16, 1, '*')])]


def beaver(h, head_dy=0, head_dx=0, tail=TAIL, paws=PAWS, bob=0, lift=0, far=None, fxs=(), over=(), rock=False):
  """Sat up: the foot stays down (lift raises it too, for a hop); the body
  sinks by bob; the head nods by head_dy, the paws with it."""
  up = lambda p: at(p, 0, bob + lift)
  return stack(24, up(BODY_SIT), at(FOOT, 0, lift), *([at(B_ROCK, 17)] if rock else []), at(tail, 0, lift),
               up(at(h, head_dx, head_dy)), up(at(paws, head_dx, head_dy)), *([up(far)] if far else []), *over, *fxs)


BODY = {
  'idle': [  # a breath, then the paddle comes up and slaps the floor
    beaver(head()),
    beaver(head()),
    beaver(head(), head_dy=1),
    beaver(head(), head_dy=1),
    beaver(head()),
    beaver(head(), tail=TAIL_UP),
    beaver(head(), bob=1),
    beaver(head()),
  ],
  'working': [  # the strike first: it is the still under reduced motion; the paddle slaps the rock
    beaver(head('squint'), bob=1, tail=TAIL_HIT, rock=True, fxs=[SLAP]),
    beaver(head('squint'), tail=at(TAIL_HIT, 0, -3), rock=True),
    beaver(head(), head_dy=-1, tail=TAIL_UP, rock=True),
    beaver(head('squint'), tail=at(TAIL_HIT, 0, -3), rock=True),
  ],
  'thinking': [  # eyes up, nibbling a stick
    beaver(head('up'), over=[STICK]),
    beaver(head('up'), head_dy=1, over=[at(STICK, -1, 1)]),
  ],
  'done': [  # crouch with the paddle up, the hop, the slap and a big orange grin
    beaver(head('happy'), bob=1, head_dy=1, tail=TAIL_UP),
    beaver(head('happy', 'open'), lift=-2, tail=TAIL_UP, far=PAW_UP, fxs=[CHEER[0]]),
    beaver(head('happy', 'open'), far=PAW_UP, fxs=[DUST, CHEER[1]]),
  ],
  'sleeping': [
    beaver(head('closed'), head_dy=2, fxs=[fx(24, z_small(16, 2))]),
    beaver(head('closed'), head_dy=3, bob=1, fxs=[fx(24, z_big(19, 0) + z_small(15, 3))]),
  ],
  'error': [
    beaver(head('dazed'), head_dy=1, fxs=[fx(24, star(2, 1) + star(15, 1))]),
    beaver(head('dazed'), head_dy=1, head_dx=1, fxs=[fx(24, star(1, 2) + star(16, 2))]),
  ],
  'wave': [
    beaver(head('happy', 'open'), far=PAW_UP),
    beaver(head('happy', 'open'), far=at(PAW_UP, 1, -1)),
    beaver(head('happy', 'open'), far=PAW_UP),
    beaver(head('happy', 'open'), far=at(PAW_UP, 1, -1)),
  ],
}
