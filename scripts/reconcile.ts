// Reconciliation: for the N most recent videos with a 7d reading, the tab's 7d views beside a fresh metrics() read.
// Read-only: only metrics() reads (plus the runner's usual token refresh); nothing is written to snapshots or jobs.
//   node scripts/reconcile.ts --n 10
import { join } from "node:path";
import { parseArgs } from "node:util";
import { dataDir } from "../src/config.ts";
import { loadKey } from "../src/crypto.ts";
import { Store } from "../src/db.ts";
import { Runner } from "../src/runner.ts";
import { publishers } from "../src/platforms/index.ts";
import { AuthError } from "../src/http.ts";
import type { Account } from "../src/types.ts";
import type { MetricsContext } from "../src/platforms/base.ts";
import { AnalyticsStore } from "../src/analytics/store.ts";
import { valueAtAge } from "../src/analytics/score.ts";
import { AGES } from "../src/analytics/types.ts";

export const FLAG_PERCENT = 5;

/** The fresh read's difference from the tab's value, in percent of the tab's value; flagged when over 5% either way. */
export function percentDiff(tab: number, fresh: number): { pct: number; flagged: boolean } {
  if (tab === 0) return { pct: fresh === 0 ? 0 : Infinity, flagged: fresh !== 0 };
  const pct = ((fresh - tab) * 100) / tab;
  return { pct, flagged: Math.abs(pct) > FLAG_PERCENT };
}

async function main() {
  const { values } = parseArgs({ options: { n: { type: "string", default: "10" } } });
  const n = Math.max(1, Number(values.n) || 10);
  const store = new Store(join(dataDir, "freeposter.db"), loadKey(dataDir));
  const analytics = new AnalyticsStore(store);
  const runner = new Runner(store, publishers);

  const rows = analytics
    .scoredJobs()
    .sort((a, b) => b.publishedAt! - a.publishedAt! || b.id - a.id)
    .flatMap((job) => {
      const pts = analytics.snapshots(job.id).filter((s) => s.reading.views !== null).map((s) => ({ ageSec: s.ageSec, value: s.reading.views as number }));
      const v = valueAtAge(pts, AGES["7d"]);
      return v === null ? [] : [{ job, tab: Math.round(Math.expm1(v)) }];
    })
    .slice(0, n);

  console.log("job  platform   tab 7d views  fresh views  diff");
  for (const { job, tab } of rows) {
    const publisher = publishers[job.platform];
    try {
      if (!publisher.metrics) throw new Error("no metrics for this platform");
      const ctx = (account: Account): MetricsContext => ({ account, job, progress: job.progress, publishedAt: job.publishedAt! });
      let reading;
      try {
        reading = await publisher.metrics(ctx(await runner.freshAccount(store.account(job.accountId)!)));
      } catch (err) {
        if (!(err instanceof AuthError)) throw err;
        reading = await publisher.metrics(ctx(await runner.freshAccount(store.account(job.accountId)!, true)));
      }
      if (reading.views === null) throw new Error("no views reported");
      const { pct, flagged } = percentDiff(tab, reading.views);
      console.log(`${String(job.id).padEnd(4)} ${job.platform.padEnd(10)} ${String(tab).padStart(12)}  ${String(reading.views).padStart(11)}  ${pct.toFixed(1)}%${flagged ? "  FLAG" : ""}`);
    } catch (err) {
      console.log(`${String(job.id).padEnd(4)} ${job.platform.padEnd(10)} ${String(tab).padStart(12)}  error: ${(err as Error).message}`);
    }
  }
}

if (import.meta.main) await main();
