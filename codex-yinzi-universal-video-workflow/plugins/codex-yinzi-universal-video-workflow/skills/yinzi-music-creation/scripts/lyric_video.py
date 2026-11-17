# -*- coding: utf-8 -*-
"""
通用高颜值「LRC 逐句时间轴歌词 + 双角色逐字高亮歌词字幕版 MP4（兼 MV 节拍样片）」生成器
- 零费用纯本地渲染：Pillow 预栅格化行级状态图/逐帧合成 -> FFmpeg H.264 + AAC 320k 直出 1920x1080 30fps MP4。
- 严格区分双角色颜色（题一：千金樱花粉金 vs 保镖硬汉电光蓝黄；题二：逗哏朱砂琥珀金 vs 捧哏翡翠青绿）。
- 内置实时 Bar:Beat 节拍器脉冲灯、段落标签、梗点提示条与真实音频 32 段动态频谱柱，可直接作为超级导演 MV 节拍样片使用！
"""
import os
import sys
import math
import subprocess
import numpy as np
import soundfile as sf
from PIL import Image, ImageDraw, ImageFont

FONT_BOLD_CANDIDATES = [
    "C:/Windows/Fonts/msyhbd.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/msyh.ttc",
]
FONT_REG_CANDIDATES = [
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simsun.ttc",
]

def load_font(candidates, size):
    for p in candidates:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def fmt_lrc_time(sec: float) -> str:
    sec = max(0.0, float(sec))
    mm = int(sec // 60)
    ss = sec - mm * 60
    return f"[{mm:02d}:{ss:05.2f}]"


def write_lrc(lines_meta: list, header_meta: dict, out_lrc_path: str):
    """
    lines_meta: list of dicts:
      {"start_s": float, "end_s": float, "role": "A"|"B", "role_label": str, "text": str, "section": str, "chars": [(ch, st_s, en_s), ...]}
    """
    out = [
        f"[ti:{header_meta.get('title', '')}]",
        f"[ar:{header_meta.get('artist', '')}]",
        f"[al:{header_meta.get('album', '万能创作终端 · 音乐实验室实测')}]",
        f"[by:Music Lab DiffSinger Pipeline ({header_meta.get('bpm', '')} BPM)]",
        "",
    ]
    all_lines = sorted(lines_meta, key=lambda x: x["start_s"])
    last_sec_name = None
    for ln in all_lines:
        if ln.get("section") and ln["section"] != last_sec_name:
            last_sec_name = ln["section"]
            out.append(f"{fmt_lrc_time(max(0.0, ln['start_s'] - 0.05))}=== {last_sec_name} ===")
        prefix = f"【{ln['role_label']}】" if ln.get("role_label") else ""
        out.append(f"{fmt_lrc_time(ln['start_s'])}{prefix}{ln['text']}")
    with open(out_lrc_path, "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")
    return out_lrc_path


def precompute_spectrum_bars(wav_path: str, fps: int, n_frames: int, n_bands: int = 36) -> np.ndarray:
    """Compute smooth 36-band log-frequency visualizer envelope (n_frames, n_bands) in 0..1."""
    y, sr = sf.read(wav_path, always_2d=True)
    mono = np.mean(y, axis=1).astype(np.float32)
    win = 2048
    hop = max(1, int(round(sr / fps)))
    out = np.zeros((n_frames, n_bands), dtype=np.float32)
    hann = np.hanning(win).astype(np.float32)
    freqs = np.fft.rfftfreq(win, 1.0 / sr)
    edges = np.geomspace(45.0, 12000.0, n_bands + 1)
    band_bins = [np.where((freqs >= edges[b]) & (freqs < edges[b + 1]))[0] for b in range(n_bands)]

    for f_idx in range(n_frames):
        center = int(round((f_idx / fps) * sr))
        i0 = center - win // 2
        if i0 < 0 or i0 + win > len(mono):
            continue
        spec = np.abs(np.fft.rfft(mono[i0:i0 + win] * hann))
        for b, bins in enumerate(band_bins):
            if len(bins):
                val = float(np.mean(spec[bins]))
            else:
                idx = int(np.argmin(np.abs(freqs - edges[b])))
                val = float(spec[idx])
            # Tilt high frequencies up visually so spectrum looks balanced
            tilt = 1.0 + (b / n_bands) * 2.2
            db = 20.0 * math.log10(max(val * tilt, 1e-4))
            out[f_idx, b] = np.clip((db + 28.0) / 46.0, 0.02, 1.0)

    # Temporal smoothing (fast attack, smooth decay)
    for f_idx in range(1, n_frames):
        out[f_idx] = np.maximum(out[f_idx], out[f_idx - 1] * 0.78)
    return out


def render_karaoke_mp4(
    wav_path: str,
    out_mp4_path: str,
    bpm: float,
    total_bars: int,
    theme: dict,
    roleA_lines: list,
    roleB_lines: list,
    sections_timeline: list,
    fps: int = 30,
    preroll_s: float = 0.0,
):
    """
    Render 1920x1080 30fps dual-role karaoke & MV beat-animatic MP4.
    - roleA_lines: main singer / dougen lines [{"start_s", "end_s", "text", "chars": [(ch, s0, s1), ...]}]
    - roleB_lines: bodyguards / penggen lines [{"start_s", "end_s", "text", "chars": [(ch, s0, s1), ...]}]
    - sections_timeline: [{"start_s", "end_s", "section", "gag"}]
    """
    info = sf.info(wav_path)
    dur_s = info.duration
    n_frames = int(math.ceil(dur_s * fps))
    W, H = 1920, 1080
    beat_s = 60.0 / bpm

    spec_bars = precompute_spectrum_bars(wav_path, fps, n_frames, n_bands=36)

    f_title = load_font(FONT_BOLD_CANDIDATES, 40)
    f_badge = load_font(FONT_BOLD_CANDIDATES, 28)
    f_meta = load_font(FONT_REG_CANDIDATES, 25)
    f_gag = load_font(FONT_REG_CANDIDATES, 26)
    f_main = load_font(FONT_BOLD_CANDIDATES, 68)
    f_next = load_font(FONT_REG_CANDIDATES, 42)
    f_sub_role = load_font(FONT_BOLD_CANDIDATES, 56)

    # Pre-build gradient background once
    bg = Image.new("RGB", (W, H), theme["bg_top"])
    bg_arr = np.zeros((H, W, 3), dtype=np.uint8)
    c_top = np.array(theme["bg_top"], dtype=np.float32)
    c_bot = np.array(theme["bg_bot"], dtype=np.float32)
    for y_row in range(H):
        t_y = y_row / max(H - 1, 1)
        bg_arr[y_row, :] = (c_top * (1 - t_y) + c_bot * t_y).astype(np.uint8)
    # Subtle decorative horizontal grid lines
    for y_row in range(140, H - 140, 90):
        bg_arr[y_row:y_row + 1, :] = np.clip(bg_arr[y_row:y_row + 1, :].astype(int) + 12, 0, 255).astype(np.uint8)
    base_bg = Image.fromarray(bg_arr, mode="RGB")

    # Draw static header chrome onto base_bg
    d0 = ImageDraw.Draw(base_bg)
    d0.rounded_rectangle([48, 34, W - 48, 122], radius=18, fill=theme["panel_bg"], outline=theme["panel_border"], width=2)
    d0.text((76, 52), theme["title_text"], font=f_title, fill=(255, 255, 255))
    # Color legend in bottom-right above spectrum
    d0.rounded_rectangle([56, 144, 420, 198], radius=12, fill=theme["roleA_badge_bg"])
    d0.text((74, 155), f"● {theme['roleA_name']}", font=f_badge, fill=theme["roleA_active"])
    d0.rounded_rectangle([440, 144, 830, 198], radius=12, fill=theme["roleB_badge_bg"])
    d0.text((458, 155), f"● {theme['roleB_name']}", font=f_badge, fill=theme["roleB_active"])

    # Launch FFmpeg rawvideo -> H.264 + master WAV audio
    os.makedirs(os.path.dirname(out_mp4_path), exist_ok=True)
    tmp_env = os.environ.copy()
    tmp_env["TMP"] = os.environ.get("TMP", tmp_env.get("TEMP", ""))
    tmp_env["TEMP"] = os.environ.get("TMP", tmp_env.get("TEMP", ""))

    ffmpeg_cmd = [
        os.environ.get("FFMPEG_PATH") or "ffmpeg", "-y", "-loglevel", "error",
        "-f", "rawvideo", "-vcodec", "rawvideo",
        "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(fps),
        "-i", "-",
        "-i", wav_path,
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "320k",
        "-shortest",
        out_mp4_path
    ]
    err_log = open(out_mp4_path + ".ffmpeg.log", "wb")
    proc = subprocess.Popen(ffmpeg_cmd, stdin=subprocess.PIPE, stderr=err_log, env=tmp_env)

    def find_active_and_next(lines, t):
        active = None
        nxt = None
        for i, ln in enumerate(lines):
            # Show line slightly early (0.35s lead-in) and hold 0.45s after end if next hasn't started
            lead_in = 0.35
            hold_out = 0.45
            prev_end = lines[i - 1]["end_s"] if i > 0 else -999.0
            nxt_st = lines[i + 1]["start_s"] if i + 1 < len(lines) else 99999.0
            vis_s0 = max(prev_end + 0.05, ln["start_s"] - lead_in)
            vis_s1 = min(nxt_st - 0.05, ln["end_s"] + hold_out)
            if vis_s0 <= t <= vis_s1:
                active = ln
                if i + 1 < len(lines):
                    nxt = lines[i + 1]
                break
            if ln["start_s"] > t and nxt is None:
                nxt = ln
        return active, nxt

    def draw_karaoke_line(draw: ImageDraw.ImageDraw, ln: dict, t: float, center_y: int, font, active_col, idle_col, stroke_col, scale_pop=False):
        chars = ln["chars"]
        if not chars:
            return
        # Measure each character width so spacing is rock-steady frame-to-frame
        widths = [draw.textlength(c[0], font=font) for c in chars]
        total_w = sum(widths)
        x = (W - total_w) * 0.5
        # Subtle dark backdrop pill behind active lyric line for 100% readability
        pad_x, pad_y = 36, 20
        draw.rounded_rectangle(
            [x - pad_x, center_y - 46 - pad_y, x + total_w + pad_x, center_y + 46 + pad_y],
            radius=22, fill=(14, 18, 32)
        )
        cur_x = x
        for (ch, s0, s1), cw in zip(chars, widths):
            is_sung = (t >= s0)
            is_now = (s0 <= t <= s1 + 0.06)
            y_off = -8 if (is_now and scale_pop) else (-4 if is_now else 0)
            col = active_col if is_sung else idle_col
            draw.text((cur_x, center_y - 38 + y_off), ch, font=font, fill=col, stroke_width=3, stroke_fill=stroke_col)
            if is_now:
                # Active underline glow bar under the currently sung character!
                prog = np.clip((t - s0) / max(s1 - s0, 0.05), 0.15, 1.0)
                draw.rounded_rectangle(
                    [cur_x + 2, center_y + 42, cur_x + max(6, cw * prog - 2), center_y + 50],
                    radius=4, fill=active_col
                )
            cur_x += cw

    for f_idx in range(n_frames):
        t = f_idx / fps
        frame = base_bg.copy()
        dr = ImageDraw.Draw(frame)

        # 1. Beat & Bar Metronome HUD (top-right)
        total_beats = max(0.0, t - preroll_s) / beat_s
        bar_num = min(total_bars, int(total_beats // 4.0) + 1)
        beat_in_bar = int(total_beats % 4.0) + 1
        beat_frac = total_beats % 1.0
        pulse = max(0.0, 1.0 - beat_frac * 3.2)

        # 4 Metronome dots
        for b_i in range(1, 5):
            cx = W - 490 + (b_i - 1) * 34
            cy = 78
            if b_i == beat_in_bar:
                r = int(10 + 4 * pulse)
                col = (255, 215, 64) if b_i == 1 else theme["roleA_active"]
            else:
                r = 7
                col = (75, 85, 110)
            dr.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col)

        mm, ss = int(t // 60), t % 60
        hud_txt = f"Bar {bar_num:02d}/{total_bars} · Beat {beat_in_bar}  |  {bpm:g} BPM  |  {mm:02d}:{ss:04.1f}"
        dr.text((W - 350, 62), hud_txt, font=f_meta, fill=(220, 230, 248))

        # 2. Section & Gag Callout Banner
        cur_sec = sections_timeline[0] if sections_timeline else None
        for s_it in sections_timeline:
            if s_it["start_s"] <= t <= s_it["end_s"]:
                cur_sec = s_it
                break
        if cur_sec:
            dr.rounded_rectangle([850, 144, W - 56, 198], radius=12, fill=(24, 30, 50), outline=theme["panel_border"], width=1)
            sec_str = f"【{cur_sec['section']}】 {cur_sec.get('gag', '')}"
            if len(sec_str) > 46:
                sec_str = sec_str[:45] + "…"
            dr.text((870, 156), sec_str, font=f_gag, fill=(235, 240, 255))

        # 3. Role A (Claude / 逗哏张半仙) Center Karaoke Stage (Y = 430)
        act_A, nxt_A = find_active_and_next(roleA_lines, t)
        if act_A:
            # Role tag pill above line
            dr.text((W // 2 - 110, 322), f"▼ {theme['roleA_name']}", font=f_badge, fill=theme["roleA_active"])
            draw_karaoke_line(
                dr, act_A, t, center_y=430, font=f_main,
                active_col=theme["roleA_active"], idle_col=theme["roleA_idle"],
                stroke_col=(10, 12, 22), scale_pop=False
            )
            if nxt_A and (nxt_A["start_s"] - t) < 5.0:
                nxt_txt = f"下一句：{nxt_A['text']}"
                nw = dr.textlength(nxt_txt, font=f_next)
                dr.text(((W - nw) * 0.5, 525), nxt_txt, font=f_next, fill=(135, 148, 175))
        elif nxt_A and (nxt_A["start_s"] - t) < 3.5:
            nxt_txt = f"即将进入：{nxt_A['text']}"
            nw = dr.textlength(nxt_txt, font=f_next)
            dr.text(((W - nw) * 0.5, 430), nxt_txt, font=f_next, fill=(150, 165, 195))

        # 4. Role B (肌肉男保镖应援 / 捧哏小徒弟) Call & Response Stage (Y = 710)
        act_B, _ = find_active_and_next(roleB_lines, t)
        if act_B:
            dr.text((W // 2 - 110, 612), f"★ {theme['roleB_name']}", font=f_badge, fill=theme["roleB_active"])
            draw_karaoke_line(
                dr, act_B, t, center_y=710, font=f_sub_role,
                active_col=theme["roleB_active"], idle_col=theme["roleB_idle"],
                stroke_col=(8, 16, 28), scale_pop=True
            )

        # 5. Bottom 36-Band Audio Spectrum + Song Timeline Progress Bar
        bars_v = spec_bars[f_idx]
        bar_area_w = W - 160
        bw = bar_area_w / len(bars_v)
        base_y = H - 68
        for bi, bv in enumerate(bars_v):
            bx0 = int(80 + bi * bw + 4)
            bx1 = int(80 + (bi + 1) * bw - 4)
            bh = int(8 + bv * 125)
            col = theme["roleA_active"] if (bi % 2 == 0) else theme["roleB_active"]
            dr.rounded_rectangle([bx0, base_y - bh, bx1, base_y], radius=4, fill=col)

        # Progress bar
        dr.rounded_rectangle([80, H - 42, W - 80, H - 28], radius=7, fill=(40, 48, 70))
        pw = int((W - 160) * min(1.0, t / max(dur_s, 0.1)))
        if pw > 8:
            dr.rounded_rectangle([80, H - 42, 80 + pw, H - 28], radius=7, fill=theme["roleA_active"])

        proc.stdin.write(frame.tobytes())

    proc.stdin.close()
    ret = proc.wait()
    err_log.close()
    stderr_bytes = open(out_mp4_path + ".ffmpeg.log", "rb").read()
    if ret != 0:
        raise RuntimeError(f"FFmpeg lyric video encode failed ({ret}): {stderr_bytes.decode('utf-8', 'replace')[-800:]}")
    return out_mp4_path


THEMES = {
    "A": dict(roleA_badge_bg=(62, 26, 48), roleA_active=(255, 112, 166), roleA_idle=(245, 215, 228)),
    "B": dict(roleB_badge_bg=(18, 48, 72), roleB_active=(56, 205, 255), roleB_idle=(195, 232, 250)),
}


def main():
    """python lyric_video.py <母带.wav> <工程/lyric_lines.json> <输出.mp4>
    主唱轨（role=lead 的第一条）粉色在上，其余（和声、应援、捧哏）蓝色在下，逐字高亮，带小节/拍号节拍灯，可当 MV 节拍样片。"""
    import json
    wav, lines_json, out = (os.path.abspath(x) for x in sys.argv[1:4])
    d = json.load(open(lines_json, encoding="utf-8"))
    tracks = d["tracks"]
    lead = next((t for t in tracks if t["role"] == "lead"), tracks[0])
    def conv(ls):
        return [{"start_s": l["start_s"], "end_s": l["end_s"], "text": l["text"], "chars": [tuple(c) for c in l["chars"]]} for l in ls]
    A = conv([l for l in d["lines"] if l["track"] == lead["name"]])
    B = conv([l for l in d["lines"] if l["track"] != lead["name"]])
    others = "、".join(t["label"] for t in tracks if t["name"] != lead["name"]) or "和声"
    beat = 60.0 / d["bpm"]
    pre = float(d.get("preroll_s", 0.0))
    secs = []
    for s in d.get("sections", []):
        b0, b1 = [int(x) for x in str(s["bars"]).split("-")]
        secs.append({"start_s": pre + (b0 - 1) * 4 * beat, "end_s": pre + b1 * 4 * beat, "section": s.get("name", ""), "gag": s.get("gag", "")})
    theme = {"title_text": f"《{d['title']}》", "roleA_name": lead["label"], "roleB_name": others,
             "bg_top": (22, 18, 38), "bg_bot": (10, 14, 28), "panel_bg": (32, 28, 54), "panel_border": (110, 85, 160),
             **THEMES["A"], **THEMES["B"]}
    bars = d.get("bars") or int(sf.info(wav).duration / (4 * beat)) + 1
    render_karaoke_mp4(wav, out, d["bpm"], bars, theme, A, B, secs, fps=30, preroll_s=pre)
    print(json.dumps({"video": out}, ensure_ascii=False))


if __name__ == "__main__":
    main()
