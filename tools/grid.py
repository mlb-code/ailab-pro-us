"""Tile screenshots (<prefix>-*.png, as written by cdp-shots.mjs) into one contact sheet.

usage: python3 tools/grid.py <prefix> <cols> <out.png>
Requires Pillow (QA-only dependency).
"""
import glob
import sys

from PIL import Image

if len(sys.argv) != 4:
    sys.exit(__doc__)
prefix, cols, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
files = sorted(glob.glob(prefix + '-*.png'))
if not files:
    sys.exit(f'no files match {prefix}-*.png')
ims = [Image.open(f) for f in files]
w, h = ims[0].size
rows = (len(ims) + cols - 1) // cols
sheet = Image.new('RGB', (cols * w + (cols - 1) * 8, rows * h + (rows - 1) * 8), (50, 50, 50))
for i, im in enumerate(ims):
    sheet.paste(im, ((i % cols) * (w + 8), (i // cols) * (h + 8)))
sheet.save(out)
print(out, sheet.size, len(ims))
