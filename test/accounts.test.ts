import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { accountSets, createAccountSet, defaultAccountIds, deleteAccountSet, noteSignInSet, placeInSet, takeSignInSet, defaultAccounts, noteConnected, noteRemoving, renameAccountSet, setDefaultAccounts, setSharing, sharedFrom, sharingPairs } from "../src/accounts.ts";
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

test("a new set starts empty; only an empty set that isn't the last can be deleted", () => {
  const { store, ig } = metaPair();
  const client = createAccountSet(store, "Client A");
  assert.deepEqual(client, { id: 2, name: "Client A", accountIds: [] });
  assert.equal(deleteAccountSet(store, 1), "remove the accounts in this set first");
  placeInSet(store, client.id, [ig.id]);
  assert.ok(!accountSets(store)[0].accountIds.includes(ig.id));
  assert.deepEqual(accountSets(store)[1].accountIds, [ig.id]);
  assert.equal(deleteAccountSet(store, client.id), "remove the accounts in this set first");
  placeInSet(store, 1, [ig.id]);
  assert.equal(deleteAccountSet(store, client.id), null);
  assert.equal(accountSets(store).length, 1);
  store.accounts().forEach((a) => store.deleteAccount(a.id));
  assert.equal(deleteAccountSet(store, 1), "there must be at least one account set");
});

test("a sign-in remembers the set it started from, once", () => {
  const store = newStore();
  const set = createAccountSet(store, "Client A");
  noteSignInSet(store, "s1", set.id);
  noteSignInSet(store, "s2", 99);
  assert.equal(takeSignInSet(store, "s2"), undefined, "an unknown set is not remembered");
  assert.equal(takeSignInSet(store, "s1"), set.id);
  assert.equal(takeSignInSet(store, "s1"), undefined);
});

test("/api/account-sets creates and deletes sets", async () => {
  const { store } = metaPair();
  const app = buildServer(store, new Runner(store, publishers, tmp()), publishers);
  assert.equal((await app.inject({ method: "POST", url: "/api/account-sets", payload: { name: "" } })).statusCode, 400);
  const created = (await app.inject({ method: "POST", url: "/api/account-sets", payload: { name: "Client A" } })).json();
  assert.equal(created.name, "Client A");
  assert.deepEqual((await app.inject("/api/status")).json().accountSets.map((s: any) => s.name), ["Personal Brand", "Client A"]);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/account-sets/1" })).statusCode, 400);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/account-sets/${created.id}` })).statusCode, 200);
  assert.equal((await app.inject("/api/status")).json().accountSets.length, 1);
  await app.close();
});

test("an account signed in from a set joins that set; a reconnected one stays where it was", async () => {
  const { writeFileSync } = await import("node:fs");
  const { envFile, reloadConfig } = await import("../src/config.ts");
  writeFileSync(envFile, "YOUTUBE_CLIENT_ID=yt-id\nYOUTUBE_CLIENT_SECRET=yt-secret\nREDIRECT_PAGE_URL=https://relay.example\n");
  reloadConfig();
  const store = newStore();
  const old = store.upsertAccount(account("youtube", { externalId: "old", name: "Old channel" }));
  const set = createAccountSet(store, "Client A");
  let returned = [account("youtube", { externalId: "new", name: "New channel" }), account("youtube", { externalId: "old", name: "Old channel" })];
  const fake = { ...publishers, youtube: { ...publishers.youtube, exchangeCode: async () => returned } };
  const app = buildServer(store, new Runner(store, fake, tmp()), fake);
  const signIn = async (url: string) => {
    const state = new URL((await app.inject(url)).headers.location as string).searchParams.get("state")!;
    await app.inject(`/callback?${new URLSearchParams({ state, code: "c" })}`);
  };
  await signIn(`/connect/youtube?set=${set.id}`);
  const fresh = store.accounts().find((a) => a.externalId === "new")!;
  assert.deepEqual(accountSets(store).map((s) => s.accountIds), [[old.id], [fresh.id]]);
  returned = [account("youtube", { externalId: "third" })];
  await signIn("/connect/youtube");
  const third = store.accounts().find((a) => a.externalId === "third")!;
  assert.deepEqual(accountSets(store).map((s) => s.accountIds), [[old.id, third.id], [fresh.id]], "no set: the first set");
  await app.close();
});
