"""The elder: an old shaman. A bald crown, long white hair and a white beard
to his belly, bushy white brows, a grey wolf pelt over his shoulders and a
tall walking staff with the green bead set in its knob. The caveman's build,
sunk a pixel lower into his shoulders."""
from pixelgrid import at, dots, fx, layer, part, stack, star, z_big, z_small
from cast.caveman import B_ARM_DOWN, B_ARM_TUCK, B_CHEER, B_ROCK, B_SIT_ARM, B_SPARKS, B_WAVE, b_wave_tilt

HEAD = part(2, """
..........OOOOO.........
........OOKKSSSOO.......
.......OKKSSSSSSSO......
......OKSSSSSSSSSSO.....
....OOBKSSsssssSSSbOO...
...OBBBBSSSSSSSSSSbbbO..
...OBbBBSSSSSSSSSSSbbO..
...OBBBBSBBBSSSBBBSbbO..
....OBBBSSeSSsSSeSSbbO..
.....OBBSSSSsdsSSSSbbO..
.....OBBBSBBBBBBBSBbbO..
.....OBBBBBBddBBBBBbbO..
......OBBBBBBBBBBBBbO...
.......BBBBBBBBBBBbb....
........BBBBBBBBBbb.....
.........BB.BBB.bb......
..........B....b........
""")

# Expressions, as pixels on HEAD: brows row 9, eyes row 10, mouth row 13.
FACE = {
  'closed': [(10, 10, 'd'), (16, 10, 'd')],
  'aside': [(10, 10, 'S'), (16, 10, 'S'), (11, 10, 'e'), (17, 10, 'e')],
  'crossed': [(10, 10, 'S'), (16, 10, 'S'), (11, 10, 'e'), (15, 10, 'e')],
  'happy': [(10, 10, 'd'), (16, 10, 'd'), (9, 10, 'd'), (17, 10, 'd')],
  'grunt': [(12, 13, 'O'), (13, 13, 'O')],
  'shout': [(11, 13, 'O'), (12, 13, 'O'), (13, 13, 'O'), (14, 13, 'O'), (12, 14, 'd'), (13, 14, 'd')],
  'grin': [(11, 13, 'd'), (12, 13, 'L'), (13, 13, 'L'), (14, 13, 'd'), (12, 14, 'd'), (13, 14, 'd')],
  'wavy': [(11, 13, 'd'), (12, 13, 'B'), (13, 13, 'd'), (14, 13, 'B'), (12, 14, 'd')],
}


def head(*faces):
  return dots(HEAD, [p for f in faces for p in FACE[f]])


# The wolf pelt: over both shoulders, a ragged hem.
TORSO = part(13, """
......OlOlRRRRRRRRRRmOmO
.....OllRlRRRRRRRRRRRRmO
....OlRRRRRRRRRRRRRmO...
....OlRRmRRRRRRRRRmO....
....OlRRRRRRRRmRRRmO....
....ORRRRRmRRRRRmmO.....
....ORRmRRRRRRRRmmO.....
....OmOmRRmOORRmOmO.....
.....OSSdO..OSSSdO......
....OSSSdO.OSSSSdO......
....OOOOOO.OOOOOOO......
""")
SIT_TORSO = part(16, """
......OlllRRRRRRRRRRRmO.
.....OllRRRRRRRRRRRRRRmO
....OlRRRRRRRRRRRRRmO...
....OlRRmRRRRRRRRRmO....
....ORRRRRRRRRmRRRmO....
...ORRRRRmRRRRRRmmmO....
..OSSdRmRRRRRmRmmSSdO...
..OOOOOOOOOOOOOOOOOOO...
""")

# The staff in his right hand (our left), planted on the floor. The bead is
# the stone in its knob.
STAFF_UP = part(0, """
.OOOO...
OwwWVO..
OwGWVO..
OWWWVO..
.OWVVO..
..OWVO..
..OWVO..
..OWVO..
..OWVO..
..OWVO..
..OWVO..
..OWVO..
.OSSSO..
OSSSSSO.
OSdSSSS.
.OSSS...
..OVO...
..OVO...
..OVO...
..OVO...
..OVO...
..OVO...
..OVO...
..OOO...
""")


STAFF_HIGH = part(0, """
.OOOO...
OwwWVO..
OwGWVO..
OWWWVO..
.OWVVO..
..OWVO..
.OSSSO..
OSSSSSO.
OSdSSSO.
.OSSSO..
..OSSO..
..OSSSO.
..OdSSSO
...OSSSS
""")
# Swung like the caveman's club: held mid-shaft, the knob strikes the rock.
STAFF_DIAG = part(4, """
.OOOO....
OwwWVO...
OwGWVO...
OWWWVO...
.OOVVO...
...OWVO..
....OWVO.
....OWVO.
...OSSSO.
..OSSSSSO
..OSdSSSS
...OSSS..
""")
STAFF_HIT = part(6, """
....OOO..
....OVO..
....OVO..
....OVO..
....OVO..
....OVO..
...OSSSO.
..OSSSSSO
..OSdSSSS
...OVWVO.
..OVVWWO.
..OVWGwO.
..OVWwwO.
...OOOO..
""")
STAFF_SWUNG = part(0, """
.OOOO...
OwwWVO..
OwGWVO..
OWWWVO..
.OWVVO..
..OWVO..
..OWVO..
..OWVO..
..OWVO..
..OWVO..
..OWVO..
..OWVO..
.OSSSO..
OSSSSSO.
OSdSSSS.
.OSSS...
..OVO...
..OVO...
..OOO...
""")
STAFF_GROUND = part(19, """
.OOOO.........
OwwWVO........
OwGWVOOOOOOOO.
OWWVVWWWWWWVO.
.OOOOOOOOOOOO.
""")

# His left hand strokes the beard (thinking).
ARM_STROKE = part(13, """
....................OO..
...................OSSO.
..............OOO.OSdSO.
.............OSSSOSSSO..
.............OSdSSSdO...
..............OSSSO.....
...............OOO......
""")


def body(h, arm, staff, head_dy=0, fxs=()):
  return stack(24, TORSO, at(h, 0, head_dy), arm, staff, *fxs)


def hop(h, arm, staff):
  return stack(24, at(TORSO, 0, -1), at(h, 0, -1), at(arm, 0, -1), at(staff, 0, -1))


def stepped(h, staff, fxs=()):
  return stack(24, at(TORSO, 2), at(h, 2), at(B_ARM_TUCK, 2), staff, *fxs)


BODY = {
  'idle': [
    body(head(), B_ARM_DOWN, STAFF_UP),
    body(head(), B_ARM_DOWN, STAFF_UP, head_dy=1),
  ],
  'working': [  # the strike first: it is the still under reduced motion
    stepped(head('shout'), layer(B_ROCK, STAFF_HIT), [B_SPARKS]),
    stepped(head('grunt'), layer(B_ROCK, STAFF_DIAG)),
    stepped(head(), layer(B_ROCK, at(STAFF_SWUNG, 2))),
    stepped(head('grunt'), layer(B_ROCK, STAFF_DIAG)),
  ],
  'thinking': [
    body(head('aside'), ARM_STROKE, STAFF_UP),
    body(head('aside'), at(ARM_STROKE, 0, 1), STAFF_UP),
  ],
  'done': [
    body(head('happy', 'shout'), B_CHEER, STAFF_HIGH),
    hop(head('happy', 'shout'), B_CHEER, STAFF_HIGH),
    body(head('happy', 'grin'), B_CHEER, STAFF_HIGH),
  ],
  'sleeping': [  # sat down against his staff; the head nods and he snores
    stack(24, SIT_TORSO, at(head('closed'), 0, 3), B_SIT_ARM, at(STAFF_UP, 0, 4), fx(24, z_small(19, 3))),
    stack(24, SIT_TORSO, at(head('closed', 'grunt'), 0, 4), B_SIT_ARM, at(STAFF_UP, 0, 4), fx(24, z_big(20, 0) + z_small(17, 4))),
  ],
  'error': [
    stack(24, STAFF_GROUND, at(TORSO, 2), at(head('crossed', 'wavy'), 2), at(B_ARM_TUCK, 2), fx(24, star(5, 2) + star(21, 1))),
    stack(24, STAFF_GROUND, at(TORSO, 2), at(head('crossed', 'wavy'), 3), at(B_ARM_TUCK, 2), fx(24, star(8, 1) + star(19, 3))),
  ],
  'wave': [
    body(head('grin'), B_WAVE, STAFF_UP),
    body(head('happy', 'grin'), b_wave_tilt(-1), STAFF_UP),
    body(head('happy', 'grin'), b_wave_tilt(1), STAFF_UP),
    body(head('grin'), B_WAVE, STAFF_UP),
  ],
}
