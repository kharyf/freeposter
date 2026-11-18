import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCampaignText } from "../src/campaigns/parse.ts";
import { parseCompiled, type MakeInstruction, type PostInstruction, type Vocabulary } from "../src/campaigns/spec.ts";
import { readTime } from "../src/drive/filename.ts";

const entry = (id: number, kind: "hook" | "angle" | "cta", name: string) => ({ id, kind, name, text: "t", keywords: [], url: null, createdAt: 0 });
const vocab: Vocabulary = {
  styles: [{ id: "basic", token: "Basic" }, { id: "fancy", token: "Fancy" }],
  types: [{ id: 1, name: "Clip" }, { id: 2, name: "Behind the Scenes" }],
  hooks: [entry(1, "hook", "Stop Scrolling"), entry(2, "hook", "Nobody Tells"), entry(3, "hook", "Rise and Grind")],
  angles: [entry(10, "angle", "Myth Bust")],
  ctas: [entry(20, "cta", "Free Guide")],
};

const EXAMPLE =
  "On Sunday make and post 3 Fancy videos with Stop Scrolling hook, Myth Bust angle, and Free Guide call to action. " +
  "On Monday post 'Gatekeeping_5.30.pm_Basic'. " +
  "On Tuesday make 2 Basic videos with Nobody Tells hook, Free Guide cta, and a random angle. " +
  "When analytics show that a hook on this campaign is working, create 3 variant videos that all use that hook.";

const parse = (text: string) => {
  const r = parseCampaignText(text, vocab);
  assert.ok(parseCompiled(r.compiled, vocab).ok, "the output always validates");
  return r;
};

test("the user's example compiles with no unread lines", () => {
  const { compiled, unread } = parse(EXAMPLE);
  assert.deepEqual(unread, []);
  assert.equal(compiled.days.sun[0].kind, "make");
  assert.deepEqual((compiled.days.tue[0] as MakeInstruction).angle, { pick: "random" });
  assert.deepEqual(compiled.days.mon[0], { kind: "post", name: "Gatekeeping", at: "17:30", style: "basic", types: [], source: "On Monday post 'Gatekeeping_5.30.pm_Basic'" });
  assert.deepEqual(compiled.days.sun, [{
    kind: "make", count: 3, style: "fancy", hook: { pick: "named", id: 1 }, angle: { pick: "named", id: 10 }, cta: { pick: "named", id: 20 },
    types: [], post: { at: "default" }, source: "On Sunday make and post 3 Fancy videos with Stop Scrolling hook, Myth Bust angle, and Free Guide call to action",
  }]);
  assert.deepEqual(compiled.days.tue[0], {
    kind: "make", count: 2, style: "basic", hook: { pick: "named", id: 2 }, angle: { pick: "random" }, cta: { pick: "named", id: 20 },
    types: [], post: null, source: "On Tuesday make 2 Basic videos with Nobody Tells hook, Free Guide cta, and a random angle",
  });
  assert.equal(compiled.rules.length, 1);
  assert.deepEqual(compiled.rules[0].then, { kind: "make", count: 3, keep: ["hook"], vary: ["angle", "cta"], post: true });
});

test("sentences split on newlines and '. ', but not inside quotes or times", () => {
  const { compiled, unread } = parse("On Monday post 'Big. Idea_5.30.pm'\nOn Friday post Gatekeeping_5.30.pm. On Saturday post Late_9pm_Fancy");
  assert.deepEqual(unread, []);
  assert.equal((compiled.days.mon[0] as PostInstruction).name, "Big. Idea");
  assert.equal((compiled.days.fri[0] as PostInstruction).at, "17:30");
  assert.equal((compiled.days.fri[0] as PostInstruction).style, null);
  assert.deepEqual({ at: (compiled.days.sat[0] as PostInstruction).at, style: (compiled.days.sat[0] as PostInstruction).style }, { at: "21:00", style: "fancy" });
});

test("curly quotes, en-dashes and 'Sun.' are normalized, not sent to AI", () => {
  const text = [
    "Sun. – make 2 Fancy videos with “Stop Scrolling” hook, Myth Bust angle and Free Guide cta.",
    "sunday — post ‘Gatekeeping_5.30.pm_Basic’.",
    "Sundays make   one Basic video with the best hook...",
    "On Wed. post ‘Morning_9.15.am’",
  ].join("\n");
  const { compiled, unread } = parse(text);
  assert.deepEqual(unread, []);
  assert.equal(compiled.days.sun.length, 3);
  const [a, b, c] = compiled.days.sun as [MakeInstruction, PostInstruction, MakeInstruction];
  assert.deepEqual([a.count, a.hook, a.angle, a.cta], [2, { pick: "named", id: 1 }, { pick: "named", id: 10 }, { pick: "named", id: 20 }]);
  assert.equal(a.source, 'Sun. - make 2 Fancy videos with "Stop Scrolling" hook, Myth Bust angle and Free Guide cta');
  assert.deepEqual([b.name, b.at, b.style], ["Gatekeeping", "17:30", "basic"]);
  assert.deepEqual([c.count, c.style, c.hook, c.angle, c.cta], [1, "basic", { pick: "best" }, { pick: "random" }, { pick: "random" }]);
  assert.equal((compiled.days.wed[0] as PostInstruction).at, "09:15");
});

test("make without post has post: null; make and post defaults; a post time sets it", () => {
  const { compiled, unread } = parse([
    "On Thursday make 2 Basic videos with Free Guide cta",
    "On Friday make and post 2 Basic videos with Free Guide cta",
    "On Saturday make and post 2 Basic videos at 6pm with Free Guide cta",
    "On Sunday make 1 Basic video with Free Guide cta, post at 18:00",
  ].join("\n"));
  assert.deepEqual(unread, []);
  assert.equal((compiled.days.thu[0] as MakeInstruction).post, null);
  assert.deepEqual((compiled.days.fri[0] as MakeInstruction).post, { at: "default" });
  assert.deepEqual((compiled.days.sat[0] as MakeInstruction).post, { at: "18:00" });
  assert.deepEqual((compiled.days.sun[0] as MakeInstruction).post, { at: "18:00" });
});

test("names with 'and' in them, any clause order, types, and word counts", () => {
  const { compiled, unread } = parse(
    "On Tuesday make three Fancy videos with Free Guide cta, a random angle, Rise and Grind hook, types Clip and Behind the Scenes\n" +
    "On Monday post 'Gatekeeping_Basic' type clip",
  );
  assert.deepEqual(unread, []);
  const m = compiled.days.tue[0] as MakeInstruction;
  assert.deepEqual([m.count, m.hook, m.types], [3, { pick: "named", id: 3 }, [1, 2]]);
  assert.deepEqual([(compiled.days.mon[0] as PostInstruction).at, (compiled.days.mon[0] as PostInstruction).types], [null, [1]]);
});

test("the analytics rule sentence compiles to a rule with the 25%/72h/3 defaults", () => {
  const { compiled, unread } = parse(EXAMPLE);
  assert.deepEqual(unread, []);
  assert.deepEqual(compiled.rules[0], {
    when: { label: "hook", is: "working", thresholdPct: 25, minVideos: 3, age: "72h", scope: "campaign" },
    then: { kind: "make", count: 3, keep: ["hook"], vary: ["angle", "cta"], post: true },
    source: "When analytics show that a hook on this campaign is working, create 3 variant videos that all use that hook",
  });
});

test("rule modifiers override the defaults; not working and stop using it", () => {
  const { compiled, unread } = parse(
    "On Monday make 1 Basic video with Free Guide cta\n" +
    "When analytics show that an angle on this campaign is working (top 10% at 24 hours after 5 videos), make 2 variant videos that all use that angle\n" +
    "When analytics show a cta on this campaign is not working, stop using it",
  );
  assert.deepEqual(unread, []);
  assert.deepEqual(compiled.rules[0].when, { label: "angle", is: "working", thresholdPct: 10, minVideos: 5, age: "24h", scope: "campaign" });
  assert.deepEqual(compiled.rules[0].then, { kind: "make", count: 2, keep: ["angle"], vary: ["hook", "cta"], post: true });
  assert.deepEqual(compiled.rules[1], {
    when: { label: "cta", is: "not_working", thresholdPct: 25, minVideos: 3, age: "72h", scope: "campaign" },
    then: { kind: "stop_using" },
    source: "When analytics show a cta on this campaign is not working, stop using it",
  });
});

test("an unknown style name leaves the line unread", () => {
  const { compiled, unread } = parse("On Sunday make 3 Glitter videos with Stop Scrolling hook");
  assert.deepEqual(unread, [{ line: "On Sunday make 3 Glitter videos with Stop Scrolling hook", day: "sun" }]);
  assert.deepEqual(compiled.days.sun, []);
});

test("unknown library names, other shapes and out-of-range counts are unread, never guessed", () => {
  const { compiled, unread } = parse([
    "On Monday make 2 Basic videos with Stop Scroling hook",
    "On Tuesday make 25 Basic videos",
    "Post something nice on Friday",
    "Be authentic",
    "On Wednesday post 'Name_tomorrow'",
    "When analytics show that a hook on this campaign is working, create 2 variant videos that all use that angle",
  ].join("\n"));
  assert.deepEqual(unread.map((u) => u.day), ["mon", "tue", "fri", null, "wed", null]);
  assert.deepEqual(compiled.days.mon, []);
  assert.deepEqual(compiled.rules, []);
});

test("a make rule with no named CTA anywhere is moved to unread by the self-check", () => {
  const rule = "When analytics show that a hook on this campaign is working, create 3 variant videos that all use that hook";
  const { compiled, unread } = parse(`On Sunday make 2 Basic videos\n${rule}`);
  assert.deepEqual(unread, [{ line: rule, day: null }]);
  assert.equal(compiled.days.sun.length, 1);
  assert.deepEqual(compiled.rules, []);
});

test("readTime reads 12-hour filename times", () => {
  assert.deepEqual(readTime("5.30.pm"), { h: 17, m: 30 });
  assert.deepEqual(readTime("12am"), { h: 0, m: 0 });
  assert.deepEqual(readTime("9:05 AM"), { h: 9, m: 5 });
  assert.equal(readTime("13pm"), null);
  assert.equal(readTime("5.30"), null);
});
