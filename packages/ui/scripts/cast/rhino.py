"""The woolly rhino: a stocky calf side on, facing left. A big round grey
head (rock-light lit top-left, rock, rock-mid shade) carrying the long bone
nose horn that sweeps up past the top of the frame and a stub of a second
horn on the brow, a pink-lined ear, and behind it a tall shaggy coat (sand,
sand-shade, fur) that rises into the shoulder hump with the green bead tied
in its top tuft. The coat's front edge is a ruff of tufts over the back of
the head and its hem hangs in tufts over four stubby grey legs with bone
toenails. Idle breathes (the coat and head sink a pixel) then flicks an ear
back with a little toss of the head; working gores the rock with the horn
(HEAD_RAM, the head pitched down), rears back with a hoof up and charges
again. No skin letters, so a skin tone never touches him."""
from pixelgrid import at, dots, fx, layer, part, stack, star, z_big, z_small
from cast.caveman import B_ROCK

PALETTE = {'A': 'rock', 'a': 'rock-light', 'x': 'rock-mid', 'F': 'sand-shade', 'f': 'sand', 'n': 'fur', 'p': 'pink'}
LID = 'A'

FAR_FRONT = part(19, """
.............OxO
.............OxO
.............OxO
.............ObO
.............OOO
""")
NEAR_FRONT = part(19, """
......OaAxO
......OaAxO
......OaAxO
......OBBbO
......OOOOO
""")
BACK_LEGS = part(19, """
................OxOaAxO
................OxOaAxO
................OxOaAxO
................ObOBBbO
................OOOOOOO
""")
COAT = part(4, """
...............OOOO
.............OOffffOO
............OfffGfffOO
............OffffFFfffOO
............OffFFFFFFFfO
............OfFFFFFFFFFO
............OfFFFFFFFFnO
............OFFFFFFnFFnO
............OFFFFFFnFFnO
............OFFFFFFFFnnO
............OFFnFFFFFFnO
............OFFnFFFFFnnO
............OFFFFFFFnnnO
............OnFFFFFnnnO
...........OnnnnnnnnnO
...........OOnOnnOnOO
""")
RUFF = part(9, """
..............Of
.............Off
.............OfF
..............OF
.............OfF
.............OFF
..............OF
.............OnF
............OnOn
""")
HEAD = part(0, """
.OO
OBBO
OBBO
OBBbO
OBBbO
.OBBbO
.OBBbO.OO
..OBBbOBbO
.OaBBbaBbbaaaO
OaaaaaaaaaaaaAO
OaaAAAAAAAAAAAxO
OaAAAAAAAeAAAAxO
OaAAAAAAAeAAAAxO
OaAAAAAAAAAAAAxO
OAAAAAAAAAAAAxxO
OxOOAAAAAAAAxxxO
.OxxOAAAAAAxxxxO
.OOxxxxxxxxxxxO
..OOOOOOOOOOOO
""")
EAR = part(5, """
..........OO
.........OapO
.........OapO
.........OaAO
""")
EAR_BACK = part(6, """
...........OO
..........OpaO
.........OaAO
""")
HEAD_RAM = part(5, """
...........OO
..........OapO
......OOOOOapO
.....OaaaaaaAO
....OaaAAAAAAAxO
...OaAAAAAAAAAxO
...OaAAAAeAAAAxO
...OaAAAAeAAAAxO
...OAAAAAAAAAxxO
..OOAAAAAAAAxxO
.OBbOAAAAAAxxO
OBBbOAAAAxxxO
OBBOOOxxxxxO
OBbO.OOOOOO
ObO
OO
""")

# A front leg held out under the chin, the hoof forward (wave).
LEG_OUT = part(18, """
...OOOOOOO
..OBaaaAAAO
..ObbxxxxxO
...OOOOOOO
""")

# The eye is two pixels tall at (9, 11) and (9, 12); the mouth is the notch at (2, 15).
FACE = {
  'closed': [(9, 11, 'A'), (8, 12, 'O'), (9, 12, 'O'), (10, 12, 'O')],
  'happy': [(9, 12, 'A'), (8, 12, 'O'), (9, 11, 'O'), (10, 12, 'O')],
  'up': [(9, 12, 'A'), (9, 10, 'O'), (9, 11, 'O')],
  'squint': [(9, 11, 'A'), (9, 12, 'A'), (8, 11, 'O'), (9, 12, 'O'), (10, 12, 'O')],
  'dazed': [(9, 11, 'A'), (9, 12, 'A'), (8, 10, 'O'), (10, 10, 'O'), (9, 11, 'O'), (8, 12, 'O'), (10, 12, 'O')],
  'open': [(2, 15, 'p'), (3, 15, 'p'), (2, 16, 'O'), (3, 16, 'O'), (1, 16, 'x')],
  'wavy': [(2, 15, 'A'), (3, 15, 'O'), (1, 15, 'O'), (2, 16, 'O')],
}


def head(*faces, ear=EAR):
  return layer(dots(HEAD, [p for f in faces for p in FACE[f]]), ear)


def rhino(h, hx=0, hy=0, bob=0, front=NEAR_FRONT, lean=0, fxs=()):
  """Legs stay planted; the coat and ruff ride `bob`, the head rides bob + (hx, hy)."""
  up = lambda p: at(p, lean, bob)
  return stack(24, FAR_FRONT, BACK_LEGS, *([front] if front else []), up(COAT), at(h, hx + lean, hy + bob), up(RUFF), *fxs)


SPARKS = fx(24, [(5, 17, '*'), (7, 19, '*'), (6, 15, '*'), (8, 21, '*')])
CHEER = [fx(24, [(17, 1, '*'), (21, 3, '*')]), fx(24, star(19, 1) + [(14, 0, '*'), (23, 4, '*')])]

BODY = {
  'idle': [  # a slow breath (the coat sinks a pixel), then an ear flick and a little head toss
    rhino(head()),
    rhino(head()),
    rhino(head(), bob=1),
    rhino(head(), bob=1),
    rhino(head()),
    rhino(head(ear=EAR_BACK), hy=-1),
    rhino(head(ear=EAR_BACK)),
    rhino(head()),
  ],
  'working': [  # the strike first: it is the still under reduced motion; the horn gores the rock
    rhino(dots(HEAD_RAM, FACE['squint']), lean=-1, fxs=[B_ROCK, SPARKS]),
    rhino(head('squint'), hy=1, fxs=[B_ROCK]),
    rhino(head(), hy=-2, bob=-1, front=at(NEAR_FRONT, 0, -2), fxs=[B_ROCK]),
    rhino(head('squint'), hy=2, bob=1, fxs=[B_ROCK]),
  ],
  'thinking': [  # chin up, eyes up, tapping a front hoof
    rhino(head('up'), hy=-1),
    rhino(head('up'), hy=-1, front=at(NEAR_FRONT, 0, -1)),
  ],
  'done': [  # a crouch, a hop with sparkles, then he lands proud
    rhino(head('happy'), hy=1, bob=1),
    stack(24, at((0, rhino(head('happy', 'open'), hy=-1)), 0, -2), CHEER[0]),
    rhino(head('happy', 'open'), hy=-1, fxs=[CHEER[1]]),
  ],
  'sleeping': [  # lain down, the chin on the floor; the coat rises as he snores
    rhino(head('closed'), hy=5, bob=4, fxs=[fx(24, z_small(19, 0))]),
    rhino(head('closed'), hy=5, bob=3, fxs=[fx(24, z_big(20, 0) + z_small(16, 1))]),
  ],
  'error': [  # dazed, stars round the horn, the head lolling
    rhino(head('dazed', 'wavy'), hy=1, fxs=[fx(24, star(8, 2) + star(19, 1))]),
    rhino(head('dazed', 'wavy'), hy=2, fxs=[fx(24, star(10, 1) + star(17, 2))]),
  ],
  'wave': [  # a front hoof held out under the chin and shaken hello
    rhino(head('happy'), front=LEG_OUT),
    rhino(head('happy', 'open'), hy=-1, front=at(LEG_OUT, 0, -1)),
    rhino(head('happy', 'open'), hy=-1, front=LEG_OUT),
    rhino(head('happy'), front=at(LEG_OUT, 0, -1)),
  ],
}
