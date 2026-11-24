"""Builds resources/dmg-background.tiff: the picture behind the two icons in the
DMG's Finder window (docs/, "the ember trail").

A 640 x 400 window: white, so Finder's dark icon labels read in light and
dark mode alike, a line of 4 px pixel embers (the app icon's own
grid) brightening toward Applications and ending in a stepped chevron, and
one line of Inter. The icons themselves are Finder's, at 128 px, centred at
APP and APPLICATIONS (package.mjs places them there); Finder draws their
labels. The TIFF holds the 1x and 2x pictures, so the window is sharp on
Retina.

Needs python3, rsvg-convert (brew install librsvg), the Inter font installed
(rsvg-convert finds it through fontconfig) and macOS tiffutil. The outputs are
committed; a release build only reads them.
"""
import os
import subprocess
import tempfile

W, H = 640, 400
APP = (180, 190)           # the app icon's centre, as package.mjs places it
APPLICATIONS = (460, 190)  # the Applications link's centre
ICON = 128
TUNIC = '#eb9e3d'
CAPTION = 'Drag Caveman Code into Applications'

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'resources')


def trail():
  """Pixel embers from the app's edge to the folder's, brightening as they go, then a stepped chevron."""
  y = APP[1] - 2
  start = APP[0] + ICON // 2 + 18
  end = APPLICATIONS[0] - ICON // 2 - 30
  xs = list(range(start, end + 1, 12))
  rects = []
  for i, x in enumerate(xs):
    opacity = 0.35 + 0.55 * i / max(1, len(xs) - 1)
    rects.append(f'<rect x="{x}" y="{y}" width="4" height="4" fill="{TUNIC}" opacity="{opacity:.2f}"/>')
  tip = xs[-1] + 12
  for dx, dy in [(0, -8), (4, -4), (8, 0), (4, 4), (0, 8)]:
    rects.append(f'<rect x="{tip + dx}" y="{y + dy}" width="4" height="4" fill="{TUNIC}" opacity="0.9"/>')
  return ''.join(rects)


def svg():
  return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
  <rect width="{W}" height="{H}" fill="#ffffff"/>
  {trail()}
  <text x="{W / 2}" y="{H - 34}" text-anchor="middle" font-family="Inter" font-size="12" fill="#6b6d72">{CAPTION}</text>
</svg>'''


def main():
  os.makedirs(OUT, exist_ok=True)
  with tempfile.TemporaryDirectory() as tmp:
    source = os.path.join(tmp, 'background.svg')
    with open(source, 'w') as f:
      f.write(svg())
    one = os.path.join(tmp, 'background.png')
    two = os.path.join(tmp, 'background@2x.png')
    subprocess.run(['rsvg-convert', '-w', str(W), '-h', str(H), source, '-o', one], check=True)
    subprocess.run(['rsvg-convert', '-w', str(W * 2), '-h', str(H * 2), source, '-o', two], check=True)
    # One TIFF with both resolutions: Finder picks the one the display needs.
    subprocess.run(['tiffutil', '-cathidpicheck', one, two, '-out', os.path.join(OUT, 'dmg-background.tiff')], check=True)


if __name__ == '__main__':
  main()
