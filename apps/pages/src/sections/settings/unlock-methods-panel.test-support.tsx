/**
 * The shared fixture of the Settings › Security panel tests: a vault whose
 * header a test sets, a store of spies, and the WebAuthn, password, QR and
 * Identity seams stubbed. `installUnlockSeams` swaps them in and returns the
 * function that puts the originals back.
 */

import { deviceIdentitySeams } from "@opensesame/app-core/lib/device-identity.js";
import { federationSeams } from "@opensesame/app-core/lib/federation.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import { passwordSeams } from "@opensesame/app-core/lib/vault/password.js";
import {
  type UnlockMethodId,
  type WebauthnHostCheck,
  unlockMethodsSeams,
} from "@opensesame/app-core/lib/vault/unlock-methods.js";
import { webauthnHostSeams } from "@opensesame/app-core/lib/vault/webauthn-host.js";
import type { JsonObject } from "@opensesame/os-domain";
import { screen, within } from "@testing-library/react";
import { vi } from "vitest";
import { qrSeams } from "../../components/QrCode.js";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";

/** What `useVault` answers in these tests: the header, and whether a guest. */
export interface FixtureVault {
  header: JsonObject | null;
  guest?: boolean;
}

/** The vault the next render reads; a test replaces `current`. */
export interface FixtureVaultRef {
  current: FixtureVault;
}

export const vault: FixtureVaultRef = { current: { header: null } };

export const store = {
  enrollPasskey: vi.fn(),
  removePasskey: vi.fn(),
  enrollPin: vi.fn(),
  removePin: vi.fn(),
  enrollPassword: vi.fn(),
  changeMasterPassword: vi.fn(),
  removePassword: vi.fn(),
  beginTotpEnrollment: vi.fn(),
  confirmTotpEnrollment: vi.fn(),
  cancelTotpEnrollment: vi.fn(),
  removeTotp: vi.fn(),
  beginCodeEnrollment: vi.fn(),
  confirmCodeEnrollment: vi.fn(),
  cancelCodeEnrollment: vi.fn(),
  removeCode: vi.fn(),
  describeCodeChannel: vi.fn(),
  recoveryCodes: vi.fn(),
  generateRecoveryCodes: vi.fn(),
};

export const listAvailableUnlockMethods = vi.fn((): UnlockMethodId[] => [
  "password",
]);
export const checkWebauthnHost = vi.fn(
  (): WebauthnHostCheck => ({
    ok: true,
    hostname: "localhost",
    reason: "",
    fixUrl: null,
  }),
);
const describeWebauthnError = vi.fn((error: { message?: string }) =>
  error instanceof Error ? `webauthn: ${error.message}` : "webauthn failed",
);

export const identityApi = { current: "http://127.0.0.1:8788" };

/** Swap every seam the panel reads for the fixture's; returns the undo. */
export function installUnlockSeams(): () => void {
  const originals = {
    vaultHooks: { ...vaultHooksSeams },
    unlockMethods: { ...unlockMethodsSeams },
    webauthnHost: { ...webauthnHostSeams },
    password: { ...passwordSeams },
    qr: { ...qrSeams },
    identity: { ...identitySeams },
    federation: { ...federationSeams },
    remoteIdentityApi: deviceIdentitySeams.remoteIdentityApi,
  };
  Object.assign(vaultHooksSeams, {
    useVault: () => vault.current,
    useVaultStore: () => store,
  });
  Object.assign(unlockMethodsSeams, { listAvailableUnlockMethods });
  Object.assign(webauthnHostSeams, {
    checkWebauthnHost,
    describeWebauthnError,
  });
  Object.assign(passwordSeams, {
    estimateStrength: (password: string) => ({
      score: password.length >= 12 ? 3 : 1,
      label: password.length >= 12 ? "Strong" : "Weak",
    }),
  });
  Object.assign(qrSeams, {
    QrCode: ({ value }: { value: string }) => (
      <div data-testid="qr">{value}</div>
    ),
  });
  Object.assign(identitySeams, { identityBase: () => identityApi.current });
  deviceIdentitySeams.remoteIdentityApi = () => identityApi.current;
  Object.assign(federationSeams, { loadSession: () => null });
  return () => {
    Object.assign(vaultHooksSeams, originals.vaultHooks);
    Object.assign(unlockMethodsSeams, originals.unlockMethods);
    Object.assign(webauthnHostSeams, originals.webauthnHost);
    Object.assign(passwordSeams, originals.password);
    Object.assign(qrSeams, originals.qr);
    Object.assign(identitySeams, originals.identity);
    Object.assign(federationSeams, originals.federation);
    deviceIdentitySeams.remoteIdentityApi = originals.remoteIdentityApi;
  };
}

export function passwordOnlyHeader() {
  vault.current = { header: { wrap: {}, kdf: {}, unlocks: {} } };
  listAvailableUnlockMethods.mockReturnValue(["password"]);
}

export function pinAndPasswordHeader() {
  vault.current = {
    header: { wrap: {}, kdf: {}, unlocks: { pin: {} } },
  };
  listAvailableUnlockMethods.mockReturnValue(["password", "pin"]);
}

export function guestHeader() {
  vault.current = { header: null, guest: true };
  listAvailableUnlockMethods.mockReturnValue([]);
}

/** The one row a method has, found by its name. */
export function row(name: string) {
  const heading = screen.getByText(name, { selector: ".sw__name" });
  const container = heading.closest(".sw");
  if (!(container instanceof HTMLElement)) {
    throw new Error(`no row for ${name}`);
  }
  return within(container);
}

export function sheet() {
  return within(screen.getByRole("dialog"));
}
