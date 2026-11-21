# Docked workspace layout

## Intent

FreePoster's UI moves from one scrolling page with a tab row to a workspace laid out like VS Code. It has four docked areas. You can resize the areas by dragging the borders between them, and drag tabs within an area or between areas. Each tab scrolls inside its own area, so the rest of the window stays still. The goal is to see and work with several parts of FreePoster at once, such as reviews next to the calendar or the New Post form next to Posts, and to arrange them the way you like.

## Goals

- Four areas: **top** (the main area), **left**, **bottom** and **right**, arranged as in VS Code. Left and right run the full height of the workspace. Top and bottom share the middle column.
- Default tabs:
  - **Top:** Waiting for your review, Analytics, Campaigns, Calendar, Editing Styles
  - **Left:** Accounts, AI Agents, New Post
  - **Bottom:** From Drive, Upcoming, Posts
  - **Right:** AI Providers, Setup
- You can drag the borders to resize the areas, and the other areas follow the pointer live, with no jump on release.
- You can drag a tab to a new position in its area's tab row, or into another area.
- Each tab scrolls inside its area. Nothing else on the page moves.
- Left, right and bottom can collapse fully.
- The top area is never shorter than **50%** of the workspace height or narrower than **15%** of its width.
- The layout is remembered between launches: which tabs are in which area, their order, the active tab in each area, the area sizes, and which areas are collapsed.
- The Google Drive folder picker moves out of Home and into Setup.

## Non-goals

- Splitting an area into sub-panes, floating windows, or more than four areas.
- A separate layout for phones or narrow windows. Collapsing the side areas is how a narrow window copes.
- Changing what any tab contains, apart from the Drive folder move and the Setup reflow described below.

## Anti-goals: failures even if it technically works

- A review waiting for approval goes unnoticed because its tab is in the background.
- A tab gets lost, for example dragged into a collapsed area or left in an unknown state, and the user can't get it back.
- Resizing stutters or reflows heavy tabs such as Analytics on every pointer move.
- The workspace makes the whole page scroll. The page itself must never scroll.

## Constraints

- Everything stays in `public/index.html`: plain JavaScript and CSS, no frontend framework, and no new packages. The desktop app must work offline.
- The existing light and dark color tokens in `:root` are reused.
- Electron window: default width 1280, `minWidth` 420 (`src/desktop.ts`).

## Approaches

1. **Write it ourselves in plain JavaScript (chosen).** This fits the existing single file with no dependencies. The specific rules (four fixed areas, the minimum size for the top area, full collapse, and the saved layout) are simple to enforce in our own code. The cost is about 400–500 lines, including drag-and-drop handling that we write ourselves.
2. **A docking library such as dockview.** Drag, drop and resize come ready-made. However, its model is free-form (splits, floating panes), so we would have to work against it to enforce the four fixed areas. We would also have to bundle it, because the app must run offline. Not chosen.

The user picked approach 1.

## Decided with the user

- Reviews ("Waiting for your review") lives in the top area by default.
- The layout is remembered between launches.
- Left, right and bottom can collapse fully.
- The top area has a minimum height of 50% and a minimum width of 15%.

## Design

### Page structure

```
┌ header (title, layout toggles, Reset layout, Quit) ─────────────┐
├ banners (redirectBanner, banner) ───────────────────────────────┤
│┌left─────┐┌top──────────────────────────────┐┌right──────────┐ │
││tab row  ││tab row                          ││tab row        │ │
││ body    ││ body (scrolls)                  ││ body          │ │
││(scrolls)│├═════ resize border ═════════════┤│ (scrolls)     │ │
││         ││bottom: tab row + body           ││               │ │
│└─────────┘└─────────────────────────────────┘└───────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

- `body` is a flex column that fills the window (`height: 100vh; overflow: hidden`). The header and banners don't grow or shrink. The workspace takes the rest of the height.
- The workspace is a row of left area, a resize border, the middle column, a resize border, and the right area. The middle column is a column of the top area, a resize border, and the bottom area.
- Each area is a column: a tab row (one line, which scrolls sideways when it overflows) and a body. The body holds every tab panel in that area, and only the active one is shown. The active panel has `overflow: auto` and `min-height: 0`, so it scrolls on its own.
- The existing tab row (`nav.tabs`) and the Home grid (`main#home`) go away. Every Home `<section>` becomes its own tab panel. Its `<h2>` heading is dropped because the tab label now names it.

### Tab panels

There are 13 tabs, each with a fixed id:
`reviews, analytics, campaigns, calendar, styles, accounts, agents, newpost, drive, upcoming, posts, ai, setup`.

- Each panel element is created once and moved between areas with `appendChild`. It is never rebuilt, so form state, video previews and scroll position survive a move.
- A tab's label is its name. The **reviews** tab also shows a count badge (the number of pending reviews) whenever that number is above zero.
- The From Drive, Upcoming and Reviews sections currently hide themselves when they're empty (`[public/index.html:1439](../../../public/index.html#L1439)`, `:1747`, `:2003`). As tabs they stay visible and show a one-line empty state instead, such as "Nothing waiting for review." and "Nothing scheduled.". From Drive keeps its current text when no folder is set, and points to Setup.
- AI Providers currently hides its section when the request fails (`:3395`). As a tab it shows the error instead.

### Loading data when a tab becomes visible

`showTab(name)` currently does two jobs: it shows one page and hides the rest, and it loads data for Styles, Calendar, Analytics and Campaigns. These two jobs are separated:

- `revealTab(id)` opens the tab's area if it is collapsed, makes the tab active there, and calls `onTabShown(id)`.
- `onTabShown(id)` runs the same loader as today: `renderStyles`, `loadCalendar`, `showAnalytics` or `loadCampaigns`. It runs whenever a tab becomes the active one in an area that is open, at startup, after a move, after an area is opened, and after a tab is activated. Several tabs are visible at once, so several loaders can run at startup. Each loader already works on its own.
- Every call to `showTab(...)`, every `[data-open-tab]` link, and every call to `openSetup`/`closeSetup` goes through `revealTab`.

### Resizing

- There are three borders: left|middle, middle|right, and top/bottom. Each is a 5px hit area with a 1px visible line, and it is highlighted on hover and while dragging.
- Dragging uses Pointer Events with `setPointerCapture`. Each `pointermove` writes the new size to a CSS custom property (`--left-w`, `--right-w`, `--bottom-h`), no more than once per animation frame. Area contents are not re-rendered during a drag.
- Sizes are stored in pixels and clamped on every move:
  - top height ≥ 50% of the workspace height, so bottom height ≤ 50%
  - top width ≥ 15% of the workspace width, so left + right ≤ 85%
  - an area that is open and not being dragged to collapse is at least 120px
- **Collapsing by dragging:** if a side or bottom area is dragged below half of its 120px minimum, it snaps shut. Dragging the border out again reopens it.
- When the window is resized, the stored sizes are clamped again. If the window is too narrow for both side areas and the 15% for the top, the right area collapses first, then the left.

### Collapsing

- The header has three toggle buttons, styled like VS Code's layout icons: left, bottom and right. Each one shows whether its area is open.
- A collapsed area takes up no space. It keeps its tabs and its last size, so reopening it restores the same width or height.
- The top area cannot collapse.

### Dragging tabs

- Tabs are `draggable` and use HTML5 drag and drop, which avoids building a custom ghost image.
- **Drop targets:**
  - **A tab row:** an insertion bar appears between tabs, and the tab is inserted at that position.
  - **An area's body:** the whole body is outlined, and the tab is added to the end of that area's tab row.
  - **A collapsed area's edge:** while a drag is in progress, a 24px drop strip appears along the edge of every collapsed area. Dropping there opens the area and puts the tab in it.
- A tab that is dropped becomes the active tab in its new area.
- **Emptying an area:**
  - If the left, right or bottom area loses its last tab, it collapses. The drag-time edge strip still accepts drops there.
  - The top area must always keep at least one tab. Dragging its last tab out is refused, and the tab snaps back.
- When a tab leaves an area, the area makes the tab next to it active.

### Persistence

- The layout is saved in `localStorage["layout.v1"]` as `{ areas: { top|left|bottom|right: { tabs: [...ids], active, size, collapsed } } }`.
- It is saved whenever it changes. During a resize drag, it is saved once when the drag ends.
- **On load**, the saved layout is checked before it is used:
  - unknown ids are dropped
  - a tab that is missing (for example, one added in a later release) goes to its default area
  - duplicates are removed
  - if `localStorage` throws or holds a broken value, the default layout is used
- `localStorage` persists in Electron, because the app runs with the same origin and session every time.
- **Reset layout:** a header button (`⟲`, titled "Reset layout") restores the default layout and clears the saved one.

### Reviews

When the number of pending reviews goes from N to more than N, the reviews tab's badge updates. If the reviews tab is not the active tab in its area, its label also gets a short pulse using the accent color. Focus is never taken away from the tab the user is working in.

### Setup in a narrow area

The Setup wizard (`.wiz`) is a 220px step list next to the step content. That doesn't fit a side area.

- Inside an area narrower than about 640px, the step list becomes a `<select>` above the step content. Its options show the step's tick or number and its title. This uses a container query on the area (`container-type: inline-size`).
- Wider than that, it keeps its current layout. This applies, for example, when Setup is dragged into the top area.
- **First launch / incomplete setup** (`:3371`, `openSetup(resume || "redirect")`): `revealTab("setup")` opens the right area. If the right area is under 480px wide, it is widened to 480px, within the limits above.
- **Finish** (`closeSetup`) no longer switches to Home. It reloads status and makes **AI Providers** the active tab in Setup's area.

### Google Drive folder moves into Setup

- The `driveSection` (`#driveBody`, rendered by `renderDrive`) leaves the Home column and becomes a new Setup step, **"Google Drive folder"**. It is placed after "Connect accounts", which makes it the last step. Like the platform steps, it can be skipped ("I don't use Google Drive").
- `renderDrive` renders into the step body while that step is shown. The status poll that currently refreshes `#driveBody` (`:1953`) keeps working: it refreshes the step if that step is on screen and does nothing otherwise.
- The step's HTML contains `<div id="driveBody">`, so `renderDrive` works unchanged. `loadDrive` (`:1949`) skips `renderDrive` when `#driveBody` isn't in the page, but it always updates the global `driveView`.
- The step's tick shows when a folder is set (`driveView?.folderId`). This is client-side only: `setupComplete` is a marker file on the server (`src/server.ts:180`), and the new step doesn't change it.
- The From Drive tab points to this step when no folder is set, using a link such as `data-setup="drive"`.

## Left to the builder

- The exact tab row look: height, font and active indicator. Follow the screenshot's VS Code feel, using the existing colors and font sizes.
- The exact header icons for the three toggles and Reset.
- Hover and drag highlight colors, from the existing color tokens.
- How the tab row scrolls when it has more tabs than fit.
- How to structure the layout code inside `index.html`: one `Layout` block of functions is fine.

## Calls made without the user, open to correction

- Both side areas run the full height of the workspace, and bottom spans only the middle, as in VS Code's default.
- Areas cannot split into sub-panes.
- An emptied side or bottom area collapses. The top area always keeps one tab.
- New reviews show a badge and a pulse, and don't take focus.
- A Reset layout button.
- On a narrow window, the right area collapses first, then the left.
- On first run or when setup is incomplete, the right area opens and is widened to at least 480px.
- The Drive folder becomes the last Setup step, and it can be skipped.
- Empty states replace the sections that used to hide themselves.
