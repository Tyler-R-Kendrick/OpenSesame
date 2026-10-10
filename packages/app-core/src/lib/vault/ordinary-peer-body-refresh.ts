import type { VaultBody, VaultHeader } from "@opensesame/vault-core";
/** Same-root ordinary writes may consume a peer's authenticated projection; protection turns stay strict. */
import { refuseWhileFrozen } from "../duress/hold/gate.js";
import { ProtectionError } from "./protection/errors.js";
import { verifyManifestAuth } from "./protection/manifest-auth.js";
import { loadVaultBody } from "./store-body.js";
import { freshBody } from "./store-fresh.js";
import { operationHeader } from "./store-operation-check.js";
function stale(): never {
  throw new ProtectionError(
    "stale_operation",
    "Stored operation header changed.",
  );
}
function outerHeader(header: VaultHeader): string {
  const { protection: _projection, bodyRev: _revision, ...unlock } = header;
  return JSON.stringify(unlock);
}
function requireSameRootPeerManifest(
  previous: VaultHeader,
  header: VaultHeader,
  root: Uint8Array | undefined,
  outer: string,
) {
  if (!root || outerHeader(header) !== outer || !header.protection) stale();
  if ((header.bodyRev ?? 0) < (previous.bodyRev ?? 0)) stale();
  const next = header.protection;
  const before = previous.protection;
  if (
    before &&
    (before.vaultId !== next.vaultId ||
      before.rootKeyId !== next.rootKeyId ||
      before.rootEpoch !== next.rootEpoch ||
      before.purpose !== next.purpose ||
      next.revision < before.revision)
  )
    stale();
  return { root, next };
}
export async function ordinaryPeerFreshBody(
  tomb: string,
  key: CryptoKey | null,
  raw: Uint8Array | null,
  held: Readonly<{
    header: VaultHeader | null;
    body: VaultBody;
    mark: string | null;
  }>,
  readHeader: () => VaultHeader | null,
  original: () => void,
): Promise<Readonly<{ header: VaultHeader; body: VaultBody | null }>> {
  original();
  if (!key || !held.header) stale();
  const previous = held.header;
  const identity = operationHeader(previous);
  const outer = outerHeader(previous);
  // The owned raw bytes are copied before any await and wiped on every path.
  const root = raw?.slice();
  try {
    const fresh = await freshBody(tomb, key, held, readHeader);
    original();
    const header = fresh.header;
    if (!header) stale();
    if (operationHeader(header) === identity)
      return { header, body: fresh.body };
    const checked = requireSameRootPeerManifest(previous, header, root, outer);
    await verifyManifestAuth(checked.root, checked.next);
    original();
    // A changed HEADER never borrows the IV-only cache shortcut: authenticate
    // the actual current BODY with the original key and rollback witness.
    const body = await loadVaultBody(tomb, key, header);
    original();
    if ((body.rev ?? 0) < (held.body.rev ?? 0)) stale();
    if (operationHeader(readHeader() ?? previous) !== operationHeader(header))
      stale();
    return {
      header,
      body: (body.rev ?? 0) > (held.body.rev ?? 0) ? body : null,
    };
  } finally {
    root?.fill(0);
  }
}

/** Existing nullable raw-key requirement only; no owner or root is inferred. */
export function requireOriginalRawRoot(raw: Uint8Array | null): Uint8Array {
  if (!raw) throw new Error("Unlock the vault before changing unlock methods.");
  return raw;
}

/** Existing refusal policy; these callbacks only record failure/cancel a parked challenge. */
export function frozenAuthenticationRefusal(
  tomb: () => string,
  failed: () => void,
  open: () => boolean,
  cancel: () => void,
) {
  return (miss?: string): void => {
    refuseWhileFrozen(
      tomb(),
      () => {
        failed();
        if (!open()) cancel();
      },
      miss,
    );
  };
}
