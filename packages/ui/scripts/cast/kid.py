"""The cave kid: half the caveman's height on the same floor, a big head with
a spiky tuft, big eyes (two pixels tall), rosy cheeks, a little leopard
tunic, the green bead on a cord and a small club of his own."""
from pixelgrid import at, dots, fx, layer, part, stack, star, z_big, z_small
from cast.caveman import B_ROCK

# Big eyes: an eye is 'e' over 'O', so a blink (the 'e' turned to skin)
# leaves the lower pixel as the shut lid.
LID = 'S'

HEAD = part(4, """
............OO..........
.........OO.OhO.OO......
.........OhOhHHOhO......
........OhhHHHHHHHO.....
.......OhhHHHHHHHHHO....
......OhhHHHHHHHHHHHO...
......OhHHSSSHHSSSHHO...
......OHSSSSSSSSSSSHO...
......OHSSeSSSSSeSSHO...
......OSSSOSSSSSOSSSO...
......OSsSSSSSSSSSsSO...
.......OSSSSdddSSSSO....
........OOSSSSSSSOO.....
........OOOOSGSOOOO.....
""")

# Expressions, as pixels on HEAD: eyes rows 12-13, mouth row 15.
FACE = {
  'closed': [(10, 12, 'S'), (16, 12, 'S'), (10, 13, 'd'), (9, 13, 'd'), (16, 13, 'd'), (17, 13, 'd')],
  'aside': [(10, 12, 'S'), (10, 13, 'S'), (16, 12, 'S'), (16, 13, 'S'), (11, 12, 'e'), (11, 13, 'O'), (17, 12, 'e'), (17, 13, 'O')],
  'crossed': [(10, 12, 'S'), (10, 13, 'S'), (16, 12, 'S'), (16, 13, 'S'), (11, 12, 'e'), (11, 13, 'O'), (15, 12, 'e'), (15, 13, 'O')],
  'happy': [(10, 13, 'S'), (16, 13, 'S'), (9, 13, 'd'), (10, 12, 'd'), (11, 13, 'd'), (15, 13, 'd'), (16, 12, 'd'), (17, 13, 'd')],
  'grunt': [(12, 15, 'O'), (13, 15, 'O'), (14, 15, 'O')],
  'shout': [(12, 15, 'O'), (13, 15, 'O'), (14, 15, 'O'), (12, 16, 'O'), (13, 16, 'd'), (14, 16, 'O')],
  'grin': [(11, 15, 'd'), (12, 15, 'L'), (13, 15, 'L'), (14, 15, 'L'), (15, 15, 'd'), (12, 16, 'd'), (13, 16, 'd'), (14, 16, 'd')],
  'wavy': [(12, 15, 'S'), (14, 15, 'S'), (11, 15, 'd'), (12, 16, 'd'), (13, 15, 'd'), (14, 16, 'd'), (15, 15, 'd')],
}


def head(*faces):
  return dots(HEAD, [p for f in faces for p in FACE[f]])


TORSO = part(18, """
.......OTDTTTTTTtTO.....
.......OTTTTTDTTtO......
.......OOTtOOOTDtOO.....
........OSSdOOSSdO......
........OSSdOOSSdO......
........OOOOOOOOOO......
""")
# Sitting, legs folded under him (sleeping).
SIT_TORSO = part(19, """
.......OTTTTTTTTTTO.....
.......OTDTTTTTTtTO.....
......OTTTTTDTTTtTO.....
.....OSSdTTtTTTttSSdO...
.....OOOOOOOOOOOOOOOO...
""")

# His left arm (our right).
ARM_DOWN = part(18, """
..................O.....
.................OSO....
.................OSSO...
..................OdSO..
...................OO...
""")
ARM_TUCK = part(18, """
..................O.....
.................OSO....
..............OOOSdO....
.............OSSSSO.....
..............OOOO......
""")
ARM_CHIN = part(13, """
...................OOO..
..................OSSSO.
..................OSdSO.
...................OSO..
...................OSO..
...................OSO..
..................OSSO..
""")
WAVE = part(10, """
...................OOO..
..................OSSSO.
..................OSSdO.
...................OSO..
...................OSO..
...................OSO..
..................OSSO..
.................OSSO...
""")
FIST_UP = part(10, """
..................OOOO..
..................OSdSO.
..................OSSSO.
...................OSO..
...................OSO..
...................OSO..
..................OSSO..
.................OSSO...
""")


def wave_tilt(dx):
  hand, arm = (10, WAVE[1][:3]), (13, WAVE[1][3:])
  return layer(at(hand, dx), arm)


# His right arm (our left) and the club.
CLUB_OUT = part(12, """
.OOOO...
OwwWVO..
OwWWVO..
OWWVVO..
.OWVO...
.OWVO...
OSSSOO..
OSdSSSSS
.OSSSO..
..OVO...
..OVO...
..OOO...
""")
CLUB_HIGH = part(5, """
.OOOO...
OwwWVO..
OwWWVO..
OWWVVO..
.OWVO...
OSSSO...
OSdSO...
.OSSO...
..OSO...
..OSO...
..OSO...
..OSSO..
...OSSO.
....OSSS
""")
# The windup over his shoulder (working): the club up, the arm bent.
CLUB_WINDUP = part(8, """
..OOOO....
.OwwWVO...
.OwWWVO...
.OWWVVO...
..OWVO....
.OSSSO....
.OSdSO....
..OSSO....
...OSSO...
....OSSO..
.....OSSS.
""")
CLUB_DIAG = part(10, """
.OOOO.....
OwwWVO....
OwWWVO....
OWWVVO....
.OOVVO....
...OWVOO..
...OSSSSO.
...OSdSSSO
....OOSSSS
.......OSS
""")
CLUB_HIT = part(15, """
.OOOO.....
OwwWVO....
OwWWVOOO..
OWWVVWVSO.
OWVVVOSdSS
.OOOO.OOO.
""")
CLUB_GROUND = part(20, """
..........
.OOO......
OwWVOOOO..
OWVVWWVO..
.OOOOOOO..
""")


def body(h, arm, club, head_dy=0, fxs=()):
  return stack(24, TORSO, at(h, 0, head_dy), arm, club, *fxs)


def hop(h, arm, club, dy=-2):
  return stack(24, at(TORSO, 0, dy), at(h, 0, dy), at(arm, 0, dy), at(club, 0, dy))


def stepped(h, club, fxs=()):
  return stack(24, at(TORSO, 2), at(h, 2), at(ARM_TUCK, 2), club, *fxs)


SPARKS = fx(24, [(0, 13, '*'), (6, 13, '*'), (7, 21, '*'), (8, 22, '*')])

BODY = {
  'idle': [
    body(head(), ARM_DOWN, CLUB_OUT),
    body(head(), ARM_DOWN, CLUB_OUT, head_dy=1),
  ],
  'working': [  # the strike first: it is the still under reduced motion
    stepped(head('shout'), layer(B_ROCK, CLUB_HIT), [SPARKS]),
    stepped(head('grunt'), layer(B_ROCK, CLUB_DIAG)),
    stepped(head(), layer(B_ROCK, CLUB_WINDUP)),
    stepped(head('grunt'), layer(B_ROCK, CLUB_DIAG)),
  ],
  'thinking': [
    body(head('aside'), ARM_CHIN, CLUB_OUT),
    body(head('aside'), at(ARM_CHIN, 0, 1), CLUB_OUT),
  ],
  'done': [
    body(head('happy', 'shout'), FIST_UP, CLUB_HIGH),
    hop(head('happy', 'shout'), FIST_UP, CLUB_HIGH),
    body(head('happy', 'grin'), FIST_UP, CLUB_HIGH),
  ],
  'sleeping': [
    stack(24, SIT_TORSO, at(head('closed'), 0, 2), at(ARM_TUCK, 0, 1), at(CLUB_OUT, 0, 1), fx(24, z_small(19, 5))),
    stack(24, SIT_TORSO, at(head('closed', 'grunt'), 0, 3), at(ARM_TUCK, 0, 1), at(CLUB_OUT, 0, 1), fx(24, z_big(20, 2) + z_small(17, 6))),
  ],
  'error': [
    stack(24, CLUB_GROUND, at(TORSO, 2), at(head('crossed', 'wavy'), 2), at(ARM_TUCK, 2), fx(24, star(7, 4) + star(21, 3))),
    stack(24, CLUB_GROUND, at(TORSO, 2), at(head('crossed', 'wavy'), 3), at(ARM_TUCK, 2), fx(24, star(10, 3) + star(20, 5))),
  ],
  'wave': [
    body(head('grin'), WAVE, CLUB_OUT),
    body(head('happy', 'grin'), wave_tilt(-1), CLUB_OUT),
    body(head('happy', 'grin'), wave_tilt(1), CLUB_OUT),
    body(head('grin'), WAVE, CLUB_OUT),
  ],
}
