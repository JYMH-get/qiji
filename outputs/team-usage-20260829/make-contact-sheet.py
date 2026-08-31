from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

source = Path(__file__).with_name("previews")
paths = sorted(source.glob("*.png"), key=lambda p: (p.name != "总表.png", p.name))
tile_w = 900
label_h = 28
gap = 16
tiles = []
for path in paths:
    image = Image.open(path).convert("RGB")
    scale = min(1, tile_w / image.width)
    image = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)
    tile = Image.new("RGB", (tile_w, label_h + image.height), "white")
    draw = ImageDraw.Draw(tile)
    draw.text((8, 5), path.stem, fill="#203040", font=ImageFont.load_default())
    tile.paste(image, ((tile_w - image.width) // 2, label_h))
    tiles.append(tile)

cols = 2
rows = (len(tiles) + cols - 1) // cols
row_heights = []
for r in range(rows):
    row_heights.append(max(t.height for t in tiles[r * cols : (r + 1) * cols]))
canvas = Image.new("RGB", (cols * tile_w + (cols + 1) * gap, sum(row_heights) + (rows + 1) * gap), "#E9EEF5")
y = gap
for r in range(rows):
    x = gap
    for c in range(cols):
        i = r * cols + c
        if i < len(tiles):
            canvas.paste(tiles[i], (x, y))
        x += tile_w + gap
    y += row_heights[r] + gap
canvas.save(Path(__file__).with_name("all-sheets-contact.png"))
