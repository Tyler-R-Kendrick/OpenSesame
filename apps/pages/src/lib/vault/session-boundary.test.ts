import { beforeEach, describe, expect, it } from "vitest";
import { kvDelete } from "../kv.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
} from "../vfs.js";
import { WrongPasswordError } from "./crypto.js";
import { itemTypeRegistry, syncInstalledTypes } from "./item-types.js";
import { ATTEMPTS_KEY, VaultStore } from "./store.js";

const PASSWORD = "correct horse battery staple";

const RESIDENT_ID = JSON.stringify({
  apiVersion: "opensesame.dev/v1alpha1",
  kind: "VaultItemType",
  metadata: {
    id: "resident-id",
    version: "1.0.0",
    publisher: "https://community.test",
  },
  spec: {
    title: "Resident ID",
    plural: "Resident IDs",
    extension: ".rid",
    summary: "A national residence permit.",
    categories: ["identity"],
    sections: [
      {
        id: "card",
        title: "Card",
        fields: [
          { id: "country", type: "country", label: "Country", required: true },
          { id: "permitNumber", type: "concealed", label: "Permit number" },
          { id: "expiresAt", type: "date", label: "Expires" },
        ],
      },
    ],
    native: {
      secret: "permitNumber",
      trailer: [
        { key: "country", field: "country" },
        { key: "expires_at", field: "expiresAt" },
      ],
    },
    cxf: { credential: "identity-document" },
    subtitle: ["country", "expiresAt"],
    search: ["country"],
  },
});

describe("vault session boundary", () => {
  beforeEach(async () => {
    syncInstalledTypes(undefined);
    await vfsFlush();
    kvDelete(ATTEMPTS_KEY);
    kvDelete(tombFileKey(PERSONAL_TOMB, HEADER_PATH));
    kvDelete(tombFileKey(PERSONAL_TOMB, BODY_PATH));
    kvDelete(tombFileKey(PERSONAL_TOMB, MIGRATION_MARKER_PATH));
    kvDelete(tombFileKey(PERSONAL_TOMB, INDEX_PATH));
  });

  it("installs item types only after the second step, and clears them on lock", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    const installed = await store.installItemTypeDefinition(RESIDENT_ID);
    expect(installed.ok).toBe(true);
    expect(itemTypeRegistry().has("resident-id")).toBe(true);
    const uri = await store.beginTotpEnrollment();
    const secret = new URL(uri).searchParams.get("secret") ?? "";
    const { totpCode, parseTotp } = await import("./totp.js");
    await store.confirmTotpEnrollment(await totpCode(parseTotp(secret)));
    const selfId = store.getSnapshot().header?.unlocks?.totp?.selfItemId ?? "";
    await store.trashItem(selfId);
    store.lock();
    expect(itemTypeRegistry().has("resident-id")).toBe(false);

    const reopened = new VaultStore();
    await reopened.unlock(PASSWORD);
    expect(reopened.getSnapshot().awaitingSecondStep).toBe(true);
    expect(itemTypeRegistry().has("resident-id")).toBe(false);
    await expect(reopened.confirmTotp("000000")).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
    expect(itemTypeRegistry().has("resident-id")).toBe(false);
    await reopened.confirmTotp(await totpCode(parseTotp(secret)));
    expect(reopened.getSnapshot().status).toBe("unlocked");
    expect(itemTypeRegistry().has("resident-id")).toBe(true);
    reopened.lock();
    expect(itemTypeRegistry().has("resident-id")).toBe(false);
  });
});
