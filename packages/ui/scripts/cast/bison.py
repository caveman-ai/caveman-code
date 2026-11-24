"""The bison: a calf side on, facing left, all front. A great tawny hump
(sand lit, fur-hi, fur shade) rising over a low, broad head: a dark curly
forelock (hair-hi, fur curls), a short curved bone horn, a fur face with a
lit brow over the eye, a dark muzzle and a long beard of hair strands hanging
to the knees. Behind the hump a smaller dark-fur rump with a tufted tail;
stubby dark legs with grey hooves. The green bead sits in the top of the hump.
Idle breathes through the hump then swishes the tail with a nod; working
butts the rock with its brow, paws the ground (dust) and charges again. No
skin letters, so a skin tone never touches it."""
from pixelgrid import at, dots, fx, layer, part, stack, star, z_big, z_small
from cast.caveman import B_ROCK

PALETTE = {'f': 'sand', 'F': 'fur-hi', 'n': 'fur', 'r': 'fur', 'N': 'hair-hi', 'M': 'hair', 'Y': 'fur-hi', 'k': 'rock-dark', 'm': 'rock-mid', 'p': 'pink'}
LID = 'r'

FAR_LEGS = part(19, """
..........OMO...OMO
..........OMO...OMO
..........OMO...OMO
..........OkO...OkO
..........OOO...OOO
""")
NEAR_FRONT = part(19, """
....OrNMO
....OrNMO
....OrNMO
....OmmkO
....OOOOO
""")
NEAR_BACK = part(19, """
...................OrNMO
...................OrNMO
...................OrNMO
...................OmmkO
...................OOOOO
""")
HIND = part(8, """
...............OOOOO
..............OYYYYYOO
.............OYrrrrrrYO
.............OYrrrrrrrO
.............OYrrrrrrrO
.............OrrrrrrrNO
.............OrrrrrrrNO
.............OrrrrrrNNO
.............OrrrrrNNNO
.............ONrrrNNNNO
..............ONNNNNNNO
...............OOOOOOO
""")
TAIL = part(10, """
......................O
.....................OrO
.....................ONO
.....................ONO
....................OMMO
.....................OMO
......................O
""")
TAIL_UP = part(8, """
.....................OO
....................OrNO
....................ONMO
.....................OMO
......................O
""")
CAPE = part(2, """
.........OOOO
.......OOffffOO
......OffffGfffO
.....OffffFfffffO
.....OfffFFFFFfffO
....OffFFFFFFFFFFO
....OfFFFFFFFFFFFnO
....OfFFFFFFFFnFFnO
....OFFFFFFFFFFFnnO
....OFFFFFFFFnFFnnO
....OFFFFFFFFFFnnnO
....OFFFFFFFFFnnnO
....OFFFFFFFnFnnnO
....OnFFFFFFnnnnO
....OnnFnnFnnnnO
....OnOnnOnnOnO
.....O.OO.OO.O
""")
HEAD = part(6, """
.........OO
........OBO
..OOOOOOBO
.ONNrNNOBbO
ONrNNrNNObO
ONNNrNNNrNNO
ONrFFFFFFrNNO
ONFrrrrerrrNO
ONrrrrrerrrNO
OMNrrrrrrrrNO
OMMNrrrrrrNNO
OMMMNNNNNNNNO
.OMNMNMNMNMNO
.OMNMNMNMNMO
..OMOMNMOMO
..O.O.O.O
""")

# A front hoof pawing the ground: lifted and drawn back (working's wind-up).
PAW = part(18, """
.....OOOO
....OrNMO
....OrNMO
.....OmkO
......OO
""")

# A front leg kicked out under the beard, the hoof forward (wave).
WAVE_HOOF = part(19, """
..OOOOOO
.OmrrNNO
.OkmOOOO
..OO
""")

# The eye is two pixels tall at (7, 13) and (7, 14), under a lit brow; the
# muzzle is the dark front of the face, the mouth at (2, 16).
FACE = {
  'closed': [(7, 13, 'r'), (6, 14, 'O'), (7, 14, 'O'), (8, 14, 'O')],
  'happy': [(7, 14, 'r'), (6, 14, 'O'), (7, 13, 'O'), (8, 14, 'O')],
  'up': [(7, 14, 'r'), (7, 12, 'O'), (7, 13, 'O')],
  'squint': [(7, 13, 'r'), (7, 14, 'r'), (6, 13, 'O'), (7, 14, 'O'), (8, 14, 'O'), (6, 12, 'N'), (7, 12, 'N')],
  'dazed': [(7, 13, 'r'), (7, 14, 'r'), (6, 12, 'O'), (8, 12, 'O'), (7, 13, 'O'), (6, 14, 'O'), (8, 14, 'O')],
  'open': [(1, 16, 'p'), (2, 16, 'p'), (3, 16, 'O'), (2, 17, 'O')],
  'wavy': [(1, 16, 'O'), (2, 15, 'O'), (3, 16, 'O')],
}


def head(*faces):
  return dots(HEAD, [p for f in faces for p in FACE[f]])


def bison(h, hy=0, bob=0, front=NEAR_FRONT, tail=TAIL, lean=0, hoof=None, fxs=()):
  """Legs stay planted; the body rides `bob` (and `lean` sideways), the head
  rides bob + hy. A hoof raised to wave is painted over the beard."""
  up = lambda p: at(p, lean, bob)
  return stack(24, FAR_LEGS, NEAR_BACK, front, up(HIND), up(tail), up(CAPE), at(h, lean, bob + hy), *([hoof] if hoof else []), *fxs)


SPARKS = fx(24, [(7, 19, '*'), (8, 17, '*'), (0, 18, '*'), (6, 15, '*')])
DUST = fx(24, [(12, 22, 'Z'), (13, 21, 'Z')])
CHEER = [fx(24, [(3, 4, '*'), (16, 1, '*')]), fx(24, star(3, 4) + star(18, 1))]

BODY = {
  'idle': [  # a slow breath through the hump, then a swish of the tail and a nod
    bison(head()),
    bison(head()),
    bison(head(), bob=1),
    bison(head(), bob=1),
    bison(head()),
    bison(head(), tail=TAIL_UP),
    bison(head(), hy=1, tail=TAIL_UP),
    bison(head()),
  ],
  'working': [  # the strike first: it is the still under reduced motion; the brow butts the rock
    bison(head('squint'), hy=3, lean=-1, tail=TAIL_UP, fxs=[B_ROCK, SPARKS]),
    bison(head('squint'), hy=1, fxs=[B_ROCK]),
    bison(head(), hy=-1, bob=-1, front=PAW, fxs=[B_ROCK, DUST]),
    bison(head('squint'), hy=2, tail=TAIL_UP, fxs=[B_ROCK]),
  ],
  'thinking': [  # eyes up, chewing it over: the beard works
    bison(head('up'), hy=-1),
    bison(head('up')),
  ],
  'done': [  # a crouch, a buck with the tail up, then it stands tall
    bison(head('happy'), hy=1, bob=1),
    stack(24, at((0, bison(head('happy', 'open'), hy=-1, tail=TAIL_UP)), 0, -2), CHEER[0]),
    bison(head('happy', 'open'), hy=-1, tail=TAIL_UP, fxs=[CHEER[1]]),
  ],
  'sleeping': [  # down on its knees, the beard on the floor
    stack(24, at(HIND, 0, 4), at(TAIL, 0, 4), at(CAPE, 0, 5), at(head('closed'), 0, 3), fx(24, z_small(19, 1))),
    stack(24, at(HIND, 0, 4), at(TAIL, 0, 4), at(CAPE, 0, 4), at(head('closed'), 0, 3), fx(24, z_big(20, 0) + z_small(16, 2))),
  ],
  'error': [  # dazed, stars round the horn, the head lolling
    bison(head('dazed', 'wavy'), hy=1, fxs=[fx(24, star(3, 6) + star(13, 1))]),
    bison(head('dazed', 'wavy'), hy=2, fxs=[fx(24, star(5, 5) + star(12, 1))]),
  ],
  'wave': [  # a front hoof kicked out and shaken hello
    bison(head('happy'), front=FAR_LEGS, hoof=WAVE_HOOF),
    bison(head('happy', 'open'), hy=-1, front=FAR_LEGS, hoof=at(WAVE_HOOF, 0, -1)),
    bison(head('happy', 'open'), hy=-1, front=FAR_LEGS, hoof=WAVE_HOOF),
    bison(head('happy'), front=FAR_LEGS, hoof=at(WAVE_HOOF, 0, -1)),
  ],
}
