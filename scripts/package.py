#!/usr/bin/env python3
"""Create deterministic, unsigned XPI with extension files only."""
from pathlib import Path
import zipfile
root = Path(__file__).resolve().parents[1]
src = root / "extension"
dst = root / "dist" / "hls-grabber-unsigned.xpi"
dst.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(dst, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for p in sorted(x for x in src.rglob("*") if x.is_file()):
        arc = p.relative_to(src).as_posix()
        info = zipfile.ZipInfo(arc, (1980,1,1,0,0,0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        z.writestr(info, p.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
print(dst)
