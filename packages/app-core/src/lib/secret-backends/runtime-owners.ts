import {
  awaitSecretBackendOwner,
  secretBackendVaultGuard,
} from "./runtime-guard.js";
import { captureSecretBackendTransport } from "./transport.js";
import { SecretBackendError } from "./types.js";

type PendingOwner = Readonly<{ signal: AbortSignal; close(): void }>;
const generations = new Map<string, number>();
const pending = new Map<string, Set<PendingOwner>>();

function ended(): SecretBackendError {
  return new SecretBackendError("stale", "The backend operation ended.");
}

/** Capture the caller before any vault work and dispose a capture delivered too late. */
export async function captureSecretBackendVault(callerSignal?: AbortSignal) {
  if (callerSignal?.aborted) throw ended();
  const capturing = secretBackendVaultGuard();
  const guard = callerSignal
    ? await awaitSecretBackendOwner(capturing, callerSignal, async (late) =>
        late.close(),
      )
    : await capturing;
  try {
    if (callerSignal?.aborted) throw ended();
    const signal = callerSignal
      ? AbortSignal.any([guard.signal, callerSignal])
      : guard.signal;
    return {
      ...guard,
      signal,
      current: () => !signal.aborted && guard.current(),
    };
  } catch (error) {
    guard.close();
    throw error;
  }
}

/** Both original owners are selected before custody or ledger hydration can yield. */
export async function captureSecretBackendAttempt(callerSignal?: AbortSignal) {
  if (callerSignal?.aborted) throw ended();
  const capturing = captureSecretBackendVault(callerSignal);
  const transport = captureSecretBackendTransport();
  return { guard: await capturing, transport };
}

export function secretBackendGeneration(id: string): number {
  return generations.get(id) ?? 0;
}

/** Withdraw the old set before aborting; reentrant owners belong to a new set. */
export function advanceSecretBackendGeneration(id: string): number {
  const next = secretBackendGeneration(id) + 1;
  generations.set(id, next);
  const previous = pending.get(id);
  pending.delete(id);
  for (const owner of [...(previous ?? [])]) owner.close();
  return next;
}

export function registerPendingSecretBackend(
  id: string | undefined,
  generation: number,
  owner: PendingOwner,
): () => void {
  if (
    owner.signal.aborted ||
    (id && secretBackendGeneration(id) !== generation)
  ) {
    owner.close();
    throw ended();
  }
  if (!id) return () => {};
  const owners = pending.get(id) ?? new Set<PendingOwner>();
  pending.set(id, owners);
  owners.add(owner);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    owner.signal.removeEventListener("abort", release);
    owners.delete(owner);
    if (pending.get(id) === owners && owners.size === 0) pending.delete(id);
  };
  try {
    owner.signal.addEventListener("abort", release, { once: true });
    if (owner.signal.aborted || secretBackendGeneration(id) !== generation)
      throw ended();
  } catch (error) {
    release();
    owner.close();
    throw error;
  }
  return release;
}
