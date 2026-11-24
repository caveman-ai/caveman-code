"""The dino: a small purple T-rex side on, facing left (wrong era, doesn't
care). A big head with a toothy smile and a cream jaw, a cream belly, the
green bead on its throat, a thick tail, stompy feet with bone claws and two
very short arms. No skin letters: a skin tone never touches it."""
from pixelgrid import at, dots, fx, layer, part, stack, star, z_big, z_small
from cast.caveman import B_ROCK

PALETTE = {'P': 'dino', 'p': 'dino-light', 'q': 'dino-shade'}
LID = 'q'

HEAD = part(1, """
......OOOO
....OOpppPOO
...OpppPPPPPO
..OpPPPPPPqPpO
.OpPPPPPPeqPPPO
OpOPPPPPPePPPPqO
OpPPPPPPPPPPPPqO
OqLOOOOLOOOPPqqO
.OOBBBBBBBOPqqO
..ObbBBBBBOqqqO
...OOOOOO
""")

# The eye is two pixels tall at (9, 5) and (9, 6); the mouth runs along row 8.
FACE = {
  'closed': [(9, 5, 'P'), (8, 6, 'O'), (9, 6, 'O'), (10, 6, 'O')],
  'happy': [(9, 6, 'P'), (8, 6, 'O'), (9, 5, 'O'), (10, 6, 'O')],
  'up': [(9, 6, 'P'), (9, 4, 'O'), (9, 5, 'O')],
  'squint': [(9, 5, 'P'), (9, 6, 'P'), (8, 5, 'O'), (9, 5, 'O'), (10, 6, 'O')],
  'dazed': [(9, 5, 'P'), (9, 6, 'P'), (8, 4, 'O'), (10, 4, 'O'), (9, 5, 'O'), (8, 6, 'O'), (10, 6, 'O')],
  # the jaw drops: a dark mouth, teeth on top, the cream jaw a row lower
  'roar': [*((x, 9, 'O') for x in range(2, 10)), (2, 8, 'L'), (7, 8, 'L'), (3, 9, 'L'),
           *((x, 10, 'B') for x in range(3, 10)), (3, 10, 'b'), (4, 10, 'b'), *((x, 11, 'O') for x in range(3, 10))],
  'grit': [(2, 8, 'O'), (7, 8, 'O'), (3, 8, 'L'), (4, 8, 'L'), (5, 8, 'L'), (6, 8, 'L')],
  'wavy': [(2, 8, 'O'), (7, 8, 'O'), (3, 8, 'B'), (5, 8, 'B'), (7, 9, 'O')],
}


def head(*faces):
  return dots(at(HEAD, 0, 0), [p for f in faces for p in FACE[f]]) if faces else HEAD


# Neck, belly and back. Its right side runs into the tail.
TORSO = part(11, """
.........bBBqOOOO
.......ObBBGPqpppO
........ObBBPPPqPpO
........OBBBPPPPPPO
........OBBBPPPPqPqO
........ObBBPPPPPPq
........ObBBPqPPPPP
.........ObbPPPPPqP
.........OObbPPPPPq
""")
ARM = part(13, """
......OOO
.....OpPO
......OOO
""")
# Held out to wave, the hand flapping up then down from the wrist: the whole
# arm still reaches about one snout-pixel.
ARM_HI = part(11, """
...O.O
...ObO
...OpOOO
....OpPPP
.....OOO
""")
ARM_LO = part(13, """
....OOOO
...ObpPPP
...ObOOO
....O
""")
# Up at the chin, nearly.
ARM_CHIN = part(11, """
....O.O
....ObO
....OpPO
.....OpPP
......OOO
""")

# The tail: resting, raised for the swing, down on the rock.
TAIL = part(16, """
...................OOOO
...................pppOO
..................PPPPqO
..................qqqqOO
.................OOOOO
""")
TAIL_UP = part(9, """
.....................OO
....................OpO
...................OpPO
...................OPqO
..................OpPqO
..................OPPqO
..................OPPqO
...................OPqO
..................PPPqO
..................qqOO
.................OOO
""")
TAIL_HIT = part(16, """
...................OO
...................ppOO
..................PPPPPOO
..................qqqqqqqO
.................OOOOOOOO
""")
NEAR_LEG = part(19, """
............OPPPPO
............OPPPPO
.............OPPPqO
.............ObPPPqO
.............OOOOOOO
""")
FAR_LEG = part(19, """
........OqqqO
........OqqO
........OqqqO
.......ObqqqqO
.......OOOOOOO
""")


def dino(h, arm=ARM, tail=TAIL, head_dy=0, near=(0, 0), far_=(0, 0), bob=0, fxs=()):
  up = lambda p: at(p, 0, bob)
  return stack(24, at(FAR_LEG, *far_), at(NEAR_LEG, *near), up(tail), up(TORSO), up(arm), up(at(h, 0, head_dy)), *fxs)


# Lying down (sleeping): the tail wraps round under the chin.
TAIL_CURL = part(18, """
..................OOO
..................PpOO
..................PPPpO
.........OOOOOOOOOqqqO
........OpPPPPPPPPqqO
.........OqqqqqqqqOO
""")
# Its belly on the floor, the bead slid round to the back of its neck.
LYING = dots(at(TORSO, 0, 3), [(11, 15, 'B'), (16, 15, 'G')])

ROCK = at(B_ROCK, 17)  # under the tail, in front of the heel
SPARKS = fx(24, [(16, 17, '*'), (23, 16, '*'), (17, 15, '*')])
ROAR = [fx(24, [(0, 10, '*'), (0, 12, '*')]), fx(24, [(0, 9, '*'), (0, 13, '*'), (1, 11, '*')])]


BODY = {
  'idle': [
    dino(head()),
    dino(head(), head_dy=1),
  ],
  'working': [  # the strike first: it is the still under reduced motion
    stack(24, (0, dino(head('squint', 'grit'), tail=TAIL_HIT)), ROCK, SPARKS),
    stack(24, (0, dino(head('squint'), tail=TAIL)), ROCK),
    stack(24, (0, dino(head(), tail=TAIL_UP)), ROCK),
    stack(24, (0, dino(head('squint'), tail=TAIL)), ROCK),
  ],
  'thinking': [
    dino(head('up'), arm=ARM_CHIN),
    dino(head('up'), arm=at(ARM_CHIN, 0, 1)),
  ],
  'done': [
    dino(head('happy', 'roar'), arm=ARM_HI, tail=TAIL_UP, fxs=[ROAR[0]]),
    stack(24, at((0, dino(head('happy', 'roar'), arm=ARM_HI, tail=TAIL_UP, near=(0, -1), far_=(0, -1))), 0, -2), ROAR[1]),
    dino(head('happy', 'roar'), arm=ARM_HI, tail=TAIL_UP),
  ],
  'sleeping': [
    stack(24, LYING, at(ARM, 0, 3), TAIL_CURL, at(head('closed'), 0, 10), fx(24, z_small(15, 6))),
    stack(24, LYING, at(ARM, 0, 3), TAIL_CURL, at(head('closed'), 0, 11), fx(24, z_big(18, 1) + z_small(14, 7))),
  ],
  'error': [
    dino(head('dazed', 'wavy'), fxs=[fx(24, star(4, 1) + star(14, 2))]),
    dino(head('dazed', 'wavy'), head_dy=1, fxs=[fx(24, star(2, 2) + star(15, 1))]),
  ],
  'wave': [
    dino(head('happy'), arm=ARM_HI),
    dino(head('happy'), arm=ARM_LO),
    dino(head('happy'), arm=ARM_HI),
    dino(head('happy'), arm=ARM_LO),
  ],
}
