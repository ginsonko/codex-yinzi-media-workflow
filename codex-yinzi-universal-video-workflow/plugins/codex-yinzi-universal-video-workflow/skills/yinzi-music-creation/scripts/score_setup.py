# -*- coding: utf-8 -*-
"""精确作曲路线的环境准备：声库、声码器、音源、warble 不进安装包，第一次用时下载到数据目录。

  python score_setup.py --inspect                       # 只读：数据目录里装了什么、缺什么、各自的许可
  python score_setup.py --prepare --components qixuan,alemon [--root D:\\music-data]
  python score_setup.py --adopt alemon=H:\\old\\Alemon_CN&EN&JP_v3.5   # 登记已有的文件夹，不重复下载
  python score_setup.py --licenses                      # 打印许可表（哪些不能商用）

数据目录：--root > 环境变量 OMNI_SCORE_MUSIC_ROOT > <工作流数据目录>/score-music。
下载断点续传、解压后写 installed.json；独立虚拟环境 <root>/venv（pip 缓存也放 <root>/cache）。
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = json.load(open(os.path.join(HERE, "score_assets.json"), encoding="utf-8"))
COMP = ASSETS["components"]
COMMERCIAL = {"yes": "可商用", "no": "不可商用", "unknown": "未写明，按不可商用处理"}


def default_root():
    if os.environ.get("OMNI_SCORE_MUSIC_ROOT"):
        return os.environ["OMNI_SCORE_MUSIC_ROOT"]
    base = os.environ.get("YINZI_WORKFLOW_RUNTIME_DIR")
    if not base:
        if sys.platform == "win32":
            base = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "Yinzi", "CodexVideoWorkflow")
        else:
            base = os.path.join(os.path.expanduser("~"), ".local", "share", "yinzi-codex-video-workflow")
    return os.path.join(base, "score-music")


def state_path(root):
    return os.path.join(root, "installed.json")


def load_state(root):
    p = state_path(root)
    return json.load(open(p, encoding="utf-8")) if os.path.exists(p) else {"components": {}}


def save_state(root, st):
    os.makedirs(root, exist_ok=True)
    tmp = state_path(root) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=1)
    os.replace(tmp, state_path(root))


def free_gb(path):
    p = path
    while not os.path.exists(p):
        p = os.path.dirname(p) or "."
    return shutil.disk_usage(p).free / 1e9


def download(url, dest):
    """Resumable download (keeps a .part file)."""
    part = dest + ".part"
    have = os.path.getsize(part) if os.path.exists(part) else 0
    req = urllib.request.Request(url, headers={"User-Agent": "yinzi-score-music", **({"Range": f"bytes={have}-"} if have else {})})
    with urllib.request.urlopen(req, timeout=60) as r:
        mode = "ab" if have and r.status == 206 else "wb"
        total = int(r.headers.get("Content-Length") or 0) + (have if mode == "ab" else 0)
        done = have if mode == "ab" else 0
        with open(part, mode) as f:
            while True:
                b = r.read(1 << 20)
                if not b:
                    break
                f.write(b)
                done += len(b)
                if total:
                    print(json.dumps({"progress": os.path.basename(dest), "mb": round(done / 1e6), "of_mb": round(total / 1e6)}), file=sys.stderr, flush=True)
    os.replace(part, dest)
    return dest


def unzip_to(zpath, into):
    os.makedirs(into, exist_ok=True)
    with zipfile.ZipFile(zpath) as z:
        z.extractall(into)
    # A zip that wraps everything in one folder -> use that folder.
    items = [x for x in os.listdir(into) if not x.startswith(".")]
    return os.path.join(into, items[0]) if len(items) == 1 and os.path.isdir(os.path.join(into, items[0])) else into


def find_bank_dir(base):
    for dirpath, _, files in os.walk(base):
        if "dsconfig.yaml" in files and ("character.txt" in files or "character.yaml" in files):
            return dirpath
    return base


def ensure_venv(root):
    venv = os.path.join(root, "venv")
    py = os.path.join(venv, "Scripts" if sys.platform == "win32" else "bin", "python.exe" if sys.platform == "win32" else "python")
    if not os.path.exists(py):
        subprocess.check_call([sys.executable, "-m", "venv", venv])
    env = {**os.environ, "PIP_CACHE_DIR": os.path.join(root, "cache", "pip")}
    subprocess.check_call([py, "-m", "pip", "install", "-q", *ASSETS["python_packages"]], env=env)
    return py


def prepare(root, names):
    st = load_state(root)
    need = []
    for n in names:
        for dep in COMP[n].get("needs", []):
            if dep not in need:
                need.append(dep)
        if n not in need:
            need.append(n)
    want_mb = sum(COMP[n].get("size_mb", 0) for n in need if n not in st["components"])
    if free_gb(root) * 1000 < want_mb * 2.2 + 500:
        raise SystemExit(json.dumps({"error": "disk_low", "root": root, "free_gb": round(free_gb(root), 1),
                                     "need_mb": want_mb, "hint": "用 --root 换一个空间够的盘"}, ensure_ascii=False))
    dl = os.path.join(root, "cache", "downloads")
    os.makedirs(dl, exist_ok=True)
    for n in need:
        if n in st["components"] and os.path.exists(st["components"][n]["path"]):
            continue
        c = COMP[n]
        if n == "warble":
            dest = os.path.join(root, "tools", "warble")
            if not os.path.exists(dest):
                subprocess.check_call(["git", "clone", c["git"], dest])
            subprocess.check_call(["git", "-C", dest, "checkout", "-q", c["commit"]])
            py = ensure_venv(root)
            subprocess.check_call([py, "-m", "pip", "install", "-q", "-e", dest], env={**os.environ, "PIP_CACHE_DIR": os.path.join(root, "cache", "pip")})
            path = dest
        elif n == "whisper":
            py = ensure_venv(root)
            path = os.path.join(root, "models", "whisper")
            subprocess.check_call([py, "-c", f"from huggingface_hub import snapshot_download as s; s('{c['hf_repo']}', local_dir=r'{path}')"],
                                  env={**os.environ, "HF_HOME": os.path.join(root, "cache", "hf")})
        else:
            fname = c.get("file") or os.path.basename(c["url"])
            try:
                z = download(c["url"], os.path.join(dl, fname))
            except Exception as e:  # noqa: BLE001
                if not c.get("required"):
                    print(json.dumps({"skipped": n, "reason": str(e), "fallback": c.get("fallback", "")}, ensure_ascii=False), flush=True)
                    continue
                raise
            kind_dir = {"engine": "tools", "soundfont": "soundfonts", "vocoder": "vocoders", "voicebank": "voicebanks"}[c["kind"]]
            if fname.lower().endswith(".zip"):
                # vocoders must sit in vocoders/<name the bank's dsconfig asks for>/
                path = unzip_to(z, os.path.join(root, kind_dir, c.get("dir", n)))
                if c["kind"] == "vocoder" and os.path.basename(path) != c["dir"]:
                    path = os.path.join(root, kind_dir, c["dir"])
                if c["kind"] == "voicebank":
                    path = find_bank_dir(path)
                for ex in c.get("extra", []):
                    ez = download(ex["url"], os.path.join(dl, f"{n}-{os.path.basename(ex['url'])}"))
                    unzip_to(ez, os.path.join(path, ex["into"]))
            else:
                os.makedirs(os.path.join(root, kind_dir), exist_ok=True)
                path = os.path.join(root, kind_dir, fname)
                shutil.move(z, path)
        st["components"][n] = {"path": path, "commercial": c["commercial"], "license": c["license"]}
        save_state(root, st)
    return st


def licenses_report(names=None):
    rows = []
    for n, c in COMP.items():
        if names and n not in names:
            continue
        rows.append({"id": n, "label": c["label"], "commercial": COMMERCIAL[c["commercial"]], "license": c["license"],
                     **({"warn": c["warn"]} if c.get("warn") else {}), **({"credit": c["credit"]} if c.get("credit") else {})})
    return rows


def inspect(root):
    st = load_state(root)
    have = {n: v for n, v in st["components"].items() if os.path.exists(v["path"])}
    venv_py = os.path.join(root, "venv", "Scripts" if sys.platform == "win32" else "bin", "python.exe" if sys.platform == "win32" else "python")
    return {
        "root": root,
        "free_gb": round(free_gb(root), 1),
        "python": venv_py if os.path.exists(venv_py) else None,
        "installed": have,
        "missing_required": [n for n, c in COMP.items() if c.get("required") and n not in have],
        "voicebanks_available": [n for n, c in COMP.items() if c["kind"] == "voicebank"],
        "not_for_commercial_use": [f"{c['label']}：{COMMERCIAL[c['commercial']]}" for n, c in COMP.items() if c["commercial"] != "yes" and (n in have or c["kind"] in ("voicebank", "vocoder"))],
        "ffmpeg": shutil.which("ffmpeg") or os.environ.get("FFMPEG_PATH"),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=None)
    ap.add_argument("--inspect", action="store_true")
    ap.add_argument("--prepare", action="store_true")
    ap.add_argument("--components", default="warble,fluidsynth,sf-generaluser,vocoder-pc-2025,qixuan")
    ap.add_argument("--adopt", action="append", default=[], help="id=已有路径")
    ap.add_argument("--licenses", action="store_true")
    a = ap.parse_args()
    root = os.path.abspath(a.root or default_root())
    if a.licenses:
        print(json.dumps(licenses_report(), ensure_ascii=False, indent=1))
        return
    if a.adopt:
        st = load_state(root)
        for item in a.adopt:
            n, p = item.split("=", 1)
            if n not in COMP or not os.path.exists(p):
                raise SystemExit(json.dumps({"error": "bad_adopt", "item": item}, ensure_ascii=False))
            if n == "python":
                continue
            st["components"][n] = {"path": os.path.abspath(p), "commercial": COMP[n]["commercial"], "license": COMP[n]["license"], "adopted": True}
        save_state(root, st)
    if a.prepare:
        names = [x.strip() for x in a.components.split(",") if x.strip()]
        bad = [x for x in names if x not in COMP]
        if bad:
            raise SystemExit(json.dumps({"error": "unknown_component", "names": bad, "known": list(COMP)}, ensure_ascii=False))
        prepare(root, names)
        print(json.dumps({"prepared": names, "licenses": licenses_report(names)}, ensure_ascii=False, indent=1))
    print(json.dumps(inspect(root), ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
