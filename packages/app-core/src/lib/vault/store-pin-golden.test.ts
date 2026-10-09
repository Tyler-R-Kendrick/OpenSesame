/** @vitest-environment jsdom */
import { readVaultFile } from "@opensesame/vault-core";
import { afterEach, describe, expect, it } from "vitest";
import fixture from "../../../../../spec/conformance/vault-vectors.json" with {
  type: "json",
};
import { kvDelete, kvSet } from "../kv.js";
import { writeLastVaultId } from "../last-vault.js";
import {
  PROJECTS_KEY,
  rehydrateProjects,
  setActiveProject,
} from "../projects.js";
import {
  BODY_PATH,
  HEADER_PATH,
  lockAllTombs,
  registerTomb,
  tombFileKey,
} from "../vfs.js";
import { PIN_PBKDF2_ITERATIONS } from "./pin-kdf.js";
import { ATTEMPTS_KEY, VaultStore } from "./store.js";

afterEach(async () => {
  lockAllTombs();
  kvDelete(PROJECTS_KEY);
  rehydrateProjects();
});

describe("VaultStore PIN golden vectors", () => {
  // Golden vector predates the PIN KDF floor bump; the tomb must still open.
  it("unlocks a golden-vector vault whose PIN wrap kept the legacy iteration floor", async () => {
    const vector = fixture.vectors["backup-project"];
    const opened = readVaultFile(vector.file);
    const pinWrap = opened.header.unlocks?.pin;
    expect(pinWrap?.kdf.iterations).toBe(PIN_PBKDF2_ITERATIONS);

    const tomb = opened.tomb;
    await registerTomb(tomb);
    kvDelete(ATTEMPTS_KEY);
    kvDelete(tombFileKey(tomb, HEADER_PATH));
    kvDelete(tombFileKey(tomb, BODY_PATH));
    kvSet(tombFileKey(tomb, HEADER_PATH), JSON.stringify(opened.header));
    kvSet(tombFileKey(tomb, BODY_PATH), JSON.stringify(opened.body));
    writeLastVaultId(tomb);
    rehydrateProjects();
    await setActiveProject(tomb);

    const store = new VaultStore();
    store.loadActiveProjectScope();
    expect(store.getSnapshot().status).toBe("locked");
    await store.unlockWithPin(fixture.pin);
    expect(store.getSnapshot().status).toBe("unlocked");

    store.lock();
    const reopened = new VaultStore();
    reopened.loadActiveProjectScope();
    await reopened.unlockWithPin(fixture.pin);
    expect(reopened.getSnapshot().status).toBe("unlocked");
  });
});
