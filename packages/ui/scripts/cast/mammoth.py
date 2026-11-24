"""The mammoth: a woolly calf side on, facing left. A high domed head with a
tuft tied up by the green bead, a small shaded ear, a long wrinkled trunk
that curls forward at the tip, a long bone tusk curving forward and up, a
shaggy body with a fringe of wool over stubby legs with bone toenails.
Rust wool: wood-hi on the lit top, ginger-hi, ginger in shade and hair-hi
deepest; no skin letters.

Idle breathes (the head, trunk and tusk dip a row) and fidgets once a loop:
the ear flaps and the trunk swings. It raises its trunk and brings it down
on the rock, crouches and springs to trumpet for done, lies down asleep with
its trunk curled on the floor and waves hello with its trunk."""
from pixelgrid import at, dots, fx, layer, part, stack, star, z_big, z_small
from cast.caveman import B_ROCK

PALETTE = {'f': 'wood-hi', 'F': 'ginger-hi', 'n': 'ginger', 'N': 'hair-hi'}
LID = 'F'

HEAD = part(1, """
......OOO
.....OfGfO
...OOOfFfOOO
..OfffffFFFFOO
.OffFFFFFFFFFnO
OffFFFFFFFFFFFnO
OfFFFeFFFFFFFFnO
OfFFFeFFFFFFFnnO
OFFFFFFFFFFFFnnO
OFFFFFFFFFFFnnnO
.OFFFFFFFFFFnnnO
..OFFFFFFFFFnnO
...OOFFFFFnnOO
.....OOOOOOO
""")
TRUNK = part(10, """
OfFFO
OfnFO
OfFFnO
.OfnnO
.OfFnO
.OfnnO
..OFnO
..OfnO
OO.OFnO
OfOOFFnO
.OfFFnO
..OOOO
""")
TUSK = part(12, """
O
OBO
OBO.....OO
OBBO...OBO
.OBBOOOBbO
..ObbBBbO
...OOOOO
""")
TORSO = part(4, """
..........OOOOOOO
........OOfffffffOO
.......OfffFfFFfFFOO
......OffFFFFFFFFFFFnO
......OfFFfFFFfFFFFFnnO
......OFFFFFFFFFFFFFnnO
......OFFFFFFFFFFFFnFnnO
......OFFFFFFFFFFFFFnnnO
......OFFFFFFFFFFFFnnnnO
......OFFFFFFFFFFFnFnnnO
......OFFFFFFFFFFFnnnnNO
......OFFFFFFFFFFnnnnnNO
......OFFFFFFFFFnnnnnNNO
......OFnFnFFnFnFnnnNNO
.......OnOnOnnOnOnONO
""")
LEGS = part(18, """
......OFFFnO.....OFFnnO
......OFFFnO.....OFFnnO
......OFFFnO.....OFFnnO
......OFFFnO.....OFFnnO
.....OBFBFnO....OBFBnnO
.....OOOOOOO....OOOOOOO
""")
FAR = part(18, """
...........ONNO.ONNO
...........ONNO.ONNO
...........ONNO.ONNO
...........ONNO.ONNO
..........ObNbNO.ObNbO
..........OOOOOO.OOOOO
""")


EAR = part(6, """
..........nn
.........nnnN
.........nnNN
..........NN
""")
# Flapped forward and up, for one beat of the idle.
EAR_FLAP = part(6, """
.........nnn
........nnnNN
.........nNN
""")
# The trunk swung out (idle), raised over the face (wave, the wind-up,
# the trumpet), struck down on the rock, and curled on the floor (asleep).
TRUNK_SWING = part(10, """
OfFFO
OfnFO
OfFFnO
.OfnnO
.OfFnO
.OfnnO
.OfFnO
OfnnO
OfFnO
OFnO
OOO
""")
TRUNK_UP = part(1, """
OOO
OfFO
OfFO
.OfFO
.OfFO
.OfnO
.OfFnO
.OfnnO
.OfFnO
OfFnnO
OfFFnO
.OOOO
""")
TRUNK_WAVE = part(1, """
.
OOOO
OffFO
.OOfO
..OfFO
.OfnO
.OfFnO
.OfnnO
.OfFnO
OfFnnO
OfFFnO
.OOOO
""")
TRUNK_HIT = part(10, """
OfFFO
OfnFO
OfFFnO
.OfnnO
.OfFnO
.OfnnO
.OfFnO
OfFFnO
OfffnO
OOOOOO
""")
TRUNK_REST = part(15, """
OfFFO
OfnFO
OfFFnO
OfnnnO
.OfFFnOOO
..OOfFFnO
....OOOO
""")

FACE = {
  'closed': [(5, 7, 'F'), (4, 8, 'O'), (5, 8, 'O'), (6, 8, 'O')],
  'happy': [(5, 8, 'F'), (4, 8, 'O'), (5, 7, 'O'), (6, 8, 'O')],
  'up': [(5, 8, 'F'), (5, 6, 'O')],
  'squint': [(5, 7, 'F'), (5, 8, 'F'), (4, 7, 'O'), (5, 7, 'O'), (6, 8, 'O')],
  'dazed': [(5, 7, 'F'), (5, 8, 'F'), (4, 6, 'O'), (6, 6, 'O'), (5, 7, 'O'), (4, 8, 'O'), (6, 8, 'O')],
}


def head(*faces, trunk=TRUNK, ear=EAR, dx=0, dy=0):
  """The head with its ear, trunk and tusk, moved together."""
  h = layer(dots(HEAD, [p for f in faces for p in FACE[f]]), ear, trunk, TUSK)
  return at(h, dx, dy)


def mam(h=None, dy=0, legs_dy=0, fxs=()):
  return stack(24, at(FAR, 0, legs_dy), at(LEGS, 0, legs_dy), at(TORSO, 0, dy), h or head(dy=dy), *fxs)


ROCK = B_ROCK
SPARKS = fx(24, [(7, 17, '*'), (8, 19, '*'), (0, 22, '*')])
TOOT = [fx(24, [(0, 0, '*'), (6, 0, '*')]), fx(24, [(1, 0, '*'), (7, 1, '*'), (5, 0, '*')])]

BODY = {
  'idle': [
    mam(), mam(), mam(head(dy=1)), mam(head(dy=1)),
    mam(), mam(head(ear=EAR_FLAP, trunk=TRUNK_SWING)), mam(head(trunk=TRUNK_SWING)), mam(),
  ],
  'working': [  # the strike first: it is the still under reduced motion
    stack(24, ROCK, (0, mam(head('squint', trunk=TRUNK_HIT, dy=1))), SPARKS),
    stack(24, ROCK, (0, mam(head('squint')))),
    stack(24, ROCK, (0, mam(head(trunk=TRUNK_UP, ear=EAR_FLAP)))),
    stack(24, ROCK, (0, mam(head('squint', trunk=TRUNK_SWING)))),
  ],
  'thinking': [
    mam(head('up', trunk=TRUNK_SWING)),
    mam(head('up', dy=1)),
  ],
  'done': [  # squash, spring, trumpet
    mam(head('squint', dy=1), dy=1),
    mam(head('happy', trunk=TRUNK_UP, ear=EAR_FLAP, dy=-1), dy=-1, legs_dy=-1, fxs=[TOOT[0]]),
    mam(head('happy', trunk=TRUNK_UP, ear=EAR_FLAP), fxs=[TOOT[1]]),
  ],
  'sleeping': [
    stack(24, at(TORSO, 0, 4), head('closed', trunk=TRUNK_REST, dy=5), fx(24, z_small(18, 3))),
    stack(24, at(TORSO, 0, 4), at(TORSO, 0, 3), head('closed', trunk=TRUNK_REST, dy=5), fx(24, z_big(19, 0) + z_small(16, 4))),
  ],
  'error': [
    mam(head('dazed', trunk=TRUNK_SWING), fxs=[fx(24, star(2, 2) + star(14, 1))]),
    mam(head('dazed', dx=1), fxs=[fx(24, star(1, 4) + star(16, 2))]),
  ],
  'wave': [
    mam(head('happy', trunk=TRUNK_SWING)),
    mam(head('happy', trunk=TRUNK_UP, ear=EAR_FLAP)),
    mam(head('happy', trunk=TRUNK_WAVE, ear=EAR_FLAP)),
    mam(head('happy', trunk=TRUNK_UP, ear=EAR_FLAP)),
  ],
}
