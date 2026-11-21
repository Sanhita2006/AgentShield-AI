import 'dotenv/config';
import { runFullSelfTest } from '../server/gateway/selftest.ts';

async function main() {
  const r = await runFullSelfTest();
  for (const s of r.results) {
    console.log(`${s.passed ? 'PASS' : 'FAIL'}  ${s.name ?? s.id}`);
  }
  console.log(`\nScenarios passed: ${r.passed}/${r.total}`);
  console.log(`Attack scenarios stopped: ${r.attackScenariosStopped}/${r.attackScenariosTotal} (non-ALLOW scenarios)`);
  console.log(`Audit chain verified: ${r.auditChainVerified}; tamper detected: ${r.tamperDetectionVerified}`);
  process.exit(r.passed === r.total && r.auditChainVerified && r.tamperDetectionVerified ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
