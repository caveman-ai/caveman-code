"""The boar: a stocky piglet-shaped tusker side on, facing left, in slate
(slate-light lit, slate, slate-shade). A long wedge of a head ending in a big
pink snout disc with a nostril, a bone tusk curling up out of the jaw, a
pointed pink-lined ear, and a spiky crest of dark bristles (hair, hair-hi)
running from behind the ear over the high shoulders, the green bead caught
in it. A short tufted tail on the rump and stubby legs on dark trotters.
Idle breathes, then snuffles the ground with a flick of the tail; working
drives its tusks into the rock, paws the ground and charges again. No skin
letters, so a skin tone never touches it."""
from pixelgrid import at, dots, fx, layer, part, stack, star, z_big, z_small
from cast.caveman import B_ROCK

PALETTE = {'a': 'slate-light', 'A': 'slate', 'x': 'slate-shade', 'H': 'hair', 'h': 'hair-hi', 'p': 'pink', 'k': 'rock-dark'}
LID = 'A'

FAR_LEGS = part(17, """
..........OxO..OxO
..........OxO..OxO
..........OxO..OxO
..........OxO..OxO
..........OxO..OxO
..........OkO..OkO
..........OOO..OOO
""")
NEAR_FRONT = part(16, """
.....OaAxO
.....OaAxO
.....OaAxO
.....OaAxO
.....OaAxO
.....OaAxO
.....OkkkO
.....OOOOO
""")
NEAR_BACK = part(19, """
..................OaAxO
..................OaAxO
..................OaAxO
..................OkkkO
..................OOOOO
""")
TRUNK = part(6, """
...........OOOOOO
..........OaaaaaaOOO
.........OaaAAAAAaaaOO
.........OaAAAAAAAAAaO
.........OaAAAAAAAAAAxO
.........OAAAAAAAAAAAxO
.........OAAAAAAAAAAxxO
.........OAAAAAAAAAAxxO
.........OAAAAAAAAAxxxO
.........OAAAAAAAAxxxxO
.........OxAAAAAAxxxxO
.........OxxxxxxxxxxO
..........OOOOOOOOOO
""")
TAIL = part(9, """
......................O
.....................OhO
.....................OHO
......................O
""")
TAIL_UP = part(7, """
.....................OO
....................OhHO
.....................OO
""")
MANE = part(2, """
..........O.O
.........OhOhO.O
........OhHhHOhO.O
.......OhHHHHHHOhO
........OHHHHHHHHHHO
...........OHHHHHHHHO
...............OOHHHO
.................OOO
""")
HEAD = part(5, """
.........OO
........OxpO
....OOOOOxpO
...OaaaaaaxaO
..OaaAAAAAAAAO
.OaAAAAeAAAAAxO
OaAAAAAeAAAAAxO
OppOOAAAAAAAAxO
OOpOBOAAAAAAxxO
OppOBOAAAAAxxxO
.OOObOAAAAxxxxO
..OOOxxxxxxxxO
...OOOOOOOOOO
""")

# A front leg held out under the chin, the hoof forward (wave).
LEG_OUT = part(17, """
...OOOOOOO
..OkaaAAxO
..OkkxxxxO
...OOOOOO
""")

# The eye is two pixels tall at (7, 10) and (7, 11); the mouth is under the
# snout, behind the tusk, at (1, 15) and (2, 15).
FACE = {
  'closed': [(7, 10, 'A'), (6, 11, 'O'), (7, 11, 'O'), (8, 11, 'O')],
  'happy': [(7, 11, 'A'), (6, 11, 'O'), (7, 10, 'O'), (8, 11, 'O')],
  'up': [(7, 11, 'A'), (7, 9, 'O'), (7, 10, 'O')],
  'squint': [(7, 10, 'A'), (7, 11, 'A'), (6, 10, 'O'), (7, 11, 'O'), (8, 11, 'O'), (6, 9, 'x'), (7, 9, 'x')],
  'dazed': [(7, 10, 'A'), (7, 11, 'A'), (6, 9, 'O'), (8, 9, 'O'), (7, 10, 'O'), (6, 11, 'O'), (8, 11, 'O')],
  'open': [(1, 15, 'p'), (2, 15, 'p'), (2, 16, 'O')],
  'wavy': [(2, 15, 'x'), (1, 16, 'O')],
}


def head(*faces):
  return dots(HEAD, [p for f in faces for p in FACE[f]])


def boar(h, hy=0, bob=0, front=NEAR_FRONT, tail=TAIL, lean=0, fxs=()):
  """Legs stay planted; trunk, mane and tail ride `bob` (and `lean`), the head bob + hy."""
  up = lambda p: at(p, lean, bob)
  return stack(24, FAR_LEGS, NEAR_BACK, front, up(TRUNK), up(tail), up(MANE), at(h, lean, bob + hy), at(fx(24, [(13, 7, 'G')]), lean, bob), *fxs)


SPARKS = fx(24, [(7, 18, '*'), (8, 20, '*'), (1, 17, '*'), (9, 17, '*')])
DUST = fx(24, [(10, 22, 'Z'), (11, 21, 'Z')])
CHEER = [fx(24, [(3, 3, '*'), (21, 4, '*')]), fx(24, star(3, 3) + star(21, 3))]

BODY = {
  'idle': [  # a slow breath, then a snuffle at the ground and a flick of the tail
    boar(head()),
    boar(head()),
    boar(head(), bob=1),
    boar(head(), bob=1),
    boar(head()),
    boar(head(), hy=1, tail=TAIL_UP),
    boar(head(), tail=TAIL_UP),
    boar(head()),
  ],
  'working': [  # the strike first: it is the still under reduced motion; tusks into the rock
    boar(head('squint'), hy=3, lean=-1, tail=TAIL_UP, fxs=[B_ROCK, SPARKS]),
    boar(head('squint'), hy=1, fxs=[B_ROCK]),
    boar(head(), hy=-1, bob=-1, front=at(NEAR_FRONT, 1, -2), fxs=[B_ROCK, DUST]),
    boar(head('squint'), hy=2, tail=TAIL_UP, fxs=[B_ROCK]),
  ],
  'thinking': [  # snout up, eyes up, the tail ticking
    boar(head('up'), hy=-1),
    boar(head('up'), hy=-1, tail=TAIL_UP),
  ],
  'done': [  # a crouch, a bounce with the tail up, then it beams
    boar(head('happy'), hy=1, bob=1),
    stack(24, at((0, boar(head('happy', 'open'), hy=-1, tail=TAIL_UP)), 0, -2), CHEER[0]),
    boar(head('happy', 'open'), hy=-1, tail=TAIL_UP, fxs=[CHEER[1]]),
  ],
  'sleeping': [  # flopped on its belly, the snout on the floor
    stack(24, at(TRUNK, 0, 5), at(TAIL, 0, 5), at(MANE, 0, 5), at(head('closed'), 0, 6), fx(24, [(13, 12, 'G')] + z_small(19, 2))),
    stack(24, at(TRUNK, 0, 5), at(TAIL, 0, 5), at(MANE, 0, 4), at(head('closed'), 0, 6), fx(24, [(13, 11, 'G')] + z_big(20, 1) + z_small(16, 3))),
  ],
  'error': [  # dazed, stars over the bristles, the head lolling
    boar(head('dazed', 'wavy'), hy=1, fxs=[fx(24, star(3, 4) + star(16, 1))]),
    boar(head('dazed', 'wavy'), hy=2, fxs=[fx(24, star(5, 3) + star(14, 1))]),
  ],
  'wave': [  # a front hoof held out under the chin and shaken hello
    boar(head('happy'), front=LEG_OUT),
    boar(head('happy', 'open'), hy=-1, front=at(LEG_OUT, 0, -1)),
    boar(head('happy', 'open'), hy=-1, front=LEG_OUT),
    boar(head('happy'), front=at(LEG_OUT, 0, -1)),
  ],
}
