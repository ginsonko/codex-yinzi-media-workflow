"""Build a static progress page from <project>/repair.json.

python dashboard.py PROJECT_DIR      -> PROJECT_DIR/dashboard.html (open in a browser)

repair.json:
{
  "title": "...", "source": "in.mp4", "tier": "快速|常规|精细", "live": true,
  "issues":  [{"id": "D1", "title": "...", "severity": "高|中|低", "frames": "42-133",
               "status": "todo|doing|done|skipped", "notes": "...", "images": ["rel/path.jpg"]}],
  "assets":  [{"name": "...", "path": "rel/path.png", "notes": "..."}],
  "renders": [{"name": "...", "path": "rel/path.mp4|jpg", "notes": "..."}],
  "log":     [{"time": "2026-10-14 21:00", "text": "..."}]
}
All paths are relative to PROJECT_DIR. With "live": true the page reloads every 15 s.
"""
import html
import json
import os
import sys

CSS = """
body{font-family:system-ui,'Microsoft YaHei',sans-serif;margin:0;background:#111;color:#ddd}
header{padding:14px 22px;background:#1b1b1b;border-bottom:1px solid #333}
h1{margin:0;font-size:20px} .meta{color:#999;font-size:13px;margin-top:4px}
nav a{color:#9cf;margin-right:16px;text-decoration:none} section{padding:12px 22px}
h2{font-size:16px;border-bottom:1px solid #333;padding-bottom:6px}
table{border-collapse:collapse;width:100%} td,th{border-bottom:1px solid #2a2a2a;padding:6px;vertical-align:top;font-size:13px}
.b{padding:2px 8px;border-radius:9px;font-size:12px}
.done{background:#1f5f2f}.doing{background:#6a5310}.todo{background:#444}.skipped{background:#5a2a2a}
.grid{display:flex;flex-wrap:wrap;gap:12px}.card{background:#1b1b1b;border:1px solid #333;border-radius:6px;padding:8px;width:420px}
.card img,.card video{width:100%;border-radius:4px}.card .n{font-weight:600;margin:4px 0}.card .t{color:#aaa;font-size:12px}
.thumbs img{height:90px;margin:2px;border-radius:3px}.prog{height:8px;background:#333;border-radius:4px;overflow:hidden;width:260px}
.prog div{height:100%;background:#3a8}
"""


def media(path):
    p = html.escape(path)
    if path.lower().endswith((".mp4", ".webm", ".mov")):
        return f'<video src="{p}" controls preload="metadata"></video>'
    return f'<a href="{p}" target="_blank"><img src="{p}" loading="lazy"></a>'


def main(proj):
    with open(os.path.join(proj, "repair.json"), encoding="utf-8") as f:
        d = json.load(f)
    iss = d.get("issues", [])
    done = sum(1 for i in iss if i.get("status") in ("done", "skipped"))
    frac = done / max(len(iss), 1)
    e = html.escape

    def thumbs(paths):
        return "".join(f'<a href="{e(p)}" target="_blank"><img src="{e(p)}"></a>' for p in paths)

    rows = "".join(
        f"<tr><td>{e(i.get('id', ''))}</td><td>{e(i.get('title', ''))}</td><td>{e(i.get('severity', ''))}</td>"
        f"<td>{e(str(i.get('frames', '')))}</td><td><span class='b {e(i.get('status', 'todo'))}'>{e(i.get('status', 'todo'))}</span></td>"
        f"<td>{e(i.get('notes', ''))}<div class='thumbs'>{thumbs(i.get('images', []))}</div></td></tr>"
        for i in iss)

    def cards(xs):
        return "".join(
            f"<div class='card'>{media(x['path'])}<div class='n'>{e(x.get('name', ''))}</div>"
            f"<div class='t'>{e(x.get('notes', ''))}</div></div>" for x in xs)

    log = "".join(
        f"<tr><td style='white-space:nowrap'>{e(l.get('time', ''))}</td><td>{e(l.get('text', ''))}</td></tr>"
        for l in reversed(d.get("log", [])))
    refresh = '<meta http-equiv="refresh" content="15">' if d.get("live") else ""
    title = e(d.get("title", "修复进度"))
    page = f"""<!doctype html><html lang="zh"><head><meta charset="utf-8">{refresh}<title>{title}</title><style>{CSS}</style></head><body>
<header><h1>{title}</h1><div class="meta">源文件 {e(d.get('source', ''))} · 档位 {e(d.get('tier', ''))} · 问题 {done}/{len(iss)} 已处理</div>
<div class="prog"><div style="width:{frac * 100:.0f}%"></div></div>
<nav><a href="#issues">问题</a><a href="#renders">修复版本</a><a href="#assets">修复素材</a><a href="#log">日志</a></nav></header>
<section id="issues"><h2>发现的问题</h2><table><tr><th>ID</th><th>问题</th><th>严重度</th><th>帧</th><th>状态</th><th>说明 / 证据</th></tr>{rows}</table></section>
<section id="renders"><h2>修复版本（中间渲染与成片）</h2><div class="grid">{cards(d.get('renders', []))}</div></section>
<section id="assets"><h2>修复素材（生成 / 底板 / 蒙版）</h2><div class="grid">{cards(d.get('assets', []))}</div></section>
<section id="log"><h2>日志</h2><table>{log}</table></section></body></html>"""
    out = os.path.join(proj, "dashboard.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(page)
    print(out)


if __name__ == "__main__":
    main(sys.argv[1])
