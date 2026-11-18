import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AnalyticsStore } from "../src/analytics/store.ts";
import { CampaignStore } from "../src/campaigns/store.ts";
import { ctaFromTranscript, hookFromTranscript, labelOnPublish, labelRecorded, matchAngle, matchHook } from "../src/analytics/labels.ts";
import { OverBudget } from "../src/ai/budget.ts";
import type { Transcript } from "../src/edit/transcribe.ts";
import { DEFAULT_EDIT } from "../src/edit/settings.ts";
import { account, newStore, tmp } from "./helpers.ts";

/** A transcript from "word@start" pairs spaced 0.5s apart unless a time is given. */
function tr(text: string, step = 0.5): Transcript {
  return { language: "en", words: text.split(" ").map((w, i) => ({ text: w, start: i * step, end: i * step + step * 0.9 })) };
}

function fakeAi(answer: unknown | Error) {
  const calls: unknown[] = [];
  return { calls, ask: async (job: string, q: unknown) => { calls.push({ job, q }); if (answer instanceof Error) throw answer; return answer; } } as any;
}

test("hook text is the words spoken before 3 seconds", () => {
  assert.equal(hookFromTranscript(tr("one two three four five six seven eight")), "one two three four five six");
  assert.equal(hookFromTranscript({ words: [], language: null }), "");
});

test("a closing sentence is the CTA only when it has a URL, domain, or call to action", () => {
  assert.equal(ctaFromTranscript(tr("This is great. Go to freeposter.app")), "Go to freeposter.app");
  assert.equal(ctaFromTranscript(tr("This is great. Thanks for watching")), null);
  assert.equal(ctaFromTranscript(tr("Cool. Tap the link in my bio.")), "Tap the link in my bio.");
  assert.equal(ctaFromTranscript({ words: [], language: null }), null);
});

function entries() {
  const dir = tmp();
  const cs = new CampaignStore(newStore(dir));
  cs.addEntry({ kind: "angle", name: "Money", text: "save money", keywords: ["budget", "save"] });
  cs.addEntry({ kind: "angle", name: "Time", text: "save time", keywords: ["faster", "save"] });
  cs.addEntry({ kind: "hook", name: "h", text: "Stop scrolling, you need this!" });
  return { cs, angles: cs.entries("angle"), hooks: cs.entries("hook") };
}

test("matchAngle: whole-word keyword hits, most wins, tie is null", () => {
  const { angles } = entries();
  assert.equal(matchAngle("my Budget is tight", angles), angles[0].id);
  assert.equal(matchAngle("budgets are hard", angles), null);
  assert.equal(matchAngle("budget and faster", angles), null);
  assert.equal(matchAngle("budget and save and faster", angles), null);
  assert.equal(matchAngle("budget and save and more budget", angles), angles[0].id);
  assert.equal(matchAngle("save", angles), null);
});

test("matchHook: normalized Jaccard of at least 0.6", () => {
  const { hooks } = entries();
  assert.equal(matchHook("stop scrolling you NEED this", hooks), hooks[0].id);
  assert.equal(matchHook("something else entirely", hooks), null);
});

test("labelRecorded matches an angle by keyword without asking the AI", async () => {
  const { cs, angles } = entries();
  const ai = fakeAi({ angleId: null, description: "" });
  const l = await labelRecorded({ store: cs.store, ai }, 1, tr("here is my budget plan. go to freeposter.app"), "s1");
  assert.equal(ai.calls.length, 0);
  assert.equal(l.angleId, angles[0].id);
  assert.equal(l.source, "recorded");
  assert.equal(l.styleId, "s1");
  assert.equal(l.ctaText, "go to freeposter.app");
  assert.equal(l.labelledBy, "transcript");
});

test("labelRecorded asks the AI exactly once when no angle matches, and discards unknown ids", async () => {
  const { cs, angles } = entries();
  const ai = fakeAi({ angleId: angles[1].id, description: "about time" });
  const l = await labelRecorded({ store: cs.store, ai }, 1, tr("hello there my friends"), null);
  assert.equal(ai.calls.length, 1);
  assert.equal((ai.calls[0] as any).job, "label");
  assert.equal(l.angleId, angles[1].id);
  assert.equal(l.labelledBy, "ai");

  const bad = fakeAi({ angleId: 9999, description: "x" });
  const l2 = await labelRecorded({ store: cs.store, ai: bad }, 1, tr("hello there my friends"), null);
  assert.equal(bad.calls.length, 1);
  assert.equal(l2.angleId, null);
  assert.equal(l2.labelledBy, "transcript");
});

test("labelRecorded leaves the angle null when the AI fails or the budget is used up", async () => {
  const { cs } = entries();
  for (const err of [new Error("down"), new OverBudget()]) {
    const l = await labelRecorded({ store: cs.store, ai: fakeAi(err) }, 1, tr("hello there"), null);
    assert.equal(l.angleId, null);
  }
});

function publishedPost(store: ReturnType<typeof newStore>, extra: { words?: Transcript; style?: string } = {}) {
  const dir = tmp();
  const a = store.upsertAccount(account("youtube", { externalId: "y1", expiresAt: null }));
  const b = store.upsertAccount(account("tiktok", { externalId: "t1", expiresAt: null }));
  let editId: number | undefined;
  if (extra.words) {
    editId = store.createEdit("x.mp4", "abc", DEFAULT_EDIT).id;
    const path = join(dir, "abc.words.json");
    writeFileSync(path, JSON.stringify(extra.words));
    store.updateEdit(editId, { transcriptPath: path });
  }
  const postId = store.createPost({ caption: "", title: "", sourcePath: "x.mp4", sha256: "abc", tiktok: null, editId } as any, [a.id, b.id]);
  return { postId, jobs: store.jobsForPost(postId) };
}

test("labelOnPublish labels from the edit's transcript once, even for a second job of the post", async () => {
  const { cs } = entries();
  const store = cs.store;
  const { postId, jobs } = publishedPost(store, { words: tr("my budget plan. go to freeposter.app") });
  const ai = fakeAi({ angleId: null, description: "" });
  await Promise.all([labelOnPublish({ store, ai }, jobs[0].id), labelOnPublish({ store, ai }, jobs[1].id)]);
  const l = new AnalyticsStore(store).labels(postId)!;
  assert.equal(l.source, "recorded");
  assert.equal(l.ctaText, "go to freeposter.app");
  assert.equal(l.angleId, cs.entries("angle")[0].id);
});

test("labelOnPublish keeps existing labels and stores bare ones without a transcript", async () => {
  const store = newStore();
  const an = new AnalyticsStore(store);
  const first = publishedPost(store);
  an.setLabels({ postId: first.postId, source: "generated", styleId: null, hookId: null, hookText: "h", angleId: null, angleText: null, ctaId: null, ctaText: null, campaignId: null, campaignTaskId: null, types: [], labelledBy: "campaign" });
  await labelOnPublish({ store, ai: null }, first.jobs[0].id);
  assert.equal(an.labels(first.postId)!.source, "generated");

  const s2 = newStore();
  const second = publishedPost(s2);
  await labelOnPublish({ store: s2, ai: null }, second.jobs[0].id);
  const l = new AnalyticsStore(s2).labels(second.postId)!;
  assert.deepEqual([l.source, l.labelledBy, l.hookText, l.angleId, l.ctaText, l.styleId], ["recorded", "transcript", null, null, null, null]);
});

test("labelOnPublish never throws", async () => {
  const store = newStore();
  await labelOnPublish({ store, ai: null }, 12345);
});
