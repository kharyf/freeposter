# Tab Menus, Curved Tabs and Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add right-click tab menus (Delete Tab; Add Tab ▸ every tab), curved tabs styled after `TabMockup.jpg`, and a live, read-only, searchable Console tab.

**Architecture:** The layout model in `public/layout.js` gains a `closed` list and pure helpers (`closeTab`, `addTab`, `canCloseTab`, `addTabChoices`), so tab state stays testable outside the DOM. A server-side ring buffer captures `console.*` and is served at `GET /api/console?after=<seq>`. The Console tab polls that endpoint every second, using pure helpers in a new `public/console-view.js`. The menus and styles live in `public/index.html`, like the rest of the workspace UI.

**Tech Stack:** Node 22+ TypeScript run directly (`node src/main.ts`), Fastify, plain browser JS, node:test with `vm` for the public/*.js modules.

**Spec:** `docs/superpowers/specs/2026-11-23-tab-menus-and-console-design.md`

## Global Constraints

- The font family, size and weight of the tabs don't change. Only shape, fill and outline do.
- Console is first in the right panel by default: `right: ["console", "ai", "setup"]`. Its label is `"Console"`.
- The console buffer keeps the last **5,000** entries, and the page keeps at most **5,000** lines.
- While visible, the Console polls once every **1000 ms**, with at most one request in flight. It makes no requests while it's not visible.
- No history from earlier sessions. `freeposter.log` is never read.
- Top's last tab can't be deleted or moved away. The UI disables those items, and the model returns `null`.
- Add Tab lists every tab in `TAB_IDS` order. Tabs already in the row are disabled. Picking a tab that's open in another row moves it.
- Menu copy is exact: `Delete Tab`, `Add Tab` (followed by an arrow `▸`), and the tab labels from `TAB_LABELS`.
- Work on a branch (`feat/tab-menus-console`), not `main`.

## Review Focus

1. **The server restarts while the Console is open.** The client's `after` is now ahead of the server's `latest`. The client must clear the view and start over, not stall forever. This is pinned in Task 3 (`ConsoleBuffer.since` with `after > latest`) and Task 4 (`mergeLines` reset).
2. **A saved layout from before this change** (no `closed`, no `console`). Console must land first in the right panel and nothing else may move. Pinned in Task 1.
3. **A link or badge opens a deleted tab** (`data-open-tab`, the review badge). The tab must reopen in its default area. Pinned in Task 1 (`activateTab` on a closed tab).
4. **Search text with regex characters** (`[job 12`, `(`, `.*`). It must match literally and never throw. Pinned in Task 4 (`matchSegments`).
5. **Right-clicking an empty side area's strip** (all its tabs deleted, then the area opened with its toggle). Add Tab must work there. Pinned in Task 1 (`addTabChoices` on an empty area) and checked by hand in Task 6.

---

### Task 1: Layout model, with closed tabs and Console

**Files:**
- Modify: `public/layout.js`
- Modify: `test/layout.test.ts`

**Interfaces:**
- Produces (on `globalThis.FreePosterLayout`):
  - `TAB_IDS` now includes `"console"`. `TAB_LABELS.console === "Console"`. `DEFAULT_TABS.right` is `["console","ai","setup"]`.
  - The layout shape is `{ areas: {...}, closed: string[] }`. `defaultLayout().closed` is `[]`.
  - `closeTab(layout, id) -> layout | null`. Returns null for top's last tab, and returns an unchanged clone for an unknown id or a tab that's already closed.
  - `addTab(layout, id, area) -> layout | null`. If `id` is closed, it reopens it at the end of `area`. Otherwise it returns `moveTab(layout, id, area)`, or `activateTab` when the tab is already in `area`. Either way the tab becomes active and the area opens. Returns null when the move is refused.
  - `canCloseTab(layout, id) -> boolean`
  - `addTabChoices(layout, area) -> Array<{ id, label, disabled }>`, in `TAB_IDS` order. `disabled` is true when the tab is in `area`, or when it's top's only tab and `area !== "top"`.
  - `activateTab(layout, id)` on a closed tab returns `addTab(layout, id, DEFAULT_AREA[id])`.
  - `areaOf(layout, id)` on a closed tab returns `DEFAULT_AREA[id]`, as it does today for a missing tab.

- [ ] **Step 1: Update the existing tests for the new default, and write failing tests**

Existing tests change as follows. `defaultLayout` now expects `right.tabs` to be `["console","ai","setup"]` and `closed` to be `[]`. The `emptySide` case in `normalizeLayout` parks `"console","ai","setup"` in left. The `moveTab` case at line 82 moves `console`, `ai` and `setup` out before asserting that right is `{ tabs: [], active: null, size: 380, collapsed: true }`.

New tests:

```ts
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
  for (const id of ["reviews", "analytics", "campaigns", "calendar"]) t = L.closeTab(t, id);
  assert.equal(L.closeTab(t, "styles"), null);
  assert.equal(L.canCloseTab(t, "styles"), false);
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
  for (const id of ["reviews", "analytics", "campaigns", "calendar"]) t = L.moveTab(t, id, "left");
  assert.equal(L.addTab(t, "styles", "left"), null);
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
  for (const id of ["reviews", "analytics", "campaigns", "calendar"]) t = L.moveTab(t, id, "left");
  assert.equal(j(L.addTabChoices(t, "right")).find((c: any) => c.id === "styles").disabled, true);
  // an empty, opened side area offers everything not already there
  let e = L.closeTab(L.closeTab(L.closeTab(d(), "console"), "ai"), "setup");
  e = L.setCollapsed(e, "right", false);
  assert.equal(j(L.addTabChoices(e, "right")).every((c: any) => !c.disabled), true);
});
```

Also add `closeTab` and `addTab` to the "never mutates" test.

- [ ] **Step 2: Run the tests to check they fail**

Run: `node --import ./test/isolated-home.ts --test test/layout.test.ts`
Expected: FAIL (`L.closeTab is not a function`, and the default right is `["ai","setup"]`).

- [ ] **Step 3: Implement the changes in `public/layout.js`**

`normalizeLayout`:
- Read `raw.closed`. Keep only ids that are valid, unique and not placed in any area.
- Insert each tab that's neither placed nor closed at `clamp(DEFAULT_TABS[area].indexOf(id), 0, tabs.length)` in its default area, instead of pushing it to the end. The existing `noPosts` test still gives `[..., "posts"]`.
- The empty-top fallback stays `defaultLayout()`.

`closeTab`: reuses `moveTab`'s rules for choosing the next active tab and collapsing an empty side area. Factor a shared `removeFromArea(out, id)` helper out of `moveTab`, so the two can't drift apart.

Add the remaining functions with the signatures above, and export them all.

- [ ] **Step 4: Run the tests to check they pass**

Run: `node --import ./test/isolated-home.ts --test test/layout.test.ts`
Expected: PASS, with every test green.

- [ ] **Step 5: Commit**

```bash
git add public/layout.js test/layout.test.ts docs/superpowers/specs/2026-11-23-tab-menus-and-console-design.md docs/superpowers/plans/2026-11-23-tab-menus-and-console.md
git commit -m "feat(layout): tabs can be closed and re-added; Console tab first on the right"
```

---

### Task 2: Use the new model in the UI (deleted tabs, panel placeholder)

**Files:**
- Modify: `public/index.html`: the panel markup near line 579, `applyLayout` near line 1158, and `revealTab` near line 1202.

**Interfaces:**
- Consumes: `FPL.closeTab`, `FPL.addTab`, `FPL.activateTab` and `layout.closed` from Task 1.
- Produces:
  - `<div class="panel" id="panel-console" data-tab="console" role="tabpanel" aria-label="Console" hidden></div>`. Task 5 fills it.
  - `applyLayout()` hides the panels of closed tabs.
  - `revealTab(id)` reopens a closed tab.

- [ ] **Step 1: Add the Console panel placeholder** next to `panel-ai`.

- [ ] **Step 2: Make `applyLayout` hide closed tabs' panels.** For each id in `layout.closed`, set `panelEl(id).hidden = true`. The panel stays wherever its DOM node is.

- [ ] **Step 3: Make `revealTab(id)` reopen closed tabs.** When `layout.closed.includes(id)`, call `commitLayout(FPL.activateTab(layout, id))`, which reopens the tab and opens its area. Otherwise keep the current behavior.

- [ ] **Step 4: Check it by hand.** Run `npm run typecheck && npm test` and expect both to pass. Then `npm start`, open the app, and confirm the following:
  - Console is the first tab in the right panel and shows an empty panel.
  - In DevTools, `localStorage` holds a `closed: []` in the saved layout.
  - Every existing tab still switches and drags.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat(ui): the workspace honours closed tabs; Console panel placeholder"
```

---

### Task 3: Console capture and `GET /api/console`

**Files:**
- Create: `src/console-buffer.ts`
- Modify: `src/app.ts`, where the first line of `startApp` installs the capture
- Modify: `src/server.ts`, which gets the route and serves `/console-view.js` next to `/campaign-rows.js` (line 130)
- Test: `test/console-buffer.test.ts`, and the route test in `test/server.test.ts`

**Interfaces:**
- Produces:
  - `type ConsoleLine = { seq: number; at: number; level: "info" | "error"; text: string }`
  - `class ConsoleBuffer { constructor(limit = 5000); push(level: ConsoleLine["level"], text: string): ConsoleLine; since(after: number): { lines: ConsoleLine[]; latest: number; dropped: boolean } }`. `seq` starts at 1 and only grows.
  - `since` treats a non-finite or negative `after` as 0. **If `after > latest`, it returns everything kept, as if `after` were 0.** `dropped` is `kept.length > 0 && kept[0].seq > effectiveAfter + 1`.
  - `installConsoleCapture(buffer: ConsoleBuffer, target: Console = console): () => void`. It wraps `log` and `info` as `"info"`, and `warn` and `error` as `"error"`. It formats text with `util.format(...args)` and **calls the previously installed function** with the original args. It's idempotent per target, using a symbol marker on the target. The function it returns restores the originals.
  - `export const consoleBuffer: ConsoleBuffer`, the app's singleton.
  - `GET /api/console?after=<n>` responds `200` with `consoleBuffer.since(Number(after ?? 0))` as JSON.
  - `GET /console-view.js` serves `public/console-view.js` (Task 4) as `text/javascript`.

- [ ] **Step 1: Write the failing tests**

```ts
test("ConsoleBuffer keeps order, a ring of `limit`, and reports drops", () => {
  const b = new ConsoleBuffer(3);
  for (const t of ["a", "b", "c", "d"]) b.push("info", t);
  const r = b.since(0);
  assert.deepEqual(r.lines.map((l) => l.text), ["b", "c", "d"]);
  assert.deepEqual(r.lines.map((l) => l.seq), [2, 3, 4]);
  assert.equal(r.latest, 4);
  assert.equal(r.dropped, true);
  assert.deepEqual(b.since(2), { lines: b.since(0).lines.slice(1), latest: 4, dropped: false });
  assert.deepEqual(b.since(4).lines, []);
});

test("ConsoleBuffer.since after > latest (server restarted) returns everything", () => {
  const b = new ConsoleBuffer();
  b.push("info", "x");
  assert.deepEqual(b.since(900).lines.map((l) => l.text), ["x"]);
  assert.deepEqual(b.since(-3).lines.length, 1);
  assert.deepEqual(b.since(NaN).lines.length, 1);
});

test("installConsoleCapture formats, levels, chains, is idempotent, uninstalls", () => {
  const seen: string[] = [];
  const target: any = { log: (...a: unknown[]) => seen.push("log:" + a.join(" ")), info: () => {}, warn: () => {}, error: (...a: unknown[]) => seen.push("err:" + a.join(" ")) };
  const b = new ConsoleBuffer();
  const undo = installConsoleCapture(b, target);
  installConsoleCapture(b, target);                    // second install: no double capture
  target.log("job %d", 7);
  target.error("boom");
  assert.deepEqual(b.since(0).lines.map((l) => [l.level, l.text]), [["info", "job 7"], ["error", "boom"]]);
  assert.deepEqual(seen, ["log:job %d 7", "err:boom"]);
  undo();
  target.log("after");
  assert.equal(b.since(0).lines.length, 2);
});
```

In `test/server.test.ts`, add a test modeled on the `/layout.js` one. It pushes `"hello console"` to `consoleBuffer` and asserts the following:
- `GET /api/console?after=0` returns 200 with a line whose `text` is `"hello console"`, and `latest >= that seq`.
- `GET /api/console?after=<latest>` returns `lines: []`.
- `GET /console-view.js` returns 200 with a javascript content type that matches `/FreePosterConsole/`.

- [ ] **Step 2: Run the tests to check they fail**

Run: `node --import ./test/isolated-home.ts --test test/console-buffer.test.ts test/server.test.ts`
Expected: FAIL, because `src/console-buffer.ts` doesn't exist yet.

- [ ] **Step 3: Implement `src/console-buffer.ts`, the route, the script route, and `installConsoleCapture(consoleBuffer)` as the first statement of `startApp`.**

Installing inside `startApp` puts the capture after `desktop.ts` has swapped `console.*` for its file writer (that module's body runs before it calls `startApp`). The file writer is then the "previous" function the capture chains to, so `freeposter.log` and the terminal keep getting every line. For `/console-view.js`, read the file at startup, the same way `campaign-rows.js` is read. Task 4 creates the file. Until then, create it with just `globalThis.FreePosterConsole = {};` so this task's test passes.

- [ ] **Step 4: Run the tests to check they pass**

Run: `node --import ./test/isolated-home.ts --test test/console-buffer.test.ts test/server.test.ts && npm run typecheck`
Expected: PASS, and tsc reports no errors.

- [ ] **Step 5: Commit**

```bash
git add src/console-buffer.ts src/app.ts src/server.ts public/console-view.js test/console-buffer.test.ts test/server.test.ts
git commit -m "feat(console): capture this session's console output; GET /api/console"
```

---

### Task 4: Console view helpers (`public/console-view.js`)

**Files:**
- Modify: `public/console-view.js`, replacing the Task 3 stub
- Test: `test/console-view.test.ts`, which loads the file with `vm` the same way `test/layout.test.ts` does

**Interfaces:**
- Produces `globalThis.FreePosterConsole` with:
  - `CAP = 5000`
  - `mergeLines(state, resp) -> { state, added, reset }`. `state` is `{ lines: ConsoleLine[], seq: number, dropped: boolean }`. `resp` is the `/api/console` body.
    - **If `resp.latest < state.seq`, the server restarted:** start from empty (`reset: true`) and then add `resp.lines`.
    - Otherwise it appends `resp.lines` with `seq > state.seq`, keeps only the last `CAP` lines, and sets `state.dropped ||= resp.dropped || (an overflow past CAP)`. Then `state.seq = resp.latest`.
    - `added` holds the lines appended in this call.
  - `matchSegments(text, query) -> Array<{ text, hit: boolean }> | null`. It matches case-insensitively and literally (regex characters aren't special). It returns `null` when `query` is non-empty and nothing matches. An empty query returns `[{ text, hit: false }]`.
  - `clock(at) -> "HH:MM:SS"`, in local time, zero-padded.

- [ ] **Step 1: Write the failing tests**

```ts
test("mergeLines appends new lines, ignores repeats, caps, and resets on restart", () => {
  const C = ctx.FreePosterConsole;
  const line = (seq: number) => ({ seq, at: 0, level: "info", text: "t" + seq });
  let s = { lines: [], seq: 0, dropped: false };
  let r = C.mergeLines(s, { lines: [line(1), line(2)], latest: 2, dropped: false });
  assert.deepEqual(j(r.added).map((l: any) => l.seq), [1, 2]);
  r = C.mergeLines(r.state, { lines: [line(2), line(3)], latest: 3, dropped: false });
  assert.deepEqual(j(r.state.lines).map((l: any) => l.seq), [1, 2, 3]);
  r = C.mergeLines(r.state, { lines: [line(1)], latest: 1, dropped: false });   // server restarted
  assert.equal(r.reset, true);
  assert.deepEqual(j(r.state.lines).map((l: any) => l.seq), [1]);
  const many = Array.from({ length: 5001 }, (_, i) => line(i + 1));
  r = C.mergeLines({ lines: [], seq: 0, dropped: false }, { lines: many, latest: 5001, dropped: false });
  assert.equal(r.state.lines.length, 5000);
  assert.equal(r.state.dropped, true);
});

test("matchSegments is literal and case-insensitive", () => {
  const C = ctx.FreePosterConsole;
  assert.deepEqual(j(C.matchSegments("[job 12 x] Uploaded", "[JOB 12")), [{ text: "[job 12", hit: true }, { text: " x] Uploaded", hit: false }]);
  assert.deepEqual(j(C.matchSegments("a.b a.b", ".*")), null);
  assert.deepEqual(j(C.matchSegments("aXa", "a")), [{ text: "a", hit: true }, { text: "X", hit: false }, { text: "a", hit: true }]);
  assert.deepEqual(j(C.matchSegments("abc", "")), [{ text: "abc", hit: false }]);
  assert.equal(C.clock(new Date(2026, 0, 1, 3, 4, 5).getTime()), "03:04:05");
});
```

- [ ] **Step 2: Run the tests to check they fail**

Run: `node --import ./test/isolated-home.ts --test test/console-view.test.ts`
Expected: FAIL (`mergeLines` is undefined).

- [ ] **Step 3: Implement the helpers.** Write them as plain ES5-style functions in an IIFE, like `layout.js`, with no DOM access. For `matchSegments`, use `indexOf` on lowercased strings, not `RegExp`.

- [ ] **Step 4: Run the tests to check they pass**

Run: `node --import ./test/isolated-home.ts --test test/console-view.test.ts test/server.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add public/console-view.js test/console-view.test.ts
git commit -m "feat(console): view helpers for merging, searching and timestamps"
```

---

### Task 5: The Console tab UI

**Files:**
- Modify: `public/index.html`. This covers the `#panel-console` markup, the CSS, `<script src="/console-view.js">` next to the `campaign-rows.js` tag (line 681), a `console` branch in `onTabShown` (line 1094), and the polling and render code.

**Interfaces:**
- Consumes: `FreePosterConsole.mergeLines`, `matchSegments`, `clock` and `CAP` (Task 4), `GET /api/console` (Task 3), and `visibleTabs(layout)` (already in `index.html`).

The pieces to build:

1. **Markup.** Inside `#panel-console`:
   - a toolbar with `<input type="search" id="consoleSearch" placeholder="Search console" aria-label="Search console">` and a `<span id="consoleCount">`;
   - `<div id="consoleLog" role="log" aria-label="Console output" tabindex="0">`;
   - `<button type="button" id="consoleJump" hidden>Jump to latest</button>`.

   The panel itself is a flex column with no padding scroll of its own. Only `#consoleLog` scrolls. The log uses a monospace font, `white-space: pre-wrap`, `word-break: break-word`, and 12px text.

2. **Rendering.** Each line becomes `<div class="cl" data-level>`, holding `<span class="cl-time">HH:MM:SS</span>` followed by the segments. Hit segments go in `<mark>` and the rest are text nodes. Never use `innerHTML` with line text. Error-level lines get `color: var(--bad)`. A `dropped` state shows a first row reading `… earlier lines were dropped`.

3. **Search.** Re-render on `input`, using only the lines where `matchSegments` isn't `null`. `#consoleCount` shows `N matching` while there's a query and is empty otherwise. During a search, newly arrived lines are filtered too.

4. **Auto-scroll.**
   - Before appending, note whether the view is pinned (`scrollHeight - scrollTop - clientHeight < 24`).
   - After appending: if it was pinned, scroll to the bottom. If not, show `#consoleJump`.
   - Clicking the button scrolls to the bottom and hides it.
   - Scrolling back to the bottom by hand hides it too.

5. **Trimming.** When the line count goes past `CAP`, remove the oldest `.cl` nodes so the DOM matches `state.lines`.

6. **Polling.**
   - `onTabShown("console")` calls `startConsolePoll()`.
   - A `setInterval` runs every 1000 ms. On each tick, if `!visibleTabs(layout).includes("console")`, it clears the interval and stops. It also skips the tick while a request is in flight or while `document.hidden`.
   - Otherwise it calls `fetch("/api/console?after=" + state.seq)` and passes the result to `mergeLines`. On `reset`, it clears the DOM and re-renders. Otherwise it appends `added`.
   - A failed request is ignored, and the next tick retries.
   - Start the first fetch immediately, so the tab doesn't wait a second.

- [ ] **Step 1: Build the pieces above.**

- [ ] **Step 2: Check it by hand.** `npm start`, then in the app:
  - Open Console. It fills with startup lines within a second.
  - Do something that logs, such as starting a post or a campaign. The lines appear within about a second.
  - Search for `[job`. Only matching lines show, with the text highlighted and the count displayed. Clearing the search brings back every line.
  - Scroll up. "Jump to latest" appears when new lines arrive and doesn't pull the view down.
  - Restart the server with the tab open. The view resets and shows the new session's lines.
  - Switch to the AI Providers tab. The Network panel shows `/api/console` requests stopping.
  - Lines can't be edited, but they can be selected and copied.

- [ ] **Step 3: Run the checks.** Run `npm run typecheck && npm test`. Expect both to pass.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat(ui): Console tab with live output and search"
```

---

### Task 6: Context menus and curved tabs

**Files:**
- Modify: `public/index.html`. This covers the CSS near lines 144–149, the theme tokens in `:root` and the dark block (lines 8–19), and a delegated `contextmenu` listener next to the tab click handler (line 1781).

**Interfaces:**
- Consumes: `FPL.closeTab`, `FPL.canCloseTab`, `FPL.addTab` and `FPL.addTabChoices` (Task 1), `commitLayout`, and `onTabShown` (already in `index.html`).

The pieces to build:

1. **The menu component.** `openMenu(items, x, y)`, where an item is `{ label, disabled?, action?, submenu?: items }`.
   - It's a `div.ctx-menu[role=menu]` appended to `body`, `position: fixed`, and clamped inside the window.
   - Each item is a `button[role=menuitem]`. A disabled item gets `aria-disabled="true"`, is dimmed, and does nothing on click.
   - An item with a submenu shows its label plus a right-aligned `▸`, and has `aria-haspopup="menu"`. Its submenu opens on `mouseenter` or `focus` or `→`, to the right of the item, or to the left when it wouldn't fit. It closes when another item in the parent menu is hovered, or on `←`.
   - `↑`/`↓` move focus within a menu, and `Enter`/`Space` activate.
   - Every open menu closes on `Escape`, `pointerdown` outside, `blur`, `resize`, a `scroll` that captures anywhere, or after an action runs.
   - Styling: `--panel` background, a 1px `--line` border, 8px radius, a small shadow, 13px items in the app font, and a hover/focus background of `color-mix(in srgb, var(--accent) 14%, transparent)`.

2. **The listener.** On `contextmenu` inside `#workspace`:
   - **On `.tabstrip button[data-tab]`:** call `preventDefault()` and open `[{ label: "Delete Tab", disabled: !FPL.canCloseTab(layout, id), action: () => commitLayout(FPL.closeTab(layout, id)) }]`.
   - **On a `.tabstrip` but not on a tab button** (including the gaps between tabs): call `preventDefault()` and open `[{ label: "Add Tab", submenu: FPL.addTabChoices(layout, area).map(c => ({ label: c.label, disabled: c.disabled, action: () => addTabTo(c.id, area) })) }]`.
     - `addTabTo` runs the same steps as `dropTab`: note whether the tab was visible, call `commitLayout(FPL.addTab(...))`, then call `onTabShown(id)` again if it was already visible and still is.
   - Anywhere else, the browser's own menu stays.

3. **Curved tabs.**
   - Add the tokens `--tab: #ebe9e4; --tab-on: #d5d1c8` in `:root`, and `--tab: #3a3936; --tab-on: #0e0e0d` in the dark block.
   - `.tabstrip` gets `gap: 4px; padding: 6px 6px 0; align-items: flex-end`. Its `border-bottom` stays.
   - `.tabstrip button` gets `background: var(--tab); border: 2px solid transparent; border-bottom: 0; border-radius: 10px 10px 0 0; color: var(--muted)`. Keep the current padding, `font-size: 13px` and `font-weight: 600` unchanged.
   - `[aria-selected="true"]` gets `background: var(--tab-on); border-color: var(--accent); color: var(--ink)`.
   - Remove the old `border-top` accent rule.
   - Check that `.tab-badge`, `.drop-bar` and `.pulse` still look right on the new fills, and adjust only their offsets if they've moved.

- [ ] **Step 1: Build the pieces above.**

- [ ] **Step 2: Check it by hand.** `npm start`, in both dark and light mode:
  - The tabs have curved tops and gaps between them. The selected tab is darker than the rest, has a blue outline, and is in the same font as before. Compare it with `TabMockup.jpg`.
  - Right-click a tab. The only item is "Delete Tab", and choosing it removes the tab. On the top row's last tab, the item is greyed out.
  - Right-click empty strip space. "Add Tab ▸" appears, and hovering it opens every tab.
    - Tabs already in the row are greyed out.
    - Picking a deleted tab adds it.
    - Picking a tab that's open in another row moves it here.
  - Delete every tab in the right panel. The area collapses. Open it with its toggle, right-click the empty strip, and add Console back.
  - Delete Posts, then click a link that opens Posts (for example Setup's "Posts" link, or any `data-open-tab="posts"`). Posts reopens in the bottom row.
  - Reset Layout brings back every tab.
  - The menus can be worked with the keyboard alone: arrows, Enter and Escape.
  - Dragging tabs still works.
  - Right-clicking a panel's body still shows the browser's normal menu.

- [ ] **Step 3: Run the checks.** Run `npm run typecheck && npm test`. Expect both to pass.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat(ui): tab context menus (Delete Tab, Add Tab ▸) and curved tabs"
```
