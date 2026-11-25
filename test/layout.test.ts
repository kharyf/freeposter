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
  assert.deepEqual(l.areas.top.tabs, ["reviews", "analytics", "campaigns", "calendar", "styles", "resources"]);
  assert.deepEqual(l.areas.left.tabs, ["accounts", "agents", "newpost"]);
  assert.deepEqual(l.areas.bottom.tabs, ["drive", "upcoming", "posts"]);
  assert.deepEqual(l.areas.right.tabs, ["console", "ai", "setup"]);
  assert.deepEqual(l.closed, []);
  for (const a of j(L.AREAS)) {
    assert.equal(l.areas[a].active, l.areas[a].tabs[0]);
    assert.equal(l.areas[a].collapsed, false);
  }
  assert.deepEqual([l.areas.left.size, l.areas.bottom.size, l.areas.right.size, l.areas.top.size], [340, 280, 380, 0]);
  assert.deepEqual(j(L.AREAS), ["top", "left", "bottom", "right"]);
  assert.equal(L.TAB_LABELS.styles, "Editing Styles");
  assert.equal(L.TAB_LABELS.resources, "Resources");
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
  assert.equal(j(L.normalizeLayout(badActive)).areas.right.active, "console");
  const emptySide = j(d());
  emptySide.areas.right.tabs = [];
  emptySide.areas.right.active = null;
  emptySide.areas.right.collapsed = false;
  // console, ai and setup would be re-added to right as missing; park them elsewhere
  emptySide.areas.left.tabs.push("console", "ai", "setup");
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
  assert.deepEqual(m.areas.top.tabs, ["reviews", "posts", "analytics", "campaigns", "calendar", "styles", "resources"]);
  assert.equal(m.areas.top.active, "posts");
  assert.deepEqual(m.areas.bottom.tabs, ["drive", "upcoming"]);
  assert.equal(m.areas.bottom.active, "drive");

  m = j(L.moveTab(d(), "drive", "left"));
  assert.equal(m.areas.bottom.active, "upcoming");
  assert.deepEqual(m.areas.left.tabs.at(-1), "drive");

  const last = L.activateTab(d(), "posts");
  m = j(L.moveTab(last, "posts", "left"));
  assert.equal(m.areas.bottom.active, "upcoming");

  m = L.moveTab(L.moveTab(d(), "console", "left"), "ai", "left");
  m = j(L.moveTab(m, "setup", "left"));
  assert.deepEqual(m.areas.right, { tabs: [], active: null, size: 380, collapsed: true });

  let t = d();
  for (const id of ["reviews", "analytics", "campaigns", "calendar", "styles"]) t = L.moveTab(t, id, "left");
  assert.equal(L.moveTab(t, "resources", "left"), null);

  m = j(L.moveTab(d(), "calendar", "top", 0));
  assert.deepEqual(m.areas.top.tabs, ["calendar", "reviews", "analytics", "campaigns", "styles", "resources"]);

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
  L.closeTab(before, "posts");
  L.addTab(before, "drive", "right");
  L.resizeArea(before, "left", 10, ws);
  assert.deepEqual(j(before), snap);
});

test("moveTab within a single-tab top is a no-op, not null", () => {
  let t = d();
  for (const id of ["reviews", "analytics", "campaigns", "calendar", "styles"]) t = L.moveTab(t, id, "left");
  const m = L.moveTab(t, "resources", "top", 0);
  assert.notEqual(m, null);
  assert.deepEqual(j(m), j(t));
});

test("normalizeLayout: a layout saved before closed/console", () => {
  const old = j(d());
  old.areas.right.tabs = ["ai", "setup"]; old.areas.right.active = "setup"; delete old.closed;
  const n = j(L.normalizeLayout(old));
  assert.deepEqual(n.areas.right.tabs, ["console", "ai", "setup"]);
  assert.equal(n.areas.right.active, "setup");
  assert.deepEqual(n.closed, []);
  assert.deepEqual(n.areas.top.tabs, j(d()).areas.top.tabs);
});

test("normalizeLayout keeps closed tabs out, drops bogus and placed ids from closed", () => {
  const s = j(L.closeTab(d(), "posts"));
  s.closed.push("bogus", "drive");            // drive is still placed: placed wins
  const n = j(L.normalizeLayout(s));
  assert.deepEqual(n.closed, ["posts"]);
  assert.deepEqual(n.areas.bottom.tabs, ["drive", "upcoming"]);
});

test("closeTab", () => {
  let c = j(L.closeTab(d(), "drive"));
  assert.deepEqual(c.areas.bottom.tabs, ["upcoming", "posts"]);
  assert.equal(c.areas.bottom.active, "upcoming");
  assert.deepEqual(c.closed, ["drive"]);
  c = L.closeTab(L.closeTab(L.closeTab(d(), "console"), "ai"), "setup");
  assert.deepEqual(j(c).areas.right, { tabs: [], active: null, size: 380, collapsed: true });
  let t = d();
  for (const id of ["reviews", "analytics", "campaigns", "calendar", "styles"]) t = L.closeTab(t, id);
  assert.equal(L.closeTab(t, "resources"), null);
  assert.equal(L.canCloseTab(t, "resources"), false);
  assert.equal(L.canCloseTab(d(), "styles"), true);
  assert.deepEqual(j(L.closeTab(c, "ai")), j(c));    // already closed: unchanged
});

test("addTab: reopen, move, same area, refused", () => {
  const closed = L.setCollapsed(L.closeTab(d(), "posts"), "left", true);
  let a = j(L.addTab(closed, "posts", "left"));
  assert.equal(a.areas.left.tabs.at(-1), "posts");
  assert.equal(a.areas.left.active, "posts");
  assert.equal(a.areas.left.collapsed, false);
  assert.deepEqual(a.closed, []);
  a = j(L.addTab(d(), "drive", "right"));               // a move
  assert.equal(a.areas.right.tabs.at(-1), "drive");
  assert.deepEqual(a.areas.bottom.tabs, ["upcoming", "posts"]);
  a = j(L.addTab(d(), "posts", "bottom"));              // already here: activated only
  assert.deepEqual(a.areas.bottom.tabs, ["drive", "upcoming", "posts"]);
  assert.equal(a.areas.bottom.active, "posts");
  let t = d();
  for (const id of ["reviews", "analytics", "campaigns", "calendar", "styles"]) t = L.moveTab(t, id, "left");
  assert.equal(L.addTab(t, "resources", "left"), null);
});

test("activateTab reopens a closed tab in its default area", () => {
  const a = j(L.activateTab(L.closeTab(d(), "posts"), "posts"));
  assert.equal(a.areas.bottom.tabs.at(-1), "posts");
  assert.equal(a.areas.bottom.active, "posts");
  assert.deepEqual(a.closed, []);
});

test("addTabChoices", () => {
  const ch = j(L.addTabChoices(d(), "bottom"));
  assert.deepEqual(ch.map((c: any) => c.id), j(L.TAB_IDS));
  assert.equal(ch.find((c: any) => c.id === "posts").label, "Posts");
  assert.equal(ch.find((c: any) => c.id === "posts").disabled, true);
  assert.equal(ch.find((c: any) => c.id === "console").disabled, false);
  let t = d();
  for (const id of ["reviews", "analytics", "campaigns", "calendar", "styles"]) t = L.moveTab(t, id, "left");
  assert.equal(j(L.addTabChoices(t, "right")).find((c: any) => c.id === "resources").disabled, true);
  // an empty, opened side area offers everything not already there
  let e = L.closeTab(L.closeTab(L.closeTab(d(), "console"), "ai"), "setup");
  e = L.setCollapsed(e, "right", false);
  assert.equal(j(L.addTabChoices(e, "right")).every((c: any) => !c.disabled), true);
});
