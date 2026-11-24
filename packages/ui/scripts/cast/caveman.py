"""The caveman: the app's face (the 16x16 bust) and the original companion
(the 24x24 body). Every other member of the cast is drawn on his build and
borrows his torso, arms and rock from here."""
from pixelgrid import at, dots, fx, layer, part, stack, star, z_big, z_small


# ── Body, 24x24 ──────────────────────────────────────────────────────────────
# Squat (STYLE.md): head and hair about half his height, a short wide torso,
# stubby legs. He faces us; the club is in his right hand (our left).

B_HEAD = part(1, """
..........OOOOO.........
.........OhhhHHOO.......
........OhhHHHHHHO......
.......OhhHHHHHHHHOO....
......OhhHHHHHHHHHHHO...
.....OhhHHHHHHHHHHhHO...
.....OhHHSSSSSSSHHHHHO..
.....OHHSSSSSSSSSSHhHO..
.....OHHSSeSSsSSeSHHHO..
.....OHHSSSSsdsSSSSHHO..
.....OHHHSHHHHHHHSHHHO..
.....OHHHHHHddHHHHHHHO..
......OHHHHHHHHHHHH.....
.......HHHHHGHHHHH......
........HH.HHH.HH.......
.........H....H.........
""")

# Expressions, as pixels on B_HEAD: brows row 8, eyes row 9, mouth row 12.
B_FACE = {
  'closed': [(10, 9, 'd'), (16, 9, 'd')],
  'aside': [(10, 9, 'S'), (16, 9, 'S'), (11, 9, 'O'), (17, 9, 'O'), (16, 8, 'S')],
  'crossed': [(10, 9, 'S'), (16, 9, 'S'), (11, 9, 'O'), (15, 9, 'O'), (9, 8, 'S'), (17, 8, 'S')],
  'happy': [(10, 9, 'd'), (16, 9, 'd'), (9, 9, 'd'), (17, 9, 'd'), (10, 8, 'S'), (16, 8, 'S')],
  'grunt': [(12, 12, 'O'), (13, 12, 'O')],
  'shout': [(11, 12, 'O'), (12, 12, 'O'), (13, 12, 'O'), (14, 12, 'O'), (12, 13, 'd'), (13, 13, 'd')],
  'grin': [(11, 12, 'L'), (12, 12, 'L'), (13, 12, 'L'), (14, 12, 'L')],
  'wavy': [(11, 12, 'd'), (12, 12, 'H'), (13, 12, 'd'), (14, 12, 'H'), (12, 13, 'd')],
}


def b_head(*faces):
  return dots(B_HEAD, [p for f in faces for p in B_FACE[f]])


B_TORSO = part(13, """
......OSSSSSSSSSSSSSSSO.
.....OSSSSSSSSSSSSSSSSSO
....OTTTTTTTTTTTTTTO....
....OTDTTTTTTTTTTTO.....
....OTTTTTTTTTDTTtO.....
....OTTDTTTTTTTTtO......
....OTTTTTTDTTTttO......
....OOTtOOOTTTOOtOO.....
.....OSSdO..OSSSdO......
....OSSSdO.OSSSSdO......
....OOOOOO.OOOOOOO......
""")

# His left arm (our right).
B_ARM_DOWN = part(15, """
...................OSSSO
..................OdSSO.
..................OdSSO.
.................OOSSSO.
...................OOO..
""")
B_ARM_SCRATCH = part(5, """
....................OOO.
...................OSSSO
...................OSSdO
....................OSSO
....................OSSO
....................OSSO
....................OdSO
...................OSSSO
""")
B_WAVE_HAND = part(2, """
...................OOOO.
..................OSSSSO
.................OSSSSSO
..................OSSSdO
...................OSSO.
""")
B_WAVE_ARM = part(7, """
....................OSSO
....................OSSO
....................OSSO
....................OdSO
....................OdSO
...................OSSSO
""")
B_FIST = part(2, """
...................OOOO.
..................OSSSSO
..................OSdSSO
..................OSSSSO
...................OSSO.
""")
B_ARM_TUCK = part(15, """
..................OSSO..
.................OdSSO..
...............OSSSdO...
...............OOOOO....
""")
# Sitting on the ground, legs folded under him (sleeping).
B_SIT_TORSO = part(16, """
......OSSSSSSSSSSSSSSSO.
.....OSSSSSSSSSSSSSSSSSO
....OTTTTTTTTTTTTTTO....
....OTDTTTTTTTTTTTO.....
....OTTTTTTTTTDTTtO.....
...OTTDTTTTTTTTTtTO.....
..OSSdTTTTTDTTTttSSdO...
..OOOOOOOOOOOOOOOOOOO...
""")
B_SIT_ARM = part(18, """
...................OSSSO
..................OdSSO.
.................OSSSO..
................OSSdO...
................OOOO....
""")
B_WAVE = layer(B_WAVE_HAND, B_WAVE_ARM)
B_CHEER = layer(B_WAVE_ARM, B_FIST)


def b_wave_tilt(dx):
  return layer(at(B_WAVE_HAND, dx), B_WAVE_ARM)


# His right arm and the club.
B_CLUB_UP = part(0, """
..OOOO..................
.OwwWWO.................
OwwWWVVO................
OwWWVWVO................
OWWVVVO.................
OWVWVVO.................
.OVVVO..................
..OWVO..................
..OWVO..................
..OWVO..................
..OWVO..................
..OWVO..................
.OSSSO..................
OSSSSSO.................
OSdSSSS.................
.OSSS...................
..OVO...................
..OOO...................
""")
B_CLUB_HIGH = part(1, """
..OOOO..................
.OwwWWO.................
OwwWWVVO................
OwWWVWVO................
OWWVVVO.................
OWVWVVO.................
.OSSSO..................
OSSSSSO.................
OSdSSSO.................
.OSSSO..................
..OSSO..................
..OSSSO.................
..OdSSSO................
...OSSSS................
""")
B_CLUB_DIAG = part(4, """
.OOOO...................
OwwWWO..................
OwWWVVO.................
OWWVVVO.................
OWVVVO..................
.OOVVO..................
...OWVO.................
....OWVO................
...OSSSO................
..OSSSSSO...............
..OSdSSSS...............
...OSSS.................
""")
B_CLUB_HIT = part(12, """
...OSSSO................
..OSSSSSO...............
..OSdSSSS...............
...OVWVO................
..OVVWWVO...............
.OVWWwwWO...............
.OWWwwwWO...............
..OOOOOO................
""")
B_CLUB_GROUND = part(19, """
.OOOO...................
OwwWVO..................
OwWVVOOOOOO.............
OWVVVWWWWVO.............
.OOOOOOOOOO.............
""")
B_ROCK = part(20, """
.OOOO...................
OlllRO..................
ORmmkkO.................
OOOOOOO.................
""")
B_SPARKS = fx(24, [(0, 17, '*'), (8, 18, '*'), (1, 15, '*'), (9, 15, '*')])


# The poses as a plan: each frame is what is painted under the head, where
# the head goes and with which faces, and what is painted over it. Any head
# drawn on his build plays every pose through it: his own here, and the
# companions people make in the app (@caveman-app/shared companion.ts, from
# the kit caveman-avatar.py writes).
def frame(under, faces=(), dx=0, dy=0, over=()):
  return {'under': under, 'faces': faces, 'dx': dx, 'dy': dy, 'over': over}


def body(faces, arm, club, head_dy=0, fxs=()):
  """Standing. The torso, legs and free arm stay put; the head sinks by head_dy."""
  return frame([B_TORSO], faces, 0, head_dy, [arm, club, *fxs])


def hop(faces, arm, club):
  return frame([at(B_TORSO, 0, -1)], faces, 0, -1, [at(arm, 0, -1), at(club, 0, -1)])


def stepped(faces, club, fxs=()):
  """Two pixels to our right, left hand on his belly: room for the swing and the rock."""
  return frame([at(B_TORSO, 2)], faces, 2, 0, [at(B_ARM_TUCK, 2), club, *fxs])


PLAN = {
  'idle': [
    body((), B_ARM_DOWN, B_CLUB_UP),
    body((), B_ARM_DOWN, at(B_CLUB_UP, 0, 1), head_dy=1),
  ],
  'working': [  # the strike first: it is the still under reduced motion
    stepped(('shout',), layer(B_ROCK, B_CLUB_HIT), [B_SPARKS]),
    stepped(('grunt',), layer(B_ROCK, B_CLUB_DIAG)),
    stepped((), layer(B_ROCK, at(B_CLUB_UP, 2))),
    stepped(('grunt',), layer(B_ROCK, B_CLUB_DIAG)),
  ],
  'thinking': [
    body(('aside',), B_ARM_SCRATCH, B_CLUB_UP),
    body(('aside',), at(B_ARM_SCRATCH, 0, 1), B_CLUB_UP),
  ],
  'done': [
    body(('happy', 'shout'), B_CHEER, B_CLUB_HIGH),
    hop(('happy', 'shout'), B_CHEER, B_CLUB_HIGH),
    body(('happy', 'grin'), B_CHEER, B_CLUB_HIGH),
  ],
  'sleeping': [  # sat down against his club; the head nods and he snores
    frame([B_SIT_TORSO], ('closed',), 0, 3, [B_SIT_ARM, at(B_CLUB_UP, 0, 4), fx(24, z_small(19, 3))]),
    frame([B_SIT_TORSO], ('closed', 'grunt'), 0, 4, [B_SIT_ARM, at(B_CLUB_UP, 0, 4), fx(24, z_big(20, 0) + z_small(17, 4))]),
  ],
  'error': [
    frame([B_CLUB_GROUND, at(B_TORSO, 2)], ('crossed', 'wavy'), 2, 0, [at(B_ARM_TUCK, 2), fx(24, star(5, 2) + star(21, 1))]),
    frame([B_CLUB_GROUND, at(B_TORSO, 2)], ('crossed', 'wavy'), 3, 0, [at(B_ARM_TUCK, 2), fx(24, star(8, 1) + star(19, 3))]),
  ],
  'wave': [
    body(('grin',), B_WAVE, B_CLUB_UP),
    body(('happy', 'grin'), b_wave_tilt(-1), B_CLUB_UP),
    body(('happy', 'grin'), b_wave_tilt(1), B_CLUB_UP),
    body(('grin',), B_WAVE, B_CLUB_UP),
  ],
}


def realize(plan, head):
  """Every pose's frames with `head(*faces)` (a layer) as the head."""
  return {
    pose: [stack(24, *f['under'], at(head(*f['faces']), f['dx'], f['dy']), *f['over']) for f in frames]
    for pose, frames in plan.items()
  }


BODY = realize(PLAN, b_head)


# ── Bust, 16x16 ──────────────────────────────────────────────────────────────
# Head and shoulders: the app's face, avatars, the Caveman engine mark. Reads
# at 16 px: a dome of hair, an open face (forehead, single-pixel eyes, nose),
# the beard from under the nose, the bead.

U_HEAD = part(0, """
.....OOOOOO.....
...OOhhhHHHOO...
..OhhHHHHHHHHO..
.OhhHHHHHHHHHHO.
.OhHSSSSSSSSHHO.
.OHSSSSSSSSSSHO.
.OHSSeSssSeSSHO.
.OHSSSsddsSSSHO.
.OHHSHHHHHHSHHO.
.OHHHHHddHHHHHO.
..OHHHHHHHHHHO..
...OHHHHHHHHO...
....OHHGHHHO....
.....OHHHHO.....
......OOOO......
""")
# Brows row 5, eyes row 6, mouth row 9.
U_FACE = {
  'closed': [(5, 6, 'd'), (10, 6, 'd')],
  'aside': [(5, 6, 'S'), (10, 6, 'S'), (6, 6, 'O'), (11, 6, 'O')],
  'crossed': [(5, 6, 'S'), (10, 6, 'S'), (6, 6, 'O'), (9, 6, 'O'), (3, 5, 'S'), (12, 5, 'S')],
  'happy': [(5, 6, 'd'), (10, 6, 'd'), (3, 5, 'S'), (12, 5, 'S'), (4, 5, 'd'), (11, 5, 'd')],
  'grunt': [(7, 9, 'O'), (8, 9, 'O')],
  'shout': [(6, 9, 'O'), (7, 9, 'O'), (8, 9, 'O'), (9, 9, 'O'), (7, 10, 'd'), (8, 10, 'd')],
  'grin': [(6, 9, 'L'), (7, 9, 'L'), (8, 9, 'L'), (9, 9, 'L')],
  'wavy': [(6, 9, 'd'), (7, 9, 'H'), (8, 9, 'd'), (9, 9, 'H')],
}


def u_head(*faces):
  return dots(U_HEAD, [p for f in faces for p in U_FACE[f]])


U_SHOULDERS = part(10, """
OSO..........OSO
OSSO........OSSO
OSSTO......OTSSO
OSTTTO....OTDTSO
OsTDTTTOOTTTTTsO
OOOOOOOOOOOOOOOO
""")
U_FIST_CHIN = part(10, """
..........OOOO..
.........OSSSSO.
.........OSdSSO.
..........OSSO..
""")
U_HAND_UP = part(3, """
............OOOO
...........OSSSS
...........OSSSS
............OSSO
............OSSO
............OdSO
""")
U_KNOB_HIT = part(10, """
OOO.............
wWVO............
WVVO............
OOO.............
""")
U_KNOB_MID = part(6, """
OOO.............
wWVO............
WVVO............
OVVO............
.OOO............
""")
U_KNOB_UP = part(1, """
OOOO............
wWWVO...........
WWVVO...........
OVVO............
.OO.............
""")


def bust(head, *extra, dy=0):
  return stack(16, U_SHOULDERS, at(head, 0, dy), *extra)


BUST = {
  'idle': [bust(u_head()), bust(u_head(), dy=1)],
  'working': [
    bust(u_head('shout'), U_KNOB_HIT, fx(16, [(4, 9, '*'), (0, 8, '*')]), dy=1),
    bust(u_head('grunt'), U_KNOB_MID),
    bust(u_head(), U_KNOB_UP),
    bust(u_head('grunt'), U_KNOB_MID),
  ],
  'thinking': [bust(u_head('aside'), U_FIST_CHIN), bust(u_head('aside'), at(U_FIST_CHIN, 0, -1))],
  'done': [
    bust(u_head('happy', 'shout'), U_KNOB_UP),
    bust(u_head('happy', 'shout'), at(U_KNOB_UP, 0, -1), dy=-1),
    bust(u_head('happy', 'grin'), U_KNOB_UP),
  ],
  'sleeping': [
    bust(u_head('closed'), fx(16, z_small(13, 0)), dy=1),
    bust(u_head('closed', 'grunt'), fx(16, z_small(13, 0)), dy=2),
  ],
  'error': [
    bust(u_head('crossed', 'wavy'), fx(16, star(1, 1) + star(14, 2))),
    bust(u_head('crossed', 'wavy'), fx(16, star(2, 1) + star(13, 1))),
  ],
  'wave': [
    bust(u_head('grin'), U_HAND_UP),
    bust(u_head('happy', 'grin'), at(U_HAND_UP, -1)),
    bust(u_head('happy', 'grin'), at(U_HAND_UP, 1)),
    bust(u_head('grin'), U_HAND_UP),
  ],
}
