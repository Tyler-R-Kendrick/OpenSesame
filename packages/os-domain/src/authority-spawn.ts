/**
 * ID-SPAWN — unique workload identities bound to task/domain/runtime.
 *
 * Identity mints the principal class and PoP binding. It does **not** issue
 * Host grants, budgets, or sandbox profiles — those stay on the Host plane.
 * Unsupported runtimes refuse closed rather than inventing a second engine.
 */

import {
  type AuthorityPrincipalRef,
  bindProofOfPossession,
} from "./authority-principals.js";
import { DomainError } from "./errors.js";

export type SupportedWorkloadRuntime = "wasmtime";

export type WorkloadSpawnBinding = {
  readonly orchestrator: AuthorityPrincipalRef;
  readonly taskId: string;
  readonly accessDomainId: string;
  readonly runtimeProfile: SupportedWorkloadRuntime;
  readonly authorityGeneration: number;
};

export type SpawnedWorkloadIdentity = {
  readonly kind: "workload_instance";
  readonly principalId: string;
  readonly actorInstanceId: string;
  readonly binding: WorkloadSpawnBinding;
  readonly publicKeyJkt: string;
};

/**
 * Each spawned workload needs a unique id under the orchestrator. Reusing the
 * registration id as the instance id is refused.
 */
export type MintWorkloadInstanceIdInput = {
  readonly agentRegistrationId: string;
  readonly taskId: string;
  readonly ordinal: number;
};

export type DistinctSpawnIdentityInput = {
  readonly agentRegistrationId: string;
  readonly workloadInstanceId: string;
};

export function mintWorkloadInstanceId(
  input: MintWorkloadInstanceIdInput,
): string {
  if (input.ordinal < 0 || !Number.isInteger(input.ordinal)) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "workload ordinal must be a non-negative integer",
      { ordinal: input.ordinal },
    );
  }
  if (input.agentRegistrationId.length === 0 || input.taskId.length === 0) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "workload spawn requires registration and task ids",
      {},
    );
  }
  return `workload:${input.taskId}:${input.ordinal}:${input.agentRegistrationId}`;
}

export function assertDistinctSpawnIdentity(
  input: DistinctSpawnIdentityInput,
): void {
  if (input.workloadInstanceId === input.agentRegistrationId) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "workload instance id must not equal the agent registration id",
      {
        agentRegistrationId: input.agentRegistrationId,
        workloadInstanceId: input.workloadInstanceId,
      },
    );
  }
}

/**
 * Refuse spawn profiles Identity cannot isolate. Native binaries are Host
 * sandbox territory; Identity must not mint a workload principal for them.
 */
export function refuseUnsupportedWorkloadRuntime(
  runtimeProfile: string,
): asserts runtimeProfile is SupportedWorkloadRuntime {
  if (runtimeProfile !== "wasmtime") {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      `unsupported workload runtime ${runtimeProfile}; Identity refuses spawn without inventing a second authority engine`,
      { runtimeProfile },
    );
  }
}

/**
 * Mint a unique workload identity bound to task, access domain, runtime, and
 * authority generation. Does not issue Host grants — Host remains authoritative.
 */
export function spawnWorkloadIdentity(input: {
  readonly orchestrator: AuthorityPrincipalRef;
  readonly taskId: string;
  readonly accessDomainId: string;
  readonly runtimeProfile: string;
  readonly authorityGeneration: number;
  readonly publicKeyJkt: string;
  readonly ordinal: number;
  readonly boundAt: Date;
  readonly restoredFromGeneration?: number;
}): SpawnedWorkloadIdentity {
  refuseUnsupportedWorkloadRuntime(input.runtimeProfile);
  if (
    input.orchestrator.kind !== "agent_registration" &&
    input.orchestrator.kind !== "actor_instance" &&
    input.orchestrator.kind !== "service"
  ) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      `orchestrator kind ${input.orchestrator.kind} cannot spawn workloads`,
      { kind: input.orchestrator.kind },
    );
  }
  if (input.taskId.length === 0 || input.accessDomainId.length === 0) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "workload spawn requires task and access-domain binding",
      {},
    );
  }
  if (
    !Number.isInteger(input.authorityGeneration) ||
    input.authorityGeneration < 1
  ) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "workload spawn requires authorityGeneration >= 1",
      { authorityGeneration: input.authorityGeneration },
    );
  }
  if (
    input.restoredFromGeneration !== undefined &&
    input.restoredFromGeneration >= input.authorityGeneration
  ) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "restored workload must use a newer authorityGeneration than the backup",
      {
        restoredFromGeneration: input.restoredFromGeneration,
        authorityGeneration: input.authorityGeneration,
      },
    );
  }

  const mintInput: MintWorkloadInstanceIdInput = {
    agentRegistrationId: input.orchestrator.principalId,
    taskId: input.taskId,
    ordinal: input.ordinal,
  };
  const principalId = mintWorkloadInstanceId(mintInput);
  const distinctInput: DistinctSpawnIdentityInput = {
    agentRegistrationId: input.orchestrator.principalId,
    workloadInstanceId: principalId,
  };
  assertDistinctSpawnIdentity(distinctInput);

  const pop = bindProofOfPossession({
    subjectKind: "workload_instance",
    principalId,
    publicKeyJkt: input.publicKeyJkt,
    authorityGeneration: input.authorityGeneration,
    boundAt: input.boundAt,
  });

  return {
    kind: "workload_instance",
    principalId,
    actorInstanceId: `actor:${principalId}`,
    binding: {
      orchestrator: input.orchestrator,
      taskId: input.taskId,
      accessDomainId: input.accessDomainId,
      runtimeProfile: input.runtimeProfile,
      authorityGeneration: input.authorityGeneration,
    },
    publicKeyJkt: pop.publicKeyJkt,
  };
}
