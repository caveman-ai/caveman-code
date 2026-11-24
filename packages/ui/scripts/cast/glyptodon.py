"""The glyptodon: a giant armadillo side on, facing left, under a high domed
shell that fills the canvas. Staggered plates, each with a pale rosette,
lit from the top left (tunic, wood-hi, tunic-shade, wood seams) over a
studded rim, the green bead set in the top plate. A slate head pokes out
from under the front under its own plated cap, with a cream jaw; stumpy
slate legs with bone toenails; behind, a spiked club tail with bone spikes.
Idle breathes, then pokes its head out for a look and wags the club; it
works by bringing the club down on the rock and sleeps drawn in, only its
snout out. No skin letters, so a skin tone never touches it."""
from pixelgrid import at, dots, fx, part, stack, star, z_big, z_small
from cast.caveman import B_ROCK

PALETTE = {'a': 'tunic', 'A': 'wood-hi', 'x': 'tunic-shade', 'n': 'wood',
           'C': 'slate-light', 'Y': 'slate', 'y': 'slate-shade', 'p': 'pink'}
LID = 'y'

SHELL = part(2, """
.......OOOOOO
.....OOaaaxAAOO
....OaaLaaxAGAxO
...OaaaaaaxAAAAxO
...OxxxxxxxxxnnnO
..OaaaxaaAAxAAAxnO
..OaLaxaLAAxAaAxnO
..OaaaxaAAAxAAxxnO
..OxxxxxxxxxxnnnnnO
..OaaxaaAAxAAAxnxxO
..OLaxaLAAxAaAxnAxO
..OaaxaAAAxAAxxnxnO
..OxxxxxxxnnnnnnnnO
..OaLAAxAaAxnxAxxnO
.OnanananAnAnAnxnxnO
.OOOOOOOOOOOOOOOOOOO
""")

HEAD = part(7, """
...OOOOOO
..OaaLaaxO
.OaLaaaaxxO
.OnxnxnxnnO
OCCCYYYYYyO
OCCYeYYYYyO
OCYYeYYYyyO
OYYYYYYYyyO
OOOBBBByyyO
.OBBBBbyyO
..OOOOOOO
""")

FACE = {
  'closed': [(4, 12, 'Y'), (3, 13, 'O'), (4, 13, 'O'), (5, 13, 'O')],
  'happy': [(4, 13, 'Y'), (3, 13, 'O'), (4, 12, 'O'), (5, 13, 'O')],
  'up': [(4, 13, 'Y'), (4, 11, 'O'), (4, 12, 'O')],
  'squint': [(4, 13, 'Y'), (3, 12, 'O'), (5, 13, 'O')],
  'dazed': [(4, 13, 'Y'), (3, 11, 'O'), (5, 11, 'O'), (4, 12, 'O'), (3, 13, 'O'), (5, 13, 'O')],
  'open': [(3, 15, 'O'), (4, 15, 'O'), (5, 15, 'O'), (2, 16, 'p'), (3, 16, 'p')],
  'wavy': [(2, 15, 'B'), (3, 15, 'O'), (4, 16, 'O'), (5, 15, 'O')],
}


def head(*faces):
  return dots(HEAD, [p for f in faces for p in FACE[f]])


FRONT_LEG = part(18, """
....OCYYyO
....OCYYyO
...OCYYYyyO
...OCYYYyyO
...OBYBYByO
...OOOOOOOO
""")
# Lifted and held out in front: a foot to wave or stamp with.
FRONT_UP = part(17, """
.OOOO
OBCYYOOO
OBCYYYYyO
.OOOOYYyO
.....OOO
""")
BACK_LEG = part(18, """
............OYYyyO
............OYYyyO
...........OYYYyyyO
...........OYYYyyyO
...........OBYBYByO
...........OOOOOOOO
""")
# The club on its ringed tail, poking out behind the rim.
TAIL = part(8, """
.....................O
....................OBO
...................OaaxO
..................OaLaAB
..................OaaAxO
..................OxAxnO
...................OOBO
.....................O
""")


def glyp(h, head_dy=0, head_dx=1, tail=TAIL, front=FRONT_LEG, bob=0, lift=0, fxs=(), rock=False):
  """Stood: the legs stay put (lift raises them too, for a hop); the shell
  and tail sink by bob; the head pokes out by head_dx and nods by head_dy."""
  up = lambda p: at(p, 0, bob + lift)
  return stack(24, at(front, 0, lift), at(BACK_LEG, 0, lift), *([ROCK] if rock else []), up(tail), up(SHELL), up(at(h, head_dx, head_dy)), *fxs)


# Lying down (sleeping): toes peeking out under the rim.
TOES = part(21, """
...OBYBYBO.OBYBYBO
...OOOOOOO.OOOOOOO
""")
# The snout poked out under the front of the rim, eye shut, chin down.
SNOUT = part(16, """
.OOOOO
OCCYYyO
OCYYYyO
OYOOOyO
OOBByyO
.OOOOO
""")
TAIL_UP = at(TAIL, 0, -3)
TAIL_HI = at(TAIL, 0, -6)
TAIL_HIT = at(TAIL, 0, 6)
ROCK = at(B_ROCK, 17)
SPARKS = fx(24, [(17, 17, '*'), (23, 15, '*'), (18, 15, '*')])
CHEER = [fx(24, [(1, 3, '*'), (21, 5, '*'), (4, 1, '*')]), fx(24, [(0, 2, '*'), (22, 3, '*'), (3, 0, '*')])]

BODY = {
  'idle': [  # a breath, then it pokes its head out for a look and wags its club
    glyp(head()),
    glyp(head()),
    glyp(head(), head_dy=1),
    glyp(head(), head_dy=1),
    glyp(head()),
    glyp(head(), head_dx=0, head_dy=-1, tail=TAIL_UP),
    glyp(head(), head_dx=0, head_dy=-1),
    glyp(head()),
  ],
  'working': [  # the strike first: it is the still under reduced motion; the club comes down on the rock
    glyp(head('squint'), tail=TAIL_HIT, bob=1, head_dy=1, rock=True, fxs=[SPARKS]),
    glyp(head('squint'), rock=True),
    glyp(head(), tail=TAIL_HI, head_dy=-1, rock=True),
    glyp(head('squint'), tail=TAIL_UP, rock=True),
  ],
  'thinking': [  # eyes up, the club tapping
    glyp(head('up'), head_dx=0, head_dy=-1),
    glyp(head('up'), head_dx=0, head_dy=-1, tail=at(TAIL, 0, 1)),
  ],
  'done': [  # down to spring, the hop, landed and beaming
    glyp(head('happy'), bob=1, head_dy=1),
    glyp(head('happy', 'open'), head_dx=0, head_dy=-1, tail=TAIL_HI, lift=-2, fxs=[CHEER[0]]),
    glyp(head('happy', 'open'), head_dx=0, head_dy=-1, tail=TAIL_UP, fxs=[CHEER[1]]),
  ],
  'sleeping': [  # feet drawn in, the shell down on the floor, only the snout out; it snores
    stack(24, TOES, at(TAIL, 0, 4), at(SHELL, 0, 3), SNOUT, fx(24, z_small(17, 2))),
    stack(24, TOES, at(TAIL, 0, 4), at(SHELL, 0, 2), at(SNOUT, 0, -1), fx(24, z_big(20, 0) + z_small(16, 3))),
  ],
  'error': [
    glyp(head('dazed', 'open'), head_dy=1, fxs=[fx(24, star(2, 4) + star(12, 1))]),
    glyp(head('dazed', 'open'), head_dx=0, head_dy=1, fxs=[fx(24, star(1, 3) + star(14, 2))]),
  ],
  'wave': [  # head out and grinning, the club up and wagging hello
    glyp(head('happy', 'open'), head_dx=0, head_dy=-1, tail=TAIL_HI),
    glyp(head('happy', 'open'), head_dx=0, head_dy=-1, tail=at(TAIL_HI, -1, -1)),
    glyp(head('happy', 'open'), head_dx=0, head_dy=-1, tail=TAIL_HI),
    glyp(head('happy', 'open'), head_dx=0, head_dy=-1, tail=at(TAIL_HI, -1, -1)),
  ],
}
