from PIL import Image, ImageDraw, ImageFont
import os

out_dir = r"E:\opencode-tools-workspace\kdcokenny-opencode-notify\dist\kdco-notify-win\assets"
os.makedirs(out_dir, exist_ok=True)

SIZE = 256
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

mask = Image.new("L", (SIZE, SIZE), 0)
dm = ImageDraw.Draw(mask)
dm.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=56, fill=255)

for y in range(SIZE):
    t = y / (SIZE - 1)
    r = int(16 + t * 8)
    g = int(24 + t * 10)
    b = int(58 + t * 22)
    d.line([(0, y), (SIZE, y)], fill=(r, g, b, 255))

img.putalpha(mask)

hl = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
dhl = ImageDraw.Draw(hl)
dhl.ellipse([-90, -90, 260, 180], fill=(120, 160, 255, 38))
hl.putalpha(Image.composite(hl, Image.new("L", (SIZE, SIZE), 0), hl.split()[3]))
img = Image.alpha_composite(img, hl)

d = ImageDraw.Draw(img)
d.polygon([(70, 96), (150, 128), (70, 160), (64, 152), (128, 128), (64, 104)], fill=(255, 255, 255, 235))
d.rounded_rectangle([(84, 196), (150, 206)], radius=5, fill=(255, 255, 255, 235))

sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
icon = os.path.join(out_dir, "opencode-notify.ico")
img.save(icon, format="ICO", sizes=sizes)
print("icon written:", icon, os.path.getsize(icon))

BW, BH = 620, 180
banner = Image.new("RGBA", (BW, BH), (0, 0, 0, 0))
db = ImageDraw.Draw(banner)
for y in range(BH):
    t = y / (BH - 1)
    r = int(18 + t * 8)
    g = int(28 + t * 10)
    b = int(66 + t * 24)
    db.line([(0, y), (BW, y)], fill=(r, g, b, 255))

db.rectangle([0, 0, 10, BH - 1], fill=(88, 166, 255, 255))

icon_small = img.resize((128, 128), Image.LANCZOS)
banner.alpha_composite(icon_small, (24, 26))

try:
    font_title = ImageFont.truetype("segoeuib.ttf", 44)
    font_sub = ImageFont.truetype("segoeui.ttf", 22)
except Exception:
    font_title = ImageFont.load_default()
    font_sub = ImageFont.load_default()
db.text((176, 42), "OpenCode", font=font_title, fill=(255, 255, 255, 255))
db.text((180, 106), "Task completed / needs your input", font=font_sub, fill=(210, 220, 235, 255))

banner_path = os.path.join(out_dir, "opencode-notify-banner.png")
banner.save(banner_path, format="PNG")
print("banner written:", banner_path, os.path.getsize(banner_path))
