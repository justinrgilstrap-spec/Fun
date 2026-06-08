#!/usr/bin/env python3
"""Generate the home-screen / PWA icon set from the Footprint brand mark.

The mark is a "Z" route of map pins with a terracotta waypoint at its centre
(the same motif as public/logo.svg). The favicon SVG is deliberately faint and
small; this script renders a punchier variant tuned for an app-icon tile:
the glyph fills ~76% of the frame, the route is full-opacity and bolder, and
the dots are enlarged so the mark reads at a glance on the home screen.

iOS always composites an apple-touch-icon onto an opaque rounded square (web
apps can't supply the transparent/tinted icon variants native apps ship), so
we render a full-bleed cream tile and let iOS apply the corner mask.

Pure-PIL so it runs without an SVG renderer. Draws at 4x then downsamples
(LANCZOS) for crisp anti-aliased edges at every target size.

Outputs: public/icons/{apple-touch-icon,icon-256,icon-512,icon-1024}.png
"""

from PIL import Image, ImageDraw

# Brand palette (matches manifest background_color and logo.svg).
BG = (250, 247, 242)          # #faf7f2 cream tile
BLUE = (30, 95, 138)          # #1E5F8A route + corner pins
TERRACOTTA = (204, 107, 73)   # #CC6B49 centre waypoint

# Geometry in a 0..100 design space. The favicon layout, scaled out from the
# centre (50,50) by 1.18 so the glyph fills more of the tile, with heavier
# strokes and larger dots for legibility at icon size.
P1 = (12.2, 24.0)   # top-left pin
P2 = (79.5, 17.0)   # top-right pin
PC = (52.4, 50.0)   # centre waypoint
P4 = (24.0, 83.0)   # bottom-left pin
P5 = (87.8, 76.0)   # bottom-right pin
ROUTE = [P1, P2, PC, P4, P5]

STROKE = 4.6        # route width (design units)
CORNER_R = 6.2      # corner pin radius
CENTRE_R = 9.5      # centre waypoint radius
HALO_R = 15.5       # soft ring around the waypoint


def render(size: int) -> Image.Image:
    ss = 4
    n = size * ss
    img = Image.new("RGBA", (n, n), BG + (255,))
    d = ImageDraw.Draw(img)

    def s(v: float) -> float:
        return v / 100.0 * n

    def dot(p, r, fill):
        x, y = s(p[0]), s(p[1])
        rr = s(r)
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=fill)

    # Soft halo behind the waypoint (terracotta at ~18% opacity).
    dot(PC, HALO_R, TERRACOTTA + (46,))

    # Route: thick lines + dots at every vertex to fake round caps/joins.
    w = int(round(s(STROKE)))
    for a, b in zip(ROUTE, ROUTE[1:]):
        d.line([s(a[0]), s(a[1]), s(b[0]), s(b[1])], fill=BLUE + (255,), width=w)
    for p in ROUTE:
        dot(p, STROKE / 2, BLUE + (255,))

    # Pins and waypoint on top.
    for p in (P1, P2, P4, P5):
        dot(p, CORNER_R, BLUE + (255,))
    dot(PC, CENTRE_R, TERRACOTTA + (255,))

    out = img.resize((size, size), Image.LANCZOS)
    # Flatten onto the cream tile (no transparency on the home screen anyway).
    flat = Image.new("RGB", (size, size), BG)
    flat.paste(out, (0, 0), out)
    return flat


TARGETS = {
    "public/icons/apple-touch-icon.png": 180,
    "public/icons/icon-256.png": 256,
    "public/icons/icon-512.png": 512,
    "public/icons/icon-1024.png": 1024,
}

if __name__ == "__main__":
    import os

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for rel, size in TARGETS.items():
        path = os.path.join(root, rel)
        render(size).save(path, "PNG")
        print(f"wrote {rel} ({size}x{size})")
