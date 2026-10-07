import { importVaultKey } from "@opensesame/vault-core";
import type { PasskeyUnlockSessionHost } from "./passkey-unlock-session.js";
import { PIN_MISS, unwrapPassword, unwrapPin } from "./primary-unwrap.js";

export type GuardedUnlockHost = PasskeyUnlockSessionHost & {
  assertCurrent(): void;
};

async function admitRaw(
  host: GuardedUnlockHost,
  raw: Uint8Array,
  miss?: string,
) {
  try {
    host.assertCurrent();
    const key = await importVaultKey(raw);
    host.assertCurrent();
    host.stashRaw(raw);
    await host.afterPrimaryUnwrap(key, miss);
  } catch (error) {
    raw.fill(0);
    throw error;
  }
}

export async function unlockWithPassword(
  host: GuardedUnlockHost,
  password: string,
) {
  host.assertNotLockedOut();
  const header = host.header();
  if (!header) throw new Error("There is no vault on this device yet.");
  await admitRaw(
    host,
    await unwrapPassword(header, password, host.recordFailedUnlock),
  );
}

export async function unlockWithPin(host: GuardedUnlockHost, pin: string) {
  host.assertNotLockedOut();
  const header = host.header();
  if (!header) throw new Error("There is no vault on this device yet.");
  await admitRaw(
    host,
    await unwrapPin(header, pin, host.recordFailedUnlock),
    PIN_MISS,
  );
}
