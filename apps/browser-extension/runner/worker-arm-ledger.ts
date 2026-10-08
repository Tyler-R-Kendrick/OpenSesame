import type { ExtensionRealmBroker } from "@opensesame/app-core/browser/security/broker.js";
import type { TickReport } from "./loop-types";
import type { PassSummary, RunnerOperations, ServiceDeps } from "./service";
import {
  RunnerAuthorityEnded,
  type RunnerOwner,
  runnerOwner,
} from "./worker-authority";
import { scopedRunnerDeps } from "./worker-scoped-io";
type Arm = {
  permit: string | undefined;
  owner: RunnerOwner;
  operations: RunnerOperations;
};
/** Witnesses stay in memory; disk arms cannot create or upgrade them. */
export class WorkerArmLedger {
  private readonly arms = new Map<string, Arm>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly base: RunnerOperations;
  private lastPass: PassSummary | null = null;
  constructor(
    private readonly deps: ServiceDeps,
    private readonly make: (scoped: ServiceDeps) => RunnerOperations,
    readonly broker: ExtensionRealmBroker,
  ) {
    this.base = make(deps);
  }
  private serialized<T>(origin: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(origin) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.queues.set(origin, next);
    void next
      .finally(() => {
        if (this.queues.get(origin) === next) this.queues.delete(origin);
      })
      .catch(() => undefined);
    return next;
  }
  private async createArm(origin: string, permit: string | undefined) {
    if (!(await this.broker.allows(permit))) throw new RunnerAuthorityEnded();
    const owner = runnerOwner(
      this.broker,
      permit,
      origin,
      () => this.arms.get(origin) === arm,
    );
    const arm: Arm = {
      permit,
      owner,
      operations: this.make(scopedRunnerDeps(this.deps, owner)),
    };
    this.arms.set(origin, arm);
    return { arm, owner };
  }
  private async cleanFailedArm(origin: string, arm: Arm) {
    if (this.arms.get(origin) !== arm) return;
    this.arms.delete(origin);
    // Serialized before a successor arm; cleanup cannot erase its stored consent.
    await this.base.disarm(origin);
  }
  arm(origin: string, permit?: string) {
    return this.serialized(origin, async () => {
      const { arm, owner } = await this.createArm(origin, permit);
      try {
        const result = await arm.operations.arm(origin);
        owner.check();
        await owner.authorize();
        owner.check();
        if (result !== "armed" && this.arms.get(origin) === arm)
          this.arms.delete(origin);
        return result;
      } catch (error) {
        await this.cleanFailedArm(origin, arm);
        if (error instanceof RunnerAuthorityEnded) return "no_grant" as const;
        throw error;
      }
    });
  }
  disarm(origin: string, permit?: string) {
    return this.serialized(origin, async () => {
      const arm = this.arms.get(origin);
      if (!(await this.broker.allows(permit))) {
        if (arm && arm.permit === permit)
          await this.cleanFailedArm(origin, arm);
        return;
      }
      const owner = runnerOwner(this.broker, permit, origin, () => true);
      await owner.authorize();
      owner.check();
      this.arms.delete(origin);
      await this.make(scopedRunnerDeps(this.deps, owner)).disarm(origin);
    });
  }
  async status(permit?: string) {
    if (!(await this.broker.allows(permit))) throw new RunnerAuthorityEnded();
    const owner = runnerOwner(this.broker, permit, undefined, () => true);
    await owner.authorize();
    owner.check();
    const status = await this.make(scopedRunnerDeps(this.deps, owner)).status();
    owner.check();
    await owner.authorize();
    owner.check();
    return { ...status, lastPass: this.lastPass };
  }
  async tick(): Promise<TickReport> {
    const report: TickReport = {
      connected: false,
      driven: [],
      skipped: [],
      settled: 0,
      refused: 0,
    };
    for (const [origin, arm] of [...this.arms]) {
      if (report.driven.length >= 3) break;
      if (this.arms.get(origin) !== arm) continue;
      try {
        const next = await arm.operations.tick(3 - report.driven.length);
        arm.owner.check();
        this.lastPass = arm.operations.lastPassSummary();
        report.connected ||= next.connected;
        report.driven.push(...next.driven);
        report.skipped.push(...next.skipped);
        report.settled += next.settled;
        report.refused += next.refused;
      } catch (error) {
        if (!(error instanceof RunnerAuthorityEnded)) throw error;
        if (this.arms.get(origin) === arm) this.arms.delete(origin);
        // A failed arm may already have started runs. Stop rather than undercount/reallocate its budget.
        break;
      }
    }
    return report;
  }
}
