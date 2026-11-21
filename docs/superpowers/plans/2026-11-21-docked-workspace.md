# Docked Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace FreePoster's tab row and Home grid with a VS Code-style workspace. It has four docked areas, resizable borders, collapsible side and bottom areas, tabs you can drag between areas, and a layout saved between launches.

**Architecture:** The layout's state and rules live in a new file, `public/layout.js`. Its pure functions take a layout object and return a new one. The functions are exposed as `globalThis.FreePosterLayout`, and the tests load the file with `node:vm`. `public/index.html` keeps all of the DOM work: it renders the areas from the layout object, moves the existing panel elements into them, and wires up pointer resizing and HTML5 tab drag and drop. The server serves `/layout.js`, and the desktop build copies it into the app.

**Tech Stack:** Plain browser JavaScript and CSS (no framework), Fastify (`src/server.ts`), and `node --test` with TypeScript test files.

**Spec:** `docs/superpowers/specs/2026-11-21-docked-workspace-design.md`

## Global Constraints

- No new npm packages and no CDN scripts. The desktop app must work offline.
- All UI stays in `public/index.html` plus `public/layout.js`.
- Reuse the existing color tokens in `:root` and in the dark-mode block. Add no hard-coded colors.
- The page never scrolls: `body` is `height: 100vh; overflow: hidden`. Only an area's active panel scrolls.
- Areas: `top`, `left`, `bottom`, `right`. Tab ids: `reviews, analytics, campaigns, calendar, styles, accounts, agents, newpost, drive, upcoming, posts, ai, setup`.
- Default tabs per area, in this order:
  - top: `reviews, analytics, campaigns, calendar, styles`
  - left: `accounts, agents, newpost`
  - bottom: `drive, upcoming, posts`
  - right: `ai, setup`
- Tab labels: reviews "Waiting for your review", analytics "Analytics", campaigns "Campaigns", calendar "Calendar", styles "Editing Styles", accounts "Accounts", agents "AI Agents", newpost "New Post", drive "From Drive", upcoming "Upcoming", posts "Posts", ai "AI Providers", setup "Setup".
- Size limits:
  - The top area is at least 50% of the workspace height, so bottom is at most 50%.
  - The top area is at least 15% of the workspace width, so the open side areas together are at most 85%.
  - An open area is at least 120px.
  - Dragging an area below 60px collapses it.
- The top area can't collapse and must always keep at least one tab.
- The saved layout is stored in `localStorage["layout.v1"]`. Every `localStorage` access is wrapped in try/catch.
- Default sizes: left 340px, bottom 280px, right 380px. First run widens the right area to at least 480px.

## Review Focus

1. **Moving a tab that holds state.** A New Post tab with a chosen video, a typed caption and a playing preview keeps all of them after it is dragged to another area. The panel element is moved, never rebuilt. Checked manually in Task 4, step 4.
2. **Data loads for tabs visible at startup outside the top area.** For example, Calendar saved in the left area loads its month after a relaunch. Checked manually in Task 2, step 5.
3. **Shrinking the window to Electron's 420px `minWidth`.** The page doesn't scroll sideways, the side areas collapse right first, and the top area stays usable. Covered by the `clampSizes` tests in Task 1 and checked manually in Task 3, step 4.
4. **Dropping a tab onto its own position, or onto its own area's body.** Nothing changes, and no duplicate is created. Covered by a `moveTab` test in Task 1.
5. **The Campaigns dialogs (`showModal`) and the Calendar and Analytics detail panes** still open and close correctly when their tab is in a side or bottom area. Checked manually in Task 4, step 4.

---

### Task 1: Layout model (`public/layout.js`) served and shipped

**Files:**
- Create: `public/layout.js`
- Create: `test/layout.test.ts`
- Modify: `src/server.ts:125-126` (add a `/layout.js` route)
- Modify: `scripts/build-app.ts:30` (copy `layout.js`)
- Modify: `test/server.test.ts` (route test)

**Interfaces:**
- Produces `globalThis.FreePosterLayout` with:
  - `AREAS: string[]`, `TAB_IDS: string[]`, `TAB_LABELS: Record<id, string>`, `DEFAULT_AREA: Record<id, area>`
  - `MIN_AREA_PX = 120`, `COLLAPSE_PX = 60`
  - Type `Layout = { areas: Record<area, { tabs: string[], active: string | null, size: number, collapsed: boolean }> }`. `top.size` is unused and set to `0`.
  - `defaultLayout(): Layout`
  - `normalizeLayout(raw: unknown): Layout`
  - `moveTab(layout, id, toArea, index?): Layout | null`. Returns `null` when the move would leave top empty. If `index` is omitted, the tab goes at the end.
  - `activateTab(layout, id): Layout`
  - `areaOf(layout, id): area`
  - `setCollapsed(layout, area, collapsed): Layout`. Top is ignored.
  - `resizeArea(layout, area, px, ws: { width, height }): Layout`
  - `clampSizes(layout, ws): Layout`
- Every function returns a new object (using `structuredClone`) and never mutates its input.

- [ ] **Step 1: Write the failing tests** in `test/layout.test.ts`. Load the file with `vm.runInNewContext(readFileSync("public/layout.js","utf8"), ctx = { structuredClone })` and take `L = ctx.FreePosterLayout`. Use `ws = { width: 1280, height: 800 }`.
  - `defaultLayout`:
    - top tabs deep-equal `["reviews","analytics","campaigns","calendar","styles"]`, and so on for each area, as in Global Constraints
    - each area's active tab is its first tab
    - sizes are left 340, bottom 280, right 380
    - nothing is collapsed
  - `normalizeLayout`:
    - `null`, `"x"` and `{ areas: 5 }` each deep-equal `defaultLayout()`
    - a saved layout that has `"bogus"` in left's tabs drops it
    - a saved layout with `"posts"` missing everywhere puts `posts` at the end of bottom
    - `"posts"` in both left and bottom is kept only in the first area found, in `AREAS` order
    - an `active` that isn't in that area's tabs becomes the area's first tab
    - a side area left with no tabs gets `collapsed: true`
    - a top area left with no tabs returns `defaultLayout()`
    - a `size` of `NaN` or `-5` is replaced with that area's default size
  - `moveTab`:
    - `moveTab(d, "posts", "top", 1)`:
      - top tabs are `["reviews","posts","analytics",…]` and top's active tab is `"posts"`
      - bottom tabs are `["drive","upcoming"]`
      - bottom's active tab is still `"drive"`
    - moving bottom's active tab `"drive"` elsewhere makes `"upcoming"` active, which is the tab now at the same index
    - moving the last tab of an area whose active tab was at the end makes the new last tab active
    - moving `ai` and then `setup` out of right leaves right with `tabs: []`, `active: null` and `collapsed: true`
    - moving all five top tabs out: the fifth call returns `null`
    - `moveTab(d, "calendar", "top", 0)` reorders top to `["calendar","reviews","analytics","campaigns","styles"]`
    - `moveTab(d, "posts", "bottom", 2)` deep-equals `d` (no-op); `moveTab(d, "posts", "bottom")` also deep-equals `d`
    - moving into a collapsed area sets that area's `collapsed: false`
  - `resizeArea`:
    - bottom set to 500 gives 400 (50% of 800)
    - left set to 1200 while right is open at 380 gives `1088 - 380 = 708`
    - left set to 80 gives 120, not collapsed
    - left set to 50 gives `collapsed: true` with size still 340
    - left set to 300 while left is collapsed gives `collapsed: false`, size 300
    - `resizeArea(d, "top", …)` deep-equals `d`
  - `clampSizes`:
    - with `{ width: 600, height: 800 }`, right becomes 170 and left stays 340 (85% of 600 is 510)
    - with `{ width: 280, height: 800 }`, right is collapsed and left is 238
    - with a bottom of 700 and height 800, bottom becomes 400
  - `setCollapsed(d, "top", true)` deep-equals `d`.

- [ ] **Step 2: Run the tests to verify they fail**
  Run: `node --import ./test/isolated-home.ts --test test/layout.test.ts`
  Expected: FAIL (ENOENT for `public/layout.js`)

- [ ] **Step 3: Implement `public/layout.js`.** It is a classic script, not a module: wrap it in an IIFE that assigns `globalThis.FreePosterLayout`.
  - **`clampSizes` order:**
    1. Bottom is at most `0.5 * height`.
    2. Each open area is at least 120px.
    3. While the open side areas add up to more than `0.85 * width`:
       - shrink right toward 120
       - then shrink left toward 120
       - then collapse right
       - then set left to `min(left, 0.85 * width)`
  - **`resizeArea`:**
    - If `px < COLLAPSE_PX`, the area collapses and keeps its old size.
    - Otherwise it opens with `size = clamp(px, 120, max)`. For bottom, max is `0.5 * height`. For a side area, max is `0.85 * width` minus the other side's size, if that side is open.
  - **Active tab after a tab leaves an area:** the tab at the same index, otherwise the new last tab, otherwise `null`.

- [ ] **Step 4: Run the tests to verify they pass**
  Run: `node --import ./test/isolated-home.ts --test test/layout.test.ts`
  Expected: PASS

- [ ] **Step 5: Serve and ship it**
  1. Add a test in `test/server.test.ts`, following the file's existing pattern for `GET /`: `GET /layout.js` returns 200, `content-type` matches `/javascript/`, and the body contains `FreePosterLayout`.
  2. In `src/server.ts`, read `public/layout.js` once, next to `html`, and add `app.get("/layout.js", …)` replying with `reply.type("text/javascript")`.
  3. In `scripts/build-app.ts`, add a `copyFileSync` for `public/layout.js` after the `index.html` copy.
  4. Run `npm test` and `npm run typecheck`. Expected: all pass with 0 failures.

- [ ] **Step 6: Commit**
  `git add public/layout.js test/layout.test.ts test/server.test.ts src/server.ts scripts/build-app.ts`
  `git commit -m "feat(ui): layout model for the docked workspace"`

---

### Task 2: Workspace shell, tabs and persistence

**Files:**
- Modify: `public/index.html`
  - CSS: lines ~20–30 (`body`, `header`, `main`, `section`), ~123–127 (`.tabs`), ~193–195 (`.page`)
  - markup: lines 431–631
  - JS: `showTab`/`TABS` (~1026–1044) and the tab listeners (~1564–1575)

**Interfaces:**
- Consumes: `FreePosterLayout` from Task 1, loaded with `<script src="/layout.js"></script>` before the main `<script>`.
- Produces, in `index.html`:
  - `let layout` (the current `Layout`)
  - `applyLayout()`: renders all four areas from `layout`
  - `commitLayout(next)`: sets `layout`, saves it to `localStorage["layout.v1"]`, calls `applyLayout()`, and calls `onTabShown` for each area's active tab that is newly visible
  - `revealTab(id)`
  - `onTabShown(id)`
  - `resetLayout()`

- [ ] **Step 1: Markup.**
  - Remove `nav.tabs` and `main#home`.
  - The header gains a `.layout-actions` group with buttons `#toggleLeft`, `#toggleBottom`, `#toggleRight` and `#resetLayout` (`title="Reset layout"`). Each is a 16px inline SVG icon with `aria-pressed`. Keep `#quit` as it is.
  - After the banners, add `<div id="workspace">` containing `.area[data-area=left]`, `.sash[data-sash=left]`, `.mid` (holding `.area[data-area=top]`, `.sash[data-sash=bottom]`, `.area[data-area=bottom]`), `.sash[data-sash=right]` and `.area[data-area=right]`.
  - Each `.area` contains `<div class="tabstrip" role="tablist">` and `<div class="area-body">`.
  - Turn each former Home `<section>` into `<div class="panel" id="panel-<tabId>" role="tabpanel" hidden>` with its contents unchanged and its `<h2>` removed. The Drive folder section goes in Task 6, so leave `#driveSection` in a hidden holder `<div id="parking" hidden>` for now.
  - Wrap `#styles`, `#calendar`, `#analytics`, `#campaigns` and `#setup` in, or rename them to, `panel-styles` and so on. Keep their inner ids so existing JS keeps working.

- [ ] **Step 2: CSS.**
  - `body`: `display:flex; flex-direction:column; height:100vh; overflow:hidden`
  - `#workspace`: `flex:1; min-height:0; display:flex`
  - `.mid`: `flex:1; min-width:0; display:flex; flex-direction:column`
  - side areas: `flex: 0 0 var(--left-w)` and `flex: 0 0 var(--right-w)`; bottom: `flex: 0 0 var(--bottom-h)`
  - `.area[data-collapsed]`: `display:none`, and its adjacent sash is hidden too
  - `.area`: `display:flex; flex-direction:column; min-width:0; min-height:0; container-type:inline-size; background:var(--panel)`
  - `.area-body`: `flex:1; min-height:0; position:relative`
  - `.panel`: `position:absolute; inset:0; overflow:auto; padding:16px`
  - Panels that were `section` cards drop their card border. Remove the `max-width`s on `main` and `.page`.
  - Tab strip: one row, `overflow-x:auto`, scrollbar hidden. Active tab: `color: var(--ink)` and a 2px top border in `var(--accent)`.

- [ ] **Step 3: JS.**
  - On load: `layout = FreePosterLayout.clampSizes(FreePosterLayout.normalizeLayout(readSaved()), workspaceSize())`. `readSaved` uses try/catch around `JSON.parse(localStorage.getItem("layout.v1"))`.
  - `applyLayout()` does the following:
    - For each area, rebuilds that area's tab strip buttons (`data-tab`, `aria-selected`, label from `TAB_LABELS`).
    - `appendChild`s each panel into its area's `.area-body`, but only if `panel.parentNode` differs.
    - Sets `panel.hidden` on each panel.
    - Sets `data-collapsed` on each area.
    - Sets `--left-w`, `--right-w` and `--bottom-h` on `#workspace`.
    - Sets `aria-pressed` on the toggles.
  - `onTabShown(id)` maps `styles→renderStyles`, `calendar→loadCalendar`, `analytics→showAnalytics` and `campaigns→loadCampaigns`. Other ids do nothing.
  - `revealTab(id)` calls `commitLayout(activateTab(setCollapsed(layout, areaOf(layout, id), false), id))`.
  - Replace `TABS`/`showTab` and every caller:
    - `$(TABS[x]).click()` and `showTab(x)` become `revealTab(x)`
    - `[data-open-tab]` links become `revealTab(link.dataset.openTab)`
    - `openSetup` calls `revealTab("setup")` in place of `showTab("setup")`
    - `closeSetup` calls `revealTab("ai")` and drops its `showTab("home")`
    - remove the `.open` class logic
  - Clicking a tab strip button calls `revealTab`. `resetLayout()` removes the saved key and calls `commitLayout(clampSizes(defaultLayout(), workspaceSize()))`.
  - At startup, call `onTabShown` for every open area's active tab.

- [ ] **Step 4: Run the tests**
  Run `npm test`. Expected: 0 failures.

- [ ] **Step 5: Manual check.**
  1. Run `npm start`, open `http://localhost:4400`, and check that:
     - the four areas show the default tabs
     - clicking a tab switches it
     - a long tab (Posts, Analytics) scrolls on its own while the header stays still
  2. Move Calendar to the left area with this in the console: `commitLayout(FreePosterLayout.moveTab(layout,"calendar","left"))`.
  3. Reload and check that the left area shows Calendar with this month loaded (Review Focus 2).
  4. Click Reset layout and check that the defaults come back.

- [ ] **Step 6: Commit**
  `git commit -am "feat(ui): docked workspace shell with saved layout"`

---

### Task 3: Resizing and collapsing

**Files:**
- Modify: `public/index.html` (sash CSS and JS; toggle buttons; window resize handler)

**Interfaces:**
- Consumes: `resizeArea`, `setCollapsed` and `clampSizes` (Task 1); `layout` and `commitLayout` (Task 2).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Sash CSS.**
  - Each sash is a 5px hit area with a 1px visible line in `var(--line)`.
  - On hover and while dragging (`.sash.dragging`), the line turns `var(--accent)`.
  - The cursor is `col-resize` for the side sashes and `row-resize` for the bottom one.

- [ ] **Step 2: Sash dragging.**
  - On `pointerdown`, call `setPointerCapture` and record the starting pointer position and size. While dragging, set `document.body.style.userSelect = "none"`.
  - On `pointermove`, compute the new px and schedule one `requestAnimationFrame`. In it:
    1. Run `layout = resizeArea(layout, area, px, workspaceSize())`.
    2. Set the CSS vars and `data-collapsed`. Do **not** save or call `applyLayout` here.
  - Direction: left uses `x - left edge`, right uses `right edge - x`, bottom uses `bottom edge - y`.
  - On `pointerup`, call `commitLayout(layout)` once.

- [ ] **Step 3: Toggles and window resize.**
  - `#toggleLeft`, `#toggleBottom` and `#toggleRight` call `commitLayout(setCollapsed(layout, area, !layout.areas[area].collapsed))`.
  - When an area opens, call `onTabShown` for its active tab. `commitLayout` already does this for newly visible tabs.
  - On `window` `resize`, throttled with rAF: `layout = clampSizes(layout, workspaceSize())`, set the CSS vars, and save. Don't reload any tab.

- [ ] **Step 4: Manual check.**
  - Drag each sash. Check that:
    - the neighboring areas follow the pointer with no jump on release
    - bottom stops at half the height
    - the sides stop when the top area reaches 15% of the width
    - dragging a side or bottom area to its edge collapses it, and its toggle shows as off
    - the toggle brings the area back at its old size
  - Shrink the window to its 420px minimum and check that:
    - there is no horizontal page scroll
    - right collapses before left
  - Relaunch and check that the sizes and collapsed areas are kept.

- [ ] **Step 5: Commit**
  `git commit -am "feat(ui): resizable, collapsible workspace areas"`

---

### Task 4: Dragging tabs

**Files:**
- Modify: `public/index.html` (tab-strip drag-and-drop JS and CSS; edge drop strips)

**Interfaces:**
- Consumes: `moveTab` (Task 1); `commitLayout` (Task 2).

- [ ] **Step 1: Drag source.**
  - Tab buttons are `draggable="true"`.
  - `dragstart` sets `dataTransfer.setData("text/x-fp-tab", id)` and `effectAllowed = "move"`, and adds `body.dragging-tab`.
  - `dragend` removes it, along with every drop indicator.

- [ ] **Step 2: Drop targets.**
  - **`.tabstrip`:**
    - On `dragover`, call `preventDefault()` and compute the insertion index from the pointer's x position against each button's midpoint.
    - Show a 2px `var(--accent)` bar at that position, using an absolutely positioned `.drop-bar`.
    - On `drop`, call `moveTab(layout, id, area, index)`.
  - **`.area-body`:**
    - On `dragover`, show an outline in `var(--accent)` over the body.
    - On `drop`, call `moveTab(layout, id, area)`.
  - **Edge strips:**
    - While `body.dragging-tab` is set, every collapsed area shows a 24px `.edge-drop[data-area]` along its edge: left edge, right edge, or bottom of `.mid`.
    - Dropping on a strip calls `moveTab(layout, id, area)`.
  - **If `moveTab` returns `null`** (the top area's last tab), the drop is ignored and the tab stays where it was. Otherwise call `commitLayout(result)`.

- [ ] **Step 3: Run the tests**
  Run `npm test`. Expected: 0 failures.

- [ ] **Step 4: Manual check.**
  - **Basic moves:** check each of these:
    - reorder a tab within its tab row
    - move a tab to another area's tab row at a chosen position
    - drop a tab onto another area's body, where it goes at the end
    - drag every tab out of the right area, which collapses it
    - drag a tab onto the collapsed right area's edge strip, which reopens it
    - try to drag the top area's last tab out; it is refused
  - **Review Focus 1:** in New Post, choose a video, type a caption and play the preview. Drag New Post to the bottom area. The video, caption and preview are all still there.
  - **Review Focus 4:** drop a tab onto its own place. Nothing changes.
  - **Review Focus 5:** with Campaigns in the right area, open New campaign. The dialog shows centered and Cancel closes it. With Calendar in the left area, click a day and the detail pane opens. With Analytics in the bottom area, click a video and the detail pane opens.

- [ ] **Step 5: Commit**
  `git commit -am "feat(ui): drag tabs between workspace areas"`

---

### Task 5: Tab contents — empty states, review badge, AI error

**Files:**
- Modify: `public/index.html` (around `:1439` reviews, `:1747` upcoming, `:2003` drive files, `:3395` AI providers)

**Interfaces:**
- Consumes: `layout`, `revealTab` and `applyLayout` (Task 2).
- Produces: `setTabBadge(id, count)`.

- [ ] **Step 1: Empty states.** Where code currently sets `section.hidden = !items.length`, keep the panel visible and render a `.muted` line instead:
  - reviews: "Nothing waiting for review."
  - upcoming: "Nothing scheduled."
  - From Drive, when watching and no files: "No videos from your Drive folder yet."
  - From Drive, when no folder is set: "No Drive folder set yet. Choose one in Setup." The words "Choose one in Setup" are a link with `data-setup="drive"`, which `:1833` already turns into `openSetup`.

- [ ] **Step 2: AI Providers error.** Where `#aiSection` was hidden, render `.muted` "Couldn't load AI providers." into `#aiBody`.

- [ ] **Step 3: Review badge.**
  - `setTabBadge(id, count)` renders `<span class="badge">n</span>` on that tab's strip button, or none when the count is 0. It is re-applied after every `applyLayout`, so keep `badges[id]` in a map.
  - In the reviews render, when the count goes up and the reviews tab isn't its area's active tab, add `.pulse` to the button. This is a 1.2s keyframe on `background: color-mix(in srgb, var(--accent) 25%, transparent)`, run twice, and removed on `animationend`.
  - Never call `revealTab` from this code.

- [ ] **Step 4: Manual check.**
  - With an empty database, each of these tabs shows its empty line.
  - Ask an agent to request a review: the badge appears and the tab pulses without switching.

- [ ] **Step 5: Commit**
  `git commit -am "feat(ui): workspace tabs show empty states and a review badge"`

---

### Task 6: Setup in a workspace area and the Drive folder step

**Files:**
- Modify: `public/index.html`
  - `SETUP_STEPS` (~1000)
  - `stepDone` (~1046)
  - `stepHtml`
  - `renderSetup` (~1228)
  - `saveStep`
  - `loadDrive`/`renderDrive` (~1949–1960)
  - `.wiz` CSS (~128–136)
  - startup at ~3371

**Interfaces:**
- Consumes: `revealTab`, `commitLayout`, `resizeArea` and `layout` (Tasks 1–2); the existing `driveView` and `renderDrive`.

- [ ] **Step 1: Narrow wizard.**
  - `renderSetup` also renders `<select id="stepSelect" class="step-select">`. Each option's text is `"✓ " + title` for a finished step, or `"<n>. " + title` otherwise. On `change`, it sets `stepIndex` and calls `renderSetup()`.
  - Add `@container (max-width: 640px) { .wiz { grid-template-columns: 1fr } .wiz nav { display:none } .step-select { display:block } }`. By default `.step-select { display:none }`.
  - Remove the `.wiz` `max-width` and `margin: 0 auto`.

- [ ] **Step 2: Drive folder step.**
  - Append `{ id: "drive", title: "Google Drive folder" }` after `connect` in `SETUP_STEPS`.
  - `stepDone` gets a case: `s.id === "drive" ? Boolean(driveView?.folderId)`.
  - `stepHtml` for `drive` returns `<p class="muted">FreePoster watches this folder and posts the videos you put in it.</p><div id="driveBody" class="drive muted">Loading…</div>`. `renderSetup` then calls `if (driveView) renderDrive(driveView)`.
  - The skip button text for this step: "I don't use Google Drive".
  - The skip and next buttons on this step do the following:
    - `saveStep` returns early for `drive`, because the folder form saves itself as it does today.
    - Since `drive` is now the last step, Finish follows it, and the old `connect` step is no longer `last`.
  - `loadDrive` gets a guard: `if ($("driveBody") && !$("driveBody").contains(document.activeElement)) renderDrive(view)`.
  - Delete `#driveSection` and the `#parking` holder from Task 2.

- [ ] **Step 3: First run and Finish.**
  - At startup (~3371), before `openSetup(...)`, if `layout.areas[areaOf(layout,"setup")]` is a side area narrower than 480, call `commitLayout(resizeArea(layout, thatArea, 480, workspaceSize()))`.
  - `closeSetup` (Task 2) already reveals `ai`.

- [ ] **Step 4: Run the tests and the typecheck**
  Run `npm test` and `npm run typecheck`. Expected: 0 failures.

- [ ] **Step 5: Manual check.**
  - With a fresh home (`FREEPOSTER_HOME` pointing to an empty scratch folder, as `test/isolated-home.ts` does), launch the app. The right area opens at 480px on Setup, and the steps show as a dropdown.
  - Drag Setup into the top area: the side step list returns.
  - Go to the Google Drive folder step: choosing a folder works as it did on Home, and its tick appears.
  - Finish: the area switches to AI Providers.
  - The From Drive tab's "Choose one in Setup" link opens the Drive step.

- [ ] **Step 6: Commit**
  `git commit -am "feat(ui): setup fits workspace areas; Drive folder is a setup step"`

---

### Task 7: Final verification

- [ ] **Step 1:** Run `npm test` and `npm run typecheck`. Expected: 0 failures and no type errors.
- [ ] **Step 2:** Run `npm run desktop`. The packaged-style app loads `/layout.js`, with no console errors. Run the manual checks from Tasks 3 and 4 once in Electron, then quit and relaunch to confirm the layout was kept.
- [ ] **Step 3:** Commit any fixes, with a message that names what was fixed.
