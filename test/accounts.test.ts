import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { accountSets, defaultAccountIds, defaultAccounts, noteConnected, noteRemoving, renameAccountSet, setDefaultAccounts, setSharing, sharedFrom, sharingPairs } from "../src/accounts.ts";
import { publishers } from "../src/platforms/index.ts";
import { checkDraft } from "../src/posts.ts";
import { Runner } from "../src/runner.ts";
import { buildServer } from "../src/server.ts";
import { account, newStore, sha256, tmp, verticalSilent } from "./helpers.ts";

/** An Instagram account linked to a connected Facebook Page. */
function metaPair(store = newStore()) {
  const page = store.upsertAccount(account("facebook", { externalId: "page-1", name: "My Page" }));
  const ig = store.upsertAccount(account("instagram", { externalId: "ig-1", name: "@me", meta: { username: "me", pageId: "page-1" } }));
  return { store, page, ig };
}

test("a sharing pair needs the Instagram account and its own Page, both connected", () => {
  const store = newStore();
  const ig = store.upsertAccount(account("instagram", { meta: { pageId: "page-1" } }));
  assert.deepEqual(sharingPairs(store), [], "no Page connected");
  store.upsertAccount(account("facebook", { externalId: "page-2", name: "Other Page" }));
  assert.deepEqual(sharingPairs(store), [], "a different Page");
  const page = store.upsertAccount(account("facebook", { externalId: "page-1", name: "My Page" }));
  assert.deepEqual(sharingPairs(store).map((p) => [p.instagram.id, p.facebook.id]), [[ig.id, page.id]]);
});

test("each direction skips the receiving account, and one direction replaces the other", () => {
  const { store, page, ig } = metaPair();
  setSharing(store, "page-1", "ig_to_fb");
  assert.equal(sharedFrom(store, page)?.id, ig.id);
  assert.equal(sharedFrom(store, ig), undefined);
  setSharing(store, "page-1", "fb_to_ig");
  assert.equal(sharedFrom(store, ig)?.id, page.id);
  assert.equal(sharedFrom(store, page), undefined);
  setSharing(store, "page-1", null);
  assert.equal(sharedFrom(store, ig), undefined);
});

test("the setting has no effect while one half of the pair isn't connected", () => {
  const { store, page, ig } = metaPair();
  setSharing(store, "page-1", "fb_to_ig");
  store.deleteAccount(page.id);
  assert.equal(sharedFrom(store, ig), undefined);
});

test("checkDraft refuses an account Meta shares to, naming the account to use", async () => {
  const { store, page, ig } = metaPair();
  const clip = verticalSilent(tmp(), 4);
  const draft = (ids: number[]) => ({ sourcePath: clip, sha256: sha256(clip), caption: "hi", title: "", accountIds: ids, tiktok: null, scheduledAt: null });
  setSharing(store, "page-1", "ig_to_fb");
  await assert.rejects(checkDraft(store, publishers, draft([page.id])), /Meta shares posts from @me to this account, so post to @me instead/);
  await checkDraft(store, publishers, draft([ig.id]));
  setSharing(store, "page-1", "fb_to_ig");
  await assert.rejects(checkDraft(store, publishers, draft([ig.id, page.id])), /post to My Page instead/);
});

test("default accounts start as the first account per platform, or Drive's old list", () => {
  const store = newStore();
  const x1 = store.upsertAccount(account("x", { externalId: "x-1" }));
  store.upsertAccount(account("x", { externalId: "x-2" }));
  const yt = store.upsertAccount(account("youtube"));
  assert.deepEqual(defaultAccountIds(store).sort(), [x1.id, yt.id].sort());

  const old = newStore();
  old.upsertAccount(account("x"));
  const tt = old.upsertAccount(account("tiktok"));
  old.setPref("drive.accounts", [tt.id]);
  assert.deepEqual(defaultAccountIds(old), [tt.id], "nothing changes on upgrade");
});

test("a platform's first connect joins the defaults; removing a default promotes the next-oldest", () => {
  const store = newStore();
  const x1 = store.upsertAccount(account("x", { externalId: "x-1" }));
  assert.deepEqual(defaultAccountIds(store), [x1.id]);
  const x2 = store.upsertAccount(account("x", { externalId: "x-2" }));
  noteConnected(store, "x", true);
  assert.deepEqual(defaultAccountIds(store), [x1.id], "a second account isn't added");
  const tt = store.upsertAccount(account("tiktok"));
  noteConnected(store, "tiktok", false);
  assert.deepEqual(defaultAccountIds(store), [x1.id, tt.id]);
  noteRemoving(store, store.account(x1.id)!);
  store.deleteAccount(x1.id);
  assert.deepEqual(defaultAccountIds(store).sort(), [x2.id, tt.id].sort());
  setDefaultAccounts(store, [x2.id]);
  noteRemoving(store, store.account(tt.id)!);
  assert.deepEqual(defaultAccountIds(store), [x2.id], "a non-default leaves the set alone");
});

test("defaults leave out an account Meta shares to and keep the head", () => {
  const { store, page, ig } = metaPair();
  setDefaultAccounts(store, [page.id, ig.id]);
  setSharing(store, "page-1", "ig_to_fb");
  assert.deepEqual(defaultAccounts(store).map((a) => a.id), [ig.id]);
});

test("the window and agents see defaults and sharing; /api/sharing only takes clear pairs", async () => {
  const { store, page, ig } = metaPair();
  const app = buildServer(store, new Runner(store, publishers, tmp()), publishers);
  const share = (body: unknown) => app.inject({ method: "PUT", url: "/api/sharing", payload: body as object });
  assert.equal((await share({ pageId: "nope", sharing: "ig_to_fb" })).statusCode, 400);
  assert.equal((await share({ pageId: "page-1", sharing: "both" })).statusCode, 400);
  assert.equal((await share({ pageId: "page-1", sharing: "ig_to_fb" })).statusCode, 200);
  const status = (await app.inject("/api/status")).json();
  assert.deepEqual(status.sharingPairs, [{ pageId: "page-1", instagramId: ig.id, facebookId: page.id, sharing: "ig_to_fb" }]);
  assert.equal(status.accounts.find((a: any) => a.id === page.id).sharedFrom, ig.id);

  const mcp = await app.inject({
    method: "POST", url: "/mcp", headers: { host: "localhost:4400" },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_accounts", arguments: {} } },
  });
  const listed = mcp.json().result.structuredContent.accounts;
  assert.equal(listed.find((a: any) => a.id === page.id).shared_from, ig.id);
  assert.equal(listed.find((a: any) => a.id === ig.id).default, true);
  await app.close();
});

test("connected accounts start in one Personal Brand set; new ones join it and removed ones leave", () => {
  const { store, page, ig } = metaPair();
  assert.deepEqual(accountSets(store), [{ id: 1, name: "Personal Brand", accountIds: store.accounts().map((a) => a.id) }]);
  assert.deepEqual([...accountSets(store)[0].accountIds].sort(), [page.id, ig.id].sort());
  const tiktok = store.upsertAccount(account("tiktok"));
  assert.ok(accountSets(store)[0].accountIds.includes(tiktok.id));
  store.deleteAccount(page.id);
  assert.ok(!accountSets(store)[0].accountIds.includes(page.id));
  assert.equal(renameAccountSet(store, 1, "Client A"), true);
  assert.equal(renameAccountSet(store, 99, "Nope"), false);
  assert.equal(accountSets(store)[0].name, "Client A");
});

test("/api/account-sets renames a set and refuses empty names and unknown sets", async () => {
  const { store } = metaPair();
  const app = buildServer(store, new Runner(store, publishers, tmp()), publishers);
  const rename = (id: number, body: unknown) => app.inject({ method: "PUT", url: `/api/account-sets/${id}`, payload: body as object });
  const status = async () => (await app.inject("/api/status")).json();
  assert.equal((await status()).accountSets[0].name, "Personal Brand");
  assert.equal((await rename(1, { name: "  " })).statusCode, 400);
  assert.equal((await rename(7, { name: "Other" })).statusCode, 404);
  assert.equal((await rename(1, { name: " My Brand " })).statusCode, 200);
  const sets = (await status()).accountSets;
  assert.equal(sets[0].name, "My Brand");
  assert.equal(sets[0].accountIds.length, 2);
  await app.close();
});
