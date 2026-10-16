#!/usr/bin/env python3
"""Rasterize L4 brand assets from public/llll_logo.png.

Requires Pillow. One-off / regenerate:

  python3 -m venv /tmp/brand-venv
  /tmp/brand-venv/bin/pip install Pillow
  /tmp/brand-venv/bin/python scripts/generate-brand.py
"""

from __future__ import annotations

import base64
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "public" / "llll_logo.png"
PUBLIC = ROOT / "public"
BRAND = PUBLIC / "brand"

BG = (16, 16, 16, 255)
MARK_SIZES = (32, 64, 128, 256, 512)
FAVICON_SIZES = (16, 32, 48)


def square_mark(im: Image.Image, pad_ratio: float = 0.06) -> Image.Image:
    bbox = im.getbbox()
    if bbox is None:
        raise SystemExit("logo has no opaque pixels")
    left, top, right, bottom = bbox
    width, height = right - left, bottom - top
    side = max(width, height)
    pad = int(side * pad_ratio)
    canvas_side = side + pad * 2
    canvas = Image.new("RGBA", (canvas_side, canvas_side), (0, 0, 0, 0))
    cropped = im.crop(bbox)
    canvas.paste(cropped, ((canvas_side - width) // 2, (canvas_side - height) // 2), cropped)
    return canvas


def resize_mark(mark: Image.Image, size: int) -> Image.Image:
    out = mark.resize((size, size), Image.Resampling.LANCZOS)
    if size <= 32:
        out = out.filter(ImageFilter.UnsharpMask(radius=0.6, percent=140, threshold=1))
    return out


def app_icon(mark: Image.Image, size: int, inset: float = 0.16) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), BG)
    inner = max(1, int(size * (1 - 2 * inset)))
    logo = resize_mark(mark, inner)
    xy = (size - inner) // 2
    canvas.paste(logo, (xy, xy), logo)
    return canvas.convert("RGBA")


def og_image(mark: Image.Image) -> Image.Image:
    canvas = Image.new("RGB", (1200, 630), BG[:3])
    inner = 360
    logo = resize_mark(mark, inner)
    canvas.paste(logo, ((1200 - inner) // 2, (630 - inner) // 2), logo)
    return canvas


def write_png(im: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, format="PNG", optimize=True)
    print(f"  {path.relative_to(ROOT)}  {path.stat().st_size} bytes  {im.size}")


def write_svg(png: Path, dest: Path, size: int) -> None:
    b64 = base64.b64encode(png.read_bytes()).decode("ascii")
    dest.write_text(
        (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}">'
            f'<image href="data:image/png;base64,{b64}" width="{size}" height="{size}"/>'
            f"</svg>\n"
        ),
        encoding="utf-8",
    )
    print(f"  {dest.relative_to(ROOT)}  {dest.stat().st_size} bytes")


def main() -> None:
    im = Image.open(SRC).convert("RGBA")
    mark = square_mark(im)
    print(f"source {im.size} -> mark {mark.size}")

    for size in MARK_SIZES:
        write_png(resize_mark(mark, size), BRAND / f"logo-{size}.png")

    favicons: dict[int, Image.Image] = {}
    for size in FAVICON_SIZES:
        favicons[size] = resize_mark(mark, size)
        if size in (16, 32):
            write_png(favicons[size], PUBLIC / f"favicon-{size}x{size}.png")

    ico_path = PUBLIC / "favicon.ico"
    favicons[48].save(
        ico_path,
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48)],
    )
    print(f"  {ico_path.relative_to(ROOT)}  {ico_path.stat().st_size} bytes")

    write_svg(PUBLIC / "favicon-32x32.png", PUBLIC / "favicon.svg", 32)

    write_png(app_icon(mark, 180, inset=0.14), PUBLIC / "apple-touch-icon.png")
    write_png(app_icon(mark, 192, inset=0.18), PUBLIC / "android-chrome-192x192.png")
    write_png(app_icon(mark, 512, inset=0.18), PUBLIC / "android-chrome-512x512.png")
    write_png(og_image(mark), PUBLIC / "og-image.png")


if __name__ == "__main__":
    main()
