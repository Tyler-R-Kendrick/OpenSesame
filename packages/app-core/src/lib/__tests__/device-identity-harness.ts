/**
 * Shared ground for the device identity host tests: a vault view the test
 * sets, tombs opened with keys it remembers (a re-unlock is the same vault),
 * a faithful Web Locks double, and the three calls every test makes.
 */

import { overlapCast } from "@opensesame/os-domain";
import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { defaultCapabilityConnectors } from "../capabilities.js";
import {
  deviceIdentityFetch,
  resetDeviceIdentitySessionsForTests,
} from "../device-identity-host.js";
import { forgetDeviceIdentityKeyInFlightForTests } from "../device-identity-key.js";
import { resetDeviceRoutesForTests } from "../device-identity-routes.js";
import {
  type DeviceVaultView,
  deviceVaultSeams,
} from "../device-identity-vault.js";
import { saveSettings } from "../settings.js";
import { readFile, unlockTomb, writeFile } from "../vfs.js";
import { webLocksDouble } from "./web-locks-double.js";

export const KEY_PATH = "config/device-identity-key";

/** What the host reads of the vault. Tests assign `harness.view`. */
type Harness = { view: DeviceVaultView };
export const harness: Harness = { view: { kind: "none" } };

/** The key each tomb was opened with, so a re-unlock is the same vault. */
export const vaultKeys = new Map<string, CryptoKey>();

const realView = deviceVaultSeams.view;

/** Register the setup and teardown every device identity host test needs. */
export function useDeviceIdentityHarness(): void {
  beforeEach(() => {
    saveSettings({
      hostApi: "",
      identityApi: "",
      daemonApi: "",
      capabilityConnectors: {
        ...defaultCapabilityConnectors(),
        encryption: { providerId: "webcrypto" },
        history: { providerId: "github" },
      },
    });
    harness.view = { kind: "none" };
    deviceVaultSeams.view = () => harness.view;
    vi.stubGlobal("navigator", { locks: webLocksDouble() });
    resetDeviceIdentitySessionsForTests();
    resetDeviceRoutesForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    forgetDeviceIdentityKeyInFlightForTests();
    deviceVaultSeams.view = realView;
    resetDeviceIdentitySessionsForTests();
    resetDeviceRoutesForTests();
  });
}

export async function open(guest = false): Promise<string> {
  const tomb = `device-principal-${crypto.randomUUID()}`;
  const { vaultKey } = await mintVaultKey();
  vaultKeys.set(tomb, vaultKey);
  unlockTomb(tomb, vaultKey);
  harness.view = { kind: "unlocked", tomb, guest };
  return tomb;
}

export async function mint(): Promise<Response> {
  return deviceIdentityFetch("/v1/principals/provisional", {
    method: "POST",
    body: "{}",
  });
}

export async function me(token: string): Promise<Response> {
  return deviceIdentityFetch("/v1/principals/me", {
    headers: { authorization: `Bearer ${token}` },
  });
}

export type MintedSession = { principalId: string; accessToken: string };

export async function session(): Promise<MintedSession> {
  const res = await mint();
  expect(res.status).toBe(201);
  const body = overlapCast(await res.json());
  return {
    principalId: String(body.principalId),
    accessToken: String(body.accessToken),
  };
}

export async function plant(tomb: string, bytes: string): Promise<void> {
  await writeFile(tomb, KEY_PATH, new TextEncoder().encode(bytes));
}

export async function stored(tomb: string): Promise<string> {
  return new TextDecoder().decode(await readFile(tomb, KEY_PATH));
}
