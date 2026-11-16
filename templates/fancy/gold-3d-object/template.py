# Fancy graphic: one gold object built from primitives (coin, arrow-up, arrow-down, globe, clock, bars, lightbulb),
# turning on ink under three-point light, with a short cream label beneath it.
# params: object, label, plus FreePoster's fonts (font, italic_font) and palette (ink, ink2, gold, yellow, cream).
import math
import os
import sys

import bpy

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "blender"))
import common  # noqa: E402

cfg = common.load_config()
p = cfg["params"]
scene = common.setup_scene(cfg, p["ink"])
common.fancy_camera(scene)
common.fancy_world(p["ink"], p["ink2"])
common.fancy_eevee(scene)
fps = cfg["fps"]
start, end = scene.frame_start, scene.frame_end
frame = lambda sec: min(end, start + round(sec * fps))  # noqa: E731
view_w, view_h = common.visible_size(cfg)

GOLD = common.gold_material("gold", p["gold"], 0.25)
DARK = common.matte_material("ink", p["ink2"], 0.45)

# Everything hangs off one pivot, which the template turns and moves; it sits above centre, the label below.
pivot = bpy.data.objects.new("pivot", None)
scene.collection.objects.link(pivot)
pivot.location = (0, 0, 0.9)


def part(obj, material=GOLD, smooth=True, bevel=0.0, parent=None):
    obj.data.materials.append(material)
    if smooth:
        bpy.ops.object.shade_smooth()
    if bevel:
        mod = obj.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 3
    obj.parent = parent or pivot
    return obj


def cylinder(radius, depth, location=(0, 0, 0), rotation=(0, 0, 0), vertices=64):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=location, rotation=rotation)
    return bpy.context.object


def cone(r1, r2, depth, location=(0, 0, 0), rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cone_add(vertices=64, radius1=r1, radius2=r2, depth=depth, location=location, rotation=rotation)
    return bpy.context.object


def torus(major, minor, location=(0, 0, 0), rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, major_segments=96, minor_segments=16, location=location, rotation=rotation)
    return bpy.context.object


def box(size, location=(0, 0, 0), rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.scale = size
    return obj


def sphere(radius, location=(0, 0, 0)):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32, radius=radius, location=location)
    return bpy.context.object


FACING = (math.pi / 2, 0, 0)  # a cylinder's flat face toward the camera


def coin():
    part(cylinder(2.6, 0.36, rotation=FACING, vertices=128), bevel=0.06)
    for y in (-0.19, 0.19):
        part(torus(2.25, 0.07, location=(0, y, 0), rotation=FACING))
        part(cylinder(1.25, 0.06, location=(0, y, 0), rotation=FACING), bevel=0.02)
    return "spin"


def arrow(up):
    """A flat arrow with depth: a square shaft under a triangular head, bevelled so its edges catch the light."""
    holder = bpy.data.objects.new("arrow", None)
    scene.collection.objects.link(holder)
    holder.parent = pivot
    holder.rotation_euler = (0, 0 if up else math.pi, 0)
    part(box((1.0, 0.55, 3.0), location=(0, 0, -1.1)), smooth=False, bevel=0.06, parent=holder)
    # A three-sided cylinder is a triangular prism; facing the camera, its first corner points up.
    part(cylinder(1.8, 0.55, location=(0, 0, 1.15), rotation=FACING, vertices=3), smooth=False, bevel=0.06, parent=holder)
    return "rise" if up else "fall"


def globe():
    pivot.rotation_euler = (0.35, 0, 0)  # the Earth's tilt, more or less
    part(sphere(2.45), DARK)
    for lat in (-60, -30, 0, 30, 60):
        r = math.radians(lat)
        part(torus(2.5 * math.cos(r), 0.05, location=(0, 0, 2.5 * math.sin(r))))
    for lon in range(0, 180, 30):
        part(torus(2.5, 0.05, rotation=(math.pi / 2, 0, math.radians(lon))))
    part(cylinder(0.06, 6.2), smooth=False)  # the axis
    return "turn"


def clock():
    part(cylinder(2.6, 0.3, rotation=FACING, vertices=128), DARK)
    part(torus(2.6, 0.17, rotation=FACING))
    for h in range(12):
        a = h * math.pi / 6
        long_tick = h % 3 == 0
        part(box((0.12, 0.08, 0.5 if long_tick else 0.3), location=(2.1 * math.sin(a), -0.2, 2.1 * math.cos(a)), rotation=(0, a, 0)), smooth=False)
    hands = []
    for length, width in ((1.3, 0.16), (1.9, 0.1)):
        bpy.ops.object.empty_add(location=(0, -0.25, 0))
        hub = bpy.context.object
        hub.parent = pivot
        hand = part(box((width, 0.06, length), location=(0, 0, length / 2 - 0.15)), smooth=False)
        hand.parent = hub
        hands.append(hub)
    part(cylinder(0.2, 0.2, location=(0, -0.3, 0), rotation=FACING), bevel=0.03)
    # The hands sweep round to the end: the hour hand a quarter turn, the minute hand two turns.
    for hub, turns in zip(hands, (0.25, 2.0)):
        hub.rotation_euler = (0, -0.6, 0)
        hub.keyframe_insert("rotation_euler", index=1, frame=start)
        hub.rotation_euler = (0, -0.6 + 2 * math.pi * turns, 0)
        hub.keyframe_insert("rotation_euler", index=1, frame=end)
        common.linear_keys(hub)
    return "sway"


def bars():
    heights = (1.6, 2.6, 3.6, 5.0)
    base = -2.6
    part(box((5.6, 1.4, 0.12), location=(0, 0, base - 0.06)), bevel=0.03)
    for i, h in enumerate(heights):
        bar = part(box((0.95, 0.95, 1), location=(-2.1 + i * 1.4, 0, base)), bevel=0.04)
        # Each grows up from the base, one after another, in the first second.
        bar.scale = (0.95, 0.95, 0.001)
        bar.keyframe_insert("scale", frame=frame(0.08 * i))
        bar.keyframe_insert("location", frame=frame(0.08 * i))
        bar.scale = (0.95, 0.95, h)
        bar.location = (-2.1 + i * 1.4, 0, base + h / 2)
        bar.keyframe_insert("scale", frame=frame(0.45 + 0.12 * i))
        bar.keyframe_insert("location", frame=frame(0.45 + 0.12 * i))
    return "sway"


def lightbulb():
    glass = bpy.data.materials.new("glow")
    glass.use_nodes = True
    bsdf = glass.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = common.color(p["yellow"])
    bsdf.inputs["Roughness"].default_value = 0.15
    # "Emission" in 2.9x-3.x, "Emission Color" in 4.x; "Emission Strength" since 2.91.
    emission = bsdf.inputs["Emission Color"] if "Emission Color" in bsdf.inputs else bsdf.inputs["Emission"]
    emission.default_value = common.color(p["yellow"])
    strength = bsdf.inputs["Emission Strength"]
    part(sphere(1.75, location=(0, 0, 0.9)), glass)
    part(cone(0.74, 1.3, 1.1, location=(0, 0, -0.75)), glass)
    for i in range(4):
        part(torus(0.76, 0.11, location=(0, 0, -1.45 - i * 0.24)))
    part(cylinder(0.72, 1.0, location=(0, 0, -1.8)), bevel=0.03)
    part(cone(0.62, 0.16, 0.4, location=(0, 0, -2.5)))
    # The glow comes up as the bulb lands, then breathes to the end.
    strength.default_value = 0.0
    strength.keyframe_insert("default_value", frame=start)
    f, level = frame(0.5), 0.9
    while True:
        strength.default_value = level
        strength.keyframe_insert("default_value", frame=f)
        if f >= end:
            break
        f, level = min(end, f + round(0.8 * fps)), (0.45 if level > 0.6 else 0.9)
    return "sway"


BUILD = {"coin": coin, "arrow-up": lambda: arrow(True), "arrow-down": lambda: arrow(False), "globe": globe, "clock": clock, "bars": bars, "lightbulb": lightbulb}
motion = BUILD[p["object"]]()

# In over 0.5 s: the lights come up and the object grows into place; then it keeps moving to the end.
lights = common.three_point_lights(target=(0, 0, 0.9))
common.fade_lights_in(lights, start, frame(0.5))
tilt = tuple(pivot.rotation_euler)
SIZE = 1.15
pivot.scale = (0.7 * SIZE,) * 3
pivot.keyframe_insert("scale", frame=start)
pivot.scale = (SIZE,) * 3
pivot.keyframe_insert("scale", frame=frame(0.5))

if motion == "spin":  # a coin turns half over, face to face, edge-on in the middle
    pivot.rotation_euler = (tilt[0], tilt[1], -0.5)
    pivot.keyframe_insert("rotation_euler", index=2, frame=start)
    pivot.rotation_euler = (tilt[0], tilt[1], math.pi + 0.5)
    pivot.keyframe_insert("rotation_euler", index=2, frame=end)
elif motion in ("rise", "fall"):  # an arrow arrives from below (above) and keeps drifting its way while it turns
    d = 1 if motion == "rise" else -1
    for f, z, rz in ((start, 0.9 - 1.6 * d, -0.5), (frame(0.5), 0.9, -0.15), (end, 0.9 + 0.45 * d, 0.45)):
        pivot.location = (0, 0, z)
        pivot.rotation_euler = (tilt[0], tilt[1], rz)
        pivot.keyframe_insert("location", index=2, frame=f)
        pivot.keyframe_insert("rotation_euler", index=2, frame=f)
elif motion == "turn":  # the globe spins about its tilted axis
    for f, rz in ((start, 0.0), (end, math.radians(110))):
        pivot.rotation_euler = (tilt[0], tilt[1], rz)
        pivot.keyframe_insert("rotation_euler", index=2, frame=f)
    common.linear_keys(pivot)
else:  # a slow sway, so the light rolls across the gold
    for f, rz in ((start, -0.55), (frame(0.5), -0.25), (end, 0.3)):
        pivot.rotation_euler = (tilt[0], tilt[1], rz)
        pivot.keyframe_insert("rotation_euler", index=2, frame=f)

# The label: cream italic, flat (emission), under a short gold rule; it rises and fades up as the object lands.
cream, cream_em = common.emission_material("cream", p["cream"])
label, label_w, _ = common.solid_text(p["label"], p["italic_font"], size=0.95, material=cream, name="label")
if label_w > view_w * 0.8:
    label.scale = (view_w * 0.8 / label_w,) * 3
label_z = -view_h / 2 + 2.1
for f, z, k in ((start, label_z - 0.3, 0.0), (frame(0.55), label_z, 1.0)):
    label.location = (0, -2.0, z)
    label.keyframe_insert("location", index=2, frame=f)
    cream_em.inputs["Strength"].default_value = k
    cream_em.inputs["Strength"].keyframe_insert("default_value", frame=f)
bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.03, depth=1.0, location=(0, -2.0, label_z + 0.9), rotation=(0, math.pi / 2, 0))
rule = bpy.context.object
rule_mat, _ = common.emission_material("rule", p["gold"])
rule.data.materials.append(rule_mat)
rule.scale = (1, 1, 0.001)  # the cylinder lies along X, so its length is its local Z
rule.keyframe_insert("scale", frame=frame(0.2))
rule.scale = (1, 1, 1.4)
rule.keyframe_insert("scale", frame=frame(0.6))

common.render()
