/** Retain an independently valid refresh token even when its access token is malformed. */
import { updateNativeConnector } from "./native-connector-store.js";
import { NativeMcpAuthError } from "./native-mcp-oauth-target.js";
import { MCP_CLASSIFICATION } from "./native-mcp-profile.js";
import { requireNativeMcpRecord } from "./native-mcp-records.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";

type Retained = { intentId: string; fingerprint: string; token: string | null };
const retained = new Map<string, Retained>();

export function reserveNativeMcpPartialRefresh(
  id: string,
  intentId: string,
  fingerprint: string,
): void {
  if (retained.has(id) || retained.size >= 64)
    throw new NativeMcpAuthError("storage");
  retained.set(id, { intentId, fingerprint, token: null });
}

export function releaseNativeMcpPartialReservation(
  id: string,
  intentId: string,
): void {
  const entry = retained.get(id);
  if (entry?.intentId === intentId && entry.token === null) retained.delete(id);
}

export function forgetRetainedNativeMcpPartialRefresh(
  id: string,
  intentId: string,
): void {
  if (retained.get(id)?.intentId === intentId) retained.delete(id);
}

async function seal(id: string, entry: Retained): Promise<void> {
  if (entry.token === null) throw new NativeMcpAuthError("storage");
  const token = entry.token;
  const current = requireNativeMcpRecord(id);
  await updateNativeConnector(
    id,
    nativeOAuthGuard(current),
    MCP_CLASSIFICATION,
    (record) => {
      const intent = record.privateState.recovery.find(
        (item) => item.id === entry.intentId,
      );
      if (
        !intent ||
        intent.fingerprint !== entry.fingerprint ||
        !["exchange", "refresh"].includes(intent.credentials?.phase ?? "")
      )
        throw new NativeMcpAuthError("storage");
      if (intent.credentials?.phase === "refresh") {
        delete record.privateState.grants[intent.actor];
        record.runtime.grants = record.runtime.grants.filter(
          (item) => item.actor !== intent.actor,
        );
      }
      intent.credentials = {
        ...intent.credentials,
        phase: "partial-refresh",
        partial_refresh_token: token,
      };
      record.privateState.verification = null;
      return record;
    },
  );
  retained.delete(id);
}

export async function retainNativeMcpPartialRefresh(
  id: string,
  intentId: string,
  token: string,
): Promise<void> {
  const entry = retained.get(id);
  if (
    !entry ||
    entry.intentId !== intentId ||
    entry.token !== null ||
    token.length < 1 ||
    token.length > 32768 ||
    !/^[!-~]+$/.test(token)
  )
    throw new NativeMcpAuthError("storage");
  entry.token = token;
  await seal(id, entry);
}

export async function retryRetainedNativeMcpPartialRefresh(
  id: string,
): Promise<void> {
  const entry = retained.get(id);
  if (entry?.token) await seal(id, entry);
}
