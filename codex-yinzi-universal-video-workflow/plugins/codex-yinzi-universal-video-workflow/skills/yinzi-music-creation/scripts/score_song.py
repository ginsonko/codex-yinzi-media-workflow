# -*- coding: utf-8 -*-
"""精确作曲：一份歌曲谱（JSON）→ DiffSinger 逐字唱 → MIDI 伴奏渲染 → 混音母带 → LRC → 审听报告。

  python score_song.py song.json --out <工作文件夹>/音乐/<歌名> [--root <数据目录>] [--demo] [--force-vocals]

song.json（每个字唱什么音、多长都由你定；例子见 examples/mini_song.json）：
{
  "title": "歌名", "bpm": 156, "key": "E", "bars": 68,
  "soundfont": "sf-generaluser",            # 或 sf-musescore
  "style": "pop",                           # pop（偶像流行）| boombap（说唱/相声）| ballad
  "sections": [{"bars": "1-4", "name": "前奏", "gag": "这段的梗"}],
  "tracks": [
    {"name": "lead", "label": "大小姐", "role": "lead", "bank": "qixuan", "pan": 0, "volume_db": 0,
     "gender": -4, "notes": [[5, 1.0, 0.5, "早", "G#4", "norm"], [5, 1.5, 0.5, "安", "B4", "vib"]]},
    {"name": "guards", "label": "保镖团", "role": "backing", "bank": "alemon", "gender": 26,
     "doubles": 2, "notes": [[8, 3.0, 0.6, "神", "F#3", "shout"]]}
  ],
  "chords": [[1, 1.0, 4.0, "E", 40, [64, 68, 71, 76]]]
}
note = [小节, 拍(1 起), 拍数, 显示字, 音高, 标签, 可选拼音]；标签：norm accent stacc vib soft shout rap pocket。
rap / pocket：按字的普通话声调在该音高附近画滑音（窄音域、重拍加重），用来写说唱和捧哏接话——
说唱也必须是 DiffSinger 唱出来的音符，配音（TTS）不能当歌声。

产出：<歌名>_母带.wav/.mp3、<歌名>.lrc、分轨_人声主唱/分轨_和声/分轨_伴奏.wav、歌声工程.ustx、人声旋律.mid、
伴奏编曲.mid、score.txt、qa/*_audit.json；旧文件不覆盖（自动加 _v2、_v3）。
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from score_setup import default_root, load_state  # noqa: E402

TPQ = 480
SR = 44100
# DiffSinger starts a word's consonant before its note (≈100–300 ms). Bar 1 beat 1 at t=0 would cut it off
# (heard as a missing first word), so every output starts with this much silence; LRC/字幕 shift with it.
PREROLL_S = 1.0
POLY = {"长": "chang", "传": "chuan", "谁": "shui", "塞": "sai", "都": "dou", "没": "mei", "折": "zhe", "得": "de",
        "啦": "la", "别": "bie", "么": "me", "呀": "ya", "吧": "ba", "的": "de", "着": "zhe", "只": "zhi", "个": "ge",
        "更": "geng", "要": "yao", "场": "chang", "咱": "zan", "难": "nan", "差": "cha", "还": "hai", "行": "xing",
        "觉": "jue", "乐": "le", "重": "zhong", "了": "le", "地": "di", "和": "he", "为": "wei", "处": "chu"}
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
STEP = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def midi_of(p):
    m = re.match(r"^([A-G])([#b]?)(-?\d+)", p)
    return (int(m.group(3)) + 1) * 12 + STEP[m.group(1)] + {"#": 1, "b": -1, "": 0}[m.group(2)]


def name_of(m):
    return f"{NAMES[m % 12]}{m // 12 - 1}"


def tick_of(bar, beat):
    return int(round(((bar - 1) * 4.0 + (beat - 1.0)) * TPQ))


def pinyin_of(ch, override=None):
    if override:
        return override
    if re.fullmatch(r"[a-z]+", ch):
        return ch
    if ch in POLY:
        return POLY[ch]
    from pypinyin import lazy_pinyin
    return (lazy_pinyin(ch) or [ch])[0]


def tone_of(ch):
    from pypinyin import Style, pinyin
    r = pinyin(ch, style=Style.TONE3, neutral_tone_with_five=True)
    m = re.search(r"([1-5])$", r[0][0]) if r and r[0] else None
    return int(m.group(1)) if m else 1


def rap_contour(ch, pitch, dur_ticks, bpm, downbeat):
    """Speech-rap: keep the pitch narrow and bend it the way the word's tone goes."""
    ms = max(80.0, dur_ticks / TPQ * 60000.0 / bpm)
    end, mid = round(ms * 0.88, 1), round(ms * 0.45, 1)
    t = tone_of(ch)
    m = midi_of(pitch) + (1 if downbeat and t in (1, 4) else 0)
    pts = {1: f"0:15:io,{end}:0:io", 2: f"0:-140:io,{end}:110:io", 3: f"0:-40:io,{mid}:-160:io,{end}:-30:io",
           4: f"0:140:io,{end}:-210:io"}.get(t, f"0:0:io,{end}:-60:io")
    return name_of(m), pts


def controls(track, n, dur_ticks, bpm):
    tag = n[5] if len(n) > 5 else "norm"
    beats = dur_ticks / TPQ
    c = [f"gender={track.get('gender', 0)}", "vel=96", f"cons={1.22 if beats <= 0.6 else 1.12}"]
    if track.get("tension") is not None:
        c.append(f"tenc={track['tension']}")
    if tag in ("vib", "vib_soft", "sing_vib") and beats >= 0.75:
        c.append("vib=5.7:22:170")
    if tag in ("soft", "vib_soft"):
        c += ["brec=16", "expr=0.78"]
    elif tag in ("accent", "stacc", "shout"):
        c.append("expr=0.95")
    return c


def build_score(song, banks, out_txt):
    bpm = song["bpm"]
    lines = [f"bpm {bpm:g}", "time 4/4", f"key {song.get('key', 'C')}"]
    for tr in song["tracks"]:
        lines += ["", f"track {tr['name']}", f"bank {banks[tr['bank']]}", f"lang {tr.get('lang', 'zh')}",
                  f"volume {tr.get('volume_db', 0)}", f"pan {tr.get('pan', 0)}"]
        notes = sorted(tr["notes"], key=lambda n: tick_of(n[0], n[1]))
        pos = 0
        for i, n in enumerate(notes):
            st, dur = tick_of(n[0], n[1]), int(round(n[2] * TPQ))
            if i + 1 < len(notes):
                nxt = tick_of(notes[i + 1][0], notes[i + 1][1])
                if nxt < st + dur:
                    raise SystemExit(json.dumps({"error": "overlap", "track": tr["name"], "bar": n[0], "beat": n[1], "char": n[3]}, ensure_ascii=False))
                # zero-initial next syllable: leave a tiny gap so the vowels don't slur together
                if nxt == st + dur and pinyin_of(notes[i + 1][3])[:1] in "aoeyw" and dur > 120:
                    dur -= 18
            if st > pos:
                lines.append(f"r {st - pos}/480")
            lyric = pinyin_of(n[3], n[6] if len(n) > 6 else None)
            tag = n[5] if len(n) > 5 else "norm"
            ctl = controls(tr, n, dur, bpm)
            pitch = n[4]
            if tag in ("rap", "pocket"):
                pitch, pts = rap_contour(n[3], n[4], dur, bpm, abs(((n[1] - 1) % 2)) < 0.08)
                ctl += [f"pts={pts}", "snap=0", "vel=128"]
            lines.append(f"{lyric} {pitch} {dur}/480 " + " ".join(ctl))
            pos = st + dur
    with open(out_txt, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return out_txt


def write_vocal_midi(song, path):
    import mido
    mid = mido.MidiFile(ticks_per_beat=TPQ, charset="utf-8")
    meta = mido.MidiTrack()
    meta.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(song["bpm"]), time=0))
    mid.tracks.append(meta)
    for ch, tr in enumerate(song["tracks"]):
        t = mido.MidiTrack()
        t.append(mido.MetaMessage("track_name", name=tr.get("label", tr["name"]), time=0))
        ev = []
        for n in tr["notes"]:
            st, en, m = tick_of(n[0], n[1]), tick_of(n[0], n[1]) + int(n[2] * TPQ), midi_of(n[4])
            ev += [(st, 1, mido.MetaMessage("lyrics", text=n[3], time=0)), (st, 2, mido.Message("note_on", note=m, velocity=100, channel=ch % 16)),
                   (en, 0, mido.Message("note_off", note=m, velocity=0, channel=ch % 16))]
        last = 0
        for tk, _, msg in sorted(ev, key=lambda e: (e[0], e[1])):
            msg.time = tk - last
            t.append(msg)
            last = tk
        mid.tracks.append(t)
    mid.save(path)


def build_accompaniment(song, path, demo=False):
    """Chord sheet → a playable band arrangement (piano/guitar/bass/strings/drums) by style."""
    import mido
    style = "demo" if demo else song.get("style", "pop")
    ev = {c: [] for c in (0, 1, 2, 3, 9)}
    prog = {"pop": (1, 29, 34, 48), "boombap": (4, 105, 33, 107), "ballad": (0, 24, 32, 48), "demo": (0, 0, 33, 0)}[style if style in ("pop", "boombap", "ballad") else "demo"]

    def note(c, st, d, m, v):
        if d > 10 and 16 <= m <= 115:
            ev[c] += [(st, mido.Message("note_on", channel=c, note=m, velocity=int(v))), (st + d, mido.Message("note_off", channel=c, note=m, velocity=0))]

    for bar, beat, dur_b, _name, bass, notes in song["chords"]:
        st, dur = tick_of(bar, beat), int(dur_b * TPQ)
        voic = [n + 12 if n < 64 else n for n in notes]
        hits = [(0, 0.9), (2, 0.9)] if style in ("ballad", "demo", "boombap") else [(0, 0.7), (0.75, 0.7), (1.5, 0.45), (2, 0.9), (3, 0.9)]
        for b, d in hits:
            if b * TPQ < dur:
                for n in voic:
                    note(0, st + int(b * TPQ), min(int(d * TPQ), dur - int(b * TPQ) - 20), n, 78)
        if not demo:
            for k in range(dur // (TPQ // 2)):
                if style == "pop":
                    for n in (bass + 12, bass + 19):
                        note(1, st + k * TPQ // 2, TPQ // 2 - 40, n, 84 if k % 2 == 0 else 72)
                elif style == "boombap" and k % 2 == 0:
                    note(1, st + k * TPQ // 2, TPQ // 3, bass + 12 + (7 if k % 4 else 0), 80)
            note(3, st, dur - 30, max(voic) + 12, 76)
        for k in range(dur // TPQ):
            if style == "pop":
                note(2, st + k * TPQ, TPQ // 2 - 30, bass, 98)
                note(2, st + k * TPQ + TPQ // 2, TPQ // 2 - 30, bass + 12, 86)
            else:
                note(2, st + k * TPQ, TPQ - 60, bass, 96)
    bars = song.get("bars") or max(c[0] for c in song["chords"])
    for bar in range(1, bars + 1):
        b0 = (bar - 1) * TPQ * 4
        for b in range(4):
            tk = b0 + b * TPQ
            if style == "boombap":
                if b in (0, 2):
                    note(9, tk, 130, 36, 108)
                if b == 1:
                    note(9, tk + int(0.75 * TPQ), 110, 36, 92)
            else:
                note(9, tk, 130, 36, 104 if b in (0, 2) else 92)
            if b in (1, 3):
                note(9, tk, 140, 38, 104)
            note(9, tk, 90, 42, 80)
            note(9, tk + int((0.54 if style == "boombap" else 0.5) * TPQ), 80, 42, 66)
    mid = mido.MidiFile(ticks_per_beat=TPQ)
    for i, c in enumerate((0, 1, 2, 3, 9)):
        t = mido.MidiTrack()
        if i == 0:
            t.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(song["bpm"]), time=0))
        if c != 9:
            t.append(mido.Message("program_change", channel=c, program=prog[i], time=0))
        last = 0
        for tk, m in sorted(ev[c], key=lambda e: (e[0], 0 if e[1].type == "note_off" else 1)):
            m.time = tk - last
            t.append(m)
            last = tk
        mid.tracks.append(t)
    mid.save(path)


def board(audio, chain):
    x = np.ascontiguousarray(audio.T.astype(np.float32))
    return chain(x, SR).T.astype(np.float64)


def pan(mono, p, delay_ms=0.0):
    if delay_ms:
        s = int(round(abs(delay_ms) / 1000 * SR))
        mono = np.concatenate([np.zeros(s), mono[:-s]]) if delay_ms > 0 else np.concatenate([mono[s:], np.zeros(s)])
    a = (p + 1.0) * np.pi / 4
    return np.column_stack([mono * np.cos(a), mono * np.sin(a)])


def load_mono(path, offset, n):
    x, _ = sf.read(path, always_2d=True)
    m = x.mean(axis=1)
    m = m[offset:] if offset >= 0 else np.concatenate([np.zeros(-offset), m])
    out = np.zeros(n)
    out[:min(n, len(m))] = m[:n]
    return out


def mix(song, stems_dir, acc_wav, offset, n):
    import scipy.signal as sig
    from pedalboard import Compressor, Gain, HighpassFilter, HighShelfFilter, LowpassFilter, LowShelfFilter, Pedalboard, PeakFilter, Reverb
    lead_chain = Pedalboard([HighpassFilter(120), PeakFilter(310, -3.5, 1.3), PeakFilter(2600, 3.2, 1.0), PeakFilter(3900, 3.5, 1.0),
                             PeakFilter(7400, -2.6, 3.5), HighShelfFilter(10000, 2.0, 0.7),
                             Compressor(-24, 3.8, 8, 75), Compressor(-17, 2.5, 15, 120), Gain(5.0)])
    back_chain = Pedalboard([HighpassFilter(90), LowShelfFilter(160, 2.5, 0.8), PeakFilter(360, -2.8, 1.3), PeakFilter(2800, 3.0, 1.0),
                             Compressor(-23, 4.0, 7, 80), Gain(3.5)])
    double_chain = Pedalboard([HighpassFilter(90), LowpassFilter(4200), Compressor(-22, 4.0, 10, 90), Reverb(0.28, 0.6, 0.14, 0.9, 0.95)])
    lead = np.zeros((n, 2))
    back = np.zeros((n, 2))
    for tr in song["tracks"]:
        m = load_mono(os.path.join(stems_dir, tr["name"] + ".wav"), offset - int(PREROLL_S * SR), n)
        p = float(tr.get("pan", 0))
        if tr.get("role", "lead") == "lead":
            lead += board(pan(m, p), lead_chain)
        else:
            back += board(pan(m, p), back_chain)
            for k in range(int(tr.get("doubles", 0))):
                side = 1 if k % 2 == 0 else -1
                back += board(pan(m, side * 0.45, side * (4.5 - k)), double_chain) * 0.5
    pre = np.vstack([np.zeros((int(0.04 * SR), 2)), lead[:-int(0.04 * SR)]])  # 40 ms pre-delay keeps consonants dry
    lead = lead + board(pre, Pedalboard([HighpassFilter(350), LowpassFilter(6500), Reverb(0.38, 0.55, 1.0, 0.0, 0.9)])) * 0.085
    a, _ = sf.read(acc_wav, always_2d=True)
    acc = np.zeros((n, 2))
    pre = int(PREROLL_S * SR)
    acc[pre:pre + min(n - pre, len(a))] = a[:n - pre]
    acc = board(acc, Pedalboard([HighpassFilter(35), LowShelfFilter(95, 1.2, 0.75), PeakFilter(350, -5.0, 1.1), PeakFilter(620, -3.4, 1.2),
                                 PeakFilter(2800, -2.6, 1.0), HighShelfFilter(8000, 2.8, 0.75), Compressor(-18, 2.4, 12, 110)]))
    # duck 1–4.4 kHz of the band while anyone sings
    env = np.sqrt(np.maximum(0, sig.fftconvolve(((lead + back * 0.8) ** 2).mean(axis=1), np.ones(int(0.025 * SR)) / int(0.025 * SR), mode="same")))
    b, aa = sig.butter(1, 10 / (SR / 2))
    duck = sig.filtfilt(b, aa, np.clip((env - 0.008) / 0.055, 0, 1))[:, None]
    midband = sig.sosfiltfilt(sig.butter(2, [1000 / (SR / 2), 4400 / (SR / 2)], btype="band", output="sos"), acc, axis=0)
    acc = (acc * (1 - 0.13 * duck) - midband * 0.42 * duck) * float(song.get("band_gain", 0.5))
    fade = int(1.2 * SR)
    for x in (lead, back, acc):
        x[-fade:] *= (np.linspace(1, 0, fade) ** 1.5)[:, None]
    return lead, back, acc


def master(pre):
    import pyloudnorm as pyln
    from pedalboard import Compressor, HighpassFilter, HighShelfFilter, Pedalboard
    from warble import mix as wmix
    m = board(pre, Pedalboard([HighpassFilter(28), Compressor(-16, 1.6, 25, 130), HighShelfFilter(10500, 1.0)]))
    meter = pyln.Meter(SR)
    scale = 10 ** ((-14 - meter.integrated_loudness(m)) / 20)
    m = wmix.limiter(m * scale, SR, ceiling_db=-1.0).astype(np.float64)
    trim = 10 ** ((-14 - meter.integrated_loudness(m)) / 20)
    if abs(20 * np.log10(trim)) > 0.08:
        m = wmix.limiter(m * trim, SR, ceiling_db=-1.0).astype(np.float64)
        scale *= trim
    return m, scale


def lrc_lines(song):
    beat_s = 60.0 / song["bpm"]
    out = []
    for tr in song["tracks"]:
        cur = []
        for n in sorted(tr["notes"], key=lambda n: tick_of(n[0], n[1])):
            s0 = PREROLL_S + ((n[0] - 1) * 4 + n[1] - 1) * beat_s
            s1 = s0 + n[2] * beat_s
            if cur and (s0 - cur[-1][2] > 0.4 or len(cur) >= 12):
                out.append({"role": tr.get("label", tr["name"]), "track": tr["name"], "start_s": cur[0][1], "end_s": cur[-1][2],
                            "text": "".join(c[0] for c in cur), "chars": [list(c) for c in cur]})
                cur = []
            cur.append((n[3], round(s0, 3), round(s1, 3)))
        if cur:
            out.append({"role": tr.get("label", tr["name"]), "track": tr["name"], "start_s": cur[0][1], "end_s": cur[-1][2],
                        "text": "".join(c[0] for c in cur), "chars": [list(c) for c in cur]})
    return sorted(out, key=lambda x: x["start_s"])


def write_lrc(song, lines, path):
    def ts(s):
        return f"[{int(s // 60):02d}:{s % 60:05.2f}]"
    rows = [f"[ti:{song['title']}]", f"[by:DiffSinger 精确作曲 {song['bpm']:g} BPM]", ""]
    rows += [f"{ts(l['start_s'])}【{l['role']}】{l['text']}" for l in lines]
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(rows) + "\n")


def fresh(path):
    """Never overwrite: a.wav → a_v2.wav → a_v3.wav."""
    if not os.path.exists(path):
        return path
    base, ext = os.path.splitext(path)
    k = 2
    while os.path.exists(f"{base}_v{k}{ext}"):
        k += 1
    return f"{base}_v{k}{ext}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("song")
    ap.add_argument("--out", required=True)
    ap.add_argument("--root")
    ap.add_argument("--demo", action="store_true", help="样片：钢琴+鼓，跳过精修，先核结构和梗")
    ap.add_argument("--force-vocals", action="store_true")
    ap.add_argument("--seed", default="77")
    ap.add_argument("--no-asr", action="store_true")
    a = ap.parse_args()
    song = json.load(open(a.song, encoding="utf-8"))
    root = os.path.abspath(a.root or default_root())
    st = load_state(root)["components"]
    need = {tr["bank"] for tr in song["tracks"]} | {"warble", "fluidsynth", song.get("soundfont", "sf-generaluser")}
    miss = [x for x in need if x not in st and not os.path.isdir(x)]
    if miss:
        raise SystemExit(json.dumps({"error": "missing_components", "missing": miss,
                                     "hint": f"先运行 score_setup.py --prepare --components {','.join(miss)} --root {root}"}, ensure_ascii=False))
    banks = {b: (st[b]["path"] if b in st else b) for b in {tr["bank"] for tr in song["tracks"]}}
    py_dir = os.path.dirname(sys.executable)
    warble = shutil.which("warble", path=py_dir) or shutil.which("warble")
    fluid = st["fluidsynth"]["path"]
    if os.path.isdir(fluid):
        fluid = next((os.path.join(d, f) for d, _, fs in os.walk(fluid) for f in fs if f.lower() in ("fluidsynth.exe", "fluidsynth")), fluid)
    sf2 = st[song.get("soundfont", "sf-generaluser")]["path"]
    vocoders = os.pathsep.join(os.path.dirname(v["path"]) for k, v in st.items() if k.startswith("vocoder"))
    cache = os.path.join(root, "cache")
    env = {**os.environ, "PYTHONUTF8": "1", "WARBLE_VOCODERS": vocoders, "WARBLE_CACHE": os.path.join(cache, "warble", "tensors"),
           "WARBLE_PHRASE_CACHE": os.path.join(cache, "warble", "phrases"), "HF_HOME": os.path.join(cache, "hf"),
           "TMP": os.path.join(cache, "tmp"), "TEMP": os.path.join(cache, "tmp")}
    os.makedirs(env["TMP"], exist_ok=True)

    def run(cmd):
        r = subprocess.run(cmd, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode:
            raise SystemExit(json.dumps({"error": "step_failed", "cmd": cmd[:3], "stdout": r.stdout[-1500:], "stderr": r.stderr[-1500:]}, ensure_ascii=False))
        return r.stdout

    out = os.path.abspath(a.out)
    work = os.path.join(out, "工程")
    os.makedirs(work, exist_ok=True)
    title = song["title"]
    tag = "样片" if a.demo else "母带"
    score = build_score(song, banks, os.path.join(work, "score.txt"))
    chk = json.loads(run([warble, "check", score]))
    if not chk.get("ok"):
        raise SystemExit(json.dumps({"error": "score_problems", "problems": chk.get("problems")}, ensure_ascii=False))
    run([warble, "export", score, "-o", fresh(os.path.join(out, f"{title}_歌声工程.ustx"))])
    write_vocal_midi(song, fresh(os.path.join(out, f"{title}_人声旋律.mid")))
    acc_mid = fresh(os.path.join(out, f"{title}_伴奏编曲.mid"))
    build_accompaniment(song, acc_mid, a.demo)
    acc_wav = os.path.join(work, "acc_raw.wav")
    run([fluid, "-ni", "-F", acc_wav, "-r", str(SR), "-g", "0.7", sf2, acc_mid])

    stems = os.path.join(work, "stems")
    voc = os.path.join(work, "vocals_raw.wav")
    if a.force_vocals or not all(os.path.exists(os.path.join(stems, t["name"] + ".wav")) for t in song["tracks"]):
        os.makedirs(stems, exist_ok=True)
        run([warble, "sing", score, "-o", voc, "--stems", stems, "--mix", "dry", "--no-master", "--seed", a.seed, "--sample-rate", str(SR)])
    offset = int(round(float(json.load(open(voc + ".render.json", encoding="utf-8")).get("score_offset_ms", 0)) / 1000 * SR))
    n = int(round(((song.get("bars") or max(c[0] for c in song["chords"])) * 4 * 60 / song["bpm"] + 2.4 + PREROLL_S) * SR))
    lead, back, acc = mix(song, stems, acc_wav, offset, n)
    m, scale = master(lead + back + acc)

    files = {"master_wav": fresh(os.path.join(out, f"{title}_{tag}.wav"))}
    sf.write(files["master_wav"], m.astype(np.float32), SR, subtype="PCM_24")
    files["master_mp3"] = os.path.splitext(files["master_wav"])[0] + ".mp3"
    subprocess.run([env.get("FFMPEG_PATH") or "ffmpeg", "-n", "-loglevel", "error", "-i", files["master_wav"], "-b:a", "320k", files["master_mp3"]], check=True)
    for key, buf, nm in (("stem_lead", lead, "分轨_人声主唱"), ("stem_backing", back, "分轨_和声"), ("stem_band", acc, "分轨_伴奏")):
        files[key] = fresh(os.path.join(out, f"{nm}.wav"))
        sf.write(files[key], np.clip(buf * scale, -0.99, 0.99).astype(np.float32), SR, subtype="PCM_24")
    lines = lrc_lines(song)
    files["lrc"] = fresh(os.path.join(out, f"{title}_{tag}.lrc"))
    write_lrc(song, lines, files["lrc"])
    with open(os.path.join(work, "lyric_lines.json"), "w", encoding="utf-8") as f:
        json.dump({"title": title, "bpm": song["bpm"], "preroll_s": PREROLL_S, "bars": song.get("bars"), "sections": song.get("sections", []),
                   "tracks": [{"name": t["name"], "label": t.get("label", t["name"]), "role": t.get("role", "lead")} for t in song["tracks"]],
                   "lines": lines}, f, ensure_ascii=False, indent=1)
    report = {"files": files, "engine": "DiffSinger（warble）逐字歌声；伴奏 FluidSynth", "placeholders": [],
              "licenses": {b: st[b]["commercial"] for b in banks if b in st}}
    if not a.no_asr:
        from score_qa import audit
        vb = os.path.join(work, "qa_vocal_bus.wav")
        sf.write(vb, np.clip((lead + back * 0.6) * scale, -0.99, 0.99).astype(np.float32), SR)
        lyr = "".join(c for t in song["tracks"] for nn in t["notes"] for c in nn[3])
        wh = st.get("whisper", {}).get("path")
        qa = audit(files["master_wav"], song["bpm"], lyr, vb, os.path.join(out, "qa", os.path.basename(files["master_wav"])[:-4]), wh)
        qa.pop("asr_segments", None)
        report["qa"] = {k: qa[k] for k in ("lufs", "peak_dbfs", "clipped_samples", "beat_grid_lock", "pinyin_recall_pct", "bands_pct", "listening_notes") if k in qa}
    with open(fresh(os.path.join(out, f"{title}_{tag}_报告.json")), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print(json.dumps(report, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
