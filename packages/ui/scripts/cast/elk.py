"""The giant elk (Megaloceros): a fawn side on, facing left, under antlers
wider than itself: the near palm sweeps back over the body in bone with a
row of tines, the far one (rock-light) reaches forward. A big round head
(wood-hi lit, tunic-shade, wood shade) with a dark nose, a cream chin and a
pink-lined ear, a dark fur mane down the neck, a loaf of a body with a cream
belly stripe and a cream scut of a tail, four stubby legs on dark hooves.
The green bead is tied on its back. Idle breathes, then flicks an ear back
and the tail up; working stamps a front hoof on the rock (rears to wind up,
sparks on the strike). No skin letters, so a skin tone never touches it."""
from pixelgrid import at, dots, fx, layer, part, stack, star, z_big, z_small
from cast.caveman import B_ROCK

PALETTE = {'a': 'wood-hi', 'A': 'tunic-shade', 'x': 'wood', 'F': 'fur', 'n': 'hair-hi', 'N': 'hair-hi', 'p': 'pink'}
LID = 'A'

FAR_LEGS = part(19, """
...........OxO..OxO
...........OxO..OxO
...........OxO..OxO
...........ONO..ONO
...........OOO..OOO
""")
NEAR_FRONT = part(19, """
.......OAxO
.......OAxO
.......OAxO
.......ONNO
.......OOOO
""")
NEAR_BACK = part(19, """
...................OAxO
...................OAxO
...................OAxO
...................ONNO
...................OOOO
""")
TRUNK = part(10, """
.............OOOOOOOO
...........OOaaaaaaaaOO
..........OaaAAAAAAAAaBO
.........OaAAAAAAAAAAbBO
.........OAAAAAAAAAAAAbO
.........OAAAAAAAAAAAAxO
.........OAAAAAAAAAAAxxO
.........OxAAAAAAAAAxxxO
..........OxBBBBBBBBxxO
...........OOOOOOOOOOO
""")
TAIL = part(11, """
.....................OO
....................ObbO
.....................OO
""")
TAIL_UP = part(9, """
.....................OO
....................ObbO
.....................ObO
......................O
""")
MANE = part(8, """
..........OO
.........OFFO
........OFnFFO
........OFFnFO
........OFnFFO
........OFFnFO
........OFnFO
........OnFO
.........OO
""")
HEAD = part(0, """
.O.O.O....O.O.O.O.O
ObObObO..OBOBOBOBOBO
ObbbbbbOOBBBBBBBBBBBO
.ObbbbbOBBBBBBBBBBBbbO
..OOObbOBBbbbbbbbbbbO
.....OOOBbbOOOOOOOOO
....OOOOBbO
...OaaaaOOO
..OaaAAAAaaO
.OaAAAAAAAAO
.OaAAAeAAAAAAO
OaAAAAeAAAAAAO
OAAAAAAAAAAAxO
ONAAAAAAAAAxxO
ONNBBAAAAAxxO
.OOBBbxxxxxO
..OOOOOOOOO
""")
EAR = part(7, """
..........OO
..........OapO
..........OapO
""")
EAR_BACK = part(8, """
...........OOO
..........OappO
...........OOO
""")

# A front leg held out under the chin, the hoof forward (wave).
LEG_OUT = part(16, """
.....OOOOOO
....ONaAAxO
....ONNxxxO
.....OOOOO
""")

# The eye is two pixels tall at (6, 10) and (6, 11); the mouth is under the dark nose, (3, 14).
FACE = {
  'closed': [(6, 10, 'A'), (5, 11, 'O'), (6, 11, 'O'), (7, 11, 'O')],
  'happy': [(6, 11, 'A'), (5, 11, 'O'), (6, 10, 'O'), (7, 11, 'O')],
  'up': [(6, 11, 'A'), (6, 9, 'O'), (6, 10, 'O')],
  'squint': [(6, 10, 'A'), (6, 11, 'A'), (5, 10, 'O'), (6, 11, 'O'), (7, 11, 'O')],
  'dazed': [(6, 10, 'A'), (6, 11, 'A'), (5, 9, 'O'), (7, 9, 'O'), (6, 10, 'O'), (5, 11, 'O'), (7, 11, 'O')],
  'open': [(3, 14, 'O'), (4, 14, 'p'), (3, 15, 'O'), (4, 15, 'O')],
  'wavy': [(3, 14, 'O'), (4, 13, 'O'), (5, 14, 'O')],
}


def head(*faces, ear=EAR):
  return layer(dots(HEAD, [p for f in faces for p in FACE[f]]), ear)


def elk(h, hy=0, bob=0, front=NEAR_FRONT, tail=TAIL, fxs=(), under=()):
  """Legs stay planted; the trunk rides `bob`, the head and mane bob + hy."""
  up = lambda p: at(p, 0, bob)
  return stack(24, *under, FAR_LEGS, NEAR_BACK, front, up(TRUNK), up(tail), at(MANE, 0, bob + max(hy, 0) // 2), at(h, 0, bob + hy), fx(24, [(16, 11, 'G')]), *fxs)


ROCK = at(B_ROCK, 4)  # under the near front hoof
SPARKS = fx(24, [(4, 18, '*'), (11, 17, '*'), (3, 16, '*'), (12, 19, '*')])
CHEER = [fx(24, [(22, 3, '*'), (19, 7, '*')]), fx(24, star(21, 5) + [(17, 8, '*')])]

BODY = {
  'idle': [  # a slow breath, then an ear flick and a flick of the tail
    elk(head()),
    elk(head()),
    elk(head(), bob=1),
    elk(head(), bob=1),
    elk(head()),
    elk(head(ear=EAR_BACK), tail=TAIL_UP),
    elk(head(ear=EAR_BACK)),
    elk(head()),
  ],
  'working': [  # the strike first: it is the still under reduced motion; a hoof stamps the rock
    elk(head('squint'), hy=1, front=at(NEAR_FRONT, 0, -3), under=[ROCK], fxs=[SPARKS]),
    elk(head('squint'), front=at(NEAR_FRONT, 0, -4), under=[ROCK]),
    elk(head(), hy=-1, bob=-1, front=at(NEAR_FRONT, 1, -7), tail=TAIL_UP, under=[ROCK]),
    elk(head('squint'), front=at(NEAR_FRONT, 0, -5), under=[ROCK]),
  ],
  'thinking': [  # chin up, eyes on the sky, an ear turning
    elk(head('up'), hy=-1),
    elk(head('up', ear=EAR_BACK), hy=-1),
  ],
  'done': [  # a crouch, a leap with the antlers tossed, then it stands proud
    elk(head('happy'), hy=1, bob=1),
    stack(24, at((0, elk(head('happy', 'open'), hy=-1, tail=TAIL_UP)), 0, -1), CHEER[0]),
    elk(head('happy', 'open'), tail=TAIL_UP, fxs=[CHEER[1]]),
  ],
  'sleeping': [  # folded down on its legs, the chin on the floor
    stack(24, at(TRUNK, 0, 4), at(TAIL, 0, 4), at(MANE, 0, 5), at(head('closed'), 0, 6), fx(24, [(16, 15, 'G')] + z_small(19, 3))),
    stack(24, at(TRUNK, 0, 4), at(TAIL, 0, 4), at(MANE, 0, 5), at(head('closed'), 0, 6), fx(24, [(16, 15, 'G')] + z_big(20, 2) + z_small(16, 5))),
  ],
  'error': [  # dazed, stars caught in the antlers, the head lolling
    elk(head('dazed', 'wavy'), hy=1, fxs=[fx(24, star(9, 9) + star(21, 7))]),
    elk(head('dazed', 'wavy'), hy=2, fxs=[fx(24, star(7, 8) + star(19, 8))]),
  ],
  'wave': [  # a front hoof held out under the chin and shaken hello
    elk(head('happy'), front=LEG_OUT),
    elk(head('happy', 'open'), hy=-1, front=at(LEG_OUT, 0, -1)),
    elk(head('happy', 'open'), hy=-1, front=LEG_OUT),
    elk(head('happy'), front=at(LEG_OUT, 0, -1)),
  ],
}
