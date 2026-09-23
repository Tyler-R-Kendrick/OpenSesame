import { bytesToB64url } from "@opensesame/sdk-browser";
import { b64ToBytes } from "@opensesame/vault-core";
import type { LocalPasskey } from "./local-credentials.js";
import {
  hasUsablePrfOutput,
  readPrfFirst,
} from "./vault/protection/adapters/webauthn-prf-output.js";
import { unwrapVaultKeyWithPrf } from "./vault/unlock-methods.js";

function viewBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
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
  const { vaultStore } = await import("./vault/store.js");
  if (!vaultStore.isUnlocked() || vaultStore.activeTomb() !== tomb)
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
  const row =
    plan.get(credential.id) ??
    plan.get(bytesToB64url(new Uint8Array(credential.rawId)));
  const results = credential.getClientExtensionResults();
  const first = readPrfFirst(results);
  const supported =
    hasUsablePrfOutput(results) && first !== null && row !== undefined;
  if (!supported || !row || !first) {
    zeroSignInPrfSalts(plan);
    return false;
  }
  const prfOutput = new Uint8Array(first);
  try {
    const { vaultStore } = await import("./vault/store.js");
    if (!vaultStore.isUnlocked() || vaultStore.activeTomb() !== tomb)
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
        const opened = await unwrapVaultKeyWithPrf(
          {
            credentialIdB64: record.credentialIdB64,
            userIdB64: "",
            prfSaltB64: record.saltB64,
            wrap: record.wrap,
          },
          viewBuffer(prfOutput),
        );
        opened.fill(0);
      }
      return true;
    }
    const userId = new TextEncoder().encode(principalId);
    const candidate = await vaultStore.protection.enrollHeldWebauthnPrf({
      prfOutput: viewBuffer(prfOutput),
      prfSalt: row.salt,
      credentialId: viewBuffer(new Uint8Array(credential.rawId)),
      userId: viewBuffer(userId),
    });
    await vaultStore.protection.commitEnrollment(candidate.operationId);
    return true;
  } finally {
    prfOutput.fill(0);
    zeroSignInPrfSalts(plan);
  }
}
