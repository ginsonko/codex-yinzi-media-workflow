"""Bounded scene-to-Blender renderer for the Codex professional director path.

The backend writes a normalized scene JSON and invokes this fixed script. It
does not execute user supplied Python or load external project files. Unknown
asset types become visible placeholders and are reported in the manifest so a
browser GLB preview is useful without pretending to be a final asset render.
"""

import argparse
import json
import math
import os
import sys

import bpy
from mathutils import Vector


def parse_args():
    raw = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description="Yinzi bounded Blender render")
    parser.add_argument("--output", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--engine", default="BLENDER_EEVEE_NEXT")
    parser.add_argument("--frames", default="1,2,3")
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=360)
    parser.add_argument("--fps", type=int, default=24)
    return parser.parse_args(raw)


def clamp(value, low, high, fallback):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, number))


def vec3(value, fallback=(0.0, 0.0, 0.0)):
    values = value if isinstance(value, (list, tuple)) else fallback
    return tuple(clamp(values[index] if index < len(values) else fallback[index], -100.0, 100.0, fallback[index]) for index in range(3))


def color(value, fallback=(0.35, 0.45, 0.55, 1.0)):
    text = str(value or "").strip().lstrip("#")
    if len(text) not in (6, 8):
        return fallback
    try:
        channels = tuple(int(text[index:index + 2], 16) / 255.0 for index in range(0, len(text), 2))
    except ValueError:
        return fallback
    return (channels + (1.0,))[:4] if len(channels) == 3 else channels


def make_material(name, props):
    material = bpy.data.materials.new(name)
    material.diffuse_color = color(props.get("color"), (0.35, 0.45, 0.55, 1.0))
    material.use_nodes = True
    principled = material.node_tree.nodes.get("Principled BSDF")
    if principled:
        principled.inputs["Base Color"].default_value = material.diffuse_color
        principled.inputs["Roughness"].default_value = clamp(props.get("roughness"), 0.05, 1.0, 0.55)
        opacity = clamp(props.get("opacity"), 0.05, 1.0, 1.0)
        principled.inputs["Alpha"].default_value = opacity
        if opacity < 0.999 and hasattr(material, "surface_render_method"):
            material.surface_render_method = "DITHERED"
        emissive = color(props.get("emissive"), (0.0, 0.0, 0.0, 1.0))
        if "Emission Color" in principled.inputs:
            principled.inputs["Emission Color"].default_value = emissive
            principled.inputs["Emission Strength"].default_value = clamp(props.get("emissive_intensity"), 0.0, 20.0, 0.0)
    return material


def apply_material(obj, props, index):
    material = make_material("Yinzi_Material_%03d" % index, props or {})
    if hasattr(obj.data, "materials"):
        obj.data.materials.append(material)


def add_primitive(kind, name, position, scale, props, warnings, index):
    shape = kind
    if shape == "plane":
        bpy.ops.mesh.primitive_plane_add(size=2.0, location=position)
    elif shape == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12, radius=0.5, location=position)
    elif shape == "cylinder":
        bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.5, depth=1.0, location=position)
    else:
        if shape not in ("box", "cube", "asset", "character", "procedural"):
            warnings.append("unsupported_shape:%s" % shape)
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=position)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    apply_material(obj, props or {}, index)
    return obj


def build_procedural(obj, recipe, warnings, index):
    nodes = recipe.get("nodes", []) if isinstance(recipe, dict) else []
    if not nodes:
        warnings.append("procedural_without_nodes:%s" % obj.name)
        return
    # The root object is an empty so recipe pieces can retain their own shape
    # and material while the director timeline moves the whole asset.
    root = bpy.data.objects.new(obj.name + "_root", None)
    bpy.context.collection.objects.link(root)
    root.location = obj.location
    root.rotation_euler = obj.rotation_euler
    root.scale = obj.scale
    for node_index, node in enumerate(nodes[:24]):
        node_props = node.get("material", {}) if isinstance(node, dict) else {}
        shape = str(node.get("shape", "box")) if isinstance(node, dict) else "box"
        piece = add_primitive(shape, "%s_part_%02d" % (obj.name, node_index), vec3(node.get("position")), vec3(node.get("scale"), (0.5, 0.5, 0.5)), node_props, warnings, index + node_index + 1)
        piece.rotation_euler = vec3(node.get("rotation"))
        piece.parent = root
    bpy.data.objects.remove(obj, do_unlink=True)
    return root


def look_at(camera, target):
    direction = Vector(target) - camera.location
    if direction.length < 0.001:
        return
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def choose_engine(scene, requested):
    candidates = []
    for item in (requested, "BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "BLENDER_WORKBENCH", "CYCLES"):
        if item and item not in candidates:
            candidates.append(item)
    for item in candidates:
        try:
            scene.render.engine = item
            return item
        except (TypeError, ValueError):
            continue
    raise RuntimeError("No supported Blender render engine is available")


def export_glb(path):
    if hasattr(bpy.ops.wm, "gltf_export"):
        try:
            bpy.ops.wm.gltf_export(filepath=path, export_format="GLB")
            return "wm.gltf_export"
        except (AttributeError, RuntimeError):
            pass
    if hasattr(bpy.ops.preferences, "addon_enable"):
        try:
            bpy.ops.preferences.addon_enable(module="io_scene_gltf2")
        except (AttributeError, RuntimeError):
            pass
    if hasattr(bpy.ops.export_scene, "gltf"):
        try:
            bpy.ops.export_scene.gltf(filepath=path, export_format="GLB")
            return "export_scene.gltf"
        except (AttributeError, RuntimeError):
            pass
    return None


def load_scene(path):
    with open(path, "r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict) or not isinstance(value.get("objects"), list):
        raise ValueError("normalized director scene is invalid")
    return value


def build_scene(document, args):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    engine = choose_engine(scene, args.engine)
    scene.render.resolution_x = max(160, min(1280, args.width))
    scene.render.resolution_y = max(90, min(720, args.height))
    scene.render.resolution_percentage = 100
    scene.render.fps = max(1, min(60, args.fps))
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    world = scene.world or bpy.data.worlds.new("Yinzi_World")
    scene.world = world
    world.color = (0.02, 0.025, 0.04)

    warnings = []
    objects = {}
    camera_specs = []
    for index, spec in enumerate(document.get("objects", [])[:80]):
        kind = str(spec.get("kind", "box"))
        object_id = str(spec.get("id", "object-%d" % index))
        props = spec.get("props") if isinstance(spec.get("props"), dict) else {}
        position = vec3(spec.get("position"))
        scale = vec3(spec.get("scale"), (1.0, 1.0, 1.0))
        if kind == "camera":
            bpy.ops.object.camera_add(location=position)
            obj = bpy.context.object
            obj.name = spec.get("name") or object_id
            obj.data.angle = math.radians(clamp(props.get("fov"), 18.0, 120.0, 42.0))
            camera_specs.append((obj, props))
        elif kind == "light":
            light_type = "AREA" if str(props.get("type", "AREA")).upper() == "AREA" else "POINT"
            bpy.ops.object.light_add(type=light_type, location=position)
            obj = bpy.context.object
            obj.name = spec.get("name") or object_id
            obj.data.energy = clamp(props.get("intensity"), 0.1, 5000.0, 900.0)
            if light_type == "AREA":
                obj.data.shape = "DISK"
                obj.data.size = clamp(props.get("size"), 0.1, 20.0, 4.0)
        elif kind == "character":
            obj = add_primitive("character", spec.get("name") or object_id, position, (0.45 * scale[0], 0.45 * scale[1], 1.0 * scale[2]), props, warnings, index)
            bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=10, radius=0.36, location=(position[0], position[1], position[2] + 1.15 * scale[2]))
            head = bpy.context.object
            head.name = (spec.get("name") or object_id) + "_head"
            head.parent = obj
            head.location = (0.0, 0.0, 0.75)
            apply_material(head, props, index + 1)
        elif kind == "procedural":
            placeholder = add_primitive("box", spec.get("name") or object_id, position, scale, props, warnings, index)
            placeholder.rotation_euler = vec3(spec.get("rotation"))
            root = build_procedural(placeholder, props.get("recipe", {}), warnings, index)
            obj = root or placeholder
        else:
            obj = add_primitive(kind, spec.get("name") or object_id, position, scale, props, warnings, index)
        obj.rotation_euler = vec3(spec.get("rotation"))
        objects[object_id] = obj

    for object_id, spec in ((str(item.get("id")), item) for item in document.get("objects", [])[:80]):
        parent_id = str((spec.get("props") or {}).get("attach_to", "")).strip()
        if parent_id and object_id in objects and parent_id in objects:
            child = objects[object_id]
            child.parent = objects[parent_id]
            child.location = vec3((spec.get("props") or {}).get("local_offset"))
            child.rotation_euler = vec3((spec.get("props") or {}).get("local_rotation"))
            child.scale = vec3((spec.get("props") or {}).get("local_scale"), (1.0, 1.0, 1.0))
        elif parent_id:
            warnings.append("missing_attachment_parent:%s" % object_id)

    active_id = str(document.get("active_camera_id", ""))
    if active_id in objects and objects[active_id].type == "CAMERA":
        scene.camera = objects[active_id]
    elif camera_specs:
        scene.camera = camera_specs[0][0]
    for camera, props in camera_specs:
        target_id = str(props.get("target_id", "")).strip()
        if target_id in objects:
            constraint = camera.constraints.new(type="TRACK_TO")
            constraint.target = objects[target_id]
            constraint.track_axis = "TRACK_NEGATIVE_Z"
            constraint.up_axis = "UP_Y"
        elif props.get("aim_mode", "target") != "rotation":
            look_at(camera, vec3(props.get("target"), (0.0, 0.8, 0.0)))
    return scene, objects, warnings, engine


def apply_keyframes(scene, objects, keyframes):
    for keyframe in keyframes:
        object_id = str(keyframe.get("object_id", ""))
        obj = objects.get(object_id)
        if obj is None:
            continue
        frame = max(1, int(round(float(keyframe.get("time", 0.0)) * scene.render.fps)) + 1)
        if "position" in keyframe:
            obj.location = vec3(keyframe.get("position"))
        if "rotation" in keyframe:
            obj.rotation_euler = vec3(keyframe.get("rotation"))
        if "scale" in keyframe:
            obj.scale = vec3(keyframe.get("scale"), (1.0, 1.0, 1.0))
        if "local_offset" in keyframe:
            obj.location = vec3(keyframe.get("local_offset"))
        if "local_rotation" in keyframe:
            obj.rotation_euler = vec3(keyframe.get("local_rotation"))
        if "local_scale" in keyframe:
            obj.scale = vec3(keyframe.get("local_scale"), (1.0, 1.0, 1.0))
        obj.keyframe_insert(data_path="location", frame=frame)
        obj.keyframe_insert(data_path="rotation_euler", frame=frame)
        obj.keyframe_insert(data_path="scale", frame=frame)


def intact_file(target, kind):
    try:
        with open(target, "rb") as handle:
            header = handle.read(12)
            if kind == "png":
                handle.seek(-12, os.SEEK_END)
                return header[:8] == bytes.fromhex("89504e470d0a1a0a") and handle.read(12)[4:8] == b"IEND"
            if kind == "blend":
                return header[:7] == b"BLENDER" or header[:4] == bytes.fromhex("28b52ffd") or header[:2] == bytes.fromhex("1f8b")
            return header[:4] == b"glTF" and int.from_bytes(header[8:12], "little") == os.path.getsize(target)
    except (OSError, ValueError):
        return False


def progress(phase, **values):
    print("YINZI_PROGRESS " + json.dumps(dict(phase=phase, **values)), flush=True)


def main():
    args = parse_args()
    output = os.path.abspath(args.output)
    os.makedirs(os.path.join(output, "frames"), exist_ok=True)
    document = load_scene(os.path.abspath(args.input))
    scene, objects, warnings, engine = build_scene(document, args)
    apply_keyframes(scene, objects, document.get("timeline", {}).get("keyframes", []))
    scene.frame_end = max(1, round(document.get("timeline", {}).get("duration", 5) * scene.render.fps))
    scene.frame_set(1)
    progress("modeling")
    blend_path = os.path.join(output, "scene.blend")
    if not intact_file(blend_path, "blend"):
        bpy.ops.wm.save_as_mainfile(filepath=blend_path, compress=False)
    glb_path = os.path.join(output, "scene.glb")
    exporter = "reused" if intact_file(glb_path, "glb") else export_glb(glb_path)
    progress("exporting")
    frames = []
    for raw in str(args.frames).split(","):
        try:
            frame = max(1, int(raw.strip()))
        except ValueError:
            continue
        scene.frame_set(frame)
        target = os.path.join(output, "frames", "frame-%04d.png" % frame)
        if not intact_file(target, "png"):
            scene.render.filepath = target
            bpy.ops.render.render(write_still=True)
        if os.path.isfile(target):
            frames.append(os.path.relpath(target, output).replace(os.sep, "/"))
            progress("rendering", frame=frame, completed_frames=len(frames))
    result = {
        "schema": "yinzi.blender-render-result/v1",
        "status": "succeeded" if frames and os.path.isfile(blend_path) else "partial",
        "engine": engine,
        "objects": len(objects),
        "keyframes": len(document.get("timeline", {}).get("keyframes", [])),
        "frames": frames,
        "blend": "scene.blend" if os.path.isfile(blend_path) else None,
        "glb": "scene.glb" if exporter and os.path.isfile(glb_path) else None,
        "gltf_export_operator": exporter,
        "warnings": warnings,
        "video": {"status": "pending", "reason": "FFmpeg is an independent backend stage"},
    }
    temporary = os.path.join(output, "manifest.json.tmp")
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
    os.replace(temporary, os.path.join(output, "manifest.json"))
    return 0 if result["status"] == "succeeded" else 2


if __name__ == "__main__":
    sys.exit(main())
