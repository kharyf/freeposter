// Backtest: how well do the early (24h, 72h) overall scores predict the 30d score? Read-only, no network.
//   node scripts/backtest.ts
import { join } from "node:path";
import { dataDir } from "../src/config.ts";
import { loadKey } from "../src/crypto.ts";
import { Store } from "../src/db.ts";
import { AnalyticsStore } from "../src/analytics/store.ts";
import { scoreVideos, spearman, type ScoreAge } from "../src/analytics/score.ts";
import { PLATFORMS } from "../src/types.ts";

const store = new Store(join(dataDir, "freeposter.db"), loadKey(dataDir));
const analytics = new AnalyticsStore(store);
const jobs = analytics.scoredJobs();
const snapshotsByJob = new Map(jobs.map((j) => [j.id, analytics.snapshots(j.id)]));
const ages: ScoreAge[] = ["24h", "72h", "30d"];
const now = Date.now();

// One run of scoreVideos per platform, over that platform's jobs only, so each platform is scored against its own baselines.
const labels = analytics.allLabels();
for (const platform of PLATFORMS) {
  const mine = jobs.filter((j) => j.platform === platform);
  const postIds = new Set(mine.map((j) => j.postId));
  const scores = scoreVideos({ labels: labels.filter((l) => postIds.has(l.postId)), snapshotsByJob, jobs: mine, now, ages });
  for (const early of ["24h", "72h"] as const) {
    const pairs = scores.filter((s) => s.overall[early] !== undefined && s.overall["30d"] !== undefined);
    const rho = spearman(pairs.map((s) => s.overall[early]!), pairs.map((s) => s.overall["30d"]!));
    console.log(`${platform.padEnd(10)} ${early} vs 30d  n=${pairs.length}  rho=${Number.isNaN(rho) ? "n/a" : rho.toFixed(3)}`);
  }
}
