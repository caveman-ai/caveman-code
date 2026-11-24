"""The wolf pup, the first dog: a grey pup sat side on, facing left. A big
head with two tall ears (the near one pink inside, the far one in shade), a
short cream muzzle with a black nose, a cream bib and paws, a leather collar
with the green bead, a haunch and a fluffy tail curled up over the back with
a cream tip. Lit from the top left: slate-light, slate, slate-shade; no skin
letters, so a skin tone never touches it.

Idle breathes (the head dips a row) and fidgets once a loop: the near ear
twitches and the tail tip swishes over the back. It paws at the rock (the
paw raised, reached, struck), hops for joy with its tail straight up, curls
up asleep behind its head, and waves a front paw."""
from pixelgrid import at, dots, fx, layer, part, stack, star, z_big, z_small
from cast.caveman import B_ROCK

PALETTE = {'W': 'wood', 'A': 'slate', 'a': 'slate-shade', 'C': 'slate-light', 'P': 'pink'}
LID = 'A'

# The head, ear tips to collar, drawn from row 0 and set one row down (Y):
# the hop in done has a row of sky to rise into.
HEAD = part(0, """
........O.....O
.......OaO...OCO
.......OaaO.OCPCO
......OaaAOOCPPCO
......OaCCCCCPPAO
.....OCCCCCCCAAAaO
....OCCCAAAAAAAAaO
...OCCAAeAAAAAAAaO
..OCCAAAeAAAAAAAaO
OOCCAAAAAAAAAAAaaO
OOBBBBAAAAAAAAAaaO
.OOOBBBBBAAAABBaO
...OOOWWWGWWWWOO
""")
Y = 1

FACE = {
  'closed': [(8, 7, 'A'), (7, 8, 'O'), (8, 8, 'O'), (9, 8, 'O')],
  'happy': [(8, 8, 'A'), (7, 8, 'O'), (8, 7, 'O'), (9, 8, 'O')],
  'up': [(8, 8, 'A'), (8, 6, 'O'), (8, 7, 'O')],
  'squint': [(8, 7, 'A'), (8, 8, 'A'), (7, 7, 'O'), (8, 7, 'O'), (9, 8, 'O')],
  'dazed': [(8, 7, 'A'), (8, 8, 'A'), (7, 6, 'O'), (9, 6, 'O'), (8, 7, 'O'), (7, 8, 'O'), (9, 8, 'O')],
  'open': [(2, 10, 'O'), (3, 10, 'O'), (4, 10, 'O'), (2, 11, 'P'), (3, 11, 'P'), (4, 11, 'O'), (1, 12, 'O'), (2, 12, 'O')],
  'tongue': [(2, 11, 'P'), (1, 12, 'O'), (2, 12, 'P')],
  'wavy': [(2, 11, 'B'), (3, 10, 'O')],
  'twitch': [(14, 0, '.'), (14, 1, 'O')],
  'flat': [(14, 0, '.'), (13, 1, '.'), (14, 1, '.'), (15, 1, '.'), (12, 2, '.'), (13, 2, 'O'), (14, 2, 'O'),
           (15, 2, 'O'), (16, 2, 'O'), (12, 3, 'O'), (13, 3, 'C'), (14, 3, 'C'), (15, 3, 'P'), (16, 3, 'C'), (17, 3, 'O')],
}


def head(*faces, dx=0, dy=0):
  return at(dots(HEAD, [p for f in faces for p in FACE[f]]), dx, Y + dy)


TORSO = part(13, """
.....OBBBBBAAAAAOO
.....OBBBBAAAAAAAAOO
....OBBBBAAAAAAAAAAaO
....OBBbAAAAAAAAAAAaaO
.....ObAAAAAAAOOAAaaO
.....OAAAOAAAOCAAAaaO
.....OAAaOAAOCAAAaaaO
.....OAAaOAAOAAAAaaO
.....OAAaO.OAAAaaaO
....OBBBaO.OBBBBaO
....OOOOOO.OOOOOOO
""")
TORSO_LIFT = dots(TORSO, [*((x, y, '.') for y in range(18, 24) for x in (4, 5)),
                          *((x, y, ch) for y in range(18, 22) for x, ch in ((6, 'O'), (7, 'a'), (8, 'a'), (9, 'O'))),
                          (6, 22, 'O'), (7, 22, 'b'), (8, 22, 'b'), (9, 22, 'O'), *((x, 23, 'O') for x in range(6, 10))])

TAIL = part(3, """
...................OOO
..................OBBBO
.................OBBBCAO
..................OOCCAaO
...................OCAAaO
...................OCAAAaO
...................OCAAAaO
...................OCAAAaO
..................OCAAAaaO
..................OAAAAaO
..................OAAAaaO
..................OAAaaO
...................OaaO
""")
TAIL_SWISH = layer(at((3, TAIL[1][:5]), -1, 0), (8, TAIL[1][5:]))
TAIL_UP = part(1, """
...................OO
..................OBBO
..................OBBCO
..................OCCAO
..................OCAAaO
..................OCAAaO
..................OCAAaO
..................OCAAaO
..................OCAAaO
..................OCAAAaO
..................OAAAAaO
..................OAAAaaO
..................OAAaaO
...................OaaO
""")

PAW_HIT = part(16, """
.....OOO
....OBAAO
...OBAAO
.OOBAAO
.OBBBO
.OOOOO
""")
PAW_MID = part(16, """
..OOOOO
.OBBAAAO
.OBBAAAO
..OOOOO
""")
PAW_UP = part(13, """
.OOO
OBBBO
OBAAO
OAAAO
.OAAO
.OAAAO
..OAAO
""")
# The wrist bent: the pad tipped over toward us.
PAW_FLAP = part(13, """
.....
OOOO
OBBBOO
.OAAAO
.OAAO
.OAAAO
..OAAO
""")


def pup(h=None, tail=TAIL, paw=None, dy=0, fxs=()):
  h = h or head()
  layers = [tail, TORSO if paw is None else TORSO_LIFT, h, *([] if paw is None else [paw])]
  return stack(24, *(at(p, 0, dy) for p in layers), *fxs)


LYING = part(6, """
...............OOOOO
.............OOCCCCAOO
............OCCAAAAAAaO
...........OCAAAAAAAAaO
..........OCAAAAAAAAAaO
..........OCAAAAAAAAAaaO
.........OCAAAAAAAAAAaaO
.........OAAAAAAAAAAAaaO
.........OAAAAAAAAAAaaaO
.........OAAAAAAAAAAaaaO
.........OAAAAAAAAAaaaO
.........OAAAAAAAAAaaaO
.........OAAAAAAAAaaaaO
........OCCAAAAAaaaaaO
......OOBBCCCAAAaaaaO
..OOOOBBBBOOOOOOOOOO
.OBBBBO
.OOOOOO
""")

ROCK = B_ROCK
SPARKS = fx(24, [(0, 17, '*'), (2, 16, '*'), (6, 17, '*'), (7, 19, '*')])
HOP = fx(24, [(1, 3, '*'), (3, 1, '*'), (0, 6, '*')])


def idle(i):
  return [
    pup(), pup(), pup(head(dy=1)), pup(head(dy=1)),
    pup(), pup(head('twitch'), tail=TAIL_SWISH), pup(tail=TAIL_SWISH), pup(),
  ][i]


BODY = {
  'idle': [idle(i) for i in range(8)],
  'working': [
    stack(24, ROCK, (0, pup(head('squint', dy=1), paw=PAW_HIT)), SPARKS),
    stack(24, ROCK, (0, pup(head('squint'), paw=PAW_MID))),
    stack(24, ROCK, (0, pup(head(dy=-1), paw=PAW_UP, tail=TAIL_UP))),
    stack(24, ROCK, (0, pup(head('squint'), paw=PAW_MID))),
  ],
  'thinking': [
    pup(head('up'), fxs=[fx(24, [(3, 3, '*')])]),
    pup(head('up', 'twitch'), fxs=[fx(24, [(3, 3, '*'), (1, 1, '*')])]),
  ],
  'done': [
    pup(head('squint', dy=1), tail=TAIL_SWISH),
    pup(head('happy', 'open'), tail=TAIL_UP, dy=-1, fxs=[HOP]),
    pup(head('happy', 'tongue'), tail=TAIL_UP),
  ],
  'sleeping': [
    stack(24, LYING, head('closed', 'flat', dy=8), fx(24, z_small(20, 2))),
    stack(24, LYING, at(LYING, 0, -1), head('closed', 'flat', dy=8), fx(24, z_big(19, 0) + z_small(16, 3))),
  ],
  'error': [
    pup(head('dazed', 'wavy', 'flat'), fxs=[fx(24, star(3, 1) + star(11, 1))]),
    pup(head('dazed', 'wavy', 'flat', dx=1), fxs=[fx(24, star(1, 3) + star(13, 1))]),
  ],
  'wave': [
    pup(head('happy', 'tongue', dy=1), paw=PAW_FLAP),
    pup(head('happy', 'tongue'), paw=PAW_UP, tail=TAIL_SWISH),
    pup(head('happy', 'tongue'), paw=PAW_FLAP),
    pup(head('happy', 'tongue'), paw=PAW_UP, tail=TAIL_SWISH),
  ],
}
