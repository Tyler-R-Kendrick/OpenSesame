/** @vitest-environment jsdom */
import { createItem } from "@opensesame/vault-core";
import {
  type WebMcpToolDescriptor,
  createWebMcpRegistrar,
} from "@opensesame/webmcp";
import { afterEach, expect, it, vi } from "vitest";
import { persistentBrowserOwner } from "../browser/security-integration/management-host.fixture.js";
import { clearActivePresentation } from "../lib/duress/compartment/presentation-runtime.js";
import { kvFlush, kvForgetAll } from "../lib/kv.js";
import { enrollRetiredCredential } from "../lib/retired-credentials/index.js";
import { vaultStore } from "../lib/vault/store.js";
import { unlockWithPasswordAfterDuressGate } from "../screens/unlock/unlock-password-duress.js";
import { VAULT_TOOLS, resetTotpRateLimitForTests } from "./vault-tools.js";

afterEach(async () => {
  vi.restoreAllMocks();
  clearActivePresentation();
  vaultStore.lock();
  await kvFlush();
  kvForgetAll();
  vi.unstubAllGlobals();
  resetTotpRateLimitForTests();
});
it.each(["direct", "registered"])(
  "withholds a suspended genuine TOTP after retired readmission (%s)",
  async (route) => {
    const owner = await persistentBrowserOwner();
    await vaultStore.unlock(owner.password);
    const account = createItem("account", "Private authenticator");
    account.methods = [
      {
        id: crypto.randomUUID(),
        type: "authenticator",
        secret: "JBSWY3DPEHPK3PXP",
      },
    ];
    await vaultStore.saveItem(account);
    await enrollRetiredCredential({
      tomb: "personal",
      currentPassword: owner.password,
      retiredPassword: "old-totp-password",
      response: "synthetic_decoy",
      acknowledgePasswordVerifierRisk: true,
    });
    const tool = VAULT_TOOLS.find(
      (entry) => entry.name === "opensesame_totp_code",
    );
    if (!tool) throw new Error("Missing real TOTP tool");
    let descriptor: WebMcpToolDescriptor | undefined;
    const registrar = createWebMcpRegistrar(
      {
        registerTool: (entry) => {
          descriptor = entry;
          return null;
        },
      },
      { appId: "pages" },
    );
    const unregister = registrar.register([tool]);
    const invoke = () =>
      route === "direct"
        ? tool.execute({ itemId: account.id })
        : descriptor?.execute({ itemId: account.id });
    expect(JSON.stringify(await invoke())).toMatch(/\d{6}/);
    resetTotpRateLimitForTests();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let first = true;
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
      const result = await sign(...args);
      if (args[0] === "HMAC" && first) {
        first = false;
        entered();
        await held;
      }
      return result;
    });
    const pending = Promise.resolve(invoke()).then(
      (value) => ({ value }),
      () => ({ refused: true }),
    );
    await started;
    vaultStore.lock();
    await unlockWithPasswordAfterDuressGate(vaultStore, "old-totp-password");
    expect(vaultStore.getSnapshot().decoy).toBe(true);
    vaultStore.lock();
    await vaultStore.unlock(owner.password);
    release();
    const result = await pending;
    if (route === "direct") expect(result).toEqual({ refused: true });
    else expect(result).toMatchObject({ value: { isError: true } });
    vi.restoreAllMocks();
    resetTotpRateLimitForTests();
    expect(JSON.stringify(await invoke())).toMatch(/\d{6}/);
    unregister();
  },
);

it("refuses an old metadata create after genuine share authorization and owner replacement", async () => {
  const owner = await persistentBrowserOwner();
  await vaultStore.unlock(owner.password);
  await enrollRetiredCredential({
    tomb: "personal",
    currentPassword: owner.password,
    retiredPassword: "old-write-password",
    response: "synthetic_decoy",
    acknowledgePasswordVerifierRisk: true,
  });
  const { shareReachSeams } = await import("../lib/local-share-reach.js");
  const resolveRole = shareReachSeams.resolveCurrentAccessRole;
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let first = true;
  vi.spyOn(shareReachSeams, "resolveCurrentAccessRole").mockImplementation(
    async (tomb) => {
      const role = await resolveRole(tomb);
      if (first) {
        first = false;
        entered();
        await held;
      }
      return role;
    },
  );
  const tool = VAULT_TOOLS.find(
    (entry) => entry.name === "opensesame_vault_item_write",
  );
  if (!tool) throw new Error("Missing real write tool");
  const pending = Promise.resolve(
    tool.execute({ kind: "note", name: "Old owner intent" }),
  ).then(
    () => "accepted",
    () => "refused",
  );
  await started;
  vaultStore.lock();
  await unlockWithPasswordAfterDuressGate(vaultStore, "old-write-password");
  vaultStore.lock();
  await vaultStore.unlock(owner.password);
  release();
  expect(await pending).toBe("refused");
  const rawItems = vaultStore.getSnapshot().rawItems;
  if (!rawItems) throw new Error("Missing admitted raw owner items");
  expect(rawItems.some((item) => item.name === "Old owner intent")).toBe(false);
  vi.restoreAllMocks();
  await tool.execute({ kind: "note", name: "Fresh owner intent" });
  expect(
    vaultStore
      .getSnapshot()
      .items.some((item) => item.name === "Fresh owner intent"),
  ).toBe(true);
});
