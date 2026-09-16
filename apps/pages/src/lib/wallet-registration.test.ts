import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceIdentitySeams } from "./device-identity.js";
import {
  WalletRegistrationUnavailable,
  listWalletRegistrations,
} from "./wallet-registration.js";

describe("wallet-registration client", () => {
  const original = deviceIdentitySeams.remoteIdentityApi;

  beforeEach(() => {
    deviceIdentitySeams.remoteIdentityApi = () => "";
  });

  afterEach(() => {
    deviceIdentitySeams.remoteIdentityApi = original;
  });

  it("refuses without an Identity API (local authority preserved)", async () => {
    await expect(listWalletRegistrations()).rejects.toBeInstanceOf(
      WalletRegistrationUnavailable,
    );
  });
});
