/**
 * A fake `ApprovedCapabilityContext` for module tests. It records every
 * registration and revocation, every `hydrate` and `egress.fetch` call, and
 * aborts its lease on demand so a test can prove that disposal and a
 * mid-flight disable behave. Nothing here touches the real store, registry
 * or network.
 */

import type {
  ActivationLease,
  ContributionKind,
  PlanIdentity,
  RegistrationHandle,
} from "@opensesame/capability-composition";
import type {
  ApprovedCapabilityContext,
  ContributionEntry,
} from "../lib/capabilities/runtime-contract.js";
import type { ParsedRuntimeConfig } from "../lib/runtime-config.js";

export type RegisteredContribution = {
  readonly kind: ContributionKind;
  readonly entry: ContributionEntry<ContributionKind>;
  readonly handle: RegistrationHandle;
  readonly generation: number;
  revoked: boolean;
  /** How many times `revoke` was called — idempotency is asserted on this. */
  revokeCalls: number;
};

export type EgressCall = {
  readonly input: string;
  readonly capability: string;
  readonly purpose: string;
};

export type TestContext = Readonly<{
  ctx: ApprovedCapabilityContext;
  registered: RegisteredContribution[];
  hydrated: string[][];
  egressCalls: EgressCall[];
  /** Abort the lease (a commit, a lock, a vault switch, a revocation). */
  abort: (reason?: string) => void;
  /** Registrations not yet revoked. */
  live: () => RegisteredContribution[];
  /** Sorted, de-duplicated kinds of live registrations. */
  liveKinds: () => ContributionKind[];
  /** Live entries of one kind. */
  entries: <K extends ContributionKind>(kind: K) => ContributionEntry<K>[];
}>;

export type TestContextOptions = Readonly<{
  tomb?: string | null;
  guest?: boolean;
  generation?: number;
  runtimeConfig?: Partial<ParsedRuntimeConfig>;
  /** Response for `egress.fetch`; defaults to a 204 with no body. */
  egressResponse?: () => Response;
}>;

const IDENTITY: PlanIdentity = Object.freeze({
  instanceId: "instance-test",
  installationId: "installation-test",
  vaultId: null,
  distributionId: "distribution-test",
  policyRevision: "policy-1",
  selectionRevision: "selection-1",
  planDigest: "sha256:test",
});

export function createTestContext(
  options: TestContextOptions = {},
): TestContext {
  const controller = new AbortController();
  const generation = options.generation ?? 1;
  const lease: ActivationLease = Object.freeze({
    identity: { ...IDENTITY, vaultId: options.tomb ?? null },
    generation,
    signal: controller.signal,
  });
  const registered: RegisteredContribution[] = [];
  const hydrated: string[][] = [];
  const egressCalls: EgressCall[] = [];

  const register = <K extends ContributionKind>(
    kind: K,
    entry: ContributionEntry<K>,
  ): RegistrationHandle => {
    if (controller.signal.aborted) {
      throw new Error(`stale lease: cannot register ${kind}`);
    }
    const record: RegisteredContribution = {
      kind,
      entry,
      generation,
      revoked: false,
      revokeCalls: 0,
      handle: {
        kind,
        capability: "test",
        generation,
        revoke: () => {
          record.revokeCalls += 1;
          record.revoked = true;
        },
      },
    };
    registered.push(record);
    return record.handle;
  };

  const runtimeConfig: ParsedRuntimeConfig = {
    status: "ok",
    endpoints: {},
    ambientAuth: undefined,
    capabilityComposition: null,
    diagnostics: [],
    ...options.runtimeConfig,
  };

  const ctx: ApprovedCapabilityContext = {
    lease,
    register,
    runtimeConfig,
    hydrate: async (keys) => {
      hydrated.push([...keys]);
    },
    vault: { tomb: options.tomb ?? null, guest: options.guest ?? false },
    egress: {
      capability: "test",
      decide: (input) => ({
        ok: true,
        class: "application-assets",
        crossOrigin: false,
        destination: String(input),
      }),
      fetch: async (input, _init, meta) => {
        // The S18 port's `meta` is optional; a module that leaves it out is
        // recorded as having named neither, which the assertions can see.
        egressCalls.push({
          input: String(input),
          capability: meta?.capability ?? "",
          purpose: meta?.purpose ?? "",
        });
        return options.egressResponse
          ? options.egressResponse()
          : new Response(null, { status: 204 });
      },
    },
  };

  const live = () => registered.filter((record) => !record.revoked);

  return {
    ctx,
    registered,
    hydrated,
    egressCalls,
    abort: (reason = "test-abort") => {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    live,
    liveKinds: () => [...new Set(live().map((record) => record.kind))].sort(),
    entries: <K extends ContributionKind>(kind: K) =>
      live()
        .filter((record) => record.kind === kind)
        .map((record) => record.entry as ContributionEntry<K>),
  };
}
