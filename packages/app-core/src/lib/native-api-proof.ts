/** Refused browser access clears readiness without discarding cleanup authority. */
import {
  NativeApiBrowserUnavailable,
  assertNativeApiBrowserTarget,
} from "./native-api-admission.js";
import type { NativeApiTarget } from "./native-api-target.js";
import {
  type NativeConnectorRecord,
  updateNativeConnector,
} from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";

export async function requireNativeApiBrowserAccess(
  record: NativeConnectorRecord,
  target: NativeApiTarget,
  transport: NativeProviderTransport,
): Promise<void> {
  try {
    assertNativeApiBrowserTarget(target);
  } catch (error) {
    if (
      error instanceof NativeApiBrowserUnavailable &&
      record.privateState.verification
    )
      await invalidateNativeApiProof(record, target, transport);
    throw error;
  }
}

export async function invalidateNativeApiProof(
  record: NativeConnectorRecord,
  target: NativeApiTarget,
  transport: NativeProviderTransport,
): Promise<void> {
  await updateNativeConnector(
    record.connectionId,
    {
      revision: record.revision,
      fingerprint: record.configuration.fingerprint,
    },
    target.classification,
    (current) => {
      transport.assertCurrent();
      return {
        ...current,
        runtime: {
          ...current.runtime,
          grants: current.runtime.grants.map((grant) => ({
            ...grant,
            needsReauth: true,
          })),
        },
        privateState: { ...current.privateState, verification: null },
      };
    },
  );
}
