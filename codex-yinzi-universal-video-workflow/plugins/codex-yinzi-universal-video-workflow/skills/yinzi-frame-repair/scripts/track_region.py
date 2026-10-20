"""Track a planar or static region from a key frame through a frame range.

python track_region.py FRAMES_DIR KEY X0 Y0 X1 Y1 FIRST LAST OUT.json
                       [--pattern %04d.png] [--interp A-B ...] [--extrap K ...]

FRAMES_DIR holds one PNG per frame, named by --pattern (printf style). Frames
exported by the workflow's local.video.export-frames use --pattern frame-%06d.png
and zero-based indexes. Writes {frame: {"H": 3x3 key->frame, "cc": ecc, "interp": bool}}.

--interp 117-126 : frames strictly between 117 and 126 get their region corners
                   linearly interpolated (an occluder crossed the region).
--extrap 132     : continue the motion of the two previous frames (motion-blurred
                   shot end).
"""
import argparse
import json
import os

import cv2
import numpy as np


def T(x, y):
    return np.array([[1, 0, x], [0, 1, y], [0, 0, 1]], np.float64)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("frames")
    ap.add_argument("key", type=int)
    for n in ("x0", "y0", "x1", "y1", "first", "last"):
        ap.add_argument(n, type=int)
    ap.add_argument("out")
    ap.add_argument("--pattern", default="%04d.png")
    ap.add_argument("--interp", nargs="*", default=[])
    ap.add_argument("--extrap", nargs="*", type=int, default=[])
    a = ap.parse_args()

    def load(i):
        img = cv2.imread(os.path.join(a.frames, a.pattern % i))
        if img is None:
            raise SystemExit(f"missing frame {a.pattern % i} in {a.frames}")
        return img

    ref = load(a.key)
    g = lambda im: cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
    m = np.zeros(ref.shape[:2], np.uint8)
    m[a.y0:a.y1, a.x0:a.x1] = 255
    # A low contrast threshold keeps enough features on dark scenes.
    sift = cv2.SIFT_create(4000, contrastThreshold=0.01)
    k1, d1 = sift.detectAndCompute(g(ref), m)
    tpl = cv2.GaussianBlur(g(ref)[a.y0:a.y1, a.x0:a.x1].astype(np.float32), (0, 0), 1.0)
    T0 = T(a.x0, a.y0)
    crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6)
    out, prev = {}, None
    for i in range(a.first, a.last + 1):
        img = load(i)
        Hm = None
        k2, d2 = sift.detectAndCompute(g(img), None)
        if d1 is not None and d2 is not None and len(k2) > 10:
            mm = cv2.BFMatcher().knnMatch(d1, d2, k=2)
            good = [p[0] for p in mm if len(p) == 2 and p[0].distance < 0.75 * p[1].distance]
            if len(good) >= 12:
                p1 = np.float32([k1[q.queryIdx].pt for q in good])
                p2 = np.float32([k2[q.trainIdx].pt for q in good])
                H, inl = cv2.findHomography(p1, p2, cv2.RANSAC, 2.5)
                if H is not None and inl.sum() >= 12:
                    Hm = H / H[2, 2]
        if Hm is None:
            Hm = prev
        if Hm is None:
            continue
        gi = cv2.GaussianBlur(g(img).astype(np.float32), (0, 0), 1.0)
        W = (Hm @ T0).astype(np.float32)
        # The ECC inputMask is in input-frame coordinates, not template coordinates.
        mask, cc = None, None
        for _ in range(2):
            try:
                cc, W = cv2.findTransformECC(tpl, gi, W, cv2.MOTION_HOMOGRAPHY, crit, mask, 5)
            except cv2.error:
                break
            wp = cv2.warpPerspective(gi, W, (tpl.shape[1], tpl.shape[0]), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
            mt = cv2.erode(((np.abs(wp - tpl) < 18) & (wp > 0)).astype(np.uint8) * 255, np.ones((5, 5), np.uint8))
            mask = cv2.warpPerspective(mt, W, (gi.shape[1], gi.shape[0]), flags=cv2.INTER_NEAREST)
        A = W.astype(np.float64) @ np.linalg.inv(T0)
        A /= A[2, 2]
        out[i] = {"H": A.tolist(), "cc": cc, "interp": False}
        prev = A
        c = cv2.perspectiveTransform(np.float32([[[(a.x0 + a.x1) / 2, (a.y0 + a.y1) / 2]]]), A)[0, 0]
        print(i, None if cc is None else round(cc, 4), c.round(2), flush=True)
    pts = np.float32([[[a.x0, a.y0]], [[a.x1, a.y0]], [[a.x1, a.y1]], [[a.x0, a.y1]]])
    cor = lambda k: cv2.perspectiveTransform(pts, np.array(out[k]["H"]))[:, 0]
    setH = lambda k, C: out.setdefault(k, {}).update(
        H=cv2.getPerspectiveTransform(pts[:, 0], C.astype(np.float32)).tolist(), interp=True)
    for span in a.interp:
        s, e = map(int, span.split("-"))
        for k in range(s + 1, e):
            t = (k - s) / (e - s)
            setH(k, (1 - t) * cor(s) + t * cor(e))
    for k in a.extrap:
        setH(k, cor(k - 1) + (cor(k - 1) - cor(k - 2)))
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump({str(k): v for k, v in sorted(out.items())}, f)


if __name__ == "__main__":
    main()
