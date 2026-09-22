#!/usr/bin/env python3
"""Read-only inspection by default; --prepare installs an isolated draft runtime.

Does not install, launch, downgrade, or register Jianying, download templates,
change global Python packages, or activate unattended GUI export.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid


def probe(python):
    if not python:
        return {"ready": False, "reason": "No configured draft interpreter"}
    try:
        process = subprocess.run([str(python), str(Path(__file__).with_name("jianying-draft.py")), "probe"],
                                 check=False, capture_output=True, text=True, encoding="utf-8", timeout=30,
                                 env={**os.environ, "PYTHONUTF8": "1"})
        result = json.loads(process.stdout)
        result["ready"] = process.returncode == 0 and result.get("ready") is True
        return result
    except Exception as exc:
        return {"ready": False, "reason": str(exc)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--inspect", action="store_true", help="Read-only readiness inspection (the default)")
    modes.add_argument("--prepare", action="store_true", help="Create an isolated venv, install pinned draft builder, and save config")
    modes.add_argument("--adopt", action="store_true", help="Verify an existing --python environment and save it; never pip install there")
    parser.add_argument("--python", type=Path, help="Existing interpreter to adopt, or Python used to create a fresh venv")
    parser.add_argument("--root", type=Path, default=Path.home() / ".yinzi-media" / "jianying", help="Isolated environment directory (default: ~/.yinzi-media/jianying)")
    parser.add_argument("--config", type=Path, default=Path(os.environ.get("YINZI_JIANYING_CONFIG", str(Path.home() / ".yinzi-media" / "jianying.json"))), help="Config destination; existing unrelated fields are retained")
    parser.add_argument("--executable", type=Path, help="Optional installed Jianying executable; not launched")
    parser.add_argument("--drafts-root", type=Path, help="Optional existing editor drafts directory; otherwise detected from Jianying settings")
    parser.add_argument("--index-url", help="Optional trusted pip package index for --prepare")
    args = parser.parse_args()
    root, config_path = args.root.expanduser().resolve(), args.config.expanduser().resolve()
    if args.adopt and not args.python:
        parser.error("--adopt requires --python")
    if args.index_url and not args.prepare:
        parser.error("--index-url applies only to --prepare")
    if args.executable and not args.executable.is_file():
        parser.error("--executable must name an existing application")
    if args.drafts_root and not args.drafts_root.is_dir():
        parser.error("--drafts-root must name an existing directory")
    initial = config_path.read_bytes() if config_path.exists() else None
    existing = json.loads(initial.decode("utf-8-sig")) if initial is not None else {}
    if not isinstance(existing, dict):
        parser.error("Existing config is not an object; it has been left untouched")
    if not args.prepare and not args.adopt:
        configured_python = args.python or existing.get("python")
        if configured_python and not Path(configured_python).is_absolute():
            configured_python = config_path.parent / configured_python
        print(json.dumps({"status": "inspected", "stage": "environment_inspected", "config_path": str(config_path),
                          "config_exists": initial is not None, "dependency": probe(configured_python),
                          "note": "Read-only; use --prepare for an isolated install or --adopt --python for an existing runtime."}, ensure_ascii=False))
        return
    selected_python = args.python.resolve() if args.python else Path(sys.executable)
    if not selected_python.is_file():
        parser.error("--python must name an existing interpreter")
    env = root / "venv"
    if args.prepare and env.exists() and not (env / "pyvenv.cfg").is_file():
        parser.error("Environment directory already exists but is not a venv; refusing to overwrite")
    config_path.parent.mkdir(parents=True, exist_ok=True)
    lock = config_path.with_name(config_path.name + ".setup.lock")
    try:
        lock_fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        parser.error("Setup is already running or left a recovery lock; inspect that operation before continuing")
    try:
        os.write(lock_fd, json.dumps({"pid": os.getpid(), "started": datetime.now(timezone.utc).isoformat()}).encode())
        if args.prepare:
            subprocess.run([str(selected_python), "-c", "import sys; assert sys.version_info >= (3,10), 'Python 3.10+ is required'"], check=True)
            root.mkdir(parents=True, exist_ok=True)
            if not env.exists():
                subprocess.run([str(selected_python), "-m", "venv", str(env)], check=True)
            python = env / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
            command = [str(python), "-m", "pip", "install", "--disable-pip-version-check", "pyJianYingDraft==0.3.0"]
            if args.index_url:
                command.extend(["--index-url", args.index_url])
            subprocess.run(command, check=True)
        else:
            python = selected_python
        result = probe(python)
        if result.get("ready") is not True:
            raise RuntimeError("Dependency import/version verification did not pass: " + json.dumps(result, ensure_ascii=False))
        current = config_path.read_bytes() if config_path.exists() else None
        if current != initial:
            raise RuntimeError("Configuration changed during setup; verified environment is retained, but current config was not overwritten")
        if current is not None:
            backup = config_path.with_name(config_path.name + ".before-" + uuid.uuid4().hex[:8])
            backup.write_bytes(current)
        settings = {**existing, "python": str(python), "library": "pyJianYingDraft==0.3.0", "setup_at": datetime.now(timezone.utc).isoformat()}
        if args.executable:
            settings["executable"] = str(args.executable.resolve())
        if args.drafts_root:
            settings["drafts_root"] = str(args.drafts_root.resolve())
        temp = config_path.with_name(config_path.name + "." + uuid.uuid4().hex + ".tmp")
        temp.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(config_path)
        print(json.dumps({"status": "configured", "mode": "prepare" if args.prepare else "adopt", "config_path": str(config_path), "python": str(python),
                          "library": "pyJianYingDraft==0.3.0", "editor_installed_by_setup": False,
                          "note": "Only draft dependencies are ready. Editor loading, preset licensing, export and visual quality still require validation."}, ensure_ascii=False))
    finally:
        os.close(lock_fd)
        lock.unlink()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"status": "failed", "error": str(exc)}, ensure_ascii=False))
        sys.exit(1)
