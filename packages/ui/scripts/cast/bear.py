"""The cave bear: a round teddy of a bear sat facing us. A wide head with two
round ears (pink inside), beady eyes set wide, a sand muzzle with a black
nose, the green bead on a cord under the chin; a sand belly, stubby arms with
sand palms and feet with pink pads. Fur, fur-hi on the lit left, hair-hi in
shade; no skin letters.

Idle breathes (the head dips a row) and fidgets once a loop: a glance aside
and an ear twitch. It raises a paw and slams the rock, thinks paw at chin,
cheers both paws up with a hop for done, sleeps on its front behind its
paws and waves a paw by its cheek."""
from pixelgrid import at, dots, fx, layer, part, stack, star, z_big, z_small
from cast.caveman import B_ROCK

PALETTE = {'U': 'fur', 'u': 'hair-hi', 'Y': 'fur-hi', 'A': 'sand', 'a': 'sand-shade', 'P': 'pink'}
LID = 'U'

HEAD = part(0, """
...OOOO.........OOOO
..OYYYUO.......OUUuuO
..OYPPUOOOOOOOOOUPPuO
..OYPPYYYYYYYYYUUPPuO
...OYYYYYYYUUUUUUUuO
..OYYYUUUUUUUUUUUUUuO
.OYYUUUeUUUUUUUUeUUUuO
.OYUUUUeUUUUUUUUeUUuuO
.OYUUUUUUAAAAAAUUUUuuO
.OUUUUUUAAAOOAAAUUUuuO
..OUUUUUAAAOOAAAUUuuO
..OUUUUUAAAAAAAauuuuO
...OOuuuuaaaaaauuuOO
.....OOOOOOGOOOOOO
""")

TORSO = part(12, """
.....OUUUUUUUUUUUUO
....OYUUUUUUUUUUUUuO
....OYUAAAAAAAAAAUuO
...OYUAAAAAAAAAAAAuuO
...OYUAAAAAAAAAAAAuuO
...OYUAAAAAAAAAAAauuO
...OUUAAAAAAAAAAaauuO
...OUUUAAAAAAAAaauuuO
..OOUUUUaaaaaaauuuuOO
.OAAAAOOOOOOOOOOAAAAO
.OAPPAO........OAPPAO
..OOOO..........OOOO
""")
ARM_L = part(13, """
...OO
..OYUO
..OYUO
.OYUUO
.OYUUO
.OYUUO
.OAAAO
..OOO
""")
ARM_R = part(13, """
...................OO
..................OuuO
..................OuuO
..................OuuuO
..................OuuuO
..................OuuuO
..................OaaaO
...................OOO
""")
ARM_L_HIT = part(13, """
...OO
..OYUO
.OYUUO
OYUUO
OYUUO
OAAAO
OOOOO
""")
# Up by the cheek, the sand palm out: a wave, a cheer, the wind-up.
ARM_L_UP = part(6, """
.OOO
OAAAO
OAAAO
OYUUO
.OYUO
.OYUUO
..OYUO
..OYUO
..OYUO
...OO
""")
ARM_R_UP = (6, [r[::-1].rjust(23, '.').replace('Y', 'u').replace('U', 'u') for r in ARM_L_UP[1]])
# The paw tipped out from the wrist.
ARM_R_WAVE = part(5, """
.....................OO
....................OAAO
...................OAAAO
...................OAAuO
...................OuuO
..................OuuuO
..................OuuO
..................OuuO
..................OuuO
...................OO
""")
ARM_L_MID = part(12, """
.OOOOO
OAYYUUO
OAUUUuO
.OOOOOO
""")
# At the chin, pondering.
ARM_R_CHIN = part(10, """
............OOOO
...........OAAAAO
...........OAAAAuO
............OOuuuuO
..............OuuuuO
...............OuuuO
................OuuuO
.................OuuO
..................OO
""")

FACE = {
  'closed': [(7, 6, 'U'), (16, 6, 'U'), (6, 7, 'O'), (8, 7, 'O'), (15, 7, 'O'), (17, 7, 'O')],
  'happy': [(7, 7, 'U'), (16, 7, 'U'), (6, 7, 'O'), (7, 6, 'O'), (8, 7, 'O'), (15, 7, 'O'), (16, 6, 'O'), (17, 7, 'O')],
  'up': [(7, 7, 'U'), (16, 7, 'U'), (7, 5, 'O'), (16, 5, 'O')],
  'squint': [(7, 6, 'U'), (16, 6, 'U'), (6, 6, 'O'), (8, 7, 'O'), (17, 6, 'O'), (15, 7, 'O')],
  'dazed': [(6, 5, 'O'), (8, 5, 'O'), (7, 6, 'O'), (6, 7, 'O'), (8, 7, 'O'), (7, 7, 'U'),
            (15, 5, 'O'), (17, 5, 'O'), (16, 6, 'O'), (15, 7, 'O'), (17, 7, 'O'), (16, 7, 'U')],
  'open': [(10, 11, 'O'), (11, 11, 'P'), (12, 11, 'P'), (13, 11, 'O'), (11, 12, 'O'), (12, 12, 'O')],
  'grit': [(10, 11, 'O'), (11, 11, 'L'), (12, 11, 'L'), (13, 11, 'O')],
  'wavy': [(10, 11, 'O'), (12, 11, 'O'), (11, 12, 'O'), (13, 12, 'O')],
  'glance': [(7, 6, 'U'), (7, 7, 'U'), (16, 6, 'U'), (16, 7, 'U'), (6, 6, 'e'), (6, 7, 'e'), (15, 6, 'e'), (15, 7, 'e')],
  'twitch': [(3, 0, '.'), (4, 0, '.'), (5, 0, '.'), (6, 0, '.'), (3, 1, 'O'), (4, 1, 'O'), (5, 1, 'O'), (6, 1, 'O')],
}


def head(*faces, dx=0, dy=0):
  return at(dots(HEAD, [p for f in faces for p in FACE[f]]), dx, dy)


def bear(h=None, left=ARM_L, right=ARM_R, dy=0, fxs=()):
  """`dy` lifts the body off the floor (the hop). An arm raised past the
  shoulder (its part starts above row 12) is painted over the head."""
  arms = [at(a, 0, dy) if a else None for a in (left, right)]
  low, high = [a for a in arms if a and a[0] >= 12], [a for a in arms if a and a[0] < 12]
  return stack(24, at(TORSO, 0, dy), *low, h or head(), *high, *fxs)


# Asleep on its front: a round back behind, the head down on its paws.
BACK = part(6, """
......OOOOOOOOOOOO
....OOYYYYUUUUUUUuOO
...OYYUUUUUUUUUUUuuuO
..OYUUUUUUUUUUUUUUuuuO
..OUUUUUUUUUUUUUUUuuuO
..OUUUUUUUUUUUUUUuuuuO
..OUUUUUUUUUUUUUuuuuuO
""")
PAWS = part(20, """
OOOOO..............OOOOO
OAAAAO............OaaaaO
OAPPAO............OaPPaO
OOOOOO............OOOOOO
""")

ROCK = B_ROCK
SPARKS = fx(24, [(0, 14, '*'), (2, 12, '*'), (7, 19, '*')])
CHEER = [fx(24, [(0, 0, '*'), (23, 3, '*')]), fx(24, [(1, 0, '*'), (22, 0, '*'), (0, 3, '*')])]


def lying(dy):
  return stack(24, at(BACK, 0, dy), head('closed', dy=8), PAWS)


BODY = {
  'idle': [
    bear(), bear(), bear(head(dy=1)), bear(head(dy=1)),
    bear(), bear(head('glance')), bear(head('glance', 'twitch')), bear(),
  ],
  'working': [  # the strike first: it is the still under reduced motion
    stack(24, (0, bear(head('squint', 'grit', dy=1), left=None)), ROCK, ARM_L_HIT, SPARKS),
    stack(24, (0, bear(head('squint'), left=ARM_L_MID)), ROCK),
    stack(24, (0, bear(head(), left=ARM_L_UP)), ROCK),
    stack(24, (0, bear(head('squint'), left=ARM_L_MID)), ROCK),
  ],
  'thinking': [
    bear(head('up'), right=ARM_R_CHIN),
    bear(head('up', dx=-1), right=ARM_R_CHIN),
  ],
  'done': [  # squash, spring with both paws up, land beaming
    bear(head('squint', dy=1), left=at(ARM_L, 0, 1), right=at(ARM_R, 0, 1)),
    bear(head('happy', 'open'), left=ARM_L_UP, right=ARM_R_UP, dy=-1, fxs=[CHEER[0]]),
    bear(head('happy', 'open'), left=ARM_L_UP, right=ARM_R_UP, fxs=[CHEER[1]]),
  ],
  'sleeping': [
    stack(24, (0, lying(0)), fx(24, z_small(19, 1))),
    stack(24, (0, lying(-1)), fx(24, z_big(20, 0) + z_small(17, 2))),
  ],
  'error': [
    bear(head('dazed'), fxs=[fx(24, star(2, 1) + star(21, 2))]),
    bear(head('dazed', dx=1), fxs=[fx(24, star(1, 3) + star(22, 1))]),
  ],
  'wave': [
    bear(head('happy', 'open'), right=at(ARM_R_UP, 0, 2)),
    bear(head('happy', 'open'), right=ARM_R_UP),
    bear(head('happy', 'open'), right=ARM_R_WAVE),
    bear(head('happy', 'open'), right=ARM_R_UP),
  ],
}
