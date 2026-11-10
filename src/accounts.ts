// Which accounts FreePoster posts to on its own (the accounts in an account set: the default set, or the one a Drive
// filename names), and Meta's automatic sharing between an Instagram account and its linked Facebook Page. Both are
// FreePoster's decisions: Drive only hands over files.
import type { Store } from "./db.ts";
import { STYLES, styleToken } from "./edit/styles.ts";
import type { Account, TikTokOptions } from "./types.ts";

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

/** The word a Drive filename uses for a set: its name without spaces ("Personal Brand" is PersonalBrand). */
export const setToken = (name: string) => name.replace(/\s+/g, "");

/**
 * Why a set can't have this name, or null when it can. Its filename word must not be empty, contain an
 * underscore (which separates a filename's parts), or match an editing style or another set, ignoring case.
 */
export function setNameProblem(store: Store, name: string, exceptId?: number): string | null {
  const token = setToken(name);
  if (!token) return "give the set a name";
  if (token.includes("_")) return "a set's name can't contain an underscore: underscores separate the parts of a Drive filename";
  const key = token.toLowerCase();
  const style = STYLES.find((s) => styleToken(s).toLowerCase() === key);
  if (style) return `"${token}" is the editing style ${style.name}; a filename couldn't tell them apart`;
  const other = accountSets(store).find((s) => s.id !== exceptId && setToken(s.name).toLowerCase() === key);
  if (other) return `"${token}" is already the set ${other.name}; a filename couldn't tell them apart`;
  return null;
}

/** Null when renamed, else why not. */
export function renameAccountSet(store: Store, id: number, name: string): string | null {
  const sets = accountSets(store);
  const set = sets.find((s) => s.id === id);
  if (!set) return "no such account set";
  const problem = setNameProblem(store, name, id);
  if (problem) return problem;
  set.name = name;
  store.setPref(SETS_PREF, sets);
  return null;
}

/** The new set, or why it couldn't be made. */
export function createAccountSet(store: Store, name: string): AccountSet | string {
  const problem = setNameProblem(store, name);
  if (problem) return problem;
  const sets = accountSets(store);
  const set = { id: Math.max(...sets.map((s) => s.id)) + 1, name, accountIds: [] };
  store.setPref(SETS_PREF, [...sets, set]);
  return set;
}

const DEFAULT_SET_PREF = "accounts.defaultSet";

/** The default set: the one chosen, else the oldest. Exactly one set is always the default. */
export function defaultSetId(store: Store): number {
  const sets = accountSets(store);
  // Defaults used to be chosen account by account; the set replaces that.
  if (store.pref("defaults.accounts") !== undefined) store.deletePref("defaults.accounts");
  const saved = store.pref<number>(DEFAULT_SET_PREF);
  if (sets.some((s) => s.id === saved)) return saved!;
  const oldest = Math.min(...sets.map((s) => s.id));
  store.setPref(DEFAULT_SET_PREF, oldest);
  return oldest;
}

/** False when there is no set with that id. */
export function setDefaultSet(store: Store, id: number): boolean {
  if (!accountSets(store).some((s) => s.id === id)) return false;
  store.setPref(DEFAULT_SET_PREF, id);
  return true;
}

/** Where a post to this set goes: its accounts, minus any Meta shares to. Empty when there's no such set. */
export function setAccounts(store: Store, setId: number): Account[] {
  const set = accountSets(store).find((s) => s.id === setId);
  return (set?.accountIds ?? [])
    .map((id) => store.account(id))
    .filter((a): a is Account => Boolean(a) && !sharedFrom(store, a!));
}

/** Where FreePoster posts on its own when nothing says otherwise: the default set's accounts. */
export function defaultAccounts(store: Store): Account[] {
  return setAccounts(store, defaultSetId(store));
}

/** Only an empty set, and never the last one. Null when it was deleted, else why not. */
export function deleteAccountSet(store: Store, id: number): string | null {
  const sets = accountSets(store);
  const set = sets.find((s) => s.id === id);
  if (!set) return "no such account set";
  if (set.accountIds.length) return "remove the accounts in this set first";
  if (sets.length === 1) return "there must be at least one account set";
  const wasDefault = defaultSetId(store) === id;
  store.setPref(SETS_PREF, sets.filter((s) => s.id !== id));
  // The oldest set left takes over as the default.
  if (wasDefault) store.deletePref(DEFAULT_SET_PREF);
  return null;
}

/** Moves the accounts into the set, out of whichever set they were in. */
export function placeInSet(store: Store, setId: number, accountIds: number[]) {
  const sets = accountSets(store);
  const target = sets.find((s) => s.id === setId);
  if (!target || !accountIds.length) return;
  for (const s of sets) s.accountIds = s.accountIds.filter((id) => !accountIds.includes(id));
  target.accountIds.push(...accountIds);
  store.setPref(SETS_PREF, sets);
}

const SIGN_IN_SETS_PREF = "accounts.signInSets";

/** Which set a sign-in was started from, keyed by its OAuth state, so the accounts it adds land there. */
export function noteSignInSet(store: Store, state: string, setId: number) {
  if (!accountSets(store).some((s) => s.id === setId)) return;
  store.setPref(SIGN_IN_SETS_PREF, { ...store.pref<Record<string, number>>(SIGN_IN_SETS_PREF), [state]: setId });
}

export function takeSignInSet(store: Store, state: string): number | undefined {
  const saved = { ...store.pref<Record<string, number>>(SIGN_IN_SETS_PREF) };
  const setId = saved[state];
  if (setId === undefined) return undefined;
  delete saved[state];
  store.setPref(SIGN_IN_SETS_PREF, saved);
  return setId;
}
