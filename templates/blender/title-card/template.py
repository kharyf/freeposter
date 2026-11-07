# A title (and optional subtitle) that rises and grows into place, then holds.
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import common  # noqa: E402

cfg = common.load_config()
p = cfg["params"]
scene = common.setup_scene(cfg, p.get("background", "#111111"))
title = common.add_text(p["title"], size=1.6, extrude=0.05)
mat, emission = common.emission_material("title", p.get("color", "#ffffff"))
title.data.materials.append(mat)
common.fit_width(title, 7.8)
end_in = min(scene.frame_start + round(0.6 * cfg["fps"]), scene.frame_end)

base = tuple(title.scale)
title.location = (0, 0, -0.6)
title.scale = tuple(v * 0.85 for v in base)
emission.inputs["Strength"].default_value = 0.0
title.keyframe_insert("location", frame=scene.frame_start)
title.keyframe_insert("scale", frame=scene.frame_start)
emission.inputs["Strength"].keyframe_insert("default_value", frame=scene.frame_start)
title.location = (0, 0, 0.4 if p.get("subtitle") else 0)
title.scale = base
emission.inputs["Strength"].default_value = 1.0
title.keyframe_insert("location", frame=end_in)
title.keyframe_insert("scale", frame=end_in)
emission.inputs["Strength"].keyframe_insert("default_value", frame=end_in)

if p.get("subtitle"):
    sub = common.add_text(p["subtitle"], size=0.7)
    sub_mat, _ = common.emission_material("subtitle", p.get("color", "#ffffff"), 0.8)
    sub.data.materials.append(sub_mat)
    common.fit_width(sub, 7.8)
    sub.location = (0, 0, -0.9)
common.render()
