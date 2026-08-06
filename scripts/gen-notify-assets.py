from PIL import Image, ImageDraw, ImageFont
import os

out_dir = r"E:\opencode-tools-workspace\kdcokenny-opencode-notify\dist\kdco-notify-win\assets"
os.makedirs(out_dir, exist_ok=True)

SIZE = 256
BW, BH = 620, 180

# Theme palette: (top, bottom, accent_border) for legacy + (top, bottom, accent) for flat.
#   ready:      green          (task complete)
#   error:      orange         (generic failure)
#   network:    red            (connection interrupted)
#   permission: yellow         (waiting on user / authorization)
#   question:   blue           (question asked)
#   cancelled:  grey           (user stopped the run / ESC)
themes = {
    "ready":      ((18, 70, 45),   (40, 140, 90),  (72, 226, 144), "Task completed",        "READY FOR REVIEW"),
    "error":      ((70, 45, 18),   (150, 95, 30),  (240, 150, 55), "Something went wrong",   "SOMETHING WENT WRONG"),
    "network":    ((72, 28, 22),   (160, 60, 48),  (255, 110, 92), "Connection interrupted", "NETWORK INTERRUPTED"),
    "permission": ((70, 60, 16),   (150, 128, 34), (245, 210, 65), "Waiting on you",         "WAITING FOR CONFIRMATION"),
    "question":   ((20, 48, 74),   (40, 100, 150), (84, 180, 250), "A question was asked",   "QUESTION FOR YOU"),
    "cancelled":  ((52, 56, 62),   (104, 110, 118), (176, 184, 192), "Stopped",              "STOPPED BY YOU"),
}

try:
    font_title = ImageFont.truetype("segoeuib.ttf", 44)
    font_sub = ImageFont.truetype("segoeui.ttf", 22)
    font_cap = ImageFont.truetype("segoeuib.ttf", 20)
    has_fonts = True
except Exception:
    font_title = ImageFont.load_default()
    font_sub = ImageFont.load_default()
    font_cap = font_sub
    has_fonts = False


def flat_icon(accent_rgb):
    """Current style: full 256x256 in a single brand gradient + white logo."""
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    mask = Image.new("L", (SIZE, SIZE), 0)
    dm = ImageDraw.Draw(mask)
    dm.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=56, fill=255)

    r, g, b = accent_rgb
    top = (max(0, r - 90), max(0, g - 80), max(0, b - 40))
    bottom = (min(255, r + 10), min(255, g + 40), min(255, b + 60))
    d = ImageDraw.Draw(img)
    for y in range(SIZE):
        t = y / (SIZE - 1)
        d.line([(0, y), (SIZE, y)], fill=(
            int(top[0] + (bottom[0] - top[0]) * t),
            int(top[1] + (bottom[1] - top[1]) * t),
            int(top[2] + (bottom[2] - top[2]) * t), 255))
    img.putalpha(mask)

    hl = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    dhl = ImageDraw.Draw(hl)
    dhl.ellipse([-90, -90, 260, 180], fill=(255, 255, 255, 30))
    img = Image.alpha_composite(img, hl)

    d = ImageDraw.Draw(img)
    d.polygon([(70, 96), (150, 128), (70, 160), (64, 152), (128, 128), (64, 104)], fill=(255, 255, 255, 235))
    d.rounded_rectangle([(84, 196), (150, 206)], radius=5, fill=(255, 255, 255, 235))
    return img


def legacy_icon(accent_rgb):
    """Previous style, literal: the blue gradient fills the whole square and a
    thin straight right-angle color border frames the four edges, with a white
    terminal prompt "≥" in the center. Nothing else."""
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Blue gradient fills the entire square (straight edges).
    for y in range(SIZE):
        t = y / (SIZE - 1)
        r = int(16 + t * 8)
        g = int(24 + t * 10)
        b = int(58 + t * 22)
        d.line([(0, y), (SIZE - 1, y)], fill=(r, g, b, 255))
    # Thin straight right-angle color border on all four edges (equal width).
    B = 8
    d.rectangle([0, 0, SIZE - 1, B - 1], fill=accent_rgb + (255,))
    d.rectangle([0, SIZE - B, SIZE - 1, SIZE - 1], fill=accent_rgb + (255,))
    d.rectangle([0, 0, B - 1, SIZE - 1], fill=accent_rgb + (255,))
    d.rectangle([SIZE - B, 0, SIZE - 1, SIZE - 1], fill=accent_rgb + (255,))
    # White terminal prompt "≥" centered in the blue block.
    prompt = ImageFont.truetype("segoeuib.ttf", 144)
    d = ImageDraw.Draw(img)
    bbox = d.textbbox((0, 0), "\u2265", font=prompt)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (SIZE - tw) // 2 - bbox[0]
    ty = (SIZE - th) // 2 - bbox[1]
    d.text((tx, ty), "\u2265", font=prompt, fill=(255, 255, 255, 245))
    return img


def banner_for(banner_icon, themed, name, cap, icon_x=38, title_x=180):
    """620x180 hero banner: gradient bg + accent stripe + brand + icon + subtitle.
    `icon_x` is the left offset of the 112px icon; `title_x` offsets the text.
    Used to keep the legacy (square, framed) icon clear of the title text."""
    b = Image.new("RGBA", (BW, BH), (0, 0, 0, 0))
    db = ImageDraw.Draw(b)
    for y in range(BH):
        t = y / (BH - 1)
        if themed:
            top, bottom = themes[name][0], themes[name][1]
            accent = themes[name][2]
            sub = themes[name][3]
        else:
            top, bottom, accent = (18, 28, 66), (26, 38, 90), (88, 166, 255)
            sub = "Task completed / needs your input"
        db.line([(0, y), (BW, y)], fill=(
            int(top[0] + (bottom[0] - top[0]) * t),
            int(top[1] + (bottom[1] - top[1]) * t),
            int(top[2] + (bottom[2] - top[2]) * t), 255))
    db.rectangle([0, 0, 10, BH - 1], fill=accent)
    icon_small = banner_icon.resize((112, 112), Image.LANCZOS)
    b.alpha_composite(icon_small, (icon_x, 34))
    db = ImageDraw.Draw(b)
    db.text((title_x, 42), "OpenCode", font=font_title, fill=(255, 255, 255, 255))
    db.text((title_x + 4, 106), sub, font=font_sub, fill=(210, 220, 235, 255))
    if cap:
        db.text((title_x + 4, 138), cap, font=font_cap, fill=(255, 255, 255, 235))
    return b


def write_ico(img, path, sizes):
    img.save(path, format="ICO", sizes=sizes)
    print("icon written:", path, os.path.getsize(path))


def write_banner(b, path):
    b.save(path, format="PNG")
    print("banner written:", path, os.path.getsize(path))


sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]

# ---- FLAT theme (default): full themed gradient + white logo ----
flat_default = flat_icon((88, 166, 255))
write_ico(flat_default, os.path.join(out_dir, "opencode-notify.ico"), sizes)
write_banner(banner_for(flat_default, False, None, None),
             os.path.join(out_dir, "opencode-notify-banner.png"))
for name in themes:
    icon = flat_icon(themes[name][2])
    write_banner(banner_for(icon, True, name, themes[name][4]),
                 os.path.join(out_dir, f"opencode-notify-banner-{name}.png"))

# ---- LEGACY theme: square blue block + thin color border + terminal prompt ----
legacy_dir = os.path.join(out_dir, "legacy")
os.makedirs(legacy_dir, exist_ok=True)
legacy_default = legacy_icon((88, 166, 255))
write_ico(legacy_default, os.path.join(legacy_dir, "legacy.ico"), sizes)
write_banner(banner_for(legacy_default, False, None, None, icon_x=36, title_x=196),
             os.path.join(legacy_dir, "legacy-banner.png"))
for name in themes:
    icon = legacy_icon(themes[name][2])
    write_banner(banner_for(icon, True, name, themes[name][4], icon_x=36, title_x=196),
                 os.path.join(legacy_dir, f"legacy-banner-{name}.png"))

print("done")
