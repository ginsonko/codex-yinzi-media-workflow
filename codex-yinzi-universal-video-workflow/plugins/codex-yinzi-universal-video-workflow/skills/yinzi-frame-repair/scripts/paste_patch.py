"""Composite a corrected key frame into tracked frames, keeping occluders on top.

python paste_patch.py KEY_FRAME.png PATCH.png MASK.png TRACK.json IN_DIR OUT_DIR
                      [--pattern %04d.png] [--occ 22]

PATCH.png: the key frame with the corrected object (same size as the key frame;
outside the mask it is ignored). MASK.png: 8-bit alpha, white = replace (feather
it). TRACK.json comes from track_region.py. Each frame is first copied to
OUT_DIR/_pre and always read from there, so the pass can be rerun safely without
compounding the edit. Frames not in the track are not written; copy them from
IN_DIR when assembling with ffmpeg, or pass only the changed frames to
local.video.assemble-frames.
"""
import argparse
import json
import os
import shutil

import cv2
import numpy as np


def main():
    ap = argparse.ArgumentParser()
    for n in ("key", "patch", "mask", "track", "indir", "outdir"):
        ap.add_argument(n)
    ap.add_argument("--pattern", default="%04d.png")
    ap.add_argument("--occ", type=float, default=22.0, help="occluder threshold (levels)")
    a = ap.parse_args()
    K = cv2.imread(a.key).astype(np.float32)
    P = cv2.imread(a.patch).astype(np.float32)
    A = cv2.imread(a.mask, 0).astype(np.float32) / 255
    ring = (cv2.dilate((A > 0.02).astype(np.uint8), np.ones((41, 41), np.uint8)) > 0) & (A < 0.02)
    with open(a.track, encoding="utf-8") as f:
        tr = {int(k): np.array(v["H"]) for k, v in json.load(f).items()}
    pre = os.path.join(a.outdir, "_pre")
    os.makedirs(pre, exist_ok=True)
    for i, H in sorted(tr.items()):
        name = a.pattern % i
        out_path = os.path.join(a.outdir, name)
        src = out_path if os.path.exists(out_path) else os.path.join(a.indir, name)
        bk = os.path.join(pre, name)
        if not os.path.exists(bk):
            shutil.copy2(src, bk)
        F = cv2.imread(bk).astype(np.float32)
        hw = (F.shape[1], F.shape[0])
        Pw = cv2.warpPerspective(P, H, hw, flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
        Kw = cv2.warpPerspective(K, H, hw, flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        Aw = cv2.warpPerspective(A, H, hw, flags=cv2.INTER_LINEAR)
        Rw = cv2.warpPerspective(ring.astype(np.uint8), H, hw, flags=cv2.INTER_NEAREST) > 0
        inside = cv2.warpPerspective(np.ones(K.shape[:2], np.uint8), H, hw, flags=cv2.INTER_NEAREST) > 0
        # Per-frame light match: median ratio on an unchanged ring around the mask.
        ok = Rw & inside & (np.abs(F - Kw).max(-1) < 30)
        g = np.median((F[ok] + 1) / (Kw[ok] + 1), 0) if ok.sum() > 200 else np.ones(3, np.float32)
        Kg, Pg = Kw * g, Pw * g
        k5 = np.ones((5, 5), np.uint8)
        # Pixels far from the warped key frame (with 5x5 min/max tolerance) are
        # something in front of the surface: keep them.
        dd = np.maximum(np.maximum(cv2.erode(Kg, k5) - F, F - cv2.dilate(Kg, k5)), 0).max(-1)
        occ = cv2.morphologyEx((dd > a.occ).astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        occ = cv2.GaussianBlur(cv2.dilate(occ, k5).astype(np.float32), (0, 0), 1.0)
        al = (Aw * (1 - occ) * inside)[..., None]
        cv2.imwrite(out_path, np.clip(F * (1 - al) + Pg * al + 0.5, 0, 255).astype(np.uint8))
        print(i, "gain", g.round(3), "occluded px", int(((Aw > 0.5) & (occ > 0.5)).sum()), flush=True)


if __name__ == "__main__":
    main()
