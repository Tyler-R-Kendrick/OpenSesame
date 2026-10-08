/** @vitest-environment jsdom */

import { configureHost, host } from "@opensesame/app-core/host.js";
import { webLocksDouble } from "@opensesame/app-core/lib/__tests__/web-locks-double.js";
import { clearVaultSurface } from "@opensesame/app-core/lib/vault/protection/protector-enrollment.test-support.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import { parseTotp, totpCode } from "@opensesame/vault-core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RecoveryCeremony } from "./SecondStepCeremonies.js";
import type { Run } from "./run.js";

async function spendFirstRecoveryCode(
  codes: string[],
  password: string,
): Promise<string> {
  const spent = codes[0];
  if (!spent) throw new Error("Missing genuine first recovery code");
  const selfItemId = vaultStore.getSnapshot().header?.unlocks?.totp?.selfItemId;
  if (!selfItemId) throw new Error("Missing enrolled self authenticator");
  await vaultStore.trashItem(selfItemId);
  vaultStore.lock();
  await vaultStore.unlock(password);
  expect(vaultStore.getSnapshot().awaitingSecondStep).toBe(true);
  await vaultStore.redeemRecoveryCode(spent);
  expect(vaultStore.getSnapshot().status).toBe("unlocked");
  return spent;
}

async function drainAndCloseOwner(
  actions: Promise<void>[],
  created: boolean,
  password: string,
  uri: string,
): Promise<void> {
  cleanup();
  await Promise.all(actions);
  if (!created) return;
  vaultStore.lock();
  vaultStore.loadActiveProjectScope();
  await vaultStore.unlock(password);
  if (vaultStore.getSnapshot().awaitingSecondStep)
    await vaultStore.confirmTotp(await totpCode(parseTotp(uri)));
  vaultStore.lock();
}

it("copies only unused genuine recovery codes and replaces the sealed ledger through the authored ceremony", async () => {
  const originalHost = host();
  const password = "recovery-ceremony-real-owner-password";
  const clipboard = vi.fn(async (_text: string) => {});
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(
    navigator,
    "clipboard",
  );
  let created = false;
  let uri = "";
  const actions: Promise<void>[] = [];
  const failures: unknown[] = [];
  const run: Run = (action) => {
    const pending = action().catch((error) => {
      failures.push(error);
    });
    actions.push(pending);
    return pending;
  };
  configureHost(createTestHost({ locks: webLocksDouble() }));
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboard },
  });
  try {
    await clearVaultSurface();
    vaultStore.loadActiveProjectScope();
    await vaultStore.create(password);
    created = true;
    uri = await vaultStore.beginTotpEnrollment();
    await vaultStore.confirmTotpEnrollment(await totpCode(parseTotp(uri)));
    const originalCodes = await vaultStore.generateRecoveryCodes();
    const spent = await spendFirstRecoveryCode(originalCodes, password);
    render(<RecoveryCeremony busy={false} run={run} />);
    const list = await screen.findByRole("list", { name: "Recovery codes" });
    expect(within(list).getByText(spent).className).toContain("is-used");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledTimes(1));
    expect(clipboard.mock.calls[0]?.[0]).toBe(
      originalCodes.slice(1).join("\n").concat("\n"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Make a new set" }));
    const buttons = screen.getAllByRole("button", { name: "Make a new set" });
    const commit = buttons.at(-1);
    if (!commit) throw new Error("Missing authored regeneration action");
    fireEvent.click(commit);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "I saved them" })).toBeTruthy(),
    );
    await Promise.all(actions);
    expect(failures).toEqual([]);
    const fresh = await vaultStore.recoveryCodes();
    expect(fresh?.codes).toHaveLength(originalCodes.length);
    expect(fresh?.used.every((flag) => !flag)).toBe(true);
    expect(fresh?.codes).not.toContain(spent);
    fireEvent.click(screen.getByRole("button", { name: "I saved them" }));
    cleanup();
    vaultStore.lock();
    await vaultStore.unlock(password);
    await expect(vaultStore.redeemRecoveryCode(spent)).rejects.toThrow();
    const next = fresh?.codes[0];
    if (!next) throw new Error("Missing replacement recovery code");
    await vaultStore.redeemRecoveryCode(next);
    expect(vaultStore.getSnapshot().status).toBe("unlocked");
    const after = await vaultStore.recoveryCodes();
    expect(after?.used[0]).toBe(true);
  } finally {
    try {
      await drainAndCloseOwner(actions, created, password, uri);
    } finally {
      if (clipboardDescriptor)
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      else Reflect.deleteProperty(navigator, "clipboard");
      configureHost(originalHost);
    }
  }
});
