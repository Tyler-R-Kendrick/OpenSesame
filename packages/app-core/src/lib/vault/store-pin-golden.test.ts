/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import fixture from "../../../../../spec/conformance/vault-vectors.json" with {
  type: "json",
};
import { sealedVaultText } from "./offline-backup-file.js";
import { PIN_PBKDF2_ITERATIONS } from "./pin-kdf.js";
import { VaultStore } from "./store.js";

describe("VaultStore PIN golden vectors", () => {
  // Golden vector predates the PIN KDF floor bump; the tomb must still open.
  it("unlocks a golden-vector vault whose PIN wrap kept the legacy iteration floor", async () => {
    const vector = fixture.vectors["backup-project"];
    const store = new VaultStore();
    await store.importSealed(sealedVaultText(vector.file), fixture.password);
    const pinWrap = store.getSnapshot().header?.unlocks?.pin;
    expect(pinWrap?.kdf.iterations).toBe(PIN_PBKDF2_ITERATIONS);
    store.lock();

    const reopened = new VaultStore();
    await reopened.unlockWithPin(fixture.pin);
    expect(reopened.getSnapshot().status).toBe("unlocked");
  });
});
