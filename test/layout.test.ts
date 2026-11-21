import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const ctx: any = { structuredClone };
vm.runInNewContext(readFileSync("public/layout.js", "utf8"), ctx);
const L = ctx.FreePosterLayout;
const ws = { width: 1280, height: 800 };
/** Results come from another realm, so compare them as plain JSON. */
const j = (x: unknown) => JSON.parse(JSON.stringify(x));
const d = () => L.defaultLayout();

test("defaultLayout", () => {
  const l = j(d());
  assert.deepEqual(l.areas.top.tabs, ["reviews", "analytics", "campaigns", "calendar", "styles"]);
  assert.deepEqual(l.areas.left.tabs, ["accounts", "agents", "newpost"]);
  assert.deepEqual(l.areas.bottom.tabs, ["drive", "upcoming", "posts"]);
  assert.deepEqual(l.areas.right.tabs, ["ai", "setup"]);
  for (const a of j(L.AREAS)) {
    assert.equal(l.areas[a].active, l.areas[a].tabs[0]);
    assert.equal(l.areas[a].collapsed, false);
  }
  assert.deepEqual([l.areas.left.size, l.areas.bottom.size, l.areas.right.size, l.areas.top.size], [340, 280, 380, 0]);
  assert.deepEqual(j(L.AREAS), ["top", "left", "bottom", "right"]);
  assert.equal(L.TAB_LABELS.styles, "Editing Styles");
  assert.equal(L.DEFAULT_AREA.posts, "bottom");
});

test("normalizeLayout", () => {
  const def = j(d());
  for (const bad of [null, "x", { areas: 5 }]) assert.deepEqual(j(L.normalizeLayout(bad)), def);
  const withBogus = j(d());
  withBogus.areas.left.tabs.push("bogus");
  assert.deepEqual(j(L.normalizeLayout(withBogus)).areas.left.tabs, ["accounts", "agents", "newpost"]);
  const noPosts = j(d());
  noPosts.areas.bottom.tabs = ["drive", "upcoming"];
  assert.deepEqual(j(L.normalizeLayout(noPosts)).areas.bottom.tabs, ["drive", "upcoming", "posts"]);
  const dup = j(d());
  dup.areas.left.tabs.push("posts");
  const nd = j(L.normalizeLayout(dup));
  assert.deepEqual(nd.areas.left.tabs.includes("posts"), true);
  assert.deepEqual(nd.areas.bottom.tabs, ["drive", "upcoming"]);
  const badActive = j(d());
  badActive.areas.right.active = "nope";
  assert.equal(j(L.normalizeLayout(badActive)).areas.right.active, "ai");
  const emptySide = j(d());
  emptySide.areas.right.tabs = [];
  emptySide.areas.right.active = null;
  emptySide.areas.right.collapsed = false;
  // ai and setup would be re-added to right as missing; park them elsewhere
  emptySide.areas.left.tabs.push("ai", "setup");
  const es = j(L.normalizeLayout(emptySide));
  assert.equal(es.areas.right.collapsed, true);
  assert.equal(es.areas.right.active, null);
  const emptyTop = j(d());
  emptyTop.areas.left.tabs.push(...emptyTop.areas.top.tabs);
  emptyTop.areas.top.tabs = [];
  assert.deepEqual(j(L.normalizeLayout(emptyTop)), def);
  for (const size of [NaN, -5]) {
    const s = j(d());
    s.areas.left.size = size;
    assert.equal(j(L.normalizeLayout(s)).areas.left.size, 340);
  }
});

test("moveTab", () => {
  let m = j(L.moveTab(d(), "posts", "top", 1));
  assert.deepEqual(m.areas.top.tabs, ["reviews", "posts", "analytics", "campaigns", "calendar", "styles"]);
  assert.equal(m.areas.top.active, "posts");
  assert.deepEqual(m.areas.bottom.tabs, ["drive", "upcoming"]);
  assert.equal(m.areas.bottom.active, "drive");

  m = j(L.moveTab(d(), "drive", "left"));
  assert.equal(m.areas.bottom.active, "upcoming");
  assert.deepEqual(m.areas.left.tabs.at(-1), "drive");

  const last = L.activateTab(d(), "posts");
  m = j(L.moveTab(last, "posts", "left"));
  assert.equal(m.areas.bottom.active, "upcoming");

  m = L.moveTab(d(), "ai", "left");
  m = j(L.moveTab(m, "setup", "left"));
  assert.deepEqual(m.areas.right, { tabs: [], active: null, size: 380, collapsed: true });

  let t = d();
  for (const id of ["reviews", "analytics", "campaigns", "calendar"]) t = L.moveTab(t, id, "left");
  assert.equal(L.moveTab(t, "styles", "left"), null);

  m = j(L.moveTab(d(), "calendar", "top", 0));
  assert.deepEqual(m.areas.top.tabs, ["calendar", "reviews", "analytics", "campaigns", "styles"]);

  assert.deepEqual(j(L.moveTab(d(), "posts", "bottom", 2)), j(d()));
  assert.deepEqual(j(L.moveTab(d(), "posts", "bottom")), j(d()));

  const col = L.setCollapsed(d(), "left", true);
  assert.equal(j(L.moveTab(col, "posts", "left")).areas.left.collapsed, false);
});

test("resizeArea", () => {
  assert.equal(L.resizeArea(d(), "bottom", 500, ws).areas.bottom.size, 400);
  assert.equal(L.resizeArea(d(), "left", 1200, ws).areas.left.size, 1088 - 380);
  let r = L.resizeArea(d(), "left", 80, ws);
  assert.equal(r.areas.left.size, 120);
  assert.equal(r.areas.left.collapsed, false);
  r = L.resizeArea(d(), "left", 50, ws);
  assert.equal(r.areas.left.collapsed, true);
  assert.equal(r.areas.left.size, 340);
  r = L.resizeArea(L.setCollapsed(d(), "left", true), "left", 300, ws);
  assert.equal(r.areas.left.collapsed, false);
  assert.equal(r.areas.left.size, 300);
  assert.deepEqual(j(L.resizeArea(d(), "top", 100, ws)), j(d()));
});

test("clampSizes", () => {
  let c = L.clampSizes(d(), { width: 600, height: 800 });
  assert.equal(c.areas.right.size, 170);
  assert.equal(c.areas.left.size, 340);
  c = L.clampSizes(d(), { width: 280, height: 800 });
  assert.equal(c.areas.right.collapsed, true);
  assert.equal(c.areas.left.size, 238);
  const tall = d();
  tall.areas.bottom.size = 700;
  assert.equal(L.clampSizes(tall, ws).areas.bottom.size, 400);
});

test("setCollapsed ignores top and never mutates", () => {
  assert.deepEqual(j(L.setCollapsed(d(), "top", true)), j(d()));
  const before = d();
  const snap = j(before);
  L.setCollapsed(before, "left", true);
  L.moveTab(before, "posts", "top", 0);
  L.resizeArea(before, "left", 10, ws);
  assert.deepEqual(j(before), snap);
});
