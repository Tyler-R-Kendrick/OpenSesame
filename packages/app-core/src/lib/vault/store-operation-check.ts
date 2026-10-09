import type { VaultHeader } from "@opensesame/vault-core";
/** Original operation cancellation only; never issues owner or REAL authority. */
import { originalVfsCheck } from "../vfs-operation-check.js";
import {
  assertNotCanceled,
  assertSessionGeneration,
} from "./protection/adapter.js";
import { ProtectionError } from "./protection/errors.js";
import type { ProtectionSessionGuard } from "./protection/session-guard.js";
import type { VaultScope } from "./store-scope.js";
export function operationHeader(header: VaultHeader | null): string {
  if (!header) return "null";
  const { bodyRev: _witness, ...identity } = header;
  return JSON.stringify(identity);
}
type StoreOperationState = Readonly<{
  scope: VaultScope;
  session: ProtectionSessionGuard;
  key: CryptoKey | null;
  raw: Uint8Array | null;
  header: VaultHeader | null;
}>;
export function captureStoreOperation(
  current: () => StoreOperationState,
  check?: () => void,
) {
  const transport = originalVfsCheck(check);
  const initial = current();
  const { scope, session } = initial;
  const generation = session.generation;
  const signal = session.signal;
  let key = initial.key;
  let raw = initial.raw;
  let header = operationHeader(initial.header);
  const active = () => {
    transport();
    assertSessionGeneration(generation, session.generation);
    assertNotCanceled(signal);
    const state = current();
    if (
      state.scope !== scope ||
      state.session !== session ||
      session.signal !== signal ||
      state.key !== key ||
      state.raw !== raw ||
      operationHeader(state.header) !== header
    )
      throw new ProtectionError(
        "stale_operation",
        "Original vault operation changed.",
      );
  };
  active();
  return Object.freeze({
    scope,
    active,
    adoptHeader: (next: VaultHeader, adopt: () => void) => {
      active();
      adopt();
      header = operationHeader(next);
      active();
    },
    adoptRoot: (adopt: () => void) => {
      active();
      adopt();
      const state = current();
      key = state.key;
      raw = state.raw;
      active();
    },
  });
}
