# Claude films 48 h ahead, row ids, and remaking a changed row's videos

Date: 2026-11-22. Status: awaiting approval.

## Why

A Create row with a Lemo style has Claude (headless, on this computer) make its film. Today its task is only
created on the day it posts, so the film can start a few hours before its slot at best, and a slow or failed run
misses it. The user wants these films started well ahead of the post time. Since films then exist before
the post day, a changed row must not leave videos made from the old version: everything of that row's not yet
posted is thrown out and made again. To say which videos belong to which row, every row gets a visible id. "Kept"
videos (a Create row with no post time) are dropped as a concept: every row posts.

## Goals

1. **48-hour lead.** A Create row with a Lemo style (and so a Claude model) has its task created 48 hours before its
   post time, or at once when it's saved with less than 48 hours to go. Its script is written and its brief goes out
   straight after, as today; with the launcher setting on, FreePoster starts headless Claude for it.
2. **Row id column.** A new first column, read-only, shows each row's id as 7 hex digits (`0000001`, … `000000a`, …).
   Ids come from one counter across all campaigns, starting at `0000001`, and are never reused.
3. **Remake on change.** Saving a changed row retires every video of that row that hasn't started posting and makes
   it again from the row as it is now.
4. **Every row posts.** Save Changes is refused unless every row has a time and at least one day.

## Non-goals

- Other rows (Create with a FreePoster style, Drive, Agent) keep their current timing.
- No change to the brief itself, its 24-hour deadline, leases, offers or the launcher's one-at-a-time rule.
- Existing kept videos and the Drive path that posts a kept video by name are not removed.
- Retired tasks' files are not deleted from disk.

## Anti-goals

- A video made from an old version of a row reaching a platform after the row changed.
- A changed row's video being remade while it's already posting, or after it posted.
- Losing the link between existing videos and their rows during the id renumbering.
- A Claude run continuing to make a film whose task was retired.

## Approaches considered

For "deleted and remade":

1. **Retire and remake (chosen by the user).** The old task leaves every view and queue, its review is withdrawn,
   its held post cancelled, its production/edit stopped and a Claude run on it aborted. The record stays, in a new
   `replaced` state, with its slot freed (as `retireMissed` does: `copy = -id`), so materialize makes a fresh one.
   The campaign log and Autorun undo keep working, since nothing they point at vanishes.
2. **Delete outright.** Tidier, but the log and undo would point at missing tasks and both need rework. Rejected.

For the 48-hour lead there is one sensible way: materialize also looks up to two days ahead for these rows. A
separate scheduler for them would duplicate materialize's per-day logic (picks, slot keys, missed-slot handling) and
drift from it.

## Design

### 1. 48-hour lead (worker.ts `materialize`)

- Each tick, besides today, materialize looks at the next two local days. On those days it makes only instructions
  that are a scripted Lemo make (`kind: "make"`, `look` set, `scripted: true`) whose slot
  (`localAt(day, time)`) is within 48 hours of now. The task's `date` is the day it posts, as for any task.
- Today's rule is unchanged: a time already come today isn't made.
- Nothing else changes downstream: the task goes queued → scripting → its brief (`offerBrief`, scripted path, already
  "at once") → `awaiting_agent`, and the launcher picks it up when on. The brief's deadline stays now + 24 h, which
  leaves room for the second offer.
- The save route already calls `worker.materialize()` after saving, so a row saved within 48 hours of its slot gets
  its task at once.

### 2. Row ids

- `Row.id` stays a number internally (it already links tasks via `instruction_index = ROW_INSTRUCTION_BASE + id`).
  It is shown as `id.toString(16).padStart(7, "0")`.
- **Assignment is server-side.** A new row is sent with `id: null` (the UI and the Autorun agent both); `parseRows`
  accepts null for new rows, and the save assigns the next value of a global counter. An id sent that this campaign
  doesn't already have is refused (no inventing ids). The counter lives in the database (a pref or a one-row table),
  is advanced in the same transaction as the save, and is never decremented.
- **Migration (once, in the store's schema upgrade).** Every existing row across all campaigns, in campaign id order
  then table order, gets a new id from `1` upward. In the same transaction:
  - `campaign_tasks.instruction_index` for row tasks (`>= ROW_INSTRUCTION_BASE`) is rewritten to the new id, going
    through a temporary offset so the `UNIQUE (campaign_id, date, instruction_index, copy)` constraint never collides.
  - Compiled schedules are recompiled from the renumbered rows.
  - Rows stored in the Autorun change log (`before` / `after`) are renumbered with the same map, so undo restores
    rows whose ids still match their tasks.
  - The counter is set past the highest id.
- The Autorun tool description (mcp-tools.ts) is updated: keep a row's id when changing it, send `null` for a new
  row.

### 3. Every row posts (rows.ts `parseRows` + UI)

- `parseRows` refuses a row with `time === null` or no days, naming the row by its id. The rule applies to the
  Campaigns tab and Autorun alike.
- In the Campaigns tab, Save Changes is disabled while any row lacks a time or days, with a line saying which rows
  (by id) need one; the offending cells are marked.
- Rows already saved without a time load and display as before; they just can't be saved until fixed. `restore`
  (Autorun undo) writes rows as they were and isn't held to the new rule.
- With no time, a row can no longer make a kept video, so nothing new is kept.

### 4. Remake on change (new `remake.ts`, driven by the worker)

On every save of a table (Campaigns tab, Autorun change, Autorun undo), the rows before and after are compared by id:

| Change to a row | What happens to its open tasks |
|---|---|
| Only `time` changed | Moved, as today (`retimeRows`); not remade. |
| Any other field changed (hook, angle, CTA, style, model, type, sec, origin, text), with or without `time` | Every open task of the row is retired; materialize remakes them. |
| A day unticked | That weekday's open tasks are retired; not remade. |
| Quantity lowered | Open tasks with `copy >= quantity` are retired; not remade. |
| Row deleted | All its open tasks are retired; not remade. |
| Quantity raised / day ticked / new row | Nothing to retire; materialize makes the new ones. |

- **Open** means a state in which the video hasn't started going out: `queued`, `scripting`, `rendering`,
  `awaiting_agent`, `editing`, `reviewing`, and `scheduled` while its post is still held/unstarted. A scheduled post
  whose jobs have started, and anything `posted`, `kept`, `failed`, `missed` or already `replaced`, is left alone.
- **Retiring a task** (worker method, since it needs the reviews service, productions and launcher):
  1. If the launcher's running task is this one, `launcher.abort("its row was changed")`.
  2. Its lease and brief are dropped with it (the state change closes the brief: `openBriefs` only sees
     `awaiting_agent`).
  3. A production or edit under way is cancelled (as the existing cancel paths do).
  4. A pending review is withdrawn so it leaves the review queue.
  5. A held post is cancelled with `cancelHeld`.
  6. The task's state becomes `replaced`, its slot freed (`copy = -id`), and the log says why.
  Retiring is quiet: one summary event per save ("N videos of row 000000c are being remade"), not one failure
  notice per task.
- **Remaking.** After the save, the route already calls `materialize()`; it finds the freed slots and makes fresh
  tasks from the row as it is now (and, for Lemo rows within 48 h, on the days ahead too).
- `replaced` is a new task state: excluded from `ACTIVE`, from the Calendar, Upcoming and the campaign task list's
  counts, and from the daily cap. The task list may show it under a collapsed "replaced" filter.
- Where the comparison runs: today `setRows` and `restore` in the store call `retimeRows`. The new comparison needs
  the worker, so the save route, `applyAgentChange` and `undoChange` call a worker hook after the store write (passed
  in the same way `abortOnStop` is wired). The store keeps calling `retimeRows` for time-only changes.

## Left to the builder

- Exactly how a pending review is withdrawn and a production/edit cancelled: reuse the existing paths the worker
  uses for failures and redos.
- Where the counter is stored (pref vs table) and the migration's version marker.
- Copy wording in the UI and events.
- Test layout: follow the existing campaign worker tests (fake clock, in-memory store).

## Calls made (not asked of the user)

- The 48-hour lead applies only to rows that send Claude a brief (Create + Lemo style).
- A time-only change moves videos rather than remaking them.
- Unticking a day, lowering the quantity or deleting a row retires the extras without remaking them.
- Ids are global across campaigns; existing rows are renumbered once from `0000001`.
- The id column is read-only; new rows get their id from the server on save.
- Existing kept videos stay; nothing new is kept.
