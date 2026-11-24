"""The cavewoman: auburn hair to the shoulders with a bone stuck through it,
an open face with a small smile, the green bead on a cord at her throat, and a
bone for a club. The caveman's build: his torso, arms, rock and every pose."""
from pixelgrid import at, dots, fx, layer, part, stack, star, z_big, z_small
from cast.caveman import (
  B_ARM_DOWN, B_ARM_SCRATCH, B_ARM_TUCK, B_CHEER, B_ROCK, B_SIT_ARM, B_SIT_TORSO, B_SPARKS, B_TORSO, B_WAVE,
  b_wave_tilt,
)

PALETTE = {'H': 'ginger', 'h': 'ginger-hi'}

HEAD = part(0, """
.............OO.........
............OBBO........
.........OOOOBbO........
........OhhhHOBO........
.......OhHHHHHOBO.......
......OhHHHHHHHOOO......
.....OhhHHHHHHHHHHO.....
.....OhHHSSSSSSSHHHO....
.....OHHSSSSSSSSSSHHO...
.....OHHSSeSSSSSeSSHHO..
.....OHHSSSSSsSSSSSHHO..
.....OHHSsSSSSSSSsSHHO..
.....OHHHSSSSddSSSHHHO..
......OHHHSSSSSSSHHHHO..
.......OHHHOSGSOHHHHHO..
.......OHHOSSSSSOHHHO...
""")

# Expressions, as pixels on HEAD: brows row 8, eyes row 9, mouth row 12.
FACE = {
  'closed': [(10, 9, 'd'), (16, 9, 'd')],
  'aside': [(10, 9, 'S'), (16, 9, 'S'), (11, 9, 'e'), (17, 9, 'e')],
  'crossed': [(10, 9, 'S'), (16, 9, 'S'), (11, 9, 'e'), (15, 9, 'e')],
  'happy': [(10, 9, 'd'), (16, 9, 'd'), (9, 9, 'd'), (17, 9, 'd')],
  'grunt': [(12, 12, 'O'), (13, 12, 'O'), (14, 12, 'O')],
  'shout': [(12, 12, 'O'), (13, 12, 'O'), (14, 12, 'O'), (12, 13, 'd'), (13, 13, 'd'), (14, 13, 'd')],
  'grin': [(12, 12, 'L'), (13, 12, 'L'), (14, 12, 'L'), (11, 11, 'd'), (15, 11, 'd')],
  'wavy': [(11, 12, 'd'), (12, 13, 'd'), (13, 12, 'd'), (14, 13, 'd'), (15, 12, 'd')],
}


def head(*faces):
  return dots(HEAD, [p for f in faces for p in FACE[f]])


# The bone, in the places the caveman's club goes.
BONE_UP = part(0, """
.OO.OO..
OBBOBBO.
ObBBBbO.
.OBBBO..
..OBbO..
..OBbO..
..OBbO..
..OBbO..
..OBbO..
..OBbO..
..OBbO..
..OBbO..
.OSSSO..
OSSSSSO.
OSdSSSS.
.OSSS...
..OBO...
.OOOOO..
""")
BONE_HIGH = part(1, """
.OO.OO..
OBBOBBO.
ObBBBbO.
.OBBBO..
..OBbO..
..OBbO..
.OSSSO..
OSSSSSO.
OSdSSSO.
.OSSSO..
..OSSO..
..OSSSO.
..OdSSSO
...OSSSS
""")
BONE_DIAG = part(3, """
.OO......
OBBOO....
ObBBBO...
.OBBbBO..
.OBbBbO..
..OOBbO..
....OBbO.
....OBbO.
...OSSSO.
..OSSSSSO
..OSdSSSS
...OSSS..
""")
BONE_HIT = part(12, """
...OSSSO
..OSSSSSO
..OSdSSSS
...OBbO.
...OBbO.
..OBBBO.
.ObBBBbO
.OBBOBBO
..OO.OO.
""")
BONE_GROUND = part(20, """
.OO.......OO
OBBOOOOOOOBBO
ObBBBBBBBBBbO
.OO.......OO.
""")


def body(h, arm, bone, head_dy=0, fxs=()):
  return stack(24, B_TORSO, at(h, 0, head_dy), arm, bone, *fxs)


def hop(h, arm, bone):
  return stack(24, at(B_TORSO, 0, -1), at(h, 0, -1), at(arm, 0, -1), at(bone, 0, -1))


def stepped(h, bone, fxs=()):
  return stack(24, at(B_TORSO, 2), at(h, 2), at(B_ARM_TUCK, 2), bone, *fxs)


BODY = {
  'idle': [
    body(head(), B_ARM_DOWN, BONE_UP),
    body(head(), B_ARM_DOWN, at(BONE_UP, 0, 1), head_dy=1),
  ],
  'working': [
    stepped(head('shout'), layer(B_ROCK, at(BONE_HIT, 0, -1)), [B_SPARKS]),
    stepped(head('grunt'), layer(B_ROCK, BONE_DIAG)),
    stepped(head(), layer(B_ROCK, at(BONE_UP, 2))),
    stepped(head('grunt'), layer(B_ROCK, BONE_DIAG)),
  ],
  'thinking': [
    body(head('aside'), B_ARM_SCRATCH, BONE_UP),
    body(head('aside'), at(B_ARM_SCRATCH, 0, 1), BONE_UP),
  ],
  'done': [
    body(head('happy', 'shout'), B_CHEER, BONE_HIGH),
    hop(head('happy', 'shout'), B_CHEER, BONE_HIGH),
    body(head('happy', 'grin'), B_CHEER, BONE_HIGH),
  ],
  'sleeping': [
    stack(24, B_SIT_TORSO, at(head('closed'), 0, 3), B_SIT_ARM, at(BONE_UP, 0, 4), fx(24, z_small(19, 3))),
    stack(24, B_SIT_TORSO, at(head('closed', 'grunt'), 0, 4), B_SIT_ARM, at(BONE_UP, 0, 4), fx(24, z_big(20, 0) + z_small(17, 4))),
  ],
  'error': [
    stack(24, BONE_GROUND, at(B_TORSO, 2), at(head('crossed', 'wavy'), 2), at(B_ARM_TUCK, 2), fx(24, star(5, 2) + star(21, 1))),
    stack(24, BONE_GROUND, at(B_TORSO, 2), at(head('crossed', 'wavy'), 3), at(B_ARM_TUCK, 2), fx(24, star(8, 1) + star(19, 3))),
  ],
  'wave': [
    body(head('grin'), B_WAVE, BONE_UP),
    body(head('happy', 'grin'), b_wave_tilt(-1), BONE_UP),
    body(head('happy', 'grin'), b_wave_tilt(1), BONE_UP),
    body(head('grin'), B_WAVE, BONE_UP),
  ],
}
