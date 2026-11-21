// Layout model for the docked workspace: pure functions, no DOM. Every function returns a new object.
(function () {
  var AREAS = ["top", "left", "bottom", "right"];
  var TAB_IDS = ["reviews", "analytics", "campaigns", "calendar", "styles", "accounts", "agents", "newpost", "drive", "upcoming", "posts", "ai", "setup"];
  var TAB_LABELS = {
    reviews: "Waiting for your review", analytics: "Analytics", campaigns: "Campaigns", calendar: "Calendar",
    styles: "Editing Styles", accounts: "Accounts", agents: "AI Agents", newpost: "New Post", drive: "From Drive",
    upcoming: "Upcoming", posts: "Posts", ai: "AI Providers", setup: "Setup",
  };
  var DEFAULT_TABS = {
    top: ["reviews", "analytics", "campaigns", "calendar", "styles"],
    left: ["accounts", "agents", "newpost"],
    bottom: ["drive", "upcoming", "posts"],
    right: ["ai", "setup"],
  };
  var DEFAULT_SIZE = { top: 0, left: 340, bottom: 280, right: 380 };
  var DEFAULT_AREA = {};
  AREAS.forEach(function (a) { DEFAULT_TABS[a].forEach(function (id) { DEFAULT_AREA[id] = a; }); });
  var MIN_AREA_PX = 120;
  var COLLAPSE_PX = 60;
  var MAX_BOTTOM = 0.5;
  var MAX_SIDES = 0.85;

  function clone(x) { return structuredClone(x); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function defaultLayout() {
    var areas = {};
    AREAS.forEach(function (a) {
      var tabs = DEFAULT_TABS[a].slice();
      areas[a] = { tabs: tabs, active: tabs[0], size: DEFAULT_SIZE[a], collapsed: false };
    });
    return { areas: areas };
  }

  function normalizeLayout(raw) {
    var src = raw && typeof raw === "object" && raw.areas && typeof raw.areas === "object" ? raw.areas : null;
    if (!src) return defaultLayout();
    var seen = {};
    var areas = {};
    AREAS.forEach(function (a) {
      var s = src[a] && typeof src[a] === "object" ? src[a] : {};
      var tabs = [];
      (Array.isArray(s.tabs) ? s.tabs : []).forEach(function (id) {
        if (TAB_IDS.indexOf(id) < 0 || seen[id]) return;
        seen[id] = true;
        tabs.push(id);
      });
      var size = typeof s.size === "number" && isFinite(s.size) && s.size > 0 ? s.size : DEFAULT_SIZE[a];
      areas[a] = { tabs: tabs, active: s.active, size: a === "top" ? 0 : size, collapsed: a !== "top" && s.collapsed === true };
    });
    TAB_IDS.forEach(function (id) { if (!seen[id]) areas[DEFAULT_AREA[id]].tabs.push(id); });
    if (!areas.top.tabs.length) return defaultLayout();
    AREAS.forEach(function (a) {
      var ar = areas[a];
      if (ar.tabs.indexOf(ar.active) < 0) ar.active = ar.tabs.length ? ar.tabs[0] : null;
      if (a === "top") ar.collapsed = false;
      else if (!ar.tabs.length) ar.collapsed = true;
    });
    return { areas: areas };
  }

  function areaOf(layout, id) {
    for (var i = 0; i < AREAS.length; i++) if (layout.areas[AREAS[i]].tabs.indexOf(id) >= 0) return AREAS[i];
    return DEFAULT_AREA[id];
  }

  function activateTab(layout, id) {
    var out = clone(layout);
    var a = areaOf(out, id);
    if (out.areas[a].tabs.indexOf(id) >= 0) out.areas[a].active = id;
    return out;
  }

  function moveTab(layout, id, toArea, index) {
    if (TAB_IDS.indexOf(id) < 0 || AREAS.indexOf(toArea) < 0) return clone(layout);
    var out = clone(layout);
    var from = areaOf(out, id);
    var src = out.areas[from];
    var at = src.tabs.indexOf(id);
    src.tabs.splice(at, 1);
    if (from === "top" && toArea !== "top" && !src.tabs.length) return null;
    if (from !== toArea && src.active === id) {
      src.active = src.tabs.length ? (src.tabs[at] !== undefined ? src.tabs[at] : src.tabs[src.tabs.length - 1]) : null;
    }
    if (from !== toArea && !src.tabs.length) src.collapsed = true;
    var dst = out.areas[toArea];
    var i = typeof index === "number" && isFinite(index) ? clamp(Math.floor(index), 0, dst.tabs.length) : dst.tabs.length;
    dst.tabs.splice(i, 0, id);
    if (from === toArea && i === at) return clone(layout);
    dst.active = id;
    if (toArea !== "top") dst.collapsed = false;
    return out;
  }

  function setCollapsed(layout, area, collapsed) {
    var out = clone(layout);
    if (area !== "top" && out.areas[area]) out.areas[area].collapsed = !!collapsed;
    return out;
  }

  function sideRoom(layout, area, ws) {
    var other = layout.areas[area === "left" ? "right" : "left"];
    return MAX_SIDES * ws.width - (other.collapsed ? 0 : other.size);
  }

  function resizeArea(layout, area, px, ws) {
    var out = clone(layout);
    if (area === "top" || !out.areas[area]) return out;
    var a = out.areas[area];
    if (px < COLLAPSE_PX) { a.collapsed = true; return out; }
    var max = area === "bottom" ? MAX_BOTTOM * ws.height : sideRoom(out, area, ws);
    a.size = clamp(px, MIN_AREA_PX, Math.max(MIN_AREA_PX, max));
    a.collapsed = false;
    return out;
  }

  function clampSizes(layout, ws) {
    var out = clone(layout);
    var A = out.areas;
    A.bottom.size = Math.min(A.bottom.size, MAX_BOTTOM * ws.height);
    ["left", "bottom", "right"].forEach(function (a) {
      if (!A[a].collapsed) A[a].size = Math.max(A[a].size, MIN_AREA_PX);
    });
    var limit = MAX_SIDES * ws.width;
    var open = function (a) { return !A[a].collapsed; };
    var total = function () { return (open("left") ? A.left.size : 0) + (open("right") ? A.right.size : 0); };
    if (total() > limit) {
      var minTotal = (open("left") ? MIN_AREA_PX : 0) + (open("right") ? MIN_AREA_PX : 0);
      if (minTotal <= limit) {
        var excess = total() - limit;
        if (open("right")) { var cut = Math.min(excess, A.right.size - MIN_AREA_PX); A.right.size -= cut; excess -= cut; }
        if (excess > 0 && open("left")) A.left.size -= excess;
      } else {
        if (open("right")) A.right.collapsed = true;
        if (open("left")) A.left.size = Math.min(A.left.size, limit);
      }
    }
    return out;
  }

  globalThis.FreePosterLayout = {
    AREAS: AREAS, TAB_IDS: TAB_IDS, TAB_LABELS: TAB_LABELS, DEFAULT_AREA: DEFAULT_AREA,
    MIN_AREA_PX: MIN_AREA_PX, COLLAPSE_PX: COLLAPSE_PX,
    defaultLayout: defaultLayout, normalizeLayout: normalizeLayout, moveTab: moveTab, activateTab: activateTab,
    areaOf: areaOf, setCollapsed: setCollapsed, resizeArea: resizeArea, clampSizes: clampSizes,
  };
})();
