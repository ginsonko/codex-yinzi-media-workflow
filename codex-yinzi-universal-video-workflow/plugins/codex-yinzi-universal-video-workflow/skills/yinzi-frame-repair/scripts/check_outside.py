"""Changes outside the intended edit area must be zero.

python check_outside.py BEFORE_DIR AFTER_DIR TRACK.json MASK.png [--thr 2] [--pad 5]

MASK.png is the edit mask in key-frame coordinates (any non-zero = allowed).
Every PNG in AFTER_DIR is compared with the same file name in BEFORE_DIR; the
frame index is the last number in the file name. Frames not in the track must be
identical. Prints per-frame offending pixel counts and the total; exit code 1 if
any pixel outside the (padded, warped) mask differs by more than --thr levels.
"""
import argparse
import json
import os
import re
import sys

import cv2
import numpy as np


def main():
    ap = argparse.ArgumentParser()
    for n in ("before", "after", "track", "mask"):
        ap.add_argument(n)
    ap.add_argument("--thr", type=int, default=2)
    ap.add_argument("--pad", type=int, default=5)
    a = ap.parse_args()
    with open(a.track, encoding="utf-8") as f:
        tr = {int(k): np.array(v["H"]) for k, v in json.load(f).items()}
    M = (cv2.imread(a.mask, 0) > 0).astype(np.uint8) * 255
    total = 0
    for f in sorted(os.listdir(a.after)):
        nums = re.findall(r"\d+", f)
        if not f.lower().endswith(".png") or not nums:
            continue
        i = int(nums[-1])
        A = cv2.imread(os.path.join(a.after, f)).astype(int)
        B = cv2.imread(os.path.join(a.before, f))
        if B is None:
            print(i, "missing in BEFORE_DIR")
            total += 1
            continue
        B = B.astype(int)
        allow = np.zeros(A.shape[:2], bool)
        if i in tr:
            w = cv2.warpPerspective(M, tr[i], (A.shape[1], A.shape[0]), flags=cv2.INTER_NEAREST)
            allow = cv2.dilate(w, np.ones((2 * a.pad + 1,) * 2, np.uint8)) > 0
        n = int(((np.abs(A - B).max(-1) > a.thr) & ~allow).sum())
        total += n
        if n:
            print(i, n)
    print("total offending px", total)
    sys.exit(1 if total else 0)


if __name__ == "__main__":
    main()
