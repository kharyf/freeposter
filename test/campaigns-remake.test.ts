import assert from "node:assert/strict";
import { test } from "node:test";
import { planRetirements } from "../src/campaigns/remake.ts";
import type { Row } from "../src/campaigns/rows.ts";

const r = (over: Partial<Row> = {}): Row => ({
  id: 1, quantity: 1, hook: { pick: "random" }, angle: { pick: "random" }, cta: { pick: "random" }, style: "basic",
  model: null, videoModel: null, type: null, time: "09:00", days: ["tue"], sec: 9, origin: "create", text: "", ...over,
});

test("a time-only change retires nothing", () => assert.deepEqual(planRetirements([r({ time: "09:00" })], [r({ time: "11:00" })]), []));
test("a changed hook retires and remakes the whole row, with or without a time change", () => {
  assert.deepEqual(planRetirements([r()], [r({ hook: { pick: "best" }, time: "11:00" })]), [{ rowId: 1, days: "all", fromCopy: 0, remake: true }]);
  assert.deepEqual(planRetirements([r()], [r({ text: "new" })]), [{ rowId: 1, days: "all", fromCopy: 0, remake: true }]);
});
test("picks compare by value, not identity", () => assert.deepEqual(planRetirements([r({ cta: { pick: "named", id: 4 } })], [r({ cta: { pick: "named", id: 4 } })]), []));
test("unticking a day retires that day only", () => assert.deepEqual(planRetirements([r({ days: ["mon", "tue"] })], [r({ days: ["mon"] })]), [{ rowId: 1, days: ["tue"], fromCopy: 0, remake: false }]));
test("lowering the quantity retires the extra copies", () => assert.deepEqual(planRetirements([r({ quantity: 3 })], [r({ quantity: 1 })]), [{ rowId: 1, days: "all", fromCopy: 1, remake: false }]));
test("days removed and quantity lowered give both, days first", () => {
  assert.deepEqual(planRetirements([r({ days: ["mon", "tue"], quantity: 3 })], [r({ days: ["mon"], quantity: 2 })]), [
    { rowId: 1, days: ["tue"], fromCopy: 0, remake: false },
    { rowId: 1, days: "all", fromCopy: 2, remake: false },
  ]);
});
test("a deleted row retires everything", () => assert.deepEqual(planRetirements([r()], []), [{ rowId: 1, days: "all", fromCopy: 0, remake: false }]));
test("days added, quantity raised and a new row retire nothing", () => {
  assert.deepEqual(planRetirements([r()], [r({ days: ["tue", "wed"], quantity: 4 }), r({ id: 2 })]), []);
});
test("output follows the order of before", () => {
  assert.deepEqual(planRetirements([r({ id: 5 }), r({ id: 2 })], [r({ id: 2, text: "x" })]).map((x) => x.rowId), [5, 2]);
});
