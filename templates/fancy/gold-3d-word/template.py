# Fancy graphic: one word as extruded gold serif lettering, turning slowly under dramatic light, on ink.
# params: word, plus FreePoster's font (Playfair Display Bold Italic) and palette (ink, ink2, gold, ...).
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
gold = common.gold_material("gold", p["gold"], 0.25)

# A fine bevel: Playfair's hairlines are thin, and a deeper one folds them into spikes.
word, text_w, text_h = common.solid_text(p["word"], p["font"], size=1.0, extrude=0.03, bevel=0.004, material=gold, name="word")
# As big as fits: 70% of the width (clear of the 48 px margin with room for the turn), at most 42% of the height.
fit = min(view_w * 0.7 / text_w, view_h * 0.42 / text_h)
word.scale = (fit, fit, fit)

# A thin gold rule under the word, drawn out as the word lands.
half_h = text_h * fit / 2
bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.045, depth=1.0, location=(0, 0, -half_h - 0.75), rotation=(0, math.pi / 2, 0))
rule = bpy.context.object
rule.data.materials.append(gold)
rule_len = min(text_w * fit * 0.55, view_w * 0.5)

# In over 0.5 s: the lights come up, the word rises and swings round; then it keeps turning slowly to the end.
lights = common.three_point_lights()
common.fade_lights_in(lights, start, frame(0.5))
base = tuple(word.scale)
word.location = (0, 0, -0.8)
word.scale = tuple(v * 0.86 for v in base)
word.rotation_euler = (math.pi / 2, 0, -0.75)
word.keyframe_insert("location", frame=start)
word.keyframe_insert("scale", frame=start)
word.keyframe_insert("rotation_euler", frame=start)
word.location = (0, 0, 0.15)
word.scale = base
word.rotation_euler = (math.pi / 2, 0, -0.3)
word.keyframe_insert("location", frame=frame(0.5))
word.keyframe_insert("scale", frame=frame(0.5))
word.keyframe_insert("rotation_euler", frame=frame(0.5))
word.rotation_euler = (math.pi / 2, 0, 0.32)
word.location = (0, 0, 0.35)
word.keyframe_insert("rotation_euler", frame=end)
word.keyframe_insert("location", frame=end)

# The cylinder lies along X, so its length is its local Z.
rule.scale = (1, 1, 0.001)
rule.keyframe_insert("scale", frame=frame(0.25))
rule.scale = (1, 1, rule_len)
rule.keyframe_insert("scale", frame=frame(0.75))
rule.scale = (1, 1, rule_len * 1.15)
rule.keyframe_insert("scale", frame=end)

common.render()
