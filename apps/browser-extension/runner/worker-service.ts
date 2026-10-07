import type { ExtensionRealmBroker } from "@opensesame/app-core/browser/security/broker.js";
import type { TickReport } from "./loop-types";
import type { RunnerOperations, ServiceDeps } from "./service";
import { WorkerArmLedger } from "./worker-arm-ledger";
/** Production must bind before registering alarms. Unbound construction remains a pure port harness. */
export function workerService(
  deps: ServiceDeps,
  make: (scoped: ServiceDeps) => RunnerOperations,
) {
  const base = make(deps);
  let ledger: WorkerArmLedger | undefined;
  let busy: Promise<TickReport> | null = null;
  return {
    bindSecurity(security: ExtensionRealmBroker) {
      if (ledger && ledger.broker !== security)
        throw new Error("Runner broker already bound");
      ledger ??= new WorkerArmLedger(deps, make, security);
    },
    tick() {
      busy ??= (ledger ? ledger.tick() : base.tick()).finally(() => {
        busy = null;
      });
      return busy;
    },
    status: (permit?: string) =>
      ledger ? ledger.status(permit) : base.status(),
    arm: (origin: string, permit?: string) =>
      ledger ? ledger.arm(origin, permit) : base.arm(origin),
    disarm: (origin: string, permit?: string) =>
      ledger ? ledger.disarm(origin, permit) : base.disarm(origin),
  };
}
