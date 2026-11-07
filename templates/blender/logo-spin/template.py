# A word or short logo text, extruded in 3D, spinning about its vertical axis.
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import common  # noqa: E402

cfg = common.load_config()
p = cfg["params"]
scene = common.setup_scene(cfg, p.get("background", "#000000"))
text = common.add_text(p["text"], size=2.2, extrude=0.25)
text.data.materials.append(common.lit_material("logo", p.get("color", "#ff5a36")))
text.data.bevel_depth = 0.02
common.add_key_lights()
common.fit_width(text, 7.5)
turns = float(p.get("turns", 1))
text.rotation_euler = (math.pi / 2, 0, 0)
text.keyframe_insert("rotation_euler", index=2, frame=scene.frame_start)
text.rotation_euler = (math.pi / 2, 0, 2 * math.pi * turns)
text.keyframe_insert("rotation_euler", index=2, frame=scene.frame_end)
common.linear_keys(text)
common.render()
