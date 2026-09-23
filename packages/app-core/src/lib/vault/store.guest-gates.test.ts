import { createVault } from "@opensesame/vault-core";
/**
 * The guest tomb's own gate (ADR 0091): a guest may enroll a PIN or a passkey
 * and an authenticator code, and that gate is what their unlock asks for —
 * including after a reload, when nothing is held in memory.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { kvDelete, kvGet, kvSet } from "../kv.js";
import { GUEST_TOMB, HEADER_PATH, PERSONAL_TOMB, tombFileKey } from "../vfs.js";
import { VaultStore } from "./store.js";

const HEADER_KEY = tombFileKey(PERSONAL_TOMB, HEADER_PATH);

beforeEach(() => {
  kvDelete(HEADER_KEY);
  kvDelete(tombFileKey(GUEST_TOMB, HEADER_PATH));
});

describe("the guest tomb's enrolled gate", () => {
  it("survives a reload and is what unlock asks for (ADR 0091)", async () => {
    const { header } = await createVault("correct horse battery staple");
    kvSet(HEADER_KEY, JSON.stringify(header));
    const store = new VaultStore();
    await store.createGuest();
    // The key first, in the same sheet: the wrap is the key to this tomb, it
    // reaches disk, and a reload must ask for it rather than offer a form with
    // no challenge behind it.
    await store.enrollPin("48291037");
    expect(kvGet(tombFileKey(GUEST_TOMB, HEADER_PATH))).not.toBeNull();

    store.lock();
    store.rehydrate();
    const snap = store.getSnapshot();
    expect(snap.tomb).toBe(GUEST_TOMB);
    expect(snap.status).toBe("locked");
    expect(snap.header?.unlocks?.pin).toBeTruthy();
    // The sealed vault beside it is untouched by any of this.
    expect(kvGet(HEADER_KEY)).toBe(JSON.stringify(header));
  });
});
