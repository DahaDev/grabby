"""
Generates app icons for grabby.

Aesthetic: deep brand-orange square, large cream lowercase 'g' set in
Fraunces Black Italic, with a chunky cream dot. The 'g' descender intentionally
breaks the implicit baseline grid — gives the icon a hand-set, editorial feel
rather than the centered/clean look of every generic downloader app.

Outputs:
  build/icon.png       — 1024x1024 master, used by Linux + as the canonical source
  build/icon.icns      — Mac icon bundle (multiple sizes)
  build/icon.ico       — Windows icon bundle (multiple sizes)
  build/icon-small.png — 256x256 version, used in the landing page
"""

from PIL import Image, ImageDraw, ImageFont, ImageFilter
from pathlib import Path
import struct
import os

BUILD = Path(__file__).parent
SIZE = 1024

ORANGE      = (255, 79, 31)        # brand accent
CREAM       = (244, 241, 234)      # bg/paper
CREAM_SOFT  = (255, 247, 235)      # slightly warmer for the dot
INK         = (26, 26, 26)         # text/shadow

ITALIC = BUILD / "fraunces-latin-900-italic.ttf"

# ---------- Master 1024x1024 ----------
def render_master():
    img = Image.new("RGB", (SIZE, SIZE), ORANGE)

    # Subtle gradient/noise to keep the background from looking flat.
    # We layer a soft radial highlight in the top-left for paper depth.
    overlay = Image.new("L", (SIZE, SIZE), 0)
    od = ImageDraw.Draw(overlay)
    for r in range(SIZE, 0, -8):
        alpha = int(18 * (1 - r / SIZE))
        if alpha > 0:
            od.ellipse([-SIZE*0.3, -SIZE*0.3, r, r], fill=alpha)
    overlay = overlay.filter(ImageFilter.GaussianBlur(radius=80))
    img.paste(CREAM_SOFT, (0, 0), overlay)

    draw = ImageDraw.Draw(img)

    # The 'g' — chunky and italic, positioned so the descender leans into the
    # lower third of the canvas. Font size is large enough to read at 32px.
    g_font = ImageFont.truetype(str(ITALIC), size=int(SIZE * 0.85))

    # Measure 'g' precisely (Fraunces italic has overhang on both sides).
    bbox = draw.textbbox((0, 0), "g", font=g_font)
    g_w = bbox[2] - bbox[0]
    g_h = bbox[3] - bbox[1]

    # Position: slightly left of center, baseline above bottom by ~25%
    # to give the descender room without crowding edges.
    gx = (SIZE - g_w) // 2 - bbox[0] - int(SIZE * 0.04)
    gy = int(SIZE * 0.07) - bbox[1]

    # Drop a soft underlay shadow for depth on light Dock backgrounds.
    shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.text((gx + 8, gy + 12), "g", font=g_font, fill=(0, 0, 0, 90))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=18))
    img.paste(shadow, (0, 0), shadow)

    # The 'g' itself
    draw.text((gx, gy), "g", font=g_font, fill=CREAM)

    # The dot — handled as a separate circle rather than a typed period so we
    # can control size and placement exactly. Place it at the lower-right,
    # roughly where a period would follow the 'g' in the wordmark.
    dot_d = int(SIZE * 0.12)
    dot_x = gx + g_w + int(SIZE * 0.02)
    dot_y = gy + g_h - dot_d - int(SIZE * 0.05)

    # Keep the dot fully inside the safe area (Mac auto-crops to a squircle
    # with ~10% safe inset).
    safe_max_x = SIZE - int(SIZE * 0.12) - dot_d
    if dot_x > safe_max_x:
        dot_x = safe_max_x

    draw.ellipse([dot_x, dot_y, dot_x + dot_d, dot_y + dot_d], fill=CREAM)

    return img


def render_rounded(img, radius_pct=0.225):
    """Apply rounded corners. Mac and Windows both prefer their own corner
    masking these days, but a rounded version is useful for the landing page
    and for Linux desktop environments that don't auto-round."""
    w, h = img.size
    r = int(min(w, h) * radius_pct)
    mask = Image.new("L", (w, h), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, w, h], radius=r, fill=255)
    rounded = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    rounded.paste(img, (0, 0), mask)
    return rounded


def main():
    print("Rendering master icon at 1024x1024...")
    master = render_master()
    master.save(BUILD / "icon.png")
    print(f"  -> {BUILD / 'icon.png'}")

    # Save a properly multi-resolution ICO using PIL's sizes API.
    # Save from the master (1024x1024) and let PIL downscale to each size.
    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    master.save(BUILD / "icon.ico", format="ICO", sizes=ico_sizes)
    print(f"  -> {BUILD / 'icon.ico'} ({len(ico_sizes)} resolutions)")

    # Rounded variant used by the landing page (CSS would also work,
    # but a pre-rendered file simplifies the static page).
    rounded = render_rounded(master)
    rounded.resize((512, 512), Image.LANCZOS).save(BUILD / "icon-rounded-512.png")
    print(f"  -> {BUILD / 'icon-rounded-512.png'}")

    # Note: we don't emit .icns here. electron-builder generates Mac icons
    # from icon.png automatically (it has access to iconutil when building
    # on a Mac, and falls back gracefully otherwise). Producing a half-broken
    # .icns from Pillow is worse than letting electron-builder do it right.

    # Cleanup intermediate font files — not needed at runtime.
    for f in BUILD.glob("fraunces*.woff2"):
        f.unlink()
    print("Done.")


if __name__ == "__main__":
    main()
