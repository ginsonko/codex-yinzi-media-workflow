"""Bounded, offline Blender smoke runner for the S1 capability contract.

This script is intentionally a small real render, not a product preview. It
creates one cube, a camera and a light, renders three PNG frames, saves a
.blend file and attempts a GLB export using Blender's built-in operator. The
backend only prepares the command; an explicit local executor must invoke it.
"""

import argparse
import json
import os
import sys

import bpy


def parse_args():
    # Blender places arguments after a standalone "--" in sys.argv.
    raw = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description="Yinzi S1 Blender smoke")
    parser.add_argument("--output", required=True)
    parser.add_argument("--input", required=False)
    parser.add_argument("--engine", default="BLENDER_EEVEE_NEXT")
    parser.add_argument("--frames", default="1,2,3")
    return parser.parse_args(raw)


def clean_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def build_scene(engine):
    scene = bpy.context.scene
    # Blender renamed the Eevee enum across releases. Try the requested
    # engine first, then known compatible fallbacks instead of assuming a
    # particular version's identifier.
    engine_candidates = []
    for candidate in (engine, "BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "BLENDER_WORKBENCH", "CYCLES"):
        if candidate and candidate not in engine_candidates:
            engine_candidates.append(candidate)
    for candidate in engine_candidates:
        try:
            scene.render.engine = candidate
            break
        except (TypeError, ValueError):
            continue
    else:
        raise RuntimeError("No supported Blender render engine is available")
    scene.render.resolution_x = 320
    scene.render.resolution_y = 180
    scene.render.resolution_percentage = 100
    scene.render.fps = 24

    bpy.ops.mesh.primitive_plane_add(size=8, location=(0, 0, 0))
    floor = bpy.context.object
    floor.name = "S1_Smoke_Floor"
    floor.data.materials.append(bpy.data.materials.new("S1_Smoke_Floor_Material"))
    floor.data.materials[0].diffuse_color = (0.12, 0.17, 0.2, 1.0)

    bpy.ops.mesh.primitive_cube_add(size=1.6, location=(0, 0, 0.8))
    cube = bpy.context.object
    cube.name = "S1_Smoke_Cube"
    material = bpy.data.materials.new("S1_Smoke_Cube_Material")
    material.diffuse_color = (0.1, 0.55, 0.75, 1.0)
    cube.data.materials.append(material)
    cube.rotation_euler[2] = 0.15
    cube.keyframe_insert(data_path="rotation_euler", frame=1, index=2)
    cube.rotation_euler[2] = 0.65
    cube.keyframe_insert(data_path="rotation_euler", frame=3, index=2)

    bpy.ops.object.light_add(type="AREA", location=(3, 4, 5))
    light = bpy.context.object
    light.name = "S1_Smoke_Key"
    light.data.energy = 900
    light.data.shape = "DISK"
    light.data.size = 4

    bpy.ops.object.camera_add(location=(4.8, -5.2, 3.4))
    camera = bpy.context.object
    camera.name = "S1_Smoke_Camera"
    camera.data.lens = 48
    scene.camera = camera
    # Track the cube without adding a dependency on a custom add-on.
    direction = cube.location - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()

    world = scene.world or bpy.data.worlds.new("S1_Smoke_World")
    scene.world = world
    world.color = (0.025, 0.035, 0.05)
    return scene


def export_glb(path):
    # Blender 4.x/5.x may expose a placeholder wm operator until the bundled
    # glTF add-on is enabled; older versions use export_scene.gltf directly.
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


def main():
    args = parse_args()
    output = os.path.abspath(args.output)
    os.makedirs(output, exist_ok=True)
    frames_dir = os.path.join(output, "frames")
    os.makedirs(frames_dir, exist_ok=True)
    # Preserve the normalized director input beside the smoke outputs. The
    # S1 scene is intentionally a fixed cube scene; conversion of arbitrary
    # director objects belongs to the next stage and is never implied here.
    input_snapshot = None
    if args.input:
        input_path = os.path.abspath(args.input)
        if os.path.isfile(input_path):
            with open(input_path, "r", encoding="utf-8") as handle:
                input_snapshot = json.load(handle)
            with open(os.path.join(output, "scene.json"), "w", encoding="utf-8") as handle:
                json.dump(input_snapshot, handle, ensure_ascii=False, indent=2)
    clean_scene()
    scene = build_scene(args.engine)
    frames = [int(item.strip()) for item in args.frames.split(",") if item.strip()]
    rendered = []
    for frame in frames:
        scene.frame_set(frame)
        target = os.path.join(frames_dir, "frame-%04d.png" % frame)
        scene.render.filepath = target
        bpy.ops.render.render(write_still=True)
        rendered.append(target)
    blend_path = os.path.join(output, "scene.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend_path)
    glb_path = os.path.join(output, "scene.glb")
    exporter = export_glb(glb_path)
    manifest = {
        "schema": "yinzi.blender-smoke-result/v1",
        "status": "succeeded" if rendered and os.path.exists(blend_path) else "partial",
        "engine": scene.render.engine,
        "frames": [os.path.relpath(item, output).replace(os.sep, "/") for item in rendered],
        "blend": os.path.relpath(blend_path, output).replace(os.sep, "/"),
        "glb": os.path.relpath(glb_path, output).replace(os.sep, "/") if exporter and os.path.exists(glb_path) else None,
        "gltf_export_operator": exporter,
        "input_scene_snapshot": input_snapshot is not None,
        "video": {"status": "not_created", "reason": "S1 smoke leaves MP4 encoding to a separately verified FFmpeg stage"},
    }
    with open(os.path.join(output, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
    return 0 if manifest["status"] == "succeeded" else 2


if __name__ == "__main__":
    sys.exit(main())
