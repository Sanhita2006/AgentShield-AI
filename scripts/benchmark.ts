import 'dotenv/config';
import { generateAndSaveBenchmarkReport } from '../server/gateway/benchmark.ts';

async function main() {
  const report = await generateAndSaveBenchmarkReport(process.cwd());
  const r = report.rulesOnly;
  console.log(`\nAgentShield Benchmark (${report.disclaimer})`);
  console.log(`Dataset: ${report.datasetCounts.attacks} attacks + ${report.datasetCounts.benign} benign = ${report.datasetCounts.total} total`);
  console.log(`Rules-only detection: ${r.attacksStopped}/${r.attackSamples} (${r.attackDetectionRatePct}%)`);
  console.log(`Missed by Stage 3 yet contained by Stage 2 caps: ${r.stage2ContainedCount}`);
  console.log(`Uncontained misses: ${r.uncontainedMissCount}`);
  console.log(`Benign hard FP (BLOCK): ${r.benignBlocked}/${r.benignSamples} (${r.benignHardFalsePositiveRatePct}%)`);
  console.log(`Benign total alerts (BLOCK+ASK): ${r.benignBlocked + r.benignEscalated}/${r.benignSamples} (${r.benignTotalAlertRatePct}%)`);
  console.log(`Latency (ms): p50=${r.latencyMs.p50} p95=${r.latencyMs.p95} p99=${r.latencyMs.p99} mean=${r.latencyMs.mean}`);
  console.log(`LLM Judge: ${report.judgeComparisonNote}`);
  console.log(`Wrote docs/BENCHMARK.md & docs/benchmark-summary.json\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
