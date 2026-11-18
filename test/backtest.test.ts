import "./isolated-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { spearman } from "../src/analytics/score.ts";
import { percentDiff } from "../scripts/reconcile.ts";

test("spearman is 1 for the same order and -1 for the reverse", () => {
  assert.equal(spearman([1, 2, 3], [1, 2, 3]), 1);
  assert.equal(spearman([1, 2, 3], [3, 2, 1]), -1);
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 35, 900]), 1);
});

test("spearman gives tied values their average rank", () => {
  // ranks a: 1, 2.5, 2.5, 4; b: 1, 2, 3, 4 -> Pearson of the ranks
  const r = spearman([1, 2, 2, 3], [1, 2, 3, 4]);
  assert.ok(Math.abs(r - 0.9486832980505138) < 1e-12, String(r));
});

test("spearman is NaN for fewer than 2 points or a constant series", () => {
  assert.ok(Number.isNaN(spearman([], [])));
  assert.ok(Number.isNaN(spearman([1], [2])));
  assert.ok(Number.isNaN(spearman([5, 5, 5], [1, 2, 3])));
  assert.ok(Number.isNaN(spearman([1, 2, 3], [4, 4, 4])));
});

test("percentDiff is relative to the tab's value and flags over 5%", () => {
  assert.deepEqual(percentDiff(100, 104), { pct: 4, flagged: false });
  assert.deepEqual(percentDiff(100, 106), { pct: 6, flagged: true });
  assert.deepEqual(percentDiff(100, 94), { pct: -6, flagged: true });
  assert.deepEqual(percentDiff(0, 0), { pct: 0, flagged: false });
  assert.equal(percentDiff(0, 5).flagged, true);
});
