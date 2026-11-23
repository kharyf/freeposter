# Claude 48 h Lead, Row Ids and Remaking Changed Rows — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create + Lemo rows start their Claude film 48 h before the post time; every row gets a visible global 7-hex id; saving a changed row retires and remakes its unposted videos; every row must have a time and a day.

**Architecture:** Row ids stay numbers internally (they already link tasks via `instruction_index = ROW_INSTRUCTION_BASE + id`), assigned by `CampaignStore.setRows` from a global counter and renumbered once by a store migration. `materialize` looks two days ahead for scripted Lemo instructions. A pure planner (`remake.ts`) diffs rows before/after a save; the worker retires the affected open tasks (new `replaced` state, slot freed with `copy = -id`), and the existing `materialize()` after a save remakes them.

**Tech Stack:** TypeScript on Node (run directly, `node --test`), node:sqlite via `Store`, Fastify routes, vanilla JS in `public/`.

**Spec:** `docs/superpowers/specs/2026-11-22-claude-lead-and-row-ids-design.md`

## Global Constraints

- Lead time: `CLAUDE_LEAD_HOURS = 48`, applies only to instructions with `kind: "make"`, `look` set, `scripted: true` (Create + Lemo style).
- Id display: `id.toString(16).padStart(7, "0")`; first id ever is `0000001`; ids are global across campaigns and never reused.
- Every saved row (Campaigns tab and Autorun) needs `time !== null` and `days.length >= 1`. `restore` (undo) is not held to it.
- Only a time change moves videos (`retimeRows`, unchanged); any other field change retires and remakes; unticked day / lowered quantity / deleted row retires without remaking.
- Open (retirable) states: `queued`, `scripting`, `rendering`, `awaiting_agent`, `editing`, `reviewing`, and `scheduled` only while its post's jobs are all still held. Never touch `posted`, `kept`, `failed`, `missed`, `replaced`.
- Retired tasks stay in the DB with state `replaced`, `copy = -id`; files on disk aren't deleted.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `docs/superpowers` is gitignored: `git add -f` docs there.
- Tests: `npm test` (all) or `node --import ./test/isolated-home.ts --test test/<file>.test.ts`; types: `npm run typecheck`.

## Review Focus

1. **A row changed while Claude is filming it** — the launcher run is aborted and a late `submit_brief` on the retired task is refused (task isn't `awaiting_agent`). Test in Task 5.
2. **Two saves in quick succession** — the second save retires the tasks the first save's remake just made; never two live tasks in one slot. Test in Task 5.
3. **An approved post already uploading when its row changes** — left alone, not retired. Test in Task 5.
4. **The 48 h boundary** — a slot 47 h away is made now, one 49 h away isn't, and is made once it comes within 48 h. Test in Task 3.
5. **Migration run by several `CampaignStore` instances / app restarts** — ids are renumbered exactly once and tasks keep their rows. Test in Task 1.

---

### Task 1: Global row ids (counter, assignment, one-time renumbering)

**Files:**
- Modify: `src/campaigns/rows.ts` (add `rowIdHex`, `ROW_ID_PREF`, `ROW_IDS_MIGRATED_PREF`)
- Modify: `src/campaigns/store.ts` (`setRows`, constructor migration `migrateRowIds`)
- Test: `test/campaigns-store.test.ts`

**Interfaces:**
- Produces: `rowIdHex(id: number): string` — `"0000001"` for 1, `"new"` for `id <= 0`.
- Produces: `CampaignStore.setRows(id, rows)` now gives every row with `id <= 0` a fresh id from the counter (mutating a copy, never the caller's array) and keeps the counter (`pref "campaigns.rowId.next"`) above every positive id it saves. Returns `Row[]` as saved.
- Produces: `CampaignStore.nextRowId(): number` (reads and advances the counter; used only by `setRows`).

- [ ] **Step 1: Write the failing tests**

```ts
test("setRows gives new rows (id <= 0) global ids from 1, never reused across campaigns", () => {
  const { cs } = setup(); // existing helper in this file, or newStore() + new CampaignStore
  const a = cs.create({ name: "A", text: "", accountSetId: null, defaultPostTimes: [], dailyPostCap: 3 });
  const b = cs.create({ name: "B", text: "", accountSetId: null, defaultPostTimes: [], dailyPostCap: 3 });
  assert.deepEqual(cs.setRows(a, [row({ id: -1 }), row({ id: -2 })]).map((r) => r.id), [1, 2]);
  assert.deepEqual(cs.setRows(b, [row({ id: -1 })]).map((r) => r.id), [3]);
  cs.setRows(a, [row({ id: 1 })]); // row 2 deleted
  assert.deepEqual(cs.setRows(a, [row({ id: 1 }), row({ id: -1 })]).map((r) => r.id), [1, 4]);
  assert.equal(rowIdHex(4), "0000004");
  assert.equal(rowIdHex(26), "000001a");
  assert.equal(rowIdHex(-1), "new");
});

test("migrateRowIds renumbers every campaign's rows once, keeping tasks and the change log on their rows", () => {
  // Seed with raw SQL: two campaigns whose rows both use ids 1 and 2, a task for campaign B row 2
  // (instruction_index 100002, choices.instruction.row = 2), and a campaign_changes entry for B
  // whose before/after rows use ids 1 and 2. ROW_IDS_MIGRATED_PREF unset.
  const cs = new CampaignStore(store);
  assert.deepEqual(cs.campaign(A)!.rows.map((r) => r.id), [1, 2]);
  assert.deepEqual(cs.campaign(B)!.rows.map((r) => r.id), [3, 4]);
  assert.equal(cs.task(taskB2)!.instructionIndex, ROW_INSTRUCTION_BASE + 4);
  assert.equal((cs.task(taskB2)!.choices as any).instruction.row, 4);
  assert.deepEqual((cs.change(changeB)!.after as any).rows.map((r: any) => r.id), [3, 4]);
  assert.ok(JSON.stringify(cs.change(changeB)!.after.compiled).includes('"row":4'));
  new CampaignStore(store); // a second instance: no second renumbering
  assert.deepEqual(cs.campaign(B)!.rows.map((r) => r.id), [3, 4]);
  assert.equal(store.pref<number>("campaigns.rowId.next"), 5);
});
```

- [ ] **Step 2: Run and confirm both fail** — `node --import ./test/isolated-home.ts --test test/campaigns-store.test.ts` → FAIL (`rowIdHex` not exported / ids unchanged).

- [ ] **Step 3: Implement**
  - `rows.ts`: `export const ROW_ID_PREF = "campaigns.rowId.next"`, `export const ROW_IDS_MIGRATED_PREF = "campaigns.rowIds.v1"`, `rowIdHex`.
  - `store.ts` `setRows(id, rows): Row[]`: copy rows; for each `id <= 0` assign `nextRowId()`; set the counter to `max(counter, max positive id + 1)`; then save as today (compile, `retimeRows`), then call `this.onRowsChanged?.(id, before, saved)` (hook declared in Task 5; add the optional field now: `onRowsChanged?: (campaignId: number, before: Row[], after: Row[]) => void`). Call the hook from `restore` too.
  - `migrateRowIds()` in the constructor after `migrateLooks()`, skipped when `ROW_IDS_MIGRATED_PREF` is true. In one transaction: walk campaigns by id, rows in table order, map old→new from 1; rewrite rows + `compileRows(newRows)`; rewrite `campaign_tasks.instruction_index` for `>= ROW_INSTRUCTION_BASE` in two passes (first `+ 10_000_000` offset, then to `BASE + newId`) so the UNIQUE constraint never collides, and `choices.instruction.row`; rewrite each `campaign_changes` `before`/`after` `rows` with that campaign's map and recompute their `compiled` with `compileRows`. A change-log row id with no map entry (row deleted before migration) gets a fresh counter id. Set the counter past the highest id, set the pref, commit. Write directly with SQL (not `setRows`) so no hooks fire.

- [ ] **Step 4: Run** the store tests and `npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `feat(campaigns): global row ids from one counter, renumbered once`.

---

### Task 2: Saving rules — time and day required, new-row ids, known ids

**Files:**
- Modify: `src/campaigns/rows.ts` (`parseRows`)
- Modify: `src/campaigns/routes.ts:119-127` (PUT rows passes known ids)
- Modify: `src/campaigns/autorun.ts` (`applyAgentChange` passes known ids; uses `setRows`' returned rows for the log)
- Modify: `src/campaigns/mcp-tools.ts:86` (update_campaign description)
- Test: `test/campaigns-rows.test.ts`, `test/campaigns-routes.test.ts`, `test/campaigns-autorun.test.ts`

**Interfaces:**
- Consumes: `setRows(...) : Row[]` (Task 1).
- Produces: `parseRows(raw: unknown, vocab: Vocabulary, known?: Set<number>)` — `id` may be a positive integer, or `null` / a negative integer for a new row (a null becomes a negative id no other row of that table uses, so `setRows` assigns it; duplicate ids are refused as today). With `known`, a positive id not in it is a problem: `` `${at}: id ${id} isn't a row of this campaign; send null for a new row` ``.
- Produces problems (exact copy, `<hex>` = `rowIdHex(id)`, or `row <n>` for a new row): `` `row ${hex}: needs a post time` `` and `` `row ${hex}: needs at least one day` ``.

- [ ] **Step 1: Write the failing tests**

```ts
test("parseRows refuses a row with no time or no days, naming it by its id", () => {
  const r = parseRows([raw({ id: 12, time: null }), raw({ id: 13, days: [] })], vocab);
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, ["row 000000c: needs a post time", "row 000000d: needs at least one day"]);
});
test("parseRows takes null or negative ids as new rows and refuses unknown positive ids", () => {
  const ok = parseRows([raw({ id: null }), raw({ id: -5 }), raw({ id: 3 })], vocab, new Set([3]));
  assert.ok(ok.ok); assert.deepEqual(ok.value.map((r) => r.id), [-1, -5, 3]);
  const bad = parseRows([raw({ id: 9 })], vocab, new Set([3]));
  assert.match(bad.problems[0], /id 9 isn't a row of this campaign; send null for a new row/);
});
// campaigns-routes.test.ts
test("PUT rows assigns ids to new rows and returns them", async () => { /* send id:null; response rows[0].id === counter value; a second PUT with that id keeps it */ });
test("PUT rows refuses a row without a time", async () => { /* 400, problems include "needs a post time" */ });
// campaigns-autorun.test.ts
test("an Autorun change can add a row with id null and can't invent an id", async () => { /* ... */ });
```

- [ ] **Step 2: Run** those three files → FAIL.

- [ ] **Step 3: Implement** the `parseRows` changes; in the route `parseRows(body.rows, vocab, new Set(c.rows.map((r) => r.id)))`; same in `applyAgentChange` with `c.rows`. Update the update_campaign tool text: "id (keep a row's id when changing it; send null for a new row, and FreePoster gives it one — the Campaigns tab shows ids as 7 hex digits)", "time (24-hour \"HH:MM\", required)", "days (at least one)", and drop "or null: a Create video made and kept, not posted". Update existing tests that save `time: null` rows through `parseRows`/routes/Autorun: give them a time (they described kept videos, which can no longer be saved); worker tests that call `cs.setRows` directly may keep `time: null`.

- [ ] **Step 4: Run** `npm test` and `npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `feat(campaigns): every row needs a time and a day; new rows get their id on save`.

---

### Task 3: 48-hour lead for Create + Lemo rows

**Files:**
- Modify: `src/campaigns/briefs.ts` (add `CLAUDE_LEAD_HOURS = 48`, fix the `BRIEF_LEAD_HOURS` comment)
- Modify: `src/campaigns/worker.ts:253-330` (`materialize`, `materializeCampaign`), header comment lines 2-5, `offerBrief` doc comment
- Test: `test/campaigns-worker.test.ts`

**Interfaces:**
- Produces: `materialize(date?)` also makes, on the next two local days, only scripted Lemo make instructions whose slot is `> now` and `<= now + CLAUDE_LEAD_HOURS h`. Task `date` is the posting day.
- `materializeCampaign(c, key, dayIndex, best, now, only?: (ins) => boolean)` — the extra filter; the existing past-time check stays, plus, when `only` is given, `localAt(key, hhmm) - now > CLAUDE_LEAD_HOURS * HOUR` skips.

- [ ] **Step 1: Write the failing tests** (use `LOOK`/`syncLooks` and `tableRow` as the existing Lemo Create tests do: `style: "lemo:ukiyo-e", model: "claude:claude-opus-5-5"`)

```ts
test("a Create + Lemo row's task is made 48 hours ahead, not before", () => {
  const s = setup(); syncLooks(s.store, "lemo-opuscar", [LOOK]);
  s.clock.now = at(2026, 11, 17, 10); // Tue 10:00
  const id = tableCampaign(s, [
    tableRow(s, { id: 1, style: "lemo:ukiyo-e", model: "claude:claude-opus-5-5", days: ["thu"], time: "09:00" }), // 47 h
    tableRow(s, { id: 2, style: "lemo:ukiyo-e", model: "claude:claude-opus-5-5", days: ["thu"], time: "11:00" }), // 49 h
    tableRow(s, { id: 3, days: ["thu"], time: "09:00" }), // FreePoster style: made on the day
  ]);
  s.worker.materialize();
  assert.deepEqual(s.cs.tasksOn(id, "2026-11-19").map((t) => t.instructionIndex), [ROW_INSTRUCTION_BASE + 1]);
  s.clock.now = at(2026, 11, 17, 11, 1);
  s.worker.materialize();
  assert.deepEqual(s.cs.tasksOn(id, "2026-11-19").map((t) => t.instructionIndex).sort(), [ROW_INSTRUCTION_BASE + 1, ROW_INSTRUCTION_BASE + 2]);
  assert.equal(s.worker.materialize(), 0, "made once");
});
test("an early Lemo task is scripted and its brief goes out at once", async () => {
  /* same row 47 h out; await s.tick() twice; task state "awaiting_agent", brief.postAt === Thu 09:00 */
});
```

- [ ] **Step 2: Run** the worker tests → FAIL (no task on 2026-11-19).

- [ ] **Step 3: Implement** — in `materialize`, after today's loop, for `n` in `1, 2`: `key = addDays(dayKey(now), n)`, weekday from that key (use the same local-date helpers the file already has), call `materializeCampaign` with `only = (ins) => ins.kind === "make" && !!ins.look && ins.scripted === true`. Keep the per-campaign try/catch.

- [ ] **Step 4: Run** `npm test` → PASS.

- [ ] **Step 5: Commit** — `feat(campaigns): Create rows with a Lemo style start their Claude film 48 hours ahead`.

---

### Task 4: The remake planner (pure)

**Files:**
- Create: `src/campaigns/remake.ts`
- Test: `test/campaigns-remake.test.ts`

**Interfaces:**
- Produces:
```ts
export interface Retirement { rowId: number; days: Day[] | "all"; fromCopy: number; remake: boolean; }
export function planRetirements(before: Row[], after: Row[]): Retirement[];
```
  Rows are matched by id. Rules, in order per row:
  - Row gone from `after` → `{ days: "all", fromCopy: 0, remake: false }`.
  - Any field other than `time`, `days`, `quantity` differs (compare with a canonical JSON of `hook, angle, cta, style, model, type, sec, origin, text`) → `{ days: "all", fromCopy: 0, remake: true }`.
  - Otherwise: days removed → `{ days: removed, fromCopy: 0, remake: false }`; quantity lowered → `{ days: "all", fromCopy: after.quantity, remake: false }` (both may appear).
  - Time-only, days added, quantity raised, new row → nothing.

- [ ] **Step 1: Write the failing tests** — one per rule above, e.g.

```ts
test("a time-only change retires nothing", () => assert.deepEqual(planRetirements([r({ time: "09:00" })], [r({ time: "11:00" })]), []));
test("a changed hook retires and remakes the whole row, with or without a time change", () => {
  assert.deepEqual(planRetirements([r()], [r({ hook: { pick: "best" }, time: "11:00" })]), [{ rowId: 1, days: "all", fromCopy: 0, remake: true }]);
});
test("unticking a day retires that day only", () => assert.deepEqual(planRetirements([r({ days: ["mon", "tue"] })], [r({ days: ["mon"] })]), [{ rowId: 1, days: ["tue"], fromCopy: 0, remake: false }]));
test("lowering the quantity retires the extra copies", () => assert.deepEqual(planRetirements([r({ quantity: 3 })], [r({ quantity: 1 })]), [{ rowId: 1, days: "all", fromCopy: 1, remake: false }]));
test("a deleted row retires everything", () => assert.deepEqual(planRetirements([r()], []), [{ rowId: 1, days: "all", fromCopy: 0, remake: false }]));
```

- [ ] **Step 2: Run** → FAIL (module missing). **Step 3: Implement.** **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** — `feat(campaigns): plan which of a changed row's videos to retire`.

---

### Task 5: Retiring tasks in the worker, and the launcher

**Files:**
- Modify: `src/campaigns/store.ts` (`TaskState` adds `"replaced"`; `retireTask(id): boolean` sets `state = 'replaced', copy = -id` when `copy >= 0`)
- Modify: `src/campaigns/worker.ts` (`Productions.cancel?`, `onRetire`, `retireChangedRows`, constructor wires `this.campaigns.onRowsChanged`)
- Modify: `src/campaigns/launcher.ts` (`abortOnRetire`)
- Modify: `src/app.ts:122` (wire `campaigns.onRetire = abortOnRetire(launcher)`)
- Modify: `src/campaigns/routes.ts:18` and every other list of finished task states (grep `"missed"` in `src/` and `public/`) so `replaced` is finished and hidden from Calendar, Upcoming, task counts and the daily cap
- Test: `test/campaigns-worker.test.ts`, `test/campaigns-launcher.test.ts`

**Interfaces:**
- Consumes: `planRetirements` (Task 4), `CampaignStore.onRowsChanged` (Task 1).
- Produces: `Productions.cancel?: (id: number) => boolean` (app passes the production worker, which has it).
- Produces: `CampaignWorker.onRetire: (taskId: number) => void = () => {}`.
- Produces: `CampaignWorker.retireChangedRows(campaignId: number, before: Row[], after: Row[]): number` (count retired).
- Produces: `abortOnRetire(launcher: AgentLauncher): (taskId: number) => void` — aborts with reason `"its row was changed"` when `runningFor()?.taskId === taskId`.

Retiring one task (private `retire(t)`), in this order: `onRetire(t.id)` (try/catch, as `tellStopped`); if `productionId` and the production isn't finished, `productions.cancel?.(id)`; if `editId` and the edit is open, `store.closeEdit(editId, "superseded")`; if `reviewId` and the review is pending, `reviews.reviews.close(reviewId, "superseded")` then `reviews.reviews.markDirty(reviewId)`; if `postId`, `cancelHeld(postId)`; then `campaigns.retireTask(t.id)` and `log(t, "replaced: its row was changed")`. A `scheduled` task whose post has any job without `progress.heldFrom` (already released/started) is skipped before any of this. After all retirements of a save: one event, `queueEvent(store, "campaign.remade", \`campaign.remade:${campaignId}:${now}\`, { campaign_id, rows: [hex ids], retired: n }, \`Campaign "${name}": ${n} videos of row(s) ${hexes} are being made again from the changed row\`)` — only when `n > 0`, and the text says "were removed" instead of "are being made again" when no retirement has `remake: true`. If the event types are listed in `src/api/guides.ts` (events topic), add `campaign.remade` there.

- [ ] **Step 1: Write the failing tests**

```ts
test("changing a row's hook retires its reviewing video and the next materialize remakes it", async () => {
  /* make a task reach "reviewing"; save the row with a new hook via s.cs.setRows; assert old task state "replaced",
     copy < 0, its review state "superseded"; s.worker.materialize() === 1; the new task's choices.hook is the new pick */
});
test("a time-only change still moves the video and doesn't retire it", async () => { /* state unchanged, postTime updated */ });
test("an approved post that has started uploading is left alone", async () => { /* scheduled task whose job lost heldFrom; change hook; state stays "scheduled" */ });
test("two saves in a row never leave two live tasks in one slot", async () => {
  /* save change A, materialize, save change B, materialize; live (non-replaced) tasks for the row/day/copy === 1 */
});
test("retiring an awaiting_agent task aborts the launcher run and a late submit_brief is refused", async () => {
  /* worker.onRetire = spy; change the row; spy called with the task id; submitBrief(...) → ok:false, /no open brief/ */
});
test("lowering the quantity retires copy 1 and nothing is remade for it", () => { /* ... */ });
// campaigns-launcher.test.ts
test("abortOnRetire stops the run only for its own task", () => { /* as the abortOnStop test */ });
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** as above. `retireChangedRows` takes the open tasks per retirement with SQL on `campaign_id`, `instruction_index = ROW_INSTRUCTION_BASE + rowId`, `state IN (open states)`, `copy >= fromCopy`, filtered to `days` by each task's `dayIndex` (`DAYS[dayIndex]`). The worker's constructor sets `this.campaigns.onRowsChanged = (id, b, a) => { try { this.retireChangedRows(id, b, a); } catch (err) { console.error(...); } }`. `ACTIVE` already excludes `replaced`. Add `cancel: (id) => ps.cancel(id)` to the worker test's stand-in `productions`.

- [ ] **Step 4: Run** `npm test`, `npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `feat(campaigns): a changed row's unposted videos are replaced and made again`.

---

### Task 6: Campaigns tab — id column, new rows, Save blocked

**Files:**
- Modify: `public/campaign-rows.js` (add `hexId`, `saveProblems`, export them on `FreePosterRows`)
- Modify: `public/index.html` (table header and cells ~3540-3730, Save Changes ~3544 and ~3600, new row ~3724, task state labels ~3113-3115)
- Test: `test/campaign-rows.test.ts`

**Interfaces:**
- Produces: `FreePosterRows.hexId(id) → "0000001" | "new"` (same as `rowIdHex`).
- Produces: `FreePosterRows.saveProblems(rows) → string[]` — the same texts and order as the server's (Task 2): `row 000000c: needs a post time`, `row 000000c: needs at least one day`; for an unsaved row (`id <= 0`) the name is `row <n>` with its 1-based position, as the server writes it.

- [ ] **Step 1: Write the failing tests**

```ts
test("hexId shows 7 hex digits, and 'new' for an unsaved row", () => {
  assert.equal(R.hexId(1), "0000001"); assert.equal(R.hexId(171), "00000ab"); assert.equal(R.hexId(-2), "new");
});
test("saveProblems names each row missing a time or a day, as the server does", () => {
  const rows = [row({ id: 12, time: null }), row({ id: 13, days: [] }), row({ id: 14 })];
  assert.deepEqual(j(R.saveProblems(rows)), ["row 000000c: needs a post time", "row 000000d: needs at least one day"]);
  // and the server agrees:
  assert.deepEqual(parseRows(rows, vocab).problems, j(R.saveProblems(rows)));
});
```

- [ ] **Step 2: Run** `node --import ./test/isolated-home.ts --test test/campaign-rows.test.ts` → FAIL.

- [ ] **Step 3: Implement**
  - `campaign-rows.js`: the two functions.
  - `index.html`: a first, read-only "ID" column showing `hexId(r.id)` (monospace, muted); a new row gets `id: Math.min(0, ...rows.map((r) => r.id)) - 1` instead of `max + 1`; the time cell no longer offers an empty "keep it" value; Save Changes is disabled while `saveProblems(rows)` is non-empty, with a `cp-note err` line listing them and the offending cells marked (reuse the table's existing invalid-cell styling); add `replaced: "replaced (its row changed)"` to the state labels and leave it out of the visible filters' counts. After a save the window takes the server's rows (with their new ids) as it already does.

- [ ] **Step 4: Run** `npm test` → PASS; then launch the app (`npm start`), add a row, check the id shows `new` then a hex id after saving, and that Save is disabled with a row lacking a time.

- [ ] **Step 5: Commit** — `feat(ui): row id column; Save Changes needs a time and a day on every row`.
