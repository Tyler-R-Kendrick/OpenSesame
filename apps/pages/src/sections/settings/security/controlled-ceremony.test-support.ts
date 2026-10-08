import { File } from "node:buffer";
import { webcrypto } from "node:crypto";
import { persistentBrowserOwner } from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import { configureHost } from "@opensesame/app-core/host.js";
import { clearActivePresentation } from "@opensesame/app-core/lib/duress/compartment/presentation-runtime.js";
import { kvFlush } from "@opensesame/app-core/lib/kv.js";
import { enrollRetiredCredential } from "@opensesame/app-core/lib/retired-credentials/index.js";
import { flushRetiredCredentialTelemetry } from "@opensesame/app-core/lib/retired-credentials/telemetry-queue.js";
import { unlockWithRetiredCredentialGate } from "@opensesame/app-core/lib/retired-credentials/unlock.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";

export const RETIREMENTS = ["lock", "synthetic", "fresh-owner"] as const;
export type Retirement = (typeof RETIREMENTS)[number];
const RETIRED = "selected generated PWA ceremony retired password";

/** Real browser composition and crypto; only browser storage APIs are doubled. */
export async function ceremonyOwner(synthetic = false) {
  vi.stubGlobal("crypto", webcrypto);
  const owner = await persistentBrowserOwner();
  await vaultStore.unlock(owner.password);
  if (synthetic)
    await enrollRetiredCredential({
      tomb: "personal",
      currentPassword: owner.password,
      retiredPassword: RETIRED,
      response: "synthetic_decoy",
      acknowledgePasswordVerifierRisk: true,
    });
  return {
    ...owner,
    async retire(kind: Retirement) {
      vaultStore.lock();
      if (kind === "synthetic") {
        expect(await unlockWithRetiredCredentialGate(vaultStore, RETIRED)).toBe(
          "retired_credential_session",
        );
        expect(vaultStore.getSnapshot()).toMatchObject({ decoy: true });
      }
      if (kind === "fresh-owner") await vaultStore.unlock(owner.password);
    },
    async recover() {
      vaultStore.lock();
      vaultStore.loadActiveProjectScope();
      await vaultStore.unlock(owner.password);
      expect(vaultStore.getSnapshot()).toMatchObject({
        status: "unlocked",
        tomb: "personal",
        guest: false,
        decoy: false,
      });
    },
  };
}

export async function restoreCeremonyOwner() {
  await flushRetiredCredentialTelemetry();
  vaultStore.lock();
  clearActivePresentation();
  await kvFlush();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  configureHost(createTestHost());
}

export function inputPassword(value: string) {
  fireEvent.change(screen.getByLabelText("Current vault password"), {
    target: { value },
  });
}

export function passwordField() {
  const field = screen.getByLabelText("Current vault password");
  if (!(field instanceof HTMLInputElement)) throw new Error("Missing input");
  return field;
}

export function button(name: string) {
  const element = screen.getByRole("button", { name });
  if (!(element instanceof HTMLButtonElement)) throw new Error("Missing key");
  return element;
}

export async function perform(name: string, password: string) {
  inputPassword(password);
  await waitFor(() => expect(button(name).disabled).toBe(false));
  fireEvent.click(button(name));
  await waitFor(() => expect(passwordField().value).toBe(""));
  await waitFor(() => expect(passwordField().disabled).toBe(false));
}

/** Node's File supplies the real asynchronous File.text API missing in jsdom. */
export function pairingFile(raw: string) {
  return new File([raw], "pairing.json", { type: "application/json" });
}

export function selectPairing(file?: File) {
  fireEvent.change(screen.getByLabelText("Receiver pairing file"), {
    target: { files: file ? [file] : [] },
  });
}

/** Completion gate, never a synthetic authority or crypto result. */
export function gate() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export async function releaseGate(held: ReturnType<typeof gate>) {
  await act(async () => held.release());
}
