import { afterEach, expect, it } from "vitest";
import { VaultStore } from "../vault/store.js";
import {
  localVaultSessionGuard,
  requireUnlockedVault,
} from "./local-vault-port.js";
const stores: VaultStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.lock();
});
it("refuses an unlocked guest before backend authority can be created", async () => {
  const store = new VaultStore();
  stores.push(store);
  await store.createGuest();
  expect(store.getSnapshot().status).toBe("unlocked");
  expect(() => requireUnlockedVault(store)).toThrow(
    "Unlock the destination vault first.",
  );
  expect(() => localVaultSessionGuard(store)).toThrow(
    "Unlock the destination vault first.",
  );
});
it("retires captured genuine backend authority across a guest transition", async () => {
  const store = new VaultStore();
  stores.push(store);
  await store.create("controlled genuine backend owner password");
  const guard = localVaultSessionGuard(store);
  expect(guard.current().guest).toBe(false);
  store.lock();
  await store.createGuest();
  expect(() => guard.current()).toThrow("The vault session ended.");
  guard.close();
});
