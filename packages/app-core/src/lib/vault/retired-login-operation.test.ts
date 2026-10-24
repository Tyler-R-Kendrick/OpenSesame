/** Real verifier crypto with explicit physical transport doubles; not browser evidence. */
import { describe, expect, it } from "vitest";
import { parseRetainedRetiredCredentialRecordsV2 } from "../retired-credentials/records-v2.js";
import {
  appendRetiredInteraction,
  readRetiredLoginData,
} from "./retired-login-operation.js";
import {
  OWNER_PASSWORD,
  retiredOwnerFixture,
} from "./retired-owner.fixture.js";
const password = "previously retired scalar secret 9524";
const slot = "tomb/personal/retired-credentials.v2";
async function fixture(response: "reject" | "synthetic_decoy" = "reject") {
  const f = await retiredOwnerFixture();
  await f.store.beginRetired(
    { kind: "password", secret: OWNER_PASSWORD },
    {
      kind: "change",
      change: { type: "enroll", password, response },
    },
  );
  return f;
}
describe("physical retired login data", () => {
  it("recognizes exact live credential and records observation without owner admission", async () => {
    const f = await fixture();
    try {
      expect(
        await readRetiredLoginData("personal", `${password} `, () => undefined),
      ).toBeNull();
      const data = await readRetiredLoginData(
        "personal",
        password,
        () => undefined,
      );
      expect(data?.trap.response).toBe("reject");
      const raw = f.records.get(slot);
      if (!raw) throw new Error("Missing retained record");
      expect(
        parseRetainedRetiredCredentialRecordsV2(raw).events.at(-1)?.type,
      ).toBe("retired_credential_observed");
      expect(f.store.isUnlocked()).toBe(false);
      expect(f.store.isGenuineSession()).toBe(false);
      expect(f.held).toEqual([]);
    } finally {
      f.dispose();
    }
  });
  it("refuses malformed records and never selects a stale context", async () => {
    const f = await fixture();
    try {
      const raw = f.records.get(slot);
      if (!raw) throw new Error("Missing retained record");
      const records = parseRetainedRetiredCredentialRecordsV2(raw);
      f.records.set(
        slot,
        JSON.stringify({
          ...records,
          context: {
            ...records.context,
            rootEpoch: records.context.rootEpoch + 1,
          },
        }),
      );
      expect(
        await readRetiredLoginData("personal", password, () => undefined),
      ).toBeNull();
      f.records.set(slot, "{}");
      await expect(
        readRetiredLoginData("personal", password, () => undefined),
      ).rejects.toThrow();
      expect(f.held).toEqual([]);
    } finally {
      f.dispose();
    }
  });
  it("records all portable synthetic interactions and refuses cancelled publication", async () => {
    const f = await fixture("synthetic_decoy");
    try {
      const data = await readRetiredLoginData(
        "personal",
        password,
        () => undefined,
      );
      if (!data) throw new Error("Missing recognized credential");
      for (const action of [
        "vault_read",
        "vault_export",
        "vault_write",
        "authority_denied",
      ] as const)
        await appendRetiredInteraction(data, action, () => undefined);
      const before = f.records.get(slot);
      if (!before) throw new Error("Missing retained record");
      expect(
        parseRetainedRetiredCredentialRecordsV2(before).events,
      ).toHaveLength(5);
      await expect(
        appendRetiredInteraction(data, "vault_write", () => {
          throw new Error("cancelled");
        }),
      ).rejects.toThrow("cancelled");
      expect(f.records.get(slot)).toBe(before);
    } finally {
      f.dispose();
    }
  });
  it("opens only isolated scratch and returns to the original locked vault", async () => {
    const f = await fixture("synthetic_decoy");
    try {
      let invalidated = 0;
      const unsubscribe = f.store.onLock(() => {
        invalidated++;
      });
      await f.store.unlock(password);
      expect(invalidated).toBe(1);
      expect(f.store.isUnlocked()).toBe(true);
      expect(f.store.isGenuineSession()).toBe(false);
      expect(f.store.getSnapshot().guest).toBe(true);
      expect(f.store.activeTomb()).toBe("guest-scratch");
      const honey = f.store
        .getSnapshot()
        .items.filter(
          (item) =>
            item.kind === "account" &&
            item.methods[0]?.type === "password" &&
            /^osr_c0de[0-9a-f]{28}$/u.test(String(item.methods[0].secret)),
        );
      expect(honey).toHaveLength(6);
      expect(() => f.store.exportSealed()).toThrow("owner vault");
      await expect(f.store.enrollPin("48291037")).rejects.toThrow(
        "owner vault",
      );
      await expect(f.store.sealedSnapshot()).rejects.toThrow("owner vault");
      await expect(f.store.createWithPasskey()).rejects.toThrow("owner vault");
      await expect(f.store.forkUnlockedIntoActiveScope()).rejects.toThrow(
        "owner vault",
      );
      await expect(f.store.openActiveScopeWithCurrentKey()).rejects.toThrow(
        "owner vault",
      );
      await expect(
        f.store.beginRetired(
          { kind: "password", secret: OWNER_PASSWORD },
          { kind: "inspect" },
        ),
      ).rejects.toThrow();
      f.store.lock();
      expect(f.store.activeTomb()).toBe("personal");
      expect(f.store.isUnlocked()).toBe(false);
      expect(f.store.getSnapshot().status).toBe("locked");
      unsubscribe();
    } finally {
      f.dispose();
    }
  });
});
