import "./isolated-home.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { config } from "../src/config.ts";
import { findBlender, findWanGP, wangpDefaultModel, wangpPython } from "../src/produce/tools.ts";
import { tmp } from "./helpers.ts";

test("findBlender picks the newest installed version", () => {
  const pf = tmp();
  for (const v of ["Blender 2.92", "Blender 4.2", "Blender 3.6"]) {
    mkdirSync(join(pf, "Blender Foundation", v), { recursive: true });
    writeFileSync(join(pf, "Blender Foundation", v, "blender.exe"), "");
  }
  assert.equal(findBlender(pf), join(pf, "Blender Foundation", "Blender 4.2", "blender.exe"));
  assert.equal(findBlender(tmp()), "blender");
});

test("findWanGP returns the first folder holding wgp.py, and reads its python and last model", () => {
  const empty = tmp();
  const wan = tmp();
  writeFileSync(join(wan, "wgp.py"), "");
  assert.equal(findWanGP([empty, wan]), wan);
  assert.equal(findWanGP([empty]), "");
  assert.equal(wangpPython(wan), "python");
  mkdirSync(join(wan, "env_venv", "Scripts"), { recursive: true });
  writeFileSync(join(wan, "env_venv", "Scripts", "python.exe"), "");
  assert.equal(wangpPython(wan), join(wan, "env_venv", "Scripts", "python.exe"));
  assert.equal(wangpDefaultModel(wan), "");
  writeFileSync(join(wan, "wgp_config.json"), JSON.stringify({ last_model_type: "ltx2_25_22B_distilled" }));
  assert.equal(wangpDefaultModel(wan), "ltx2_25_22B_distilled");
});

test("production settings default to safe values", () => {
  assert.equal(config.produce.agentApproval, false);
  assert.equal(config.produce.cpuLane, 2);
  assert.equal(config.produce.wangpTimeoutMin, 30);
  assert.equal(config.produce.shotRetentionDays, 14);
  assert.equal(config.produce.webhookUrl, "");
});
