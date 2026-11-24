"""The ground sloth: a giant, shaggy and in no hurry, sat facing out. A big
round head with a tufted crown (a fleck of teal moss in it), a bone face,
fur-coloured masks drooping from the eyes, a button nose and a slow wide
smile; a sand coat lit from the top left (sand, sand-shade, fur, hair-hi);
long arms hanging at its sides ending in three long bone claws each, the
green bead on a cord round the near wrist, and stubby feet. Idle breathes,
then gives a big slow yawn; it rakes the rock with its claws, holds a claw
to its chin to think and throws both arms up when done. No skin letters,
so a skin tone never touches it."""
from pixelgrid import at, dots, fx, part, stack, star, z_big, z_small
from cast.caveman import B_ROCK

PALETTE = {'f': 'sand', 'F': 'sand-shade', 'v': 'fur', 'c': 'bone', 'M': 'fur', 'g': 'teal', 'p': 'pink', 'u': 'hair-hi'}
LID = 'M'

HEAD = part(0, """
........O.O.O.O
.......OfOfOgOfO
......OfffffffFFO
.....OffccccccFFvO
....OffccccccccFvvO
....OfcMecccceMcFvO
...OfFMMccccccMMFvvO
...OfFcMccOOccMcFFvO
....OFcccccccccFFvO
....OFFccOccccOcFvO
.....OFFccOOOOcFvO
......OvFFccccFvvO
.......OOvvvvvvOO
.........OOOOOO
""")

# The eyes are single pixels at (8, 5) and (13, 5), each at the inner end of
# a drooping mask; the slow smile is rows 9 and 10.
FACE = {
  'closed': [(8, 5, 'c'), (13, 5, 'c'), (8, 6, 'M'), (9, 6, 'M'), (12, 6, 'M'), (13, 6, 'M')],
  'happy': [(8, 5, 'c'), (13, 5, 'c'), (8, 4, 'O'), (7, 5, 'O'), (9, 5, 'O'), (13, 4, 'O'), (12, 5, 'O'), (14, 5, 'O')],
  'up': [(8, 5, 'c'), (13, 5, 'c'), (8, 4, 'O'), (13, 4, 'O')],
  'squint': [(8, 5, 'M'), (13, 5, 'M'), (9, 5, 'O'), (12, 5, 'O')],
  'dazed': [(8, 5, 'c'), (13, 5, 'c'), (7, 4, 'O'), (9, 4, 'O'), (8, 5, 'O'), (7, 6, 'O'), (9, 6, 'O'),
            (12, 4, 'O'), (14, 4, 'O'), (13, 5, 'O'), (12, 6, 'O'), (14, 6, 'O')],
  # the slow yawn: the smile drops open, pink inside
  'yawn': [(10, 8, 'O'), (11, 8, 'O'), (9, 9, 'O'), (10, 9, 'p'), (11, 9, 'p'), (12, 9, 'O'),
           (9, 10, 'O'), (10, 10, 'p'), (11, 10, 'p'), (12, 10, 'O'), (14, 9, 'c'), (10, 11, 'O'), (11, 11, 'O')],
  'sleepy': [(8, 4, 'M'), (13, 4, 'M'), (7, 4, 'M'), (14, 4, 'M')],
  'open': [(10, 10, 'p'), (11, 10, 'p'), (10, 11, 'O'), (11, 11, 'O')],
  'wavy': [(10, 10, 'c'), (12, 10, 'c'), (9, 9, 'c'), (14, 9, 'c'), (10, 9, 'O'), (12, 9, 'O')],
}


def head(*faces):
  return dots(HEAD, [p for f in faces for p in FACE[f]])


TORSO = part(10, """
.......OOOOOOOOOO
.....OOfFFFFFFFFvOO
....OffFFFFFFFFFFvvO
...OfFFFfffffffFFFFvvO
...OfFFfffffffFFFFvvVO
..OfFFFfffffffFFFFvvVO
..OfFFFfffffffFFFFvvVO
..OFFFFfffffffFFFFvvVO
..OFFFFFfffffFFFFvvVVO
...OFFFFFFFFFFFFFvvVO
...OvFFFFFFFFFFFvvVVO
....OOvvvvvvvvvvvVOO
""")
FEET = part(20, """
.....OFFFO....OFFvO
....OfFFFFO..OFFFvvO
....OfFFFvO..OFFFvvO
.....OOOOO....OOOOO
""")
ARM_L = part(11, """
...OOO
..OfFFO
.OfFFvO
.OfFFvO
OfFFvO
OfFFvO
OuGuuO
OFFvvO
OBOBOBO
OBOBOBO
OBOBOBO
.O.O.O
""")
ARM_R = part(11, """
..................OOO
.................OFFvO
.................OFFvvO
.................OFFvvO
..................OFvvO
..................OFvvO
..................OFvvO
..................OFvvVO
.................OBOBOBO
.................OBOBOBO
.................OBOBOBO
..................O.O.O
""")


# The arms raised, claws up: the far one (wave), both (done).
ARM_R_UP = part(1, """
................O.O.O
...............OBOBOBO
...............OBOBOBO
................OfFFvO
................OfFvO
................OfFvO
................OfFvO
.................OFvO
.................OFvO
.................OFvvO
..................OFvO
""")
ARM_L_UP = part(1, """
..O.O.O
.OBOBOBO
.OBOBOBO
.OBOBOBO
.OfFFvO
..OfFvO
..OfFvO
..OfFvO
..OuuvO
..OGFvvO
...OfFvO
""")
# A claw up at the chin (thinking).
ARM_CHIN = part(7, """
.....O.O.O
....OBOBOBO
....OBOBOBO
....OBOBOBO
....OfFFvO
...OuGuuO
..OfFFvO
..OfFvO
..OFFvO
...OOO
""")


def sloth(h, head_dy=0, head_dx=0, arm_l=ARM_L, arm_r=ARM_R, bob=0, lift=0, rock=False, fxs=()):
  """Sat: the feet stay down (lift raises everything, for a hop); the body
  sinks by bob; the head nods by head_dy."""
  up = lambda p: at(p, 0, bob + lift)
  return stack(24, up(TORSO), at(FEET, 0, lift), *([B_ROCK] if rock else []), up(arm_l), up(arm_r),
               up(at(h, head_dx, head_dy)), *fxs)


SPARKS = fx(24, [(0, 17, '*'), (8, 18, '*'), (1, 15, '*'), (9, 16, '*')])
CHEER = [fx(24, [(10, 0, '*'), (14, 1, '*'), (0, 6, '*')]), fx(24, [(9, 1, '*'), (15, 0, '*'), (23, 6, '*')])]

BODY = {
  'idle': [  # a slow breath, then a big slow yawn
    sloth(head()),
    sloth(head()),
    sloth(head(), head_dy=1),
    sloth(head(), head_dy=1),
    sloth(head()),
    sloth(head('sleepy', 'yawn'), head_dy=-1),
    sloth(head('sleepy', 'yawn'), head_dy=-1),
    sloth(head('sleepy')),
  ],
  'working': [  # the strike first: it is the still under reduced motion; the claws rake the rock
    sloth(head('squint'), head_dy=1, bob=1, arm_l=at(ARM_L, 0, -1), rock=True, fxs=[SPARKS]),
    sloth(head('squint'), arm_l=at(ARM_L, 0, -4), rock=True),
    sloth(head(), head_dy=-1, arm_l=ARM_L_UP, rock=True),
    sloth(head('squint'), arm_l=at(ARM_L, 0, -5), rock=True),
  ],
  'thinking': [  # eyes up, a claw at the chin
    sloth(head('up'), arm_l=ARM_CHIN),
    sloth(head('up'), arm_l=at(ARM_CHIN, 0, 1)),
  ],
  'done': [  # down, then both arms all the way up
    sloth(head('happy'), head_dy=1, bob=1),
    sloth(head('happy', 'open'), arm_l=ARM_L_UP, arm_r=ARM_R_UP, lift=-1, fxs=[CHEER[0]]),
    sloth(head('happy', 'open'), arm_l=ARM_L_UP, arm_r=ARM_R_UP, fxs=[CHEER[1]]),
  ],
  'sleeping': [  # sat where it was; the head sinks on its chest and it snores
    sloth(head('closed'), head_dy=2, fxs=[fx(24, z_small(18, 2))]),
    sloth(head('closed', 'open'), head_dy=3, bob=1, fxs=[fx(24, z_big(20, 0) + z_small(17, 3))]),
  ],
  'error': [
    sloth(head('dazed', 'open'), head_dy=1, fxs=[fx(24, star(2, 1) + star(20, 2))]),
    sloth(head('dazed', 'open'), head_dy=1, head_dx=1, fxs=[fx(24, star(1, 2) + star(21, 1))]),
  ],
  'wave': [
    sloth(head('happy'), arm_r=ARM_R_UP),
    sloth(head('happy'), arm_r=at(ARM_R_UP, 1, 1)),
    sloth(head('happy'), arm_r=ARM_R_UP),
    sloth(head('happy'), arm_r=at(ARM_R_UP, 1, 1)),
  ],
}
