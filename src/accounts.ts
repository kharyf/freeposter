// Which accounts FreePoster posts to on its own (default accounts), and Meta's automatic sharing between an
// Instagram account and its linked Facebook Page. Both are FreePoster's decisions: Drive only hands over files.
import type { Store } from "./db.ts";
import type { Account, Platform, TikTokOptions } from "./types.ts";

/** "ig_to_fb": Meta shares the Instagram account's posts to its Page; "fb_to_ig": the reverse. */
export type Sharing = "ig_to_fb" | "fb_to_ig";

/** One Instagram account and the one Facebook Page it is linked to, both connected. */
export interface SharingPair {
  pageId: string;
  instagram: Account;
  facebook: Account;
  sharing: Sharing | null;
}

const SHARING_PREF = "meta.sharing";
const DEFAULTS_PREF = "defaults.accounts";
const TIKTOK_PREF = "defaults.tiktok";

/** Only clear pairs: an Instagram account whose Page is connected, and no other Instagram account on that Page. */
export function sharingPairs(store: Store): SharingPair[] {
  const accounts = store.accounts();
  const saved = store.pref<Record<string, Sharing>>(SHARING_PREF) ?? {};
  return accounts.flatMap((instagram) => {
    const pageId = instagram.platform === "instagram" ? String(instagram.meta.pageId ?? "") : "";
    if (!pageId) return [];
    const pages = accounts.filter((a) => a.platform === "facebook" && a.externalId === pageId);
    const others = accounts.filter((a) => a.platform === "instagram" && String(a.meta.pageId ?? "") === pageId);
    if (pages.length !== 1 || others.length !== 1) return [];
    return [{ pageId, instagram, facebook: pages[0], sharing: saved[pageId] ?? null }];
  });
}

/** Keyed by Page id, which stays the same when the accounts are reconnected. Null clears it. */
export function setSharing(store: Store, pageId: string, sharing: Sharing | null) {
  const saved = { ...store.pref<Record<string, Sharing>>(SHARING_PREF) };
  if (sharing) saved[pageId] = sharing;
  else delete saved[pageId];
  store.setPref(SHARING_PREF, saved);
}

/** The account Meta shares this account's posts from, when FreePoster must not post to it itself. */
export function sharedFrom(store: Store, account: Account): Account | undefined {
  const pair = sharingPairs(store).find((p) => p.instagram.id === account.id || p.facebook.id === account.id);
  if (pair?.sharing === "ig_to_fb" && pair.facebook.id === account.id) return pair.instagram;
  if (pair?.sharing === "fb_to_ig" && pair.instagram.id === account.id) return pair.facebook;
  return undefined;
}

/** The first account connected on each platform. */
function firstPerPlatform(store: Store): number[] {
  const first = new Map<Platform, number>();
  for (const a of store.accounts()) if (!first.has(a.platform) || a.id < first.get(a.platform)!) first.set(a.platform, a.id);
  return [...first.values()];
}

/** The default account ids as chosen; the first time, Drive's old account list or the first account per platform. */
export function defaultAccountIds(store: Store): number[] {
  let ids = store.pref<number[]>(DEFAULTS_PREF);
  if (!ids) {
    ids = store.pref<number[]>("drive.accounts") ?? firstPerPlatform(store);
    store.setPref(DEFAULTS_PREF, ids);
  }
  return ids.filter((id) => store.account(id));
}

export function setDefaultAccounts(store: Store, ids: number[]) {
  store.setPref(DEFAULTS_PREF, [...new Set(ids)]);
}

/** Where FreePoster posts on its own: the default accounts, minus any Meta shares to. */
export function defaultAccounts(store: Store): Account[] {
  return defaultAccountIds(store)
    .map((id) => store.account(id))
    .filter((a): a is Account => Boolean(a) && !sharedFrom(store, a!));
}

/** After a sign-in: the first account on a platform that had none becomes a default. */
export function noteConnected(store: Store, platform: Platform, hadAccounts: boolean) {
  const ids = defaultAccountIds(store); // seeds the set on first use
  if (hadAccounts) return;
  const first = store.accounts().filter((a) => a.platform === platform).sort((a, b) => a.id - b.id)[0];
  if (first && !ids.includes(first.id)) setDefaultAccounts(store, [...ids, first.id]);
}

/** Before an account is removed: the next-oldest account on its platform takes its place as a default. */
export function noteRemoving(store: Store, account: Account) {
  const ids = defaultAccountIds(store);
  if (!ids.includes(account.id)) return;
  const rest = ids.filter((id) => id !== account.id);
  const samePlatform = store.accounts().filter((a) => a.platform === account.platform && a.id !== account.id).sort((a, b) => a.id - b.id);
  const next = samePlatform.find((a) => !rest.includes(a.id));
  if (next && !samePlatform.some((a) => rest.includes(a.id))) rest.push(next.id);
  setDefaultAccounts(store, rest);
}

/** TikTok options for posts FreePoster makes on its own. Privacy is not among them: they go out as "Only me". */
export interface DefaultTikTokPrefs {
  allowComment?: boolean;
  allowDuet?: boolean;
  allowStitch?: boolean;
}

export function defaultTikTokPrefs(store: Store): DefaultTikTokPrefs {
  return store.pref<DefaultTikTokPrefs>(TIKTOK_PREF) ?? store.pref<DefaultTikTokPrefs>("drive.tiktok") ?? {};
}

export function setDefaultTikTokPrefs(store: Store, t: DefaultTikTokPrefs) {
  store.setPref(TIKTOK_PREF, t);
}

export function defaultTikTok(store: Store): TikTokOptions {
  const t = defaultTikTokPrefs(store);
  return {
    privacyLevel: "SELF_ONLY",
    disableComment: t.allowComment === false,
    disableDuet: t.allowDuet === false,
    disableStitch: t.allowStitch === false,
    brandContent: false,
    brandOrganic: false,
  };
}

/** A named group of connected accounts, shown together under Accounts. Every account is in exactly one set. */
export interface AccountSet {
  id: number;
  name: string;
  accountIds: number[];
}

const SETS_PREF = "accounts.sets";
const FIRST_SET_NAME = "Personal Brand";

/** The sets as saved; the first time, one "Personal Brand" set. Accounts in no set (just connected) join the first. */
export function accountSets(store: Store): AccountSet[] {
  const saved = store.pref<AccountSet[]>(SETS_PREF);
  const sets = saved?.length ? saved.map((s) => ({ ...s, accountIds: [...s.accountIds] })) : [{ id: 1, name: FIRST_SET_NAME, accountIds: [] }];
  const ids = store.accounts().map((a) => a.id);
  for (const s of sets) s.accountIds = s.accountIds.filter((id) => ids.includes(id));
  const placed = new Set(sets.flatMap((s) => s.accountIds));
  sets[0].accountIds.push(...ids.filter((id) => !placed.has(id)));
  if (JSON.stringify(sets) !== JSON.stringify(saved)) store.setPref(SETS_PREF, sets);
  return sets;
}

/** False when there is no set with that id. */
export function renameAccountSet(store: Store, id: number, name: string): boolean {
  const sets = accountSets(store);
  const set = sets.find((s) => s.id === id);
  if (!set) return false;
  set.name = name;
  store.setPref(SETS_PREF, sets);
  return true;
}
