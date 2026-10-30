import { updateNativeConnector } from "./native-connector-store.js";
import type { NativeMcpRegistrationMode } from "./native-mcp-oauth-metadata.js";
import { NativeMcpAuthError } from "./native-mcp-oauth-target.js";
import { MCP_CLASSIFICATION } from "./native-mcp-profile.js";
import { requireNativeMcpRecord } from "./native-mcp-records.js";
/** Retain a minted registration before awaiting its durable seal. */
import type { NativeMcpRegisteredClient } from "./native-mcp-registration-receipt.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";

const retained = new Map<
  string,
  {
    intentId: string;
    fingerprint: string;
    client: string | null;
    mode: NativeMcpRegistrationMode | null;
  }
>();
export function forgetRetainedNativeMcpRegistration(
  id: string,
  intentId: string,
): void {
  if (retained.get(id)?.intentId === intentId) retained.delete(id);
}
export function assertNativeMcpRegistrationCapacity(id: string): void {
  if (retained.size >= 64 && !retained.has(id))
    throw new NativeMcpAuthError("storage");
}
export function assertNativeMcpRegistrationAvailable(id: string): void {
  assertNativeMcpRegistrationCapacity(id);
  if (retained.has(id)) throw new NativeMcpAuthError("storage");
}
export function reserveNativeMcpRegistration(
  id: string,
  intentId: string,
  fingerprint: string,
): void {
  assertNativeMcpRegistrationAvailable(id);
  retained.set(id, { intentId, fingerprint, client: null, mode: null });
}
export function releaseNativeMcpRegistrationReservation(
  id: string,
  intentId: string,
): void {
  const entry = retained.get(id);
  if (entry?.intentId === intentId && entry.client === null)
    retained.delete(id);
}
/** Discard an obligation only when no registration request was submitted. */
export async function discardNativeMcpRegistration(
  id: string,
  intentId: string,
): Promise<void> {
  const current = requireNativeMcpRecord(id);
  await updateNativeConnector(
    id,
    nativeOAuthGuard(current),
    MCP_CLASSIFICATION,
    (record) => {
      record.privateState.recovery = record.privateState.recovery.filter(
        (entry) => entry.id !== intentId,
      );
      return record;
    },
  );
  forgetRetainedNativeMcpRegistration(id, intentId);
}
/**
 * Seal a retained registration into its obligation. A durable write that failed
 * after the record encoded is "storage": the copy stays for a retry. A record
 * the encoder or schema refused, or an obligation that is gone, is "metadata":
 * the copy can never be sealed. Anything before the update ran is rethrown.
 */
async function sealRetained(
  id: string,
  intentId: string,
  fingerprint: string,
  client: string,
  mode: NativeMcpRegistrationMode,
): Promise<void> {
  const current = requireNativeMcpRecord(id);
  let accepted = false;
  let encoded = false;
  try {
    await updateNativeConnector(
      id,
      nativeOAuthGuard(current),
      MCP_CLASSIFICATION,
      (record) => {
        const intent = record.privateState.recovery.find(
          (candidate) => candidate.id === intentId,
        );
        if (
          !intent ||
          intent.fingerprint !== fingerprint ||
          intent.kind !== "registration"
        )
          throw new NativeMcpAuthError("metadata");
        record.privateState.credentials.mcp_client = client;
        record.privateState.credentials.mcp_registration_mode = mode;
        intent.credentials = {
          ...intent.credentials,
          client,
          phase: "registered",
          registration_mode: mode,
          submission: "settled",
        };
        accepted = true;
        return record;
      },
      undefined,
      () => {
        encoded = true;
      },
    );
  } catch (error) {
    if (encoded) throw new NativeMcpAuthError("storage");
    if (accepted) throw new NativeMcpAuthError("metadata");
    throw error;
  }
  retained.delete(id);
}
/** First seal; admission settles a refusal, so this never discards. */
export async function retainNativeMcpRegistration(
  id: string,
  intentId: string,
  fingerprint: string,
  client: NativeMcpRegisteredClient,
  mode: NativeMcpRegistrationMode,
): Promise<void> {
  assertNativeMcpRegistrationCapacity(id);
  const sealed = JSON.stringify(client);
  retained.set(id, { intentId, fingerprint, client: sealed, mode });
  await sealRetained(id, intentId, fingerprint, sealed, mode);
}
/** Retry sealing the retained registration; keep its obligation on failure. */
export async function retryRetainedNativeMcpRegistration(
  id: string,
): Promise<void> {
  const entry = retained.get(id);
  if (!entry?.client || !entry.mode) return;
  await sealRetained(
    id,
    entry.intentId,
    entry.fingerprint,
    entry.client,
    entry.mode,
  );
}
