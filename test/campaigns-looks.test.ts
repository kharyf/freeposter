import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { allLooks, lookByKey, syncLooks } from "../src/campaigns/looks.ts";
import { newStore } from "./helpers.ts";

const look = (key: string, over: Record<string, unknown> = {}) => ({
  key, name: key, description: "d", needsImageGen: false, libraryVersion: "1", ...over,
});

test("sync adds, updates and hides", () => {
  const store = newStore();
  assert.deepEqual(syncLooks(store, "lemo-opuscar", [look("lemo:a"), look("lemo:b")]), { added: 2, updated: 0, hidden: 0 });
  assert.deepEqual(syncLooks(store, "lemo-opuscar", [look("lemo:b", { name: "B2" })]), { added: 0, updated: 1, hidden: 1 });
  assert.deepEqual(allLooks(store).map((l) => l.key), ["lemo:b"]);
  assert.equal(allLooks(store)[0].name, "B2");
  assert.equal(lookByKey(store, "lemo:a")?.hidden, true);
  assert.equal(allLooks(store, { includeHidden: true }).length, 2);
});

test("refuses a bad key or another producer's namespace", () => {
  const store = newStore();
  assert.throws(() => syncLooks(store, "lemo-opuscar", [look("Ukiyo e")]), /look key/);
  assert.throws(() => syncLooks(store, "lemo-opuscar", [look("wan:foo")]), /namespace/);
  assert.equal(allLooks(store, { includeHidden: true }).length, 0);
});
