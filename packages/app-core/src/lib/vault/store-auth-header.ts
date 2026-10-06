/** Durable authentication authority cannot be borrowed from a stale tab cache. */
import type { VaultHeader } from "@opensesame/vault-core";
import { readTombHeader } from "./store-header.js";
import { withBodyWriteLock } from "./vault-shared-locks.js";

export function authenticationHeaderWitness(
  header: VaultHeader | null,
): string {
  if (!header) throw new Error("There is no vault on this device yet.");
  const { bodyRev: _witness, ...authority } = header;
  return JSON.stringify(authority);
}

export function currentAuthenticationHeader(
  tomb: string,
  check: () => void,
): Promise<VaultHeader | null> {
  check();
  return withBodyWriteLock(tomb, async () => {
    check();
    return readTombHeader(tomb);
  });
}

export function validateAuthenticationHeader(
  tomb: string,
  expected: string,
  check: () => void,
  commit: () => void = () => {},
): Promise<void> {
  check();
  return withBodyWriteLock(tomb, async () => {
    check();
    if (authenticationHeaderWitness(readTombHeader(tomb)) !== expected)
      throw new Error(
        "Vault authentication changed. Enter the current credentials again.",
      );
    check();
    commit();
  });
}

export function publishAuthenticatedSession(
  tomb: string,
  expected: string,
  check: () => void,
  prove: (header: VaultHeader) => Promise<void>,
  publish: () => void,
): Promise<void> {
  check();
  return withBodyWriteLock(tomb, async () => {
    check();
    const header = readTombHeader(tomb);
    if (!header || authenticationHeaderWitness(header) !== expected)
      throw new Error("Vault authentication changed before session admission.");
    await prove(header);
    check();
    if (authenticationHeaderWitness(readTombHeader(tomb)) !== expected)
      throw new Error("Vault authentication changed during session admission.");
    publish();
  });
}
