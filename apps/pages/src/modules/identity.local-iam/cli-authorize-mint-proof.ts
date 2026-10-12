/**
 * CLI authorize humanProof minting for the Pages lazy leaf (ADR 0186).
 * Inlined here so we never dynamic-import app-core human-proof.js — Rollup
 * otherwise emits a ~400 KiB async chunk beside the vault graph.
 */

import type { VaultHeader } from "@opensesame/vault-core";
import { WrongPasswordError } from "@opensesame/vault-core";
import type { CliAuthorizeRow } from "./cli-authorize-net.js";

const PREFIX = "oschip1:";

function bindingFromRow(row: CliAuthorizeRow) {
  return {
    requestId: row[0],
    respondNonce: row[3],
    terminalSessionId: row[1],
  };
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return new Uint8Array(digest);
}

async function proofMac(
  binding: ReturnType<typeof bindingFromRow>,
  kind: "pin" | "passkey",
  material: Uint8Array,
): Promise<string> {
  const seed = new TextEncoder().encode(
    [
      binding.requestId,
      binding.respondNonce,
      binding.terminalSessionId,
      kind,
      bytesToHex(material),
    ].join("\0"),
  );
  return bytesToHex(await sha256(seed));
}

function formatProof(kind: "pin" | "passkey", mac: string): string {
  return `${PREFIX}${kind}:${mac}`;
}

export async function mintCliAuthorizePasskeyProof(
  row: CliAuthorizeRow,
): Promise<string> {
  const { vaultStore } = await import(
    "@opensesame/app-core/lib/vault/store.js"
  );
  const probe = await vaultStore.probePasskeyCeremony();
  const binding = bindingFromRow(row);
  const fingerprint = await sha256(new Uint8Array(probe.prfOutput));
  const mac = await proofMac(binding, "passkey", fingerprint);
  return formatProof("passkey", mac);
}

export async function mintCliAuthorizePinProof(
  row: CliAuthorizeRow,
  pin: string,
  header: VaultHeader,
): Promise<string> {
  const binding = bindingFromRow(row);
  const { onCompleteUnlockCodeSubmission } = await import(
    "@opensesame/app-core/sections/settings/security/duress-unlock-bridge.js"
  );
  const duressOutcome = await onCompleteUnlockCodeSubmission(pin, {
    requireDurable: false,
  });
  if (duressOutcome.kind === "duress") {
    throw new WrongPasswordError("That PIN did not work.");
  }
  const [
    { scopedKey },
    { ATTEMPTS_KEY },
    { recordFailedUnlock },
    { unwrapPin },
  ] = await Promise.all([
    import("@opensesame/app-core/lib/projects.js"),
    import("@opensesame/app-core/lib/vault/store-scope.js"),
    import("@opensesame/app-core/lib/vault/unlock-attempts.js"),
    import("@opensesame/app-core/lib/vault/primary-unwrap.js"),
  ]);
  const attemptsKey = scopedKey(ATTEMPTS_KEY);
  const raw = await unwrapPin(header, pin, () =>
    recordFailedUnlock(attemptsKey),
  );
  const fingerprint = await sha256(raw);
  raw.fill(0);
  const mac = await proofMac(binding, "pin", fingerprint);
  return formatProof("pin", mac);
}
