"""Contact sheets and before/after panels for visual QA.

python sheet.py grid FRAMES_DIR OUT.jpg 0,12,24,...  [--crop x0:y0:x1:y1] [--w 448] [--pattern %04d.png]
python sheet.py ba BEFORE_DIR AFTER_DIR OUT.jpg 40,90,138 [--crop x0:y0:x1:y1] [--w 320] [--gain 1.4]

`ba` stacks BEFORE above AFTER for each listed frame. --gain brightens dark
scenes for inspection only.
"""
import argparse
import os

import cv2
import numpy as np


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["grid", "ba"])
    ap.add_argument("dirs", nargs="+")
    ap.add_argument("--crop")
    ap.add_argument("--w", type=int, default=0)
    ap.add_argument("--gain", type=float, default=1.0)
    ap.add_argument("--cols", type=int, default=3)
    ap.add_argument("--pattern", default="%04d.png")
    a = ap.parse_args()

    def load(d, i):
        f = cv2.imread(os.path.join(d, a.pattern % i))
        if f is None:
            raise SystemExit(f"missing frame {a.pattern % i} in {d}")
        if a.crop:
            x0, y0, x1, y1 = map(int, a.crop.split(":"))
            f = f[y0:y1, x0:x1]
        return f

    def label(img, t):
        cv2.putText(img, t, (5, 22), 0, 0.7, (0, 255, 255), 2)
        return img

    if a.mode == "grid":
        d, out, ids = a.dirs
        w = a.w or 448
        tiles = []
        for i in map(int, ids.split(",")):
            f = load(d, i)
            tiles.append(label(cv2.resize(f, (w, int(f.shape[0] * w / f.shape[1]))), str(i)))
        while len(tiles) % a.cols:
            tiles.append(np.zeros_like(tiles[0]))
        img = np.vstack([np.hstack(tiles[j:j + a.cols]) for j in range(0, len(tiles), a.cols)])
    else:
        b, af, out, ids = a.dirs
        w = a.w or 320
        cols = []
        for i in map(int, ids.split(",")):
            x = np.vstack([load(b, i), load(af, i)])
            cols.append(label(cv2.resize(x, (w, int(x.shape[0] * w / x.shape[1]))), str(i)))
        img = np.hstack(cols)
    img = np.clip(img.astype(np.float32) * a.gain, 0, 255).astype(np.uint8)
    cv2.imwrite(out, img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    print(out, img.shape)


if __name__ == "__main__":
    main()
