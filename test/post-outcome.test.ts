import assert from "node:assert/strict";
import { test } from "node:test";
import { postOutcome } from "../src/calendar.ts";

const o = (...states: string[]) => postOutcome(states.map((state) => ({ state })) as any);

test("a post's outcome is judged against the accounts it was sent to", () => {
  assert.equal(o(), null);
  assert.equal(o("queued", "queued"), "scheduled");
  assert.equal(o("retry", "queued"), "scheduled");
  assert.equal(o("running", "queued"), "posting");
  assert.equal(o("published", "retry"), "posting", "not settled until every account is finished");
  assert.equal(o("published", "published"), "posted");
  assert.equal(o("published", "failed"), "partial");
  assert.equal(o("failed", "failed"), "failed");
});
