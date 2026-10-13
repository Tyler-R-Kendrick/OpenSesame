/**
 * CLI authorize humanProof minting for the Pages lazy leaf (ADR 0186).
 * Inlined here so we never dynamic-import app-core human-proof.js — Rollup
 * otherwise emits a ~400 KiB async chunk beside the vault graph.
 */

import type { VaultHeader } from "@opensesame/vault-core";
import { WrongPasswordError } from "@opensesame/vault-core";
import { readCliAppIntegrationBearer } from "@opensesame/app-core/lib/cli-app-integration/bearer-session.js";

export type CliAuthorizeRow = readonly [
  requestId: string,
  terminalSessionId: string,
  verb: string,
  respondNonce: string,
];

const PREFIX = "oschip1:";

function bindingFromRow(row: CliAuthorizeRow) {
  return {
    requestId: row[0],
    terminalSessionId: row[1],
    respondNonce: row[3],
    verb: row[2],
  };
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function humanProofMessage(binding: ReturnType<typeof bindingFromRow>): string {
  return [
    binding.requestId,
    binding.terminalSessionId,
    binding.respondNonce,
    binding.verb,
  ].join("\0");
}

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const keyBytes = new TextEncoder().encode(key);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(message),
  );
  return bytesToHex(new Uint8Array(sig));
}

function requirePairingSecret(): string {
  const secret = readCliAppIntegrationBearer();
  if (!secret) {
    throw new Error("cli_app_pairing_required");
  }
  return secret;
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
  if (new Uint8Array(probe.prfOutput).byteLength === 0) {
    throw new WrongPasswordError("Passkey confirmation was cancelled.");
  }
  const binding = bindingFromRow(row);
  const mac = await hmacSha256Hex(
    requirePairingSecret(),
    humanProofMessage(binding),
  );
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
  raw.fill(0);
  const mac = await hmacSha256Hex(
    requirePairingSecret(),
    humanProofMessage(binding),
  );
  return formatProof("pin", mac);
}
