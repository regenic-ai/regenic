"""Build Mac and Windows app icons from the Regenic mark.

Mac and Windows cannot share one PNG:

* macOS (WeChat / Cursor / Notes, Apple Big Sur grid, Mouser,
  Netcatty): bake a squircle on a 1024 canvas with ~10% gutter
  (824/1024). The Dock does **not** mask a square the way iOS does.
* Windows / Linux (Mouser 96% refit, Netcatty full-bleed crop):
  the taskbar slot is the whole tile. The Mac gutter reads as a
  tiny icon, so the same squircle is scaled to ~96% of 1024.

Run from anywhere:

    python3 apps/desktop/scripts/build-app-icon.py
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
BRAND = ROOT / "src" / "brand"
MARK_PATH = BRAND / "logo-mark-white.png"
OUT_MAC_PNG = BRAND / "app-icon.png"
OUT_WIN_PNG = BRAND / "app-icon-win.png"
OUT_ICO = BRAND / "app-icon.ico"
OUT_ICNS = BRAND / "app-icon.icns"

MAC_CANVAS = 1024
# Apple icon grid / WeChat / Cursor measured fill.
MAC_SQUIRCLE = 824
# Windows taskbar has no drop-shadow gutter.
WIN_FILL_RATIO = 980 / 1024
GREEN = (0x6B, 0xED, 0x4A, 255)
MARK_RATIO = 0.55
SQUIRCLE_N = 5.0
ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
ICNS_BASE_SIZES = (16, 32, 128, 256, 512)


def squircle_mask(size: int, n: float = SQUIRCLE_N, supersample: int = 4) -> Image.Image:
    """Superellipse n=5, supersampled — not PIL rounded_rectangle (circular arcs)."""
    big = size * supersample
    yy, xx = np.ogrid[-1 : 1 : big * 1j, -1 : 1 : big * 1j]
    inside = (np.abs(xx) ** n + np.abs(yy) ** n) <= 1.0
    mask = Image.fromarray((inside.astype(np.uint8) * 255))
    mask = mask.filter(ImageFilter.GaussianBlur(supersample * 0.45))
    return mask.resize((size, size), Image.Resampling.LANCZOS)


def crop_opaque(image: Image.Image, pad: int = 2) -> Image.Image:
    arr = np.array(image.convert("RGBA"))
    ys, xs = np.where(arr[:, :, 3] > 16)
    left = max(0, int(xs.min()) - pad)
    top = max(0, int(ys.min()) - pad)
    right = min(arr.shape[1], int(xs.max()) + 1 + pad)
    bottom = min(arr.shape[0], int(ys.max()) + 1 + pad)
    return Image.fromarray(arr[top:bottom, left:right])


def make_plate(side: int, mark: Image.Image) -> Image.Image:
    plate = Image.new("RGBA", (side, side), GREEN)
    mark_side = int(round(side * MARK_RATIO))
    fitted = mark.resize((mark_side, mark_side), Image.Resampling.LANCZOS)
    origin = (side - mark_side) // 2
    plate.alpha_composite(fitted, (origin, origin))
    plate.putalpha(squircle_mask(side))
    return plate


def place_on_canvas(plate: Image.Image, canvas_size: int) -> Image.Image:
    canvas = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    origin = (canvas_size - plate.size[0]) // 2
    canvas.alpha_composite(plate, (origin, origin))
    return canvas


def fill_ratio(image: Image.Image) -> float:
    arr = np.array(image)
    ys, xs = np.where(arr[:, :, 3] > 16)
    return (int(xs.max()) - int(xs.min()) + 1) / image.size[0]


def build_icns(mac_png: Path, out_path: Path) -> None:
    iconutil = shutil.which("iconutil")
    sips = shutil.which("sips")
    if not iconutil or not sips:
        print("skip .icns (need macOS iconutil + sips)")
        return
    with tempfile.TemporaryDirectory(prefix="regenic-iconset-") as tmp:
        iconset = Path(tmp) / "AppIcon.iconset"
        iconset.mkdir()
        for size in ICNS_BASE_SIZES:
            for retina in (False, True):
                pixel = size * 2 if retina else size
                suffix = "@2x" if retina else ""
                dest = iconset / f"icon_{size}x{size}{suffix}.png"
                subprocess.run(
                    [sips, "-z", str(pixel), str(pixel), str(mac_png), "--out", str(dest)],
                    check=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                )
        subprocess.run(
            [iconutil, "-c", "icns", str(iconset), "-o", str(out_path)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )


def main() -> int:
    if not MARK_PATH.is_file():
        print(f"missing mark: {MARK_PATH}", file=sys.stderr)
        return 1
    mark = crop_opaque(Image.open(MARK_PATH))

    mac_plate = make_plate(MAC_SQUIRCLE, mark)
    mac = place_on_canvas(mac_plate, MAC_CANVAS)
    mac.save(OUT_MAC_PNG, "PNG", optimize=True)

    win_side = int(round(MAC_CANVAS * WIN_FILL_RATIO))
    win_plate = mac_plate.resize((win_side, win_side), Image.Resampling.LANCZOS)
    win = place_on_canvas(win_plate, MAC_CANVAS)
    win.save(OUT_WIN_PNG, "PNG", optimize=True)
    win.save(OUT_ICO, format="ICO", sizes=ICO_SIZES)

    build_icns(OUT_MAC_PNG, OUT_ICNS)

    print(f"mac  {OUT_MAC_PNG.name}  fill={fill_ratio(mac):.3f}  (Apple 824/1024 ≈ 0.805)")
    print(f"win  {OUT_WIN_PNG.name}  fill={fill_ratio(win):.3f}  (taskbar ~0.96)")
    print(f"ico  {OUT_ICO.name}  {OUT_ICO.stat().st_size} bytes")
    if OUT_ICNS.exists():
        print(f"icns {OUT_ICNS.name} {OUT_ICNS.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
