import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requiresFreshOwnerAuthentication } from "./decoy-session.js";
import { hostFetch, identityFetch, identitySeams } from "./identity.js";
import {
  PASSWORD,
  clearVaultSurface,
} from "./vault/protection/protector-enrollment.test-support.js";
import { VaultStore } from "./vault/store.js";

let store: VaultStore;
beforeEach(async () => {
  await clearVaultSurface();
  store = new VaultStore();
  await store.create(PASSWORD);
  store.lock();
  await store.unlock(PASSWORD);
});
afterEach(() => {
  store.lock();
  vi.restoreAllMocks();
});

it("keeps ambient production authority sealed after synthetic lock until fresh owner password admission", async () => {
  const host = vi
    .spyOn(identitySeams, "hostFetch")
    .mockImplementation(async () => new Response("member data"));
  const identity = vi
    .spyOn(identitySeams, "identityFetch")
    .mockImplementation(async () => new Response("identity data"));
  // Ordinary startup retains the established transport behavior.
  await expect(hostFetch("/api/v1/member")).resolves.toBeInstanceOf(Response);
  host.mockClear();
  store.lock();
  await store.createGuest({ decoy: true, resume: false });
  store.lock();
  expect(requiresFreshOwnerAuthentication()).toBe(true);
  await expect(hostFetch("/api/v1/member")).rejects.toThrow(
    /authenticate again/,
  );
  await expect(identityFetch("/v1/principals/me")).rejects.toThrow(
    /authenticate again/,
  );
  expect(host).not.toHaveBeenCalled();
  expect(identity).not.toHaveBeenCalled();
  await expect(store.unlock("wrong owner password")).rejects.toThrow();
  await expect(hostFetch("/api/v1/member")).rejects.toThrow(
    /authenticate again/,
  );
  await store.unlock(PASSWORD);
  expect(requiresFreshOwnerAuthentication()).toBe(false);
  await expect(hostFetch("/api/v1/member")).resolves.toBeInstanceOf(Response);
  await expect(identityFetch("/v1/principals/me")).resolves.toBeInstanceOf(
    Response,
  );
  expect(host).toHaveBeenCalledTimes(1);
  expect(identity).toHaveBeenCalledTimes(1);
});

it("ordinary guest creation after synthetic lock cannot reactivate ambient production sessions", async () => {
  const host = vi
    .spyOn(identitySeams, "hostFetch")
    .mockResolvedValue(new Response("owner data"));
  store.lock();
  await store.createGuest({ decoy: true, resume: false });
  store.lock();
  await store.createGuest({ resume: false });
  expect(requiresFreshOwnerAuthentication()).toBe(true);
  await expect(hostFetch("/api/v1/member")).rejects.toThrow(
    /authenticate again/,
  );
  store.lock();
  await expect(hostFetch("/api/v1/member")).rejects.toThrow(
    /authenticate again/,
  );
  expect(host).not.toHaveBeenCalled();
});
