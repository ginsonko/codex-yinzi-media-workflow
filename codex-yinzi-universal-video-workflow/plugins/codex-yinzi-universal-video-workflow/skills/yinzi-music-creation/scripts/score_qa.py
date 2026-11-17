# -*- coding: utf-8 -*-
"""审听：响度/削波、节拍网格、频段占比、静音窟窿，再用语音识别核对字音（拼音召回）。

  python score_qa.py master.wav --bpm 156 --lyrics-file lyrics.txt [--vocal vocal_bus.wav] [--out qa/master]

拼音召回只是提示：人声轨上 ≥95% 一般听得清；整混音上会低 5–10 个点，这是正常的伴奏掩蔽。
识别模型：--whisper <本地模型目录> > installed.json 里的 whisper > faster-whisper small（首用自动下载）。
"""
import argparse
import json
import os
import re
from collections import Counter

import numpy as np
import soundfile as sf

_WHISPER = {}


def get_whisper(model=None):
    from faster_whisper import WhisperModel
    key = model or "small"
    if key not in _WHISPER:
        _WHISPER[key] = WhisperModel(key, device="cpu", compute_type="int8")
    return _WHISPER[key]


def pinyin_recall(expected, heard):
    from pypinyin import lazy_pinyin
    e = lazy_pinyin(re.sub(r"[^\u4e00-\u9fff]", "", expected))
    h = lazy_pinyin(re.sub(r"[^\u4e00-\u9fff]", "", heard))
    return round(sum((Counter(e) & Counter(h)).values()) / max(len(e), 1) * 100.0, 1)


def audit(wav, bpm, lyrics="", vocal=None, out_prefix=None, whisper=None):
    import librosa
    import pyloudnorm as pyln
    y, sr = sf.read(wav, always_2d=True)
    mono = y.mean(axis=1)
    rep = {"file": wav, "duration_s": round(len(y) / sr, 2)}
    rep["lufs"] = round(float(pyln.Meter(sr).integrated_loudness(y)), 2)
    rep["peak_dbfs"] = round(float(20 * np.log10(max(np.max(np.abs(y)), 1e-12))), 2)
    rep["clipped_samples"] = int(np.sum(np.abs(y) >= 0.999))

    env = librosa.onset.onset_strength(y=mono, sr=sr, hop_length=512)
    tempo, beats = librosa.beat.beat_track(onset_envelope=env, sr=sr, hop_length=512, start_bpm=bpm)
    bt = librosa.frames_to_time(beats, sr=sr, hop_length=512)
    period = 60.0 / bpm
    if len(bt) > 4:
        ph = np.mod(bt, period) / period * 2 * np.pi
        rep["beat_grid_lock"] = round(float(np.abs(np.mean(np.exp(1j * ph)))), 3)
    rep["detected_bpm"] = round(float(np.atleast_1d(tempo)[0]), 2)

    S = np.abs(librosa.stft(mono, n_fft=2048, hop_length=512)) ** 2
    f = librosa.fft_frequencies(sr=sr, n_fft=2048)
    tot = float(S.sum()) + 1e-12
    rep["bands_pct"] = {name: round(float(S[(f >= lo) & (f < hi)].sum() / tot * 100), 2) for name, lo, hi in
                        [("sub_20_90", 20, 90), ("bass_90_250", 90, 250), ("mud_250_800", 250, 800),
                         ("vocal_800_4k", 800, 4000), ("air_4k_16k", 4000, 16000)]}
    rms = librosa.feature.rms(y=mono, frame_length=2048, hop_length=512)[0]
    mid = rms[int(len(rms) * 0.05):int(len(rms) * 0.92)]
    rep["silent_hole_ratio"] = round(float(np.mean(mid < 0.003)), 4) if len(mid) else 0.0

    target = vocal if vocal and os.path.exists(vocal) else wav
    segs, _ = get_whisper(whisper).transcribe(target, language="zh", beam_size=5, vad_filter=True)
    segs = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segs]
    rep["asr_source"] = target
    rep["asr_text"] = " ".join(s["text"] for s in segs)
    rep["asr_segments"] = segs
    if lyrics:
        rep["pinyin_recall_pct"] = pinyin_recall(lyrics, rep["asr_text"])

    notes = []
    if rep["clipped_samples"]:
        notes.append("有削波：降低母带增益或检查限幅器")
    if abs(rep["lufs"] + 14) > 1:
        notes.append(f"响度 {rep['lufs']} LUFS，偏离 -14")
    if rep["bands_pct"]["mud_250_800"] > 45:
        notes.append("250–800 Hz 偏多，听感发闷：伴奏这一段再削 2–3 dB")
    if lyrics and rep.get("pinyin_recall_pct", 100) < 95:
        notes.append("字音召回 <95%：快字加 cons、主唱 2–4 kHz 提亮、伴奏让位")
    rep["listening_notes"] = notes or ["指标正常；仍要人耳听一遍情绪和咬字"]

    if out_prefix:
        os.makedirs(os.path.dirname(os.path.abspath(out_prefix)), exist_ok=True)
        with open(out_prefix + "_audit.json", "w", encoding="utf-8") as fh:
            json.dump(rep, fh, ensure_ascii=False, indent=1)
    return rep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("--bpm", type=float, required=True)
    ap.add_argument("--lyrics", default="")
    ap.add_argument("--lyrics-file")
    ap.add_argument("--vocal")
    ap.add_argument("--out")
    ap.add_argument("--whisper")
    a = ap.parse_args()
    lyr = open(a.lyrics_file, encoding="utf-8").read() if a.lyrics_file else a.lyrics
    rep = audit(a.wav, a.bpm, lyr, a.vocal, a.out, a.whisper)
    rep.pop("asr_segments", None)
    print(json.dumps(rep, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
