import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { keepRunning } from "../src/app.ts";
import { DEFAULT_EDIT } from "../src/edit/settings.ts";
import { newStore } from "./helpers.ts";

test("nothing to do lets FreePoster close", () => {
  assert.equal(keepRunning(newStore()), false);
});

test("a watched folder keeps FreePoster running, even when Drive needs reconnecting", () => {
  const store = newStore();
  store.saveDriveTokens({ accessToken: "a", refreshToken: "r", expiresAt: null }, "me@example.com");
  store.setDriveFolder("1gz2qTGVjYyDM9vTB8Ik0DmaBWyMAISry");
  assert.equal(keepRunning(store), true);
  store.setDriveError("reconnect");
  assert.equal(keepRunning(store), true);
});

test("an edit or a Drive file part-way through keeps FreePoster running", () => {
  const store = newStore();
  store.createEdit("C:/x.mp4", "abc", DEFAULT_EDIT);
  assert.equal(keepRunning(store), true);
  const other = newStore();
  other.upsertDriveFile("f", { name: "F_11.2.26_9.00.am.mp4", state: "processing" });
  assert.equal(keepRunning(other), true);
});
