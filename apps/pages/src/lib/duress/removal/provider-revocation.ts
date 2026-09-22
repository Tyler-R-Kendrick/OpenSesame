/**
 * Provider revocation with honest adapters only (BACKUP-E).
 * Missing adapters ⇒ explicit unsupported — never success stubs.
 */

export type ProviderRevocationOutcome = "ok" | "unsupported" | "failed";

export type ProviderRevocationReceipt = Readonly<{
  providerRef: string;
  outcome: ProviderRevocationOutcome;
  /** Scoped revoke never proves all derivative sessions are dead. */
  residualDisclosure: "derivative_sessions_may_remain";
  detail?: string;
}>;

export type ProviderRevocationAdapter = {
  readonly providerRef: string;
  revoke(scope: {
    vaultRef: string;
    deviceBindingRef: string;
    incidentId: string;
  }): Promise<"ok" | "failed">;
};

/**
 * Invoke real adapters only. Unknown refs are unsupported, not ok.
 */
export async function revokeProviders(input: {
  providerRefs: readonly string[];
  adapters: readonly ProviderRevocationAdapter[];
  vaultRef: string;
  deviceBindingRef: string;
  incidentId: string;
}): Promise<readonly ProviderRevocationReceipt[]> {
  const byRef = new Map(input.adapters.map((a) => [a.providerRef, a]));
  const receipts: ProviderRevocationReceipt[] = [];

  for (const providerRef of input.providerRefs) {
    const adapter = byRef.get(providerRef);
    if (!adapter) {
      receipts.push({
        providerRef,
        outcome: "unsupported",
        residualDisclosure: "derivative_sessions_may_remain",
        detail: "No real revocation adapter registered for this provider.",
      });
      continue;
    }
    try {
      const outcome = await adapter.revoke({
        vaultRef: input.vaultRef,
        deviceBindingRef: input.deviceBindingRef,
        incidentId: input.incidentId,
      });
      receipts.push({
        providerRef,
        outcome,
        residualDisclosure: "derivative_sessions_may_remain",
      });
    } catch (err) {
      receipts.push({
        providerRef,
        outcome: "failed",
        residualDisclosure: "derivative_sessions_may_remain",
        detail: err instanceof Error ? err.message : "revoke_threw",
      });
    }
  }

  return receipts;
}

/**
 * Local removal alone must not claim third-party sessions were revoked.
 */
export function localRemovalImpliesProviderRevoke(): false {
  return false;
}

/** Refuse stub adapters that always report success without work. */
export function assertHonestAdapter(
  adapter: ProviderRevocationAdapter & { __stubSuccess?: true },
): void {
  if (adapter.__stubSuccess === true) {
    throw new Error("unsupported_action: success stub adapters are forbidden");
  }
}
