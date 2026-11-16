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


# --- The Fancy editing style's graphics (templates/fancy/gold-3d-*): gold metal on ink, three-point light. ---

def fancy_camera(scene, distance=22.0, lens=50.0):
    """A perspective camera looking along +Y at the origin (setup_scene's camera, made perspective)."""
    cam = scene.camera
    cam.data.type = "PERSP"
    cam.data.lens = lens
    cam.data.sensor_fit = "AUTO"
    cam.location = (0, -distance, 0)
    return cam


def visible_size(cfg, distance=22.0, lens=50.0, sensor=36.0):
    """(width, height) in scene units of what the fancy_camera sees at the origin's depth."""
    w, h = cfg["width"], cfg["height"]
    across = distance * sensor / lens  # AUTO sensor fit: the sensor spans the longer side
    return (across, across * h / w) if w >= h else (across * w / h, across)


def fancy_world(ink, ink2, glow="#a8824c"):
    """The camera sees an ink-to-ink-2 vertical gradient; metal reflects a warm studio sky (bright above, dark below)."""
    world = bpy.context.scene.world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    mix = nt.nodes.new("ShaderNodeMixShader")
    path = nt.nodes.new("ShaderNodeLightPath")
    coords = nt.nodes.new("ShaderNodeTexCoord")

    window = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(coords.outputs["Window"], window.inputs[0])
    back = nt.nodes.new("ShaderNodeValToRGB")
    back.color_ramp.elements[0].color = color(ink2)
    back.color_ramp.elements[1].color = color(ink)
    nt.links.new(window.outputs["Y"], back.inputs[0])
    seen = nt.nodes.new("ShaderNodeBackground")
    nt.links.new(back.outputs[0], seen.inputs["Color"])

    direction = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(coords.outputs["Generated"], direction.inputs[0])
    sky = nt.nodes.new("ShaderNodeValToRGB")
    sky.color_ramp.elements[0].position = 0.25
    sky.color_ramp.elements[0].color = color(ink)
    sky.color_ramp.elements[1].position = 0.8
    sky.color_ramp.elements[1].color = color(glow)
    nt.links.new(direction.outputs["Z"], sky.inputs[0])
    lit = nt.nodes.new("ShaderNodeBackground")
    lit.inputs["Strength"].default_value = 2.0
    nt.links.new(sky.outputs[0], lit.inputs["Color"])

    nt.links.new(path.outputs["Is Camera Ray"], mix.inputs[0])
    nt.links.new(lit.outputs[0], mix.inputs[1])
    nt.links.new(seen.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])


def fancy_eevee(scene, samples=32):
    """Eevee quality settings that exist in this Blender (2.92's names; 4.2's EEVEE Next drops some)."""
    ee = scene.eevee
    for name, value in (("taa_render_samples", samples), ("use_gtao", True), ("use_ssr", True), ("use_soft_shadows", True),
                        ("use_bloom", True), ("bloom_intensity", 0.03), ("bloom_threshold", 1.2), ("use_raytracing", True)):
        if hasattr(ee, name):
            try:
                setattr(ee, name, value)
            except (AttributeError, TypeError):
                pass


def gold_material(name="gold", hex_value="#E8B923", roughness=0.25):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color(hex_value)
    bsdf.inputs["Metallic"].default_value = 1.0
    bsdf.inputs["Roughness"].default_value = roughness
    return mat


def matte_material(name, hex_value, roughness=0.6):
    mat = lit_material(name, hex_value)
    mat.node_tree.nodes.get("Principled BSDF").inputs["Roughness"].default_value = roughness
    return mat


def three_point_lights(target=(0, 0, 0), strength=1.0):
    """Key (front left, above), fill (front right, softer) and rim (behind), area lights aimed at target.
    Returns the lights, so a template can fade them up."""
    aim = bpy.data.objects.new("light-target", None)
    bpy.context.scene.collection.objects.link(aim)
    aim.location = target
    lights = []
    for name, location, energy, size in (("key", (-7, -10, 7), 1400, 6), ("fill", (8, -9, 1), 450, 8), ("rim", (2, 9, 6), 1800, 5)):
        bpy.ops.object.light_add(type="AREA", location=location)
        light = bpy.context.object
        light.name = name
        light.data.energy = energy * strength
        light.data.size = size
        track = light.constraints.new("TRACK_TO")
        track.target = aim
        track.track_axis = "TRACK_NEGATIVE_Z"
        track.up_axis = "UP_Y"
        lights.append(light)
    return lights


def fade_lights_in(lights, start, end):
    """Lights come up from dark over [start, end] (frames): the reveal."""
    for light in lights:
        full = light.data.energy
        light.data.energy = 0.0
        light.data.keyframe_insert("energy", frame=start)
        light.data.energy = full
        light.data.keyframe_insert("energy", frame=end)



def _spline_points(spline):
    return [(p.co.x, p.co.y) for p in spline.bezier_points] or [(p.co.x, p.co.y) for p in spline.points]


def _area(points):
    return sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(points, points[1:] + points[:1])) / 2


def _inside(point, polygon):
    x, y = point
    hit = False
    for (x0, y0), (x1, y1) in zip(polygon, polygon[1:] + polygon[:1]):
        if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
            hit = not hit
    return hit


def solid_text(body, font_path, size=1.0, extrude=0.0, bevel=0.0, material=None, name="text"):
    """Text facing the camera whose overlapping contours are filled solid. Blender fills a curve even-odd, so the
    overlaps variable fonts keep in their static instances (Playfair's f, b, R, !) would show as holes; here each
    outer contour becomes its own curve with the holes that sit inside it. Returns (holder, width, height): an empty
    to move, turn and scale, and the text's size in its own units."""
    bpy.ops.object.text_add(location=(0, 0, 0))
    text = bpy.context.object
    text.data.body = body
    text.data.font = bpy.data.fonts.load(font_path, check_existing=True)
    text.data.align_x = "CENTER"
    text.data.align_y = "CENTER"
    text.data.size = size
    bpy.ops.object.convert(target="CURVE")
    source = bpy.context.object
    splines = [(s, _spline_points(s)) for s in source.data.splines]
    if not splines:
        raise ValueError("the text has no outlines")
    outer_sign = 1 if _area(max((pts for _, pts in splines), key=lambda pts: abs(_area(pts)))) > 0 else -1
    outers = [(s, pts) for s, pts in splines if _area(pts) * outer_sign > 0]
    groups = {id(s): [s] for s, _ in outers}
    for s, pts in splines:
        if _area(pts) * outer_sign > 0:
            continue
        around = [(abs(_area(o)), so) for so, o in outers if _inside(pts[0], o)]
        if around:
            groups[id(min(around, key=lambda a: a[0])[1])].append(s)

    holder = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(holder)
    for k, members in enumerate(groups.values()):
        curve = bpy.data.curves.new(f"{name}-{k}", "CURVE")
        curve.dimensions = "2D"
        curve.fill_mode = "BOTH"
        curve.extrude = extrude
        curve.bevel_depth = bevel
        curve.bevel_resolution = 3
        for s in members:
            n = len(s.bezier_points)
            copy = curve.splines.new("BEZIER")
            copy.bezier_points.add(n - 1)
            for a, b in zip(s.bezier_points, copy.bezier_points):
                b.co, b.handle_left, b.handle_right = a.co, a.handle_left, a.handle_right
                b.handle_left_type, b.handle_right_type = a.handle_left_type, a.handle_right_type
            copy.use_cyclic_u = True
            copy.use_smooth = s.use_smooth
        if material:
            curve.materials.append(material)
        piece = bpy.data.objects.new(f"{name}-{k}", curve)
        bpy.context.scene.collection.objects.link(piece)
        piece.parent = holder
    xs = [x for _, pts in splines for x, _ in pts]
    ys = [y for _, pts in splines for _, y in pts]
    bpy.data.objects.remove(source, do_unlink=True)
    holder.rotation_euler = (math.pi / 2, 0, 0)  # face the camera
    return holder, max(xs) - min(xs), max(ys) - min(ys)
