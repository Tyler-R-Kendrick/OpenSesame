import { bytesToB64url } from "@opensesame/sdk-browser";
import { b64ToBytes } from "@opensesame/vault-core";
import type { LocalPasskey } from "./local-credentials.js";
import { copyPrfBytes } from "./local-passkey-prf-bytes.js";
import {
  MIN_PRF_OUTPUT_BYTES,
  readPrfFirst,
} from "./vault/protection/adapters/webauthn-prf-output.js";
import type { VaultProtectionBrowserService } from "./vault/protection/browser-service.js";
import { unwrapVaultKeyWithPrf } from "./vault/unlock-methods.js";

type SignInPrfVault = {
  isUnlocked(): boolean;
  activeTomb(): string;
  readonly protection: Pick<
    VaultProtectionBrowserService,
    "listProtectors" | "enrollHeldWebauthnPrf" | "commitEnrollment"
  >;
};

let signInVault: SignInPrfVault | null = null;

/** The singleton boot binds live reads, never a key or session snapshot. */
export function installSignInPrfVault(owner: SignInPrfVault): () => void {
  signInVault = owner;
  return () => {
    if (signInVault === owner) signInVault = null;
  };
}

/** Keep the former deferred lookup before checking the current owner state. */
function currentSignInPrfVault(): Promise<SignInPrfVault | null> {
  return Promise.resolve().then(() => signInVault);
}

function viewBuffer(bytes: Uint8Array): ArrayBuffer {
  return copyPrfBytes(bytes);
}

// WebAuthn owns the result until it returns it to us. A genuine, non-shared
// ArrayBuffer is then consumed and wiped even when it is unusable for sign-in.
function ownedPrfView(first: ArrayBuffer | null): Uint8Array | null {
  if (!first) return null;
  try {
    const byteLength = Object.getOwnPropertyDescriptor(
      ArrayBuffer.prototype,
      "byteLength",
    )?.get;
    if (!byteLength) return null;
    const length: number = Reflect.apply(byteLength, first, []);
    return new Uint8Array(first, 0, length);
  } catch {
    return null;
  }
}

function wipeOwnedPrf(
  prfOutput: Uint8Array | null,
  ownedFirst: ArrayBuffer | null,
  originalLength: number,
): void {
  try {
    prfOutput?.fill(0);
  } catch (error) {
    // A resized buffer may invalidate the fixed view while retaining a
    // prefix. Wipe only surviving original bytes, then fail closed.
    if (ownedFirst) {
      try {
        const byteLength = Object.getOwnPropertyDescriptor(
          ArrayBuffer.prototype,
          "byteLength",
        )?.get;
        if (byteLength) {
          const currentLength: number = Reflect.apply(
            byteLength,
            ownedFirst,
            [],
          );
          new Uint8Array(
            ownedFirst,
            0,
            Math.min(originalLength, currentLength),
          ).fill(0);
        }
      } catch {
        // A detached buffer no longer has writable bytes.
      }
    }
    throw error;
  }
}

type SignInPrfRow = { salt: Uint8Array; existing: boolean };

function localCredentialId(standardB64: string): string {
  return bytesToB64url(b64ToBytes(standardB64));
}

export function zeroSignInPrfSalts(plan: Map<string, SignInPrfRow>): void {
  for (const row of plan.values()) row.salt.fill(0);
}

async function knownPrfSalts(tomb: string): Promise<Map<string, Uint8Array>> {
  const salts = new Map<string, Uint8Array>();
  const vaultStore = await currentSignInPrfVault();
  if (
    !vaultStore ||
    !vaultStore.isUnlocked() ||
    vaultStore.activeTomb() !== tomb
  )
    return salts;
  for (const record of vaultStore.protection.listProtectors()) {
    if (record.kind !== "webauthn-prf") continue;
    salts.set(
      localCredentialId(record.credentialIdB64),
      b64ToBytes(record.saltB64),
    );
  }
  return salts;
}

export async function prepareSignInPrf(tomb: string, keys: LocalPasskey[]) {
  const known = await knownPrfSalts(tomb);
  const plan = new Map<string, SignInPrfRow>();
  for (const key of keys) {
    const salt = known.get(key.credentialId);
    plan.set(
      key.credentialId,
      salt
        ? { salt, existing: true }
        : {
            salt: crypto.getRandomValues(new Uint8Array(32)),
            existing: false,
          },
    );
  }
  const evalByCredential: Record<string, { first: Uint8Array }> = {};
  for (const [id, row] of plan) evalByCredential[id] = { first: row.salt };
  const first =
    plan.values().next().value?.salt ??
    crypto.getRandomValues(new Uint8Array(32));
  return { plan, extension: { eval: { first }, evalByCredential } };
}

export async function applySignInPrf(
  tomb: string,
  principalId: string,
  credential: PublicKeyCredential,
  plan: Map<string, SignInPrfRow>,
): Promise<boolean> {
  let prfOutput: Uint8Array | null = null;
  let ownedFirst: ArrayBuffer | null = null;
  let originalLength = 0;
  try {
    const row =
      plan.get(credential.id) ??
      plan.get(bytesToB64url(new Uint8Array(credential.rawId)));
    const results = credential.getClientExtensionResults();
    const first = readPrfFirst(results);
    prfOutput = ownedPrfView(first);
    if (prfOutput) {
      ownedFirst = first;
      originalLength = prfOutput.byteLength;
    }
    if (!row || !prfOutput || prfOutput.byteLength < MIN_PRF_OUTPUT_BYTES)
      return false;
    const vaultStore = await currentSignInPrfVault();
    if (
      !vaultStore ||
      !vaultStore.isUnlocked() ||
      vaultStore.activeTomb() !== tomb
    )
      return true;
    if (row.existing) {
      const assertedId = bytesToB64url(new Uint8Array(credential.rawId));
      const record = vaultStore.protection
        .listProtectors()
        .find(
          (item) =>
            item.kind === "webauthn-prf" &&
            (localCredentialId(item.credentialIdB64) === assertedId ||
              localCredentialId(item.credentialIdB64) === credential.id),
        );
      if (record?.kind === "webauthn-prf") {
        const heldPrf = viewBuffer(prfOutput);
        try {
          const opened = await unwrapVaultKeyWithPrf(
            {
              credentialIdB64: record.credentialIdB64,
              userIdB64: "",
              prfSaltB64: record.saltB64,
              wrap: record.wrap,
            },
            heldPrf,
          );
          opened.fill(0);
        } finally {
          new Uint8Array(heldPrf).fill(0);
        }
      }
      return true;
    }
    const userId = new TextEncoder().encode(principalId);
    // The enrollment service borrows this owned copy until its promise settles;
    // it must neither retain nor transfer the buffer beyond that lifetime.
    const heldPrf = viewBuffer(prfOutput);
    let candidate: Awaited<
      ReturnType<SignInPrfVault["protection"]["enrollHeldWebauthnPrf"]>
    >;
    try {
      candidate = await vaultStore.protection.enrollHeldWebauthnPrf({
        prfOutput: heldPrf,
        prfSalt: row.salt,
        credentialId: viewBuffer(new Uint8Array(credential.rawId)),
        userId: viewBuffer(userId),
      });
    } finally {
      new Uint8Array(heldPrf).fill(0);
    }
    await vaultStore.protection.commitEnrollment(candidate.operationId);
    return true;
  } finally {
    try {
      wipeOwnedPrf(prfOutput, ownedFirst, originalLength);
    } finally {
      zeroSignInPrfSalts(plan);
    }
  }
}
