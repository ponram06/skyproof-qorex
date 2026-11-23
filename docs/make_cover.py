"""Render docs/cover.png (1200x675) for the project page. Run: python docs/make_cover.py"""
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 675
BG, INK, MUTED, ACCENT, OK, BAD = (13, 16, 23), (232, 235, 243), (154, 163, 181), (160, 140, 255), (95, 211, 154), (255, 138, 128)
F = "C:/Windows/Fonts/"
bold = lambda s: ImageFont.truetype(F + "segoeuib.ttf", s)
reg = lambda s: ImageFont.truetype(F + "segoeui.ttf", s)
mono = lambda s: ImageFont.truetype(F + "consola.ttf", s)

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# Right: the flight map (permitted area, no-fly zone, route, drop, breach).
cx, cy, R = 905, 380, 230
d.ellipse([cx - R, cy - R, cx + R, cy + R], outline=OK, width=2)
for a in range(0, 360, 8):  # dashed look
    t = math.radians(a)
    d.line([cx + R * math.cos(t), cy + R * math.sin(t), cx + R * math.cos(t + 0.06), cy + R * math.sin(t + 0.06)], fill=BG, width=4)
# To scale: the demo permit (area r 2,000 m; no-fly zone 1,550 m north, r 300 m) and the simulator's route.
S = R / 2000
P = lambda x, y: (cx + x * S, cy - y * S)
nx, ny = P(0, 1550)
nr = 300 * S
d.ellipse([nx - nr, ny - nr, nx + nr, ny + nr], fill=(58, 23, 20), outline=BAD, width=2)
d.text((nx, ny), "NO-FLY", font=bold(12), fill=BAD, anchor="mm")
route = [P(0, 0), P(450, 900), P(450, 1950), P(0, 1950)]
d.line(route, fill=ACCENT, width=5, joint="curve")
for x, y in route[1:-1]:
    d.ellipse([x - 4, y - 4, x + 4, y + 4], fill=ACCENT)
hx, hy = route[0]
d.ellipse([hx - 9, hy - 9, hx + 9, hy + 9], fill=OK)
d.text((hx + 16, hy + 2), "HOME", font=bold(14), fill=OK, anchor="lm")
dx, dy = route[-1]
d.ellipse([dx - 10, dy - 10, dx + 10, dy + 10], fill=BAD)
d.text((cx - R + 10, cy - R - 6), "DROP after DENY  →  B4", font=bold(16), fill=BAD, anchor="ls")
d.line([cx - R + 200, cy - R - 12, dx - 12, dy - 4], fill=BAD, width=2)

# Left: title and the protocol.
d.text((64, 70), "SkyProof", font=bold(78), fill=INK)
d.text((66, 168), "A post-quantum flight-record rollup", font=reg(30), fill=MUTED)
d.text((66, 206), "for autonomous drones on QoreChain", font=reg(30), fill=MUTED)
steps = [
    ("ML-DSA-87", "drone-signed flight records"),
    ("ML-KEM-1024", "sealed to investigator + insurer"),
    ("x/rdk rollup", "batches anchored, receipts verified"),
    ("Watchtower", "re-execute, judge, fraud proofs"),
    ("Withdrawals", "victims paid on QoreChain"),
]
y = 290
for k, v in steps:
    d.rounded_rectangle([64, y, 560, y + 50], radius=10, fill=(21, 26, 36), outline=(38, 45, 59))
    d.text((84, y + 25), k, font=bold(20), fill=ACCENT, anchor="lm")
    d.text((250, y + 25), v, font=reg(19), fill=INK, anchor="lm")
    y += 62
d.text((64, 626), "Build Before Q-Day · Protocol Builders · live on qorechain-diana", font=mono(17), fill=MUTED)

out = Path(__file__).with_name("cover.png")
img.save(out, optimize=True)
print(out, img.size)
