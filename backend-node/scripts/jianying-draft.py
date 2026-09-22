#!/usr/bin/env python3
"""Build independent Jianying drafts. Never controls the GUI or private APIs.

Requires the isolated pyJianYingDraft==0.3.0 environment created by setup-jianying.py.
All public times are seconds; only this adapter converts them to microseconds.
"""
import argparse
import importlib.metadata
import json
import math
import re
import shutil
import sys
import uuid
from pathlib import Path


class DraftError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def checked(obj, allowed, label):
    if not isinstance(obj, dict):
        raise DraftError("JIANYING_INVALID_JOB", f"{label} 必须是对象")
    unknown = set(obj) - set(allowed.split())
    if unknown:
        raise DraftError("JIANYING_UNSUPPORTED_FIELD", f"{label} 含未支持的字段：{', '.join(sorted(unknown))}")
    return obj


def number(value, label, minimum=None, maximum=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise DraftError("JIANYING_INVALID_NUMBER", f"{label} 必须是有限数值")
    if minimum is not None and value < minimum or maximum is not None and value > maximum:
        raise DraftError("JIANYING_INVALID_NUMBER", f"{label} 超出允许范围")
    return value


def seconds(value, label="time", positive=False):
    return round(number(value, label, minimum=0.000001 if positive else 0) * 1_000_000)


def integer(value, label, minimum=0, maximum=None):
    number(value, label, minimum, maximum)
    if int(value) != value:
        raise DraftError("JIANYING_INVALID_NUMBER", f"{label} 必须是整数")
    return int(value)


def local_file(value, base):
    if not isinstance(value, str) or not value or re.match(r"^[a-z]+://", value, re.I):
        raise DraftError("JIANYING_LOCAL_PATH_REQUIRED", "仅支持已有本地素材，不会下载或上传")
    target = (base / value).resolve()
    if not target.is_file() or target.stat().st_size == 0:
        raise DraftError("JIANYING_INPUT_MISSING", f"素材不存在或为空：{target}")
    return str(target)


def enum_value(cls, name):
    if not isinstance(name, str) or name not in cls.__members__:
        raise DraftError("JIANYING_UNKNOWN_PRESET", f"未知 {cls.__name__} 预设：{name}；请使用当前依赖的准确枚举名，不会猜测替换")
    return cls[name]


def object_options(value, cls, label):
    import inspect
    allowed = set(inspect.signature(cls).parameters)
    checked(value, " ".join(allowed), label)
    for key, item in value.items():
        if isinstance(item, (int, float)) and not isinstance(item, bool):
            number(item, label + "." + key)
    for key in ("color",):
        if key in value and not isinstance(value[key], str):
            if not isinstance(value[key], list) or len(value[key]) != 3:
                raise DraftError("JIANYING_INVALID_COLOR", f"{label}.{key} 需要三个 0–1 分量")
            for item in value[key]:
                number(item, label + "." + key, 0, 1)
    return cls(**value)


def visual_properties(segment, spec, d, resources, text=False):
    for item in spec.get("keyframes", []):
        checked(item, "property time value", "keyframe")
        stamp = seconds(item["time"], "keyframe.time")
        if stamp > segment.duration:
            raise DraftError("JIANYING_KEYFRAME_RANGE", "关键帧时间不能超出片段时长")
        segment.add_keyframe(enum_value(d.KeyframeProperty, item["property"]), stamp, number(item["value"], "keyframe.value"))
    if spec.get("animation"):
        anim = checked(spec["animation"], "kind name duration", "animation")
        classes = {"intro": d.TextIntro, "outro": d.TextOutro, "loop": d.TextLoopAnim} if text else {
            "intro": d.IntroType, "outro": d.OutroType, "group": d.GroupAnimationType}
        if anim.get("kind", "intro") not in classes:
            raise DraftError("JIANYING_UNKNOWN_PRESET", "animation.kind 不受支持")
        args = {"duration": seconds(anim["duration"], "animation.duration", True)} if "duration" in anim else {}
        segment.add_animation(enum_value(classes[anim.get("kind", "intro")], anim["name"]), **args)
        resources.append({"type": "text_animation" if text else "clip_animation", "name": anim["name"], "availability": "unverified"})


def rewrite_resources(value, original, destination):
    if isinstance(value, list):
        for child in value:
            rewrite_resources(child, original, destination)
    elif isinstance(value, dict):
        for key, item in value.items():
            if (key == "path" or key.endswith("_path")) and isinstance(item, str) and item.strip() and not re.match(r"^[a-z]+://", item, re.I):
                source = (original / item).resolve()
                if not source.exists():
                    raise DraftError("JIANYING_TEMPLATE_RESOURCE_MISSING", f"模板依赖不存在：{source}")
                try:
                    value[key] = str(destination / source.relative_to(original))
                except ValueError:
                    value[key] = str(source)
            elif key == "content" and isinstance(item, str) and item.strip().startswith("{"):
                try:
                    embedded = json.loads(item)
                except ValueError:
                    continue
                rewrite_resources(embedded, original, destination)
                value[key] = json.dumps(embedded, ensure_ascii=False)
            elif isinstance(item, (dict, list)):
                rewrite_resources(item, original, destination)


def build(job_path, output_root, build_id):
    import pyJianYingDraft as d
    if importlib.metadata.version("pyJianYingDraft") != "0.3.0":
        raise DraftError("JIANYING_VERSION_UNTESTED", "当前适配器仅验证 pyJianYingDraft==0.3.0，请运行隔离安装器")
    base = job_path.resolve().parent
    job = checked(json.loads(job_path.read_text(encoding="utf-8-sig")), "name width height fps clips texts subtitles template", "job")
    for key in ("clips", "texts", "subtitles"):
        if not isinstance(job.get(key, []), list):
            raise DraftError("JIANYING_INVALID_JOB", f"{key} 必须是数组")
    if not any(job.get(key) for key in ("clips", "texts", "subtitles", "template")):
        raise DraftError("JIANYING_EMPTY_JOB", "工程至少需要一种素材、字幕或模板")
    name = str(job.get("name", "Yinzi Jianying"))
    safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")[:80] or "Yinzi"
    if re.match(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", safe_name, re.I):
        safe_name = "Yinzi_" + safe_name
    suffix = str(uuid.UUID(build_id))
    root = output_root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    target = root / (safe_name + "-" + suffix)
    if target.exists():
        raise DraftError("JIANYING_OUTPUT_EXISTS", f"不会覆盖已有草稿：{target}")
    resources = []
    folder = d.DraftFolder(str(root))
    template = job.get("template")
    if template:
        checked(template, "path text_replacements media_replacements", "template")
        original = (base / template["path"]).resolve()
        if original.is_file():
            if original.name != "draft_content.json":
                raise DraftError("JIANYING_TEMPLATE_INVALID", "模板文件名必须是 draft_content.json")
            original = original.parent
        try:
            content = json.loads((original / "draft_content.json").read_text(encoding="utf-8-sig"))
            if not isinstance(content.get("tracks"), list) or not isinstance(content.get("materials"), dict) or not content.get("canvas_config"):
                raise ValueError("缺少轨道、素材或画布信息")
        except (ValueError, UnicodeError) as exc:
            raise DraftError("JIANYING_TEMPLATE_INVALID", "模板不是受支持的明文 JSON，不会解密或绕过应用接口：" + str(exc)) from exc
        if target.is_relative_to(original):
            raise DraftError("JIANYING_TEMPLATE_RECURSION", "输出目录不能位于模板目录内")
        if original.is_symlink() or any(p.is_symlink() for p in original.rglob("*")):
            raise DraftError("JIANYING_SYMLINK_UNSUPPORTED", "模板目录不能包含符号链接")
        shutil.copytree(original, target)
        rewrite_resources(content["materials"], original, target)
        (target / "draft_content.json").write_text(json.dumps(content, ensure_ascii=False), encoding="utf-8")
        script = folder.load_template(target.name)
        if any(key in job for key in ("width", "height", "fps")):
            raise DraftError("JIANYING_TEMPLATE_CANVAS", "模板模式保留原画布和帧率；请不要同时指定 width/height/fps")
        for item in template.get("text_replacements", []):
            checked(item, "track index text", "text_replacement")
            if not isinstance(item["text"], (str, list)) or isinstance(item["text"], list) and not all(isinstance(t, str) for t in item["text"]):
                raise DraftError("JIANYING_INVALID_TEXT", "替换文字需要字符串或文本模板对应的字符串列表")
            track = script.get_imported_track(d.TrackType.text, name=item["track"])
            script.replace_text(track, integer(item["index"], "replacement.index"), item["text"])
        for item in template.get("media_replacements", []):
            checked(item, "name path kind", "media_replacement")
            if item.get("kind", "video") not in ("video", "image", "audio"):
                raise DraftError("JIANYING_INVALID_KIND", "模板仅支持视频、图片、音频替换")
            is_audio = item.get("kind") == "audio"
            material = (d.AudioMaterial if is_audio else d.VideoMaterial)(local_file(item["path"], base))
            collection = content["materials"].get("audios" if is_audio else "videos", [])
            matches = [m for m in collection if m.get("name" if is_audio else "material_name") == item["name"]]
            if len(matches) != 1:
                raise DraftError("JIANYING_TEMPLATE_MATCH", f"模板素材名需唯一匹配：{item['name']}（实际 {len(matches)} 个）")
            source_id = matches[0]["id"]
            for track in content["tracks"]:
                for seg in track.get("segments", []):
                    if seg.get("material_id") == source_id:
                        span = seg.get("source_timerange") or {}
                        if span.get("start", 0) + span.get("duration", 0) > material.duration:
                            raise DraftError("JIANYING_TEMPLATE_MEDIA_SHORT", "替换素材短于模板引用范围；请先剪出足够时长，不会静默缩短时间线")
            script.replace_material_by_name(item["name"], material)
        resources.append({"type": "template", "name": original.name, "availability": "local_plaintext_only", "license": "user_provided_not_verified"})
        for bucket, items in content["materials"].items():
            if isinstance(items, list):
                for material in items:
                    if isinstance(material, dict) and (material.get("resource_id") or material.get("effect_id")):
                        resources.append({"type": "template_" + bucket, "name": material.get("name") or material.get("id"),
                                          "resource_id": material.get("resource_id"), "effect_id": material.get("effect_id"), "availability": "unverified"})
    else:
        script = folder.create_draft(target.name, integer(job.get("width", 1920), "width", 1, 16384),
                                     integer(job.get("height", 1080), "height", 1, 16384), integer(job.get("fps", 30), "fps", 1, 120))
    tracks = {}

    def add_track(track_name, kind):
        if not isinstance(track_name, str) or not track_name.strip():
            raise DraftError("JIANYING_INVALID_TRACK", "轨道名称不能为空")
        if track_name in tracks and tracks[track_name] != kind:
            raise DraftError("JIANYING_TRACK_CONFLICT", "同一轨道名称不能混用素材类型")
        if track_name not in tracks:
            script.append_track(d.TrackSpec(kind, track_name))
            tracks[track_name] = kind

    for item in job.get("clips", []):
        checked(item, "path kind track start duration source_start speed volume transform keyframes filters transition animation fade", "clip")
        kind = item.get("kind", "video")
        if kind not in ("video", "image", "audio"):
            raise DraftError("JIANYING_INVALID_KIND", f"未知素材类型：{kind}")
        audio = kind == "audio"
        track_name = item.get("track", "audio" if audio else "footage")
        add_track(track_name, d.TrackType.audio if audio else d.TrackType.video)
        target_span = d.Timerange(seconds(item.get("start", 0)), seconds(item["duration"], "duration", True))
        speed = number(item.get("speed", 1), "speed", 0.01, 100)
        source_span = d.Timerange(seconds(item.get("source_start", 0)), round(target_span.duration * speed))
        kwargs = {"source_timerange": source_span, "volume": number(item.get("volume", 1), "volume", 0, 10)}
        if not audio:
            kwargs["clip_settings"] = object_options(item.get("transform", {}), d.ClipSettings, "transform")
        segment = (d.AudioSegment if audio else d.VideoSegment)(local_file(item["path"], base), target_span, **kwargs)
        if audio:
            for key in ("transform", "filters", "transition", "animation"):
                if key in item:
                    raise DraftError("JIANYING_UNSUPPORTED_FIELD", f"audio 不支持视觉字段 {key}")
            for frame in item.get("keyframes", []):
                checked(frame, "property time value", "audio keyframe")
                if frame.get("property") != "volume":
                    raise DraftError("JIANYING_UNKNOWN_PRESET", "音频关键帧仅支持 volume")
                stamp = seconds(frame["time"])
                if stamp > segment.duration:
                    raise DraftError("JIANYING_KEYFRAME_RANGE", "关键帧时间超出片段")
                segment.add_keyframe(stamp, number(frame["value"], "volume", 0, 10))
        else:
            visual_properties(segment, item, d, resources)
            for preset in item.get("filters", []):
                checked(preset, "name intensity", "filter")
                segment.add_filter(enum_value(d.FilterType, preset["name"]), number(preset.get("intensity", 100), "filter.intensity", 0, 100))
                resources.append({"type": "filter", "name": preset["name"], "availability": "unverified"})
            if item.get("transition"):
                preset = checked(item["transition"], "name duration", "transition")
                args = {"duration": seconds(preset["duration"], "transition.duration", True)} if "duration" in preset else {}
                if args.get("duration", 0) > segment.duration:
                    raise DraftError("JIANYING_TRANSITION_RANGE", "转场时长不能大于片段时长")
                segment.add_transition(enum_value(d.TransitionType, preset["name"]), **args)
                resources.append({"type": "transition", "name": preset["name"], "availability": "unverified"})
        if item.get("fade"):
            fade = checked(item["fade"], "in out", "fade")
            fade_in, fade_out = seconds(fade.get("in", 0)), seconds(fade.get("out", 0))
            if fade_in + fade_out > segment.duration:
                raise DraftError("JIANYING_FADE_RANGE", "淡入淡出总时长不能超过片段")
            segment.add_fade(fade_in, fade_out)
        script.add_segment(segment, track_name)

    for item in job.get("texts", []):
        checked(item, "text track start duration font style border shadow background transform keyframes animation", "text")
        if not isinstance(item.get("text"), str) or not item["text"]:
            raise DraftError("JIANYING_INVALID_TEXT", "文字片段需要非空字符串")
        track_name = item.get("track", "titles")
        add_track(track_name, d.TrackType.text)
        kwargs = {"style": object_options(item.get("style", {}), d.TextStyle, "style"),
                  "clip_settings": object_options(item.get("transform", {}), d.ClipSettings, "transform")}
        for key, cls in (("border", d.TextBorder), ("shadow", d.TextShadow), ("background", d.TextBackground)):
            if key in item:
                kwargs[key] = object_options(item[key], cls, key)
        if item.get("font"):
            kwargs["font"] = enum_value(d.FontType, item["font"])
            resources.append({"type": "font", "name": item["font"], "availability": "unverified"})
        segment = d.TextSegment(item["text"], d.Timerange(seconds(item.get("start", 0)), seconds(item["duration"], "duration", True)), **kwargs)
        visual_properties(segment, item, d, resources, text=True)
        script.add_segment(segment, track_name)
    for i, item in enumerate(job.get("subtitles", [])):
        checked(item, "path track offset style transform", "subtitles")
        script.import_srt(local_file(item["path"], base), track_name=item.get("track", f"subtitles-{i + 1}"),
                          time_offset=seconds(item.get("offset", 0)),
                          text_style=object_options(item.get("style", {"size": 5, "align": 1, "auto_wrapping": True}), d.TextStyle, "subtitles.style"),
                          clip_settings=object_options(item.get("transform", {"transform_y": -0.8}), d.ClipSettings, "subtitles.transform"))
    script.save()
    content_path = target / "draft_content.json"
    content = json.loads(content_path.read_text(encoding="utf-8-sig"))
    identity = str(uuid.uuid4()).upper()
    content["id"] = identity
    content_path.write_text(json.dumps(content, ensure_ascii=False, indent=2), encoding="utf-8")
    meta_path = target / "draft_meta_info.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8-sig")) if meta_path.exists() else {}
    meta.update(draft_name=name, draft_id=identity, draft_fold_path=str(target), draft_root_path=str(root), tm_duration=content["duration"])
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    note = ("草稿已生成，尚未在剪映内确认载入或导出。\n"
            f"工程名称：{name}\n"
            "1. 由工作流确认剪映当前草稿保存位置，将整个独立工程目录放入该位置并核对首页是否收录。不要覆盖同名工程或改写旧工程索引。\n"
            "2. 从剪映首页的草稿列表点击上述工程名称。编辑页的「素材→导入」只接收视频、图片和音频，不能用来打开工程 JSON；该窗口显示空目录不代表工程丢失。\n"
            "3. 核对媒体链接、滤镜/动画/字体资源是否可用以及会员提示。工具不会购买或下载收费资源。\n"
            "4. 导出视频后检查完整解码、画面、声音、转场与字幕，再判断成片质量。\n"
            "此工程可能引用原始素材的绝对路径；迁移电脑前请收集并重链接素材。\n")
    (target / "YINZI-OPEN-AND-REVIEW.txt").write_text(note, encoding="utf-8")
    (target / "yinzi-resource-manifest.json").write_text(json.dumps(resources, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"status": "draft_ready", "stage": "draft_ready", "project_name": name, "draft_path": str(target), "draft_content_path": str(content_path),
            "draft_id": identity, "duration_seconds": content["duration"] / 1_000_000, "tracks": len(content["tracks"]),
            "segments": sum(len(t.get("segments", [])) for t in content["tracks"]), "resources": resources,
            "editor_load_verified": False, "export_verified": False, "visual_quality_verified": False,
            "next_action": f"先确认工程已放入剪映当前草稿保存位置，再从首页草稿列表打开「{name}」。不要从素材导入窗口打开 JSON；核对素材与效果后导出并验收。",
            "library": "pyJianYingDraft==0.3.0", "portable_media_bundle": False}


def catalog(preset_type, query, limit):
    import pyJianYingDraft as d
    kinds = {"filter": d.FilterType, "transition": d.TransitionType, "text_intro": d.TextIntro,
             "text_outro": d.TextOutro, "text_loop": d.TextLoopAnim, "font": d.FontType,
             "clip_intro": d.IntroType, "clip_outro": d.OutroType, "clip_group": d.GroupAnimationType,
             "keyframe": d.KeyframeProperty}
    if preset_type not in kinds:
        raise DraftError("JIANYING_UNKNOWN_CATALOG", "未知预设类别；支持：" + ", ".join(kinds))
    integer(limit, "limit", 1, 100)
    found = []
    for name, member in kinds[preset_type].__members__.items():
        display = getattr(member.value, "name", name)
        if query.casefold() in (name + " " + display).casefold():
            found.append({"name": name, "display_name": display, "library_vip_hint": getattr(member.value, "is_vip", None)})
    return {"preset_type": preset_type, "query": query, "total": len(found), "items": found[:limit],
            "availability": "reference_only_editor_unverified", "library": "pyJianYingDraft==" + importlib.metadata.version("pyJianYingDraft"),
            "note": "这是依赖包内资源名索引，不能证明当前剪映版本已缓存、免费、可用或具有商用授权。"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("probe", help="Read-only dependency check")
    c = sub.add_parser("catalog", help="Search bundled preset metadata, without downloading resources")
    c.add_argument("--type", required=True)
    c.add_argument("--query", default="")
    c.add_argument("--limit", type=int, default=20)
    b = sub.add_parser("build", help="Generate a fresh independent draft; does not open/export it")
    b.add_argument("--job", type=Path, required=True)
    b.add_argument("--output-root", type=Path, required=True)
    b.add_argument("--id", required=True)
    args = parser.parse_args()
    try:
        if args.command == "probe":
            import pyJianYingDraft  # noqa: F401; importability is the capability being probed
            version = importlib.metadata.version("pyJianYingDraft")
            result = {"ready": version == "0.3.0", "library": "pyJianYingDraft", "version": version, "python": sys.executable}
        elif args.command == "catalog":
            result = catalog(args.type, args.query, args.limit)
        else:
            result = build(args.job, args.output_root, args.id)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"status": "failed", "code": getattr(exc, "code", "JIANYING_DRAFT_FAILED"), "error": str(exc)}, ensure_ascii=False))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
