# Tab menus, curved tabs, and the Console tab

## Intent
Make the docked workspace's tabs easier to manage, and let the user watch what FreePoster is doing as it does it.
Four changes: a right-click menu on tabs (Delete Tab), a right-click menu on a tab row's empty space (Add Tab ▸ every
tab), curved tabs styled after `TabMockup.jpg`, and a read-only, searchable Console tab with this session's console output.

## Goals
- Right-click a tab: a menu with one item, **Delete Tab**.
- Right-click the empty space in a tab row: a menu with **Add Tab**, which has a side-pointing arrow (▸). Hovering it
  opens a second menu listing every tab.
- Tabs get curved tops. The selected tab is darker than the rest and has a blue outline, as in the mockup. The current
  font stays as it is (the mockup's font is ignored).
- A **Console** tab, first in the right panel by default. It shows this session's console output, about a second behind
  live, read-only, with a search box.

## Non-goals
- No console history from earlier sessions (`freeposter.log` isn't read).
- No other context-menu items, no renaming tabs, no multiple copies of one tab.

## Decided in conversation
- **Add Tab lists every tab (option B).** Picking a tab that's already open in another row moves it to this row, so
  "add" can mean "move". The new tab goes at the end of the row, becomes the row's active tab, and its area opens if it
  was collapsed.
- **The Console updates by polling (approach A).** While the Console tab is visible it calls
  `GET /api/console?after=<seq>` once a second and adds the lines that come back. When it's hidden it makes no requests.
- Console is first in the right panel by default: `right: ["console", "ai", "setup"]`.

## Approaches considered (console transport)
- **A. Poll every second (chosen).** Same request-and-response pattern as the rest of the app, nothing to keep connected,
  and new lines show up within a second.
- **B. Server-sent events.** Instant, but nothing in FreePoster streams yet. It would need streaming on the server plus
  reconnect handling.

## Design

### Layout model (`public/layout.js`)
- Add `console` to `TAB_IDS`, `TAB_LABELS` (`"Console"`) and `DEFAULT_TABS.right` (first).
- The layout gets a `closed: string[]` list. Today `normalizeLayout` puts every missing tab back into its default area.
  From now on a tab in `closed` stays out. A tab that's neither placed nor closed (a tab added in a new version, such
  as Console for existing users) is still put back, and goes at its default index in its default area (so Console
  goes first in the right panel even for saved layouts).
- `closeTab(layout, id)` removes the tab from its row, picks the next active tab the same way `moveTab` does,
  collapses a side area left empty, and adds the id to `closed`. It refuses (returns null) when the tab is top's
  last tab.
- `addTab(layout, id, area)` takes the id out of `closed` if it's there, then behaves like
  `moveTab(layout, id, area)` (end of the row, made active, area opened). Moving top's last tab out is refused, as now.
- `areaOf` returns null-safe results for closed tabs. `activateTab` on a closed tab reopens it in its default area.
- `defaultLayout()` has `closed: []`. Reset Layout therefore brings every tab back.

### Reopening a deleted tab from elsewhere
`revealTab(id)` (used by `data-open-tab` links, the review badge, Setup and so on) reopens a closed tab in its
default area before showing it. So nothing that links to a tab breaks when that tab has been deleted.

### Context menus (`public/index.html`)
- One small menu component: an absolutely positioned list, kept inside the window, that closes on click outside,
  Escape, scroll, blur or resize. It has `role="menu"` and `role="menuitem"`, and you can move through it with the
  arrow keys (→ opens the submenu, ← closes it).
- A `contextmenu` listener on the workspace, delegated because `applyLayout` rebuilds the strips:
  - On a `.tabstrip button[data-tab]`: the menu is **Delete Tab**. It's disabled when the tab is top's last tab.
  - On a `.tabstrip` but not on a button: the menu is **Add Tab ▸**. The submenu opens on hover or focus, to the
    right (or to the left if there's no room). It lists every tab by label, in `TAB_IDS` order. Tabs already in this
    row are shown disabled. A tab whose move would be refused (top's last tab) is disabled too.
- The browser's own context menu is suppressed only on those two targets.

### Tab styling
- `.tabstrip button` gets rounded top corners (about 10px radius, square bottom), a fill a little lighter than the
  strip's background, and small gaps between tabs, so they read as separate tabs as in the mockup.
- The selected tab gets a darker fill than the others and a 2px blue outline (`--accent`) on its top and sides. Its
  bottom edge stays open, so it joins the panel below. The current 2px top accent bar is replaced by this outline.
- Font family, size and weight stay as they are now.
- Dark mode follows the mockup (gray tabs, near-black selected tab). Light mode applies the same rule: gray tabs, with
  the selected tab a darker gray, the blue outline, and text in `--ink`.
- Badges, the drag-drop bar and the pulse animation keep working.

### Console capture (server)
- A new module `src/console-buffer.ts` wraps `console.log/info/warn/error` once at startup. It runs before
  `desktop.ts` swaps them, or chains whatever is installed, so the terminal and `freeposter.log` still get every line.
  Each call becomes one entry: `{ seq, at, level: "info" | "error", text }`, with the text formatted using
  `util.format`, the same way the log file does it. The buffer is a ring of the last 5,000 entries. `seq` keeps
  increasing.
- `GET /api/console?after=<seq>` returns `{ lines, latest, dropped }`. `lines` are the entries with `seq > after`
  (at most 5,000). `dropped` is true when `after` is older than the oldest entry still kept, meaning lines were
  missed. Only localhost can reach it, like the rest of the API.

### Console tab (UI)
- The panel has a search box at the top and a scrolling monospace log below it. The log is read-only: plain text
  nodes, no inputs, though you can still select and copy text.
- Each line shows a short local time (HH:MM:SS) and the text. Error-level lines are colored `--bad`.
- **Search** filters the view to the lines that contain the query (case-insensitive) and highlights the matches. It
  shows a count of matching lines. Clearing the search shows every line again. New lines that match keep appearing
  while you search.
- **Auto-scroll:** the log stays pinned to the bottom unless you've scrolled up. It shows a "Jump to latest" button
  while you're scrolled up.
- The page keeps at most 5,000 lines and drops the oldest. If the server says `dropped`, the log shows a
  "… earlier lines were dropped" marker.
- Polling starts in `onTabShown("console")` and stops when the tab is no longer visible. One request runs at a time,
  and a failed request is retried on the next tick.

## Tests
- `layout.js`: closing, closing top's last tab (refused), adding from closed, adding as a move, Console placed
  first for a saved layout that predates it, closed tabs surviving `normalizeLayout`, `revealTab` on a closed tab.
- The console buffer: capture, chaining to the previous console functions, the ring limit, `after` and `dropped`.
- The route: response shape and the `after` filter.

## Left to the builder
The exact colors and radius within the rules above, the menu's look (styled like the app's existing controls), and
how the Console search box is laid out.
