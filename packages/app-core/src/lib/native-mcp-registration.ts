import { updateNativeConnector } from "./native-connector-store.js";
import { NativeMcpAuthError } from "./native-mcp-oauth-target.js";
import { MCP_CLASSIFICATION } from "./native-mcp-profile.js";
import { requireNativeMcpRecord } from "./native-mcp-records.js";
/** Retain a minted registration before awaiting its durable seal. */
import type { NativeMcpRegisteredClient } from "./native-mcp-registration-receipt.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";

const retained = new Map<
  string,
  { intentId: string; fingerprint: string; client: string | null }
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
export function reserveNativeMcpRegistration(
  id: string,
  intentId: string,
  fingerprint: string,
): void {
  assertNativeMcpRegistrationCapacity(id);
  if (retained.has(id)) throw new NativeMcpAuthError("storage");
  retained.set(id, { intentId, fingerprint, client: null });
}
export function releaseNativeMcpRegistrationReservation(
  id: string,
  intentId: string,
): void {
  const entry = retained.get(id);
  if (entry?.intentId === intentId && entry.client === null)
    retained.delete(id);
}
export async function retainNativeMcpRegistration(
  id: string,
  intentId: string,
  fingerprint: string,
  client: NativeMcpRegisteredClient,
): Promise<void> {
  assertNativeMcpRegistrationCapacity(id);
  retained.set(id, { intentId, fingerprint, client: JSON.stringify(client) });
  await retryRetainedNativeMcpRegistration(id);
}
export async function retryRetainedNativeMcpRegistration(
  id: string,
): Promise<void> {
  const entry = retained.get(id);
  if (!entry?.client) return;
  const client = entry.client;
  const current = requireNativeMcpRecord(id);
  await updateNativeConnector(
    id,
    nativeOAuthGuard(current),
    MCP_CLASSIFICATION,
    (record) => {
      const intent = record.privateState.recovery.find(
        (candidate) => candidate.id === entry.intentId,
      );
      if (
        !intent ||
        intent.fingerprint !== entry.fingerprint ||
        intent.kind !== "registration"
      )
        throw new NativeMcpAuthError("storage");
      record.privateState.credentials.mcp_client = client;
      intent.credentials = {
        ...intent.credentials,
        client,
        phase: "registered",
      };
      return record;
    },
  );
  retained.delete(id);
}
