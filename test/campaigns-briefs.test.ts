import "./isolated-home.ts";
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { REVIEW_BUFFER_MINUTES, LEASE_MINUTES, buildBrief, claimBrief, giveUpBrief, openBriefs, renewBrief, submitBrief, type Brief } from "../src/campaigns/briefs.ts";
import type { Look } from "../src/campaigns/looks.ts";
import { CampaignStore } from "../src/campaigns/store.ts";
import type { TaskChoices } from "../src/campaigns/worker.ts";
import { makeVideo, newStore, tmp } from "./helpers.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 19, 8, 0);
const look: Look = { key: "lemo:ukiyo-e", producer: "lemo-opuscar", name: "Ukiyo-e", description: "", needsImageGen: true, libraryVersion: "1", hidden: false };
const ch = (cs: CampaignStore, id: number) => cs.task(id)!.choices as unknown as TaskChoices;
const manifest = { look: "lemo:ukiyo-e", libraryVersion: "1" };

let portrait30: string, portrait10: string, wide30: string;
before(() => {
  const dir = tmp();
  const clip = (name: string, size: string, sec: number) =>
    makeVideo(dir, name, ["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=24`, "-t", String(sec), "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  portrait30 = clip("p30.mp4", "360x640", 30);
  portrait10 = clip("p10.mp4", "360x640", 10);
  wide30 = clip("w30.mp4", "640x360", 30);
});

function setup(opts: { sec?: number | null; postAt?: number | null } = {}) {
  const store = newStore();
  const cs = new CampaignStore(store);
  const campaignId = cs.create({ name: "Films", text: "x", accountSetId: null, defaultPostTimes: [] });
  const postAt = opts.postAt === undefined ? T0 + 10 * 3_600_000 : opts.postAt;
  const choices = {
    instruction: { kind: "make", count: 1, style: null, look: look.key, sec: opts.sec === undefined ? 30 : opts.sec, hook: { kind: "random" }, angle: { kind: "random" }, cta: { kind: "random" }, types: [], post: null, source: "" },
    campaignName: "Films", day: "Thu", style: null, types: [], postTime: null, accountSetId: null,
    hook: { id: 1, kind: "hook", name: "h", text: "Stop scrolling", keywords: [], url: null, createdAt: 0 },
  } as unknown as TaskChoices;
  const brief = buildBrief(store, choices, look, postAt, T0);
  const add = (n: number) => cs.addTask({ campaignId, date: "2026-11-19", dayIndex: 4, instructionIndex: n, kind: "make", choices: { ...choices, brief }, state: "awaiting_agent" })!;
  const id = add(1);
  return { store, cs, id, add, campaignId, brief };
}

test("buildBrief takes its deadline from the post time, or a day for a kept video", () => {
  const { brief, store } = setup();
  assert.equal(brief.deadline, T0 + 10 * 3_600_000 - REVIEW_BUFFER_MINUTES * MIN);
  assert.equal(brief.hook, "Stop scrolling");
  assert.equal(brief.language, "en");
  assert.equal(brief.needsImageGen, true);
  assert.equal(setup({ postAt: null }).brief.deadline, T0 + 24 * 3_600_000);
  store.setPref("agent.language", "fr");
  assert.equal(buildBrief(store, { hook: undefined } as unknown as TaskChoices, look, null, T0).language, "fr");
});

test("claim takes a lease; a second holder is refused until it expires", () => {
  const { cs, id } = setup();
  assert.deepEqual(openBriefs(cs, T0).map((t) => t.id), [id]);
  const a = claimBrief(cs, id, "A", T0);
  assert.ok(a.ok && a.leaseUntil === T0 + LEASE_MINUTES * MIN);
  assert.equal(openBriefs(cs, T0 + MIN).length, 0);
  const again = claimBrief(cs, id, "A", T0 + MIN);
  assert.ok(again.ok && again.leaseUntil === T0 + LEASE_MINUTES * MIN);
  assert.equal(ch(cs, id).offers, 1);
  const b = claimBrief(cs, id, "B", T0 + MIN);
  assert.ok(!b.ok && /claimed by A/.test(b.error));
  const later = claimBrief(cs, id, "B", T0 + 121 * MIN);
  assert.ok(later.ok);
  assert.equal(ch(cs, id).offers, 2);
  assert.equal(openBriefs(cs, T0 + 122 * MIN).length, 0);
  const third = claimBrief(cs, id, "C", T0 + 300 * MIN);
  assert.ok(!third.ok && /no offers left for task/.test(third.error));
});

test("renew never passes the deadline", () => {
  const { cs, id, brief } = setup({ postAt: T0 + 150 * MIN });
  claimBrief(cs, id, "A", T0);
  const r = renewBrief(cs, id, "A", T0 + 100 * MIN);
  assert.ok(r.ok && r.leaseUntil === brief.deadline);
  const other = renewBrief(cs, id, "B", T0 + 101 * MIN);
  assert.ok(!other.ok);
});

test("claim is refused when the campaign is stopped or the kill switch is on", () => {
  const { cs, id, campaignId, store } = setup();
  cs.setEnabled(campaignId, false);
  let r = claimBrief(cs, id, "A", T0);
  assert.ok(!r.ok && /campaign is stopped/.test(r.error));
  cs.setEnabled(campaignId, true);
  store.setPref("campaigns.killed", true);
  r = claimBrief(cs, id, "A", T0);
  assert.ok(!r.ok && /campaign is stopped/.test(r.error));
});

test("submit checks the file", async () => {
  const { cs, store, id } = setup();
  claimBrief(cs, id, "A", T0);
  const lease = ch(cs, id).lease;
  const refuse = async (videoPath: string, pattern: RegExp) => {
    const r = await submitBrief(store, cs, id, "A", { videoPath, manifest }, T0 + MIN);
    assert.ok(!r.ok && pattern.test(r.error), JSON.stringify(r));
    assert.deepEqual(ch(cs, id).lease, lease);
  };
  await refuse(wide30, /9:16/);
  await refuse(portrait10, /length/);
  await refuse(portrait30 + ".missing", /no file/);
  await refuse("relative.mp4", /absolute path/);
  const ok = await submitBrief(store, cs, id, "A", { videoPath: portrait30, manifest, caption: "c" }, T0 + MIN);
  assert.deepEqual(ok, { ok: true, repeat: false });
  const c = ch(cs, id);
  assert.equal(c.lease, undefined);
  assert.equal(c.delivery!.path, portrait30);
  assert.equal(c.delivery!.caption, "c");
  assert.ok(Math.abs(c.delivery!.durationSec - 30) < 1);
  assert.equal(cs.task(id)!.state, "awaiting_agent");
  assert.equal(openBriefs(cs, T0 + 500 * MIN).length, 0);
});

test("submit is idempotent for the same file and refuses it for another task", async () => {
  const { cs, store, id, add } = setup();
  const id2 = add(2);
  claimBrief(cs, id, "A", T0);
  claimBrief(cs, id2, "A", T0);
  assert.deepEqual(await submitBrief(store, cs, id, "A", { videoPath: portrait30, manifest }, T0 + MIN), { ok: true, repeat: false });
  assert.deepEqual(await submitBrief(store, cs, id, "A", { videoPath: portrait30, manifest }, T0 + 2 * MIN), { ok: true, repeat: true });
  const r = await submitBrief(store, cs, id2, "A", { videoPath: portrait30, manifest }, T0 + 3 * MIN);
  assert.ok(!r.ok && new RegExp(`already delivered for task ${id}`).test(r.error));
});

test("submit by a non-holder or after the deadline is refused", async () => {
  const { cs, store, id, brief } = setup();
  claimBrief(cs, id, "A", T0);
  let r = await submitBrief(store, cs, id, "B", { videoPath: portrait30, manifest }, T0 + MIN);
  assert.ok(!r.ok && /claimed by A|not the holder/.test(r.error));
  renewBrief(cs, id, "A", T0 + 100 * MIN);
  r = await submitBrief(store, cs, id, "A", { videoPath: portrait30, manifest }, brief.deadline + 1);
  assert.ok(!r.ok && /deadline/.test(r.error));
});

test("give up fails the task with the agent's reason", () => {
  const { cs, id } = setup();
  claimBrief(cs, id, "A", T0);
  assert.ok(!giveUpBrief(cs, id, "B", "no").ok);
  assert.deepEqual(giveUpBrief(cs, id, "A", "no image model"), { ok: true });
  const t = cs.task(id)!;
  assert.equal(t.state, "failed");
  assert.equal(t.error, "the agent gave up: no image model");
});

test("concurrent submits of one file: the same task repeats, another task is refused", async () => {
  const { cs, store, id, add } = setup();
  const id2 = add(2);
  claimBrief(cs, id, "A", T0);
  claimBrief(cs, id2, "A", T0);
  const [a, b] = await Promise.all([
    submitBrief(store, cs, id, "A", { videoPath: portrait30, manifest }, T0 + MIN),
    submitBrief(store, cs, id, "A", { videoPath: portrait30, manifest }, T0 + MIN),
  ]);
  assert.ok(a.ok && b.ok && a.repeat !== b.repeat, JSON.stringify([a, b]));
  const { cs: cs2, store: store2, id: i1, add: add2 } = setup();
  const i2 = add2(2);
  claimBrief(cs2, i1, "A", T0);
  claimBrief(cs2, i2, "A", T0);
  const rs = await Promise.all([i1, i2].map((i) => submitBrief(store2, cs2, i, "A", { videoPath: portrait30, manifest }, T0 + MIN)));
  assert.equal(rs.filter((r) => r.ok).length, 1, JSON.stringify(rs));
  assert.match(rs.find((r) => !r.ok)!.ok === false ? (rs.find((r) => !r.ok) as { error: string }).error : "", /already delivered for task/);
});

test("a give-up, stop or kill during the check stops the delivery", async () => {
  const s = setup();
  claimBrief(s.cs, s.id, "A", T0);
  const p = submitBrief(s.store, s.cs, s.id, "A", { videoPath: portrait30, manifest }, T0 + MIN);
  giveUpBrief(s.cs, s.id, "A", "changed my mind");
  const r = await p;
  assert.ok(!r.ok);
  assert.equal(ch(s.cs, s.id).delivery, undefined);
  const s2 = setup();
  claimBrief(s2.cs, s2.id, "A", T0);
  const p2 = submitBrief(s2.store, s2.cs, s2.id, "A", { videoPath: portrait30, manifest }, T0 + MIN);
  s2.cs.setEnabled(s2.campaignId, false);
  const r2 = await p2;
  assert.ok(!r2.ok && /campaign is stopped/.test(r2.error));
  assert.equal(ch(s2.cs, s2.id).delivery, undefined);
});

test("a holder submitting after its lease expired but before the deadline is refused", async () => {
  const { cs, store, id } = setup();
  claimBrief(cs, id, "A", T0);
  const r = await submitBrief(store, cs, id, "A", { videoPath: portrait30, manifest }, T0 + 121 * MIN);
  assert.ok(!r.ok && /lease/.test(r.error));
});
