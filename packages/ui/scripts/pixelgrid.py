"""Grid helpers for the mascot cast (caveman-avatar.py and scripts/cast/*.py).

A sprite is a stack of parts; each part is a full-width grid of letters with
'.' for transparent, so you can see where every pixel sits.
"""


def part(y, art):
  """A layer: rows from the left edge, the first one at canvas row y. Short
  rows are padded with '.', so a part can stop where its pixels do."""
  rows = art.strip('\n').split('\n')
  w = max(len(r) for r in rows)
  return (y, [r.ljust(w, '.') for r in rows])


def at(layer, dx=0, dy=0):
  """The layer moved by whole pixels (stack cuts what leaves the canvas)."""
  y, rows = layer
  return (y + dy, ['.' * dx + r if dx >= 0 else r[-dx:] + '.' * -dx for r in rows])


def flip(layer):
  """The layer mirrored left to right."""
  y, rows = layer
  return (y, [r[::-1] for r in rows])


def dots(layer, pts):
  """The layer with single pixels set; pts are (x, canvas y, letter)."""
  y0, rows = layer
  grid = [list(r) for r in rows]
  for x, y, ch in pts:
    grid[y - y0][x] = ch
  return (y0, [''.join(r) for r in grid])


def fx(size, pts):
  """An effects layer (stars, sparks, z) from points."""
  return dots((0, ['.' * size] * size), pts)


def stack(size, *layers):
  """Layers painted in order onto a size x size canvas."""
  g = [['.'] * size for _ in range(size)]
  for y0, rows in layers:
    for i, row in enumerate(rows):
      if 0 <= y0 + i < size:
        for x, ch in enumerate(row[:size]):
          if ch != '.':
            g[y0 + i][x] = ch
  return [''.join(r) for r in g]


def layer(*layers, size=24):
  """Several layers flattened into one (an arm made of hand + forearm)."""
  return (0, stack(size, *layers))


def star(x, y):
  return [(x, y - 1, '*'), (x - 1, y, '*'), (x, y, '*'), (x + 1, y, '*'), (x, y + 1, '*')]


def z_small(x, y):
  return [(x, y, 'Z'), (x + 1, y, 'Z'), (x + 2, y, 'Z'), (x + 1, y + 1, 'Z'), (x, y + 2, 'Z'), (x, y + 3, 'Z'), (x + 1, y + 3, 'Z'), (x + 2, y + 3, 'Z')]


def z_big(x, y):
  return [(x + i, y, 'Z') for i in range(4)] + [(x + 2, y + 1, 'Z'), (x + 1, y + 2, 'Z')] + [(x + i, y + 3, 'Z') for i in range(4)]

