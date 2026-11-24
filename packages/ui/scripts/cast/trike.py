"""The trike: a small triceratops side on, facing left, the dino's wrong-era
friend. A big head under a round frill with a bone rim and the green bead in
the middle of it, two long bone brow horns and a short nose horn, a cream
bone beak, a loaf of a body with a cream belly, stubby legs with bone toes and
a short tail. Teal, teal-light lit side, teal-shade shade; no skin letters, so
a skin tone never touches it."""
from pixelgrid import at, dots, fx, layer, part, stack, star, z_big, z_small
from cast.caveman import B_ROCK

PALETTE = {'A': 'teal', 'a': 'teal-light', 'x': 'teal-shade'}
LID = 'x'

FRILL = part(0, """
...........O.OO.O
.........OOBOBBOBOO
........OBBbBxxBbBBO
.......OBxxxxxGxxxbBO
......OBBxxxxxxxxxxbBO
.......OBxxxxxxxxxxxbO
......OBBxxxxxxxxxxxbBO
.......OBxxxxxxxxxxxbO
......OBBxxxxxxxxxxxbBO
.......ObxxxxxxxxxxbO
.......ObbxxxxxxxxbbO
........ObbbxxxxbbbO
.........OObbbbbbOO
...........OOOOOO
""")
# The brow horns, two parallel points (the far one over the frill, the near
# one over the head), and the nose horn on the snout.
FAR_HORN = part(2, """
..OO
.OBBOO
..ObBBOO
...OObBBOO
.....OObBBO
.......OObBO
""")
FACE_PART = part(8, """
.....OOOOOOO
...OOaaaaaaaOO
..OaaAAAAAAAAAO
.OaAAAAAeAAAAAO
OBBAAAAAeAAAAxO
OBBBAAAAAAAAAxO
OBBbOAAAAAAAxxO
ObbbOAAAAAAxxO
.OOOOxxxxxxxO
....OOOOOOOO
""")
NEAR_HORN = part(4, """
OO
BBOO
bBBBOO
OObbBBOO
..OOObBB
""")
NOSE = part(9, """
..O
.OBO
""")


# The eye is two pixels tall at (8, 11) and (8, 12); the mouth ends at (4, 14).
FACE = {
  'closed': [(8, 11, 'A'), (7, 12, 'O'), (8, 12, 'O'), (9, 12, 'O')],
  'happy': [(8, 12, 'A'), (7, 12, 'O'), (8, 11, 'O'), (9, 12, 'O')],
  'up': [(8, 12, 'A'), (8, 10, 'O'), (8, 11, 'O')],
  'squint': [(8, 11, 'A'), (7, 11, 'O'), (8, 12, 'O'), (9, 12, 'O')],
  'dazed': [(8, 11, 'A'), (8, 12, 'A'), (7, 10, 'O'), (9, 10, 'O'), (8, 11, 'O'), (7, 12, 'O'), (9, 12, 'O')],
  'grin': [(5, 14, 'O'), (6, 13, 'O')],
  'wavy': [(5, 13, 'O'), (6, 14, 'O'), (7, 13, 'O')],
}


def head(*faces):
  return layer(FRILL, FAR_HORN, dots(FACE_PART, [p for f in faces for p in FACE[f]]), NEAR_HORN, NOSE)


# The head lowered to butt: the face tipped down and the beak on the rock,
# the horns level, the frill risen behind.
FACE_LOW = part(10, """
....OOOOO..OOOOOO
...BBBBBBBOaaaaaaO
...OOOOOOOaaAAAAAAO
...OOOOOaAAAAAAAAAO
...BBBBBOAAAAeAAAAxO
...OOOOOaAAAAeAAAAxO
......OaAAAAAAAAAxxO
......OAAAAAAAAAAxO
.....OBBAAAAAAAAxxO
.....OBBBOAAAAAxxO
.....OBBbOOxxxxxO
......ObbO.OOOOO
.......OO
""")
# Gritted: the eye screwed into a line under a brow.
HEAD_LOW = layer(at(FRILL, -2, 1), dots(FACE_LOW, [(13, 14, 'A'), (12, 14, 'O'), (13, 15, 'O'), (14, 15, 'O')]))

TORSO = part(12, """
.............OOOOO
...........OOaaaaaOO
..........OaAAAAAAAaO
.........OaAAAAAAAAAaOOO
.........OAAAAAAAAAAAaaO
.........OAAAAAAAAAAAxxO
.........OAAAAAAAAAAxOO
.........OxAAAAAAAAxxO
.........OBBBBBBBBbxO
..........OOOOOOOOOO
""")
FRONT_LEG = part(20, """
.........OAAAxO
.........OAAAxO
.........OBABxO
.........OOOOOO
""")
# Lifted and held out in front: a foot to wave or stamp with.
FRONT_LEG_UP = part(17, """
......OOOO
.....OBAAAO
.....OBAAxOO
......OOOxAO
.........OO
""")
BACK_LEG = part(20, """
................OAAxxO
................OAAxxO
................OBABxO
................OOOOOO
""")


def trike(h, head_dy=0, front=FRONT_LEG, fxs=()):
  return stack(24, TORSO, BACK_LEG, front, at(h, 0, head_dy), *fxs)


SPARKS = fx(24, [(3, 18, '*'), (1, 16, '*'), (0, 19, '*'), (4, 15, '*')])
STOMP = fx(24, [(7, 22, '*'), (6, 21, '*'), (16, 22, '*'), (8, 19, '*')])

BODY = {
  'idle': [
    trike(head()),
    trike(head(), head_dy=1),
  ],
  'working': [  # the strike first: it is the still under reduced motion
    stack(24, TORSO, BACK_LEG, FRONT_LEG, HEAD_LOW, B_ROCK, SPARKS),
    trike(head('squint'), head_dy=2, fxs=[B_ROCK]),
    trike(head(), head_dy=-1, fxs=[B_ROCK]),
    trike(head('squint'), head_dy=2, fxs=[B_ROCK]),
  ],
  'thinking': [  # eyes up, tapping a front foot
    trike(head('up'), front=at(FRONT_LEG, 0, -1)),
    trike(head('up')),
  ],
  'done': [  # a foot up, a stomp, then it beams
    trike(head('happy', 'grin'), front=FRONT_LEG_UP),
    trike(head('happy', 'grin'), head_dy=1, fxs=[STOMP]),
    trike(head('happy', 'grin')),
  ],
  'sleeping': [  # down on its belly, chin on the ground
    stack(24, at(TORSO, 0, 2), at(head('closed'), 0, 6), fx(24, z_small(18, 3))),
    stack(24, at(TORSO, 0, 2), at(head('closed'), 0, 7), fx(24, z_big(20, 0) + z_small(17, 4))),
  ],
  'error': [
    trike(head('dazed', 'wavy'), fxs=[fx(24, star(1, 1) + star(22, 3))]),
    trike(head('dazed', 'wavy'), head_dy=1, fxs=[fx(24, star(2, 1) + star(21, 1))]),
  ],
  'wave': [  # a front foot up to say hello
    trike(head('happy', 'grin'), front=FRONT_LEG_UP),
    trike(head('happy', 'grin'), front=at(FRONT_LEG_UP, 0, -1)),
    trike(head('happy', 'grin'), front=at(FRONT_LEG_UP, -1, 0)),
    trike(head('happy', 'grin'), front=FRONT_LEG_UP),
  ],
}
