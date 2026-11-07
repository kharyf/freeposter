# Shared by FreePoster's Blender templates (each template.py adds this folder to sys.path and imports it).
# Works on Blender 2.92 through 4.x: no .blend files, everything is built in code.
import json
import math
import os
import sys

import bpy


def load_config():
    """params.json from FreePoster: {params, duration_sec, fps, width, height, engine, out_dir}."""
    argv = sys.argv[sys.argv.index("--") + 1:]
    with open(argv[0], encoding="utf-8") as f:
        return json.load(f)


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def color(hex_value, alpha=1.0):
    h = hex_value.lstrip("#")
    return tuple(srgb_to_linear(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4)) + (alpha,)


def setup_scene(cfg, background="#000000"):
    scene = bpy.context.scene
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    r = scene.render
    r.resolution_x, r.resolution_y, r.resolution_percentage = cfg["width"], cfg["height"], 100
    r.fps = cfg["fps"]
    scene.frame_start = 1
    scene.frame_end = max(1, round(cfg["duration_sec"] * cfg["fps"]))
    if cfg.get("engine") == "cycles":
        r.engine = "CYCLES"
        scene.cycles.samples = 64
    else:
        for name in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
            try:
                r.engine = name
                break
            except TypeError:
                continue
    r.image_settings.file_format = "PNG"
    r.image_settings.color_mode = "RGB"
    r.filepath = os.path.join(cfg["out_dir"], "frame_")
    # Colors as given, not tone-mapped (Filmic in 2.x, AgX in 4.x would wash them out).
    scene.view_settings.view_transform = "Standard"
    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = color(background)

    bpy.ops.object.camera_add(location=(0, -20, 0), rotation=(math.pi / 2, 0, 0))
    cam = bpy.context.object
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 16  # 16 units tall, 9 wide at 9:16
    scene.camera = cam
    return scene


def emission_material(name, hex_value, strength=1.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    em = nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = color(hex_value)
    em.inputs["Strength"].default_value = strength
    mat.node_tree.links.new(em.outputs[0], out.inputs[0])
    return mat, em


def add_text(body, size=1.0, extrude=0.0):
    bpy.ops.object.text_add(location=(0, 0, 0))
    obj = bpy.context.object
    obj.data.body = body
    obj.data.align_x = "CENTER"
    obj.data.align_y = "CENTER"
    obj.data.size = size
    obj.data.extrude = extrude
    obj.rotation_euler = (math.pi / 2, 0, 0)  # face the camera
    return obj


def fit_width(obj, max_width):
    """Scales the object down so it is at most max_width units wide."""
    bpy.context.view_layer.update()
    width = obj.dimensions.x
    if width > max_width:
        s = max_width / width
        obj.scale = (obj.scale[0] * s, obj.scale[1] * s, obj.scale[2] * s)


def linear_keys(obj):
    if obj.animation_data and obj.animation_data.action:
        for fc in obj.animation_data.action.fcurves:
            for k in fc.keyframe_points:
                k.interpolation = "LINEAR"


def render():
    bpy.ops.render.render(animation=True)


def lit_material(name, hex_value):
    """A plain shaded surface (sides read darker than the face), for 3D objects that need to look solid."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color(hex_value)
    bsdf.inputs["Roughness"].default_value = 0.35
    return mat


def add_key_lights():
    """A key light from the front-left and a rim from behind, so extruded edges catch light."""
    bpy.ops.object.light_add(type="SUN", rotation=(1.1, 0.0, -0.5))
    bpy.context.object.data.energy = 4.0
    bpy.ops.object.light_add(type="SUN", rotation=(-1.9, 0.0, 2.6))
    bpy.context.object.data.energy = 2.0
