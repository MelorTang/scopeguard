import path from "node:path";
import { fileURLToPath } from "node:url";
import { Classification } from "./qualification/evidence.mjs";
import { QualificationHarness } from "./qualification/harness.mjs";
import { qualifyApprovalContracts } from "./scenarios/approval-contracts.mjs";
import { qualifyApprovalRuntime } from "./scenarios/approval-runtime.mjs";
import {
  qualifyCompatibilityAndCleanup,
  qualifyConcurrentInterrupt,
} from "./scenarios/concurrency-cleanup.mjs";
import { qualifyProcessLifecycle } from "./scenarios/process-lifecycle.mjs";
import {
  qualifyProviderFailure,
  qualifySessionResumeAndCompaction,
} from "./scenarios/provider-session.mjs";
import { qualifyStreamingAndTools } from "./scenarios/streaming-tools.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const harness = new QualificationHarness(root);

async function main() {
  await harness.initialize();
  for (const scenario of [
    qualifyProcessLifecycle,
    qualifyStreamingAndTools,
    qualifyApprovalContracts,
    qualifyApprovalRuntime,
    qualifyProviderFailure,
    qualifySessionResumeAndCompaction,
    qualifyConcurrentInterrupt,
    qualifyCompatibilityAndCleanup,
  ]) {
    await scenario(harness);
  }
  await harness.cleanupSuccess();
  harness.record(
    "temporary-state-cleanup",
    Classification.EXACT,
    "all child processes, Provider, profile, Workspace, and Sessions removed",
  );
  process.stdout.write(
    `${JSON.stringify(harness.evidence.summary(harness.runtimeSummary()), null, 2)}\n`,
  );
}

main().catch(async (error) => {
  process.stderr.write(`FAIL pi-rpc-qualification: ${error.stack ?? error}\n`);
  await harness.cleanupFailure();
  process.exitCode = 1;
});
