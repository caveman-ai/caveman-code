"""The sabertooth: a tawny cat stood side on, facing left. A big round head
with two rounded ears (pink inside, the green bead in the near one), a dark
brow stripe, a pink nose, a cream muzzle and cheek ruff and one long bone
fang hanging past the chin; a short body with dark stripes over the back,
thick forelegs, cream paws and a bobbed tail cocked up. Tunic, tunic-shade
and a glint rim on the lit top-left edges; no skin letters.

Idle breathes (the head dips a row) and fidgets once a loop: the bobbed tail
flicks and an ear twitches. It winds a paw up and swipes the rock, crouches
and springs for done with a roar, loafs asleep, and lifts a paw to wave."""
from pixelgrid import at, dots, fx, layer, part, stack, star, z_big, z_small
from cast.caveman import B_ROCK

PALETTE = {'K': 'glint', 'D': 'hair-hi', 'P': 'pink'}
LID = 'T'

HEAD = part(1, """
....OOO..OOO
...OKPPOOKPPO
..OKKTPOKTPGO
..OKTTTTTTTTtO
.OKTTTTTDDTTtO
.OKTTTeTTTTTtO
OKTTTTeTTTTTBtO
OPKTTTTTTTTBBtO
OPPBBTTTTTBBBO
.OBBBOTTTTBBBO
.OBBBBOBBBBBO
..OBbOOOOOOO
..OBbO
..OBbO
...OO
""")

TORSO = part(5, """
.............OOOOOOO
...........OOKKKKKKKOO
..........OKTTTTDTTDTKO
..........OTTTTTDTTDTTtO
.........OTTTTTTTTTTTTtO
.........OTTTTTTTTTTTTtO
........OTTTTTTTTTTTTttO
.......OBTTTTTTTTTTTtttO
.......OBBTTTTTTTTTOtttO
......OBBBBTTTTTTTTOtttO
......OBBBBBTTTTTTOttttO
.......OOOOOOOOOOOOOOOO
""")
TAIL = part(2, """
......................OO
.....................OKtO
....................OKTtO
...................OKTtO
""")
LEGS = part(16, """
.....OBTTTtO......OTTtO
.....OTTTTtO......OTTtO
.....OTTTTtO.....OTTTtO
.....OTTTTtO.....OTTtO
.....OTTTTtO.....OTTtO
.....OTTTTtO.....OTTtO
....OBBBBBtO....OBBBtO
....OOOOOOOO....OOOOOO
""")
FAR = part(16, """
............OttO..OttO
............OttO..OttO
............OttO..OttO
............OttO..OttO
............OttO..OttO
............OttO..OttO
...........ObbtO.ObbtO
...........OOOOO.OOOOO
""")


FACE = {
  'closed': [(6, 6, 'T'), (5, 7, 'O'), (6, 7, 'O'), (7, 7, 'O')],
  'happy': [(6, 7, 'T'), (5, 7, 'O'), (6, 6, 'O'), (7, 7, 'O')],
  'up': [(6, 7, 'T'), (6, 5, 'O')],
  'squint': [(6, 6, 'T'), (6, 7, 'T'), (5, 6, 'O'), (6, 6, 'O'), (7, 7, 'O')],
  'dazed': [(6, 6, 'T'), (6, 7, 'T'), (5, 5, 'O'), (7, 5, 'O'), (6, 6, 'O'), (5, 7, 'O'), (7, 7, 'O')],
  'roar': [(5, 10, 'O'), (6, 10, 'O'), (7, 10, 'O'), (6, 11, 'P'), (7, 11, 'P'), (8, 11, 'O'), (6, 12, 'O'), (7, 12, 'O'), (8, 12, 'O')],
  'twitch': [(9, 1, '.'), (10, 1, '.'), (11, 1, '.'), (9, 2, 'O'), (10, 2, 'O'), (11, 2, 'O'), (12, 2, 'O')],
  'flat': [(9, 1, '.'), (10, 1, '.'), (11, 1, '.'), (8, 2, 'O'), (9, 2, 'O'), (10, 2, 'O'), (11, 2, 'O'), (12, 2, 'O'), (4, 1, '.'), (5, 1, '.'), (6, 1, '.'), (3, 2, '.'), (4, 2, 'O'), (5, 2, 'O'), (6, 2, 'O'), (7, 2, 'O')],
}


def head(*faces, dx=0, dy=0):
  return at(dots(HEAD, [p for f in faces for p in FACE[f]]), dx, dy)


# The near foreleg off the floor: the far one plants under the chest.
LEGS_LIFT = part(16, """
..................OTTtO
..................OTTtO
.......OttO......OTTTtO
.......OttO......OTTtO
.......OttO......OTTtO
.......OttO......OTTtO
......ObbtO.....OBBBtO
......OOOOO.....OOOOOO
""")
PAW_HIT = part(15, """
......OTTTO
.....OTTTtO
....OTTTtO
..OOTTTtO
.OBBBTtO
.OOOOOO
""")
PAW_MID = part(14, """
..OOOOOOOO
.OBBTTTTTO
.OBBTTTTtO
..OOOOOOOO
""")
# Raised forward, claws out (the glint at its tip): the wave and the wind-up.
PAW_UP = part(12, """
.OOO
OBBBOO
OBBTTTOOO
LOOTTTTTO
...OOTTtO
.....OOO
""")


def cat(h=None, tail=TAIL, dy=0, legs=LEGS, legs_dy=0, paw=None, fxs=()):
  under = [FAR, at(tail, 0, dy), at(TORSO, 0, dy), at(legs if paw is None else LEGS_LIFT, 0, legs_dy)]
  return stack(24, *under, h or head(dy=dy), *([] if paw is None else [at(paw, 0, legs_dy)]), *fxs)


TAIL_FLICK = part(2, """
.......................O
......................OKO
.....................OKTtO
...................OOKTtO
""")
PAWS_DOWN = part(21, """
..OOOOO
.OBBBBO
.OOOOOO
""")
ROCK = B_ROCK
SPARKS = fx(24, [(0, 17, '*'), (2, 16, '*'), (7, 18, '*'), (8, 20, '*')])
ROAR = [fx(24, [(0, 4, '*'), (1, 2, '*')]), fx(24, [(0, 3, '*'), (2, 1, '*'), (0, 6, '*')])]


def lying(dy):
  return stack(24, at(TAIL, 0, 6 + dy), at(TORSO, 0, 6 + dy), head('closed', 'flat', dy=7), PAWS_DOWN)


BODY = {
  'idle': [cat(), cat(), cat(head(dy=1)), cat(head(dy=1)), cat(), cat(tail=TAIL_FLICK), cat(head('twitch'), tail=TAIL_FLICK), cat()],
  'working': [  # the strike first: it is the still under reduced motion
    stack(24, ROCK, (0, cat(head('squint', 'roar', dy=1), paw=PAW_HIT)), SPARKS),
    stack(24, ROCK, (0, cat(head('squint'), paw=PAW_MID))),
    stack(24, ROCK, (0, cat(head(dy=-1), paw=PAW_UP, tail=TAIL_FLICK))),
    stack(24, ROCK, (0, cat(head('squint'), paw=PAW_MID))),
  ],
  'thinking': [
    cat(head('up'), fxs=[fx(24, [(15, 2, '*')])]),
    cat(head('up'), tail=TAIL_FLICK, fxs=[fx(24, [(15, 2, '*'), (17, 0, '*')])]),
  ],
  'done': [  # crouch, spring, roar
    cat(head('squint', dy=1), dy=1),
    cat(head('happy', 'roar', dy=-1), dy=-1, legs_dy=-1, tail=TAIL_FLICK, fxs=[ROAR[0]]),
    cat(head('happy', 'roar'), fxs=[ROAR[1]]),
  ],
  'sleeping': [
    stack(24, (0, lying(0)), fx(24, z_small(16, 4))),
    stack(24, (0, lying(-1)), fx(24, z_big(18, 0) + z_small(15, 4))),
  ],
  'error': [
    cat(head('dazed', 'flat'), fxs=[fx(24, star(2, 1) + star(16, 2))]),
    cat(head('dazed', 'flat', dx=1), fxs=[fx(24, star(1, 3) + star(17, 1))]),
  ],
  'wave': [
    cat(head('happy'), paw=PAW_MID),
    cat(head('happy'), paw=PAW_UP),
    cat(head('happy'), paw=PAW_MID, tail=TAIL_FLICK),
    cat(head('happy'), paw=PAW_UP),
  ],
}
