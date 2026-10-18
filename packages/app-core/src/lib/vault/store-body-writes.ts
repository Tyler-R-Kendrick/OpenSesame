/** Existing body-write mechanics; callers retain their original private session checks. */
import type { VaultBody, VaultHeader } from "@opensesame/vault-core";
import { bodyBeforeWrite } from "./body-edits.js";
import { ordinaryPeerFreshBody } from "./ordinary-peer-body-refresh.js";
import { ProtectionError } from "./protection/errors.js";
import { type FreshBody, freshBody } from "./store-fresh.js";
import {
  type captureStoreOperation,
  operationHeader,
} from "./store-operation-check.js";
import { withBodyWriteLockOrBare } from "./vault-shared-locks.js";
type Original = ReturnType<typeof captureStoreOperation>;
export type BodyWriteState = Readonly<{
  key: CryptoKey | null;
  raw: Uint8Array | null;
  header: VaultHeader | null;
  body: VaultBody;
  mark: string | null;
  readHeader: () => VaultHeader | null;
}>;
export async function withFreshStoreBody<T>(
  original: Original,
  state: () => BodyWriteState,
  adopt: (fresh: FreshBody) => void,
  work: () => Promise<T>,
): Promise<T> {
  original.active();
  return await withBodyWriteLockOrBare(original.scope.tomb, async () => {
    const held = state();
    const fresh = await ordinaryPeerFreshBody(
      original.scope.tomb,
      held.key,
      held.raw,
      held,
      held.readHeader,
      original.active,
    );
    original.active();
    original.adoptHeader(fresh.header, () => adopt(fresh));
    const result = await work();
    original.active();
    return result;
  });
}
export async function refreshedStoreBody(
  original: Original,
  held: BodyWriteState,
) {
  original.active();
  if (!held.key) throw new Error("The vault is locked.");
  const fresh = await freshBody(
    original.scope.tomb,
    held.key,
    held,
    held.readHeader,
  );
  original.active();
  if (operationHeader(fresh.header) !== operationHeader(held.header))
    throw new ProtectionError(
      "stale_operation",
      "Stored operation header changed.",
    );
  return fresh;
}
export async function applyStoreBodyChange(
  input: Readonly<{
    state: BodyWriteState;
    change: (body: VaultBody) => void;
    check: () => void;
    persist: () => Promise<void>;
    rollback: (previous: VaultBody) => void;
  }>,
) {
  input.check();
  if (!input.state.key) throw new Error("The vault is locked.");
  const previous = bodyBeforeWrite(input.state.body);
  input.change(input.state.body);
  try {
    await input.persist();
  } catch (error) {
    input.check();
    input.rollback(previous);
    throw error;
  }
  input.check();
}
