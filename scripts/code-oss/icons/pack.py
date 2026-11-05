# Copyright (c) 2026 Dylan Lambertson. All rights reserved.
"""Writes the rasters rendered by render.html (scripts/code-oss/gen-icons.sh).

Usage: python3 -I pack.py JOBS.json DUMPED_DOM.html OUT_DIR

Each job's "out" entry selects the container:
  png      the PNG as rendered
  ico      PNG-compressed ICO entries; jobs sharing a path become one file
  xpm      XPM2 text with a quantised palette (RGBA input)
  bmp      24-bit uncompressed BMP (RGBA input; alpha is dropped, so render on an opaque background)
Standard library only.
"""
import base64
import html
import json
import os
import re
import struct
import sys


def read_results(dom_path):
    with open(dom_path, encoding="utf-8") as f:
        dom = f.read()
    m = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
    if not m:
        sys.exit("pack.py: no <pre id=\"out\"> in the dumped DOM")
    text = html.unescape(m.group(1))
    if not text.startswith("{"):
        sys.exit("pack.py: renderer failed: " + text[:200])
    return json.loads(text)


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def ico(entries):
    """entries: list of (size, png_bytes), written smallest first."""
    entries = sorted(entries)
    header = struct.pack("<HHH", 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    directory = b""
    for size, png in entries:
        dim = 0 if size >= 256 else size
        directory += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(png), offset)
        offset += len(png)
    return header + directory + b"".join(png for _, png in entries)


def xpm(name, w, h, rgba):
    """Quantises to 5 bits per channel; pixels under 50% alpha are transparent."""
    chars = "".join(chr(c) for c in range(35, 127) if chr(c) not in '"\\')
    palette = {}
    rows = []
    for y in range(h):
        row = []
        for x in range(w):
            i = (y * w + x) * 4
            r, g, b, a = rgba[i:i + 4]
            key = None if a < 128 else (r >> 3, g >> 3, b >> 3)
            if key not in palette:
                palette[key] = len(palette)
            row.append(palette[key])
        rows.append(row)
    cpp = 1
    while len(chars) ** cpp < len(palette):
        cpp += 1

    def code(n):
        s = ""
        for _ in range(cpp):
            s = chars[n % len(chars)] + s
            n //= len(chars)
        return s

    lines = ["/* XPM */", "static char * %s_xpm[] = {" % name, '"%d %d %d %d",' % (w, h, len(palette), cpp)]
    for key, n in palette.items():
        colour = "None" if key is None else "#%02X%02X%02X" % tuple((v << 3) | (v >> 2) for v in key)
        lines.append('"%s\tc %s",' % (code(n), colour))
    for y, row in enumerate(rows):
        lines.append('"%s"%s' % ("".join(code(n) for n in row), "," if y < h - 1 else "};"))
    return ("\n".join(lines) + "\n").encode("ascii")


def bmp(w, h, rgba):
    """Bottom-up 24-bit BI_RGB bitmap at 96 DPI, the format Inno Setup expects."""
    stride = (w * 3 + 3) & ~3
    pixels = bytearray()
    for y in range(h - 1, -1, -1):
        row = bytearray()
        for x in range(w):
            i = (y * w + x) * 4
            r, g, b = rgba[i], rgba[i + 1], rgba[i + 2]
            row += bytes((b, g, r))
        row += b"\0" * (stride - len(row))
        pixels += row
    header = struct.pack("<2sIHHI", b"BM", 54 + len(pixels), 0, 0, 54)
    info = struct.pack("<IiiHHIIiiII", 40, w, h, 1, 24, 0, len(pixels), 3779, 3779, 0, 0)
    return header + info + bytes(pixels)


def main():
    jobs_path, dom_path, out_dir = sys.argv[1:4]
    with open(jobs_path, encoding="utf-8") as f:
        jobs = json.load(f)
    results = read_results(dom_path)
    icos = {}
    for job in jobs:
        data = base64.b64decode(results[job["name"]])
        kind, rel = job["out"]["type"], job["out"]["path"]
        target = os.path.join(out_dir, rel)
        if kind == "png":
            write(target, data)
        elif kind == "ico":
            icos.setdefault(target, []).append((job["w"], data))
        elif kind == "xpm":
            write(target, xpm(job["out"]["symbol"], job["w"], job["h"], data))
        elif kind == "bmp":
            write(target, bmp(job["w"], job["h"], data))
        else:
            sys.exit("pack.py: unknown output type " + kind)
    for target, entries in icos.items():
        write(target, ico(entries))


if __name__ == "__main__":
    main()
