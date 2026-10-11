/**
 * Environments through a real vault (ADR 0192): sealed with the body, still
 * there after a lock and an unlock, refused while the capability is off, and
 * reported in the tray by key and environment, never by value.
 */

import {
  type ItemEnvironments,
  type VaultItem,
  cellOf,
  createItem,
  environmentNames,
} from "@opensesame/vault-core";
import { beforeEach, describe, expect, it } from "vitest";
import { kvDelete, kvGet } from "../kv.js";
import { clearNotices, listNotices } from "../notices.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
} from "../vfs.js";
import {
  ENVIRONMENT_NOTICE_ID,
  ENVIRONMENT_REUSE_NOTICE_ID,
  clearEnvironmentNotices,
  syncEnvironmentNotices,
} from "./environments-notices.js";
import {
  environmentInView,
  forgetViewedEnvironments,
  viewEnvironment,
  writeEnvironments,
} from "./environments-write.js";
import {
  ENVIRONMENTS_CAPABILITY,
  ENVIRONMENTS_PATH,
  schemaKeys,
} from "./environments.js";
import {
  ATTEMPTS_KEY,
  PREFS_CONFIG_PATH,
  VaultStore,
  vaultStore,
} from "./store.js";
import { LEGACY_PREFS_KEY } from "./tomb-migration.js";

const PASSWORD = "correct horse battery staple";
const APPROVED = { approvedCapabilities: [ENVIRONMENTS_CAPABILITY] };
const OFF = { approvedCapabilities: [] };

function clearVault(): void {
  kvDelete(ATTEMPTS_KEY);
  for (const path of [
    HEADER_PATH,
    BODY_PATH,
    MIGRATION_MARKER_PATH,
    INDEX_PATH,
  ]) {
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
  }
  kvDelete(LEGACY_PREFS_KEY);
  kvDelete(tombFileKey(PERSONAL_TOMB, PREFS_CONFIG_PATH));
}

beforeEach(async () => {
  await vfsFlush();
  clearVault();
  clearNotices();
  forgetViewedEnvironments();
});

function secret(name: string): VaultItem {
  return createItem("secret", name);
}

type Seeded = { store: VaultStore; token: VaultItem };

async function seeded(): Promise<Seeded> {
  const store = new VaultStore();
  await store.create(PASSWORD);
  const token = secret("Stripe key");
  await store.saveItem(token);
  await store.editEnvironments({ op: "add-environment", name: "staging" });
  await store.editEnvironments({ op: "add-environment", name: "production" });
  await store.editEnvironments({ op: "add-key", itemId: token.id });
  await store.editEnvironments({
    op: "set-cell",
    itemId: token.id,
    environment: "production",
    cell: { value: "sk_live_sealed", required: true },
  });
  return { store, token };
}

describe("environments in a vault", () => {
  it("are sealed with the body and survive a lock and an unlock", async () => {
    const { store, token } = await seeded();
    await store.flushPendingWrites();
    store.lock();
    expect(store.getSnapshot().environments).toBeUndefined();
    await store.unlock(PASSWORD);

    const snapshot = store.getSnapshot();
    expect(environmentNames(snapshot.environments)).toEqual([
      "staging",
      "production",
    ]);
    const kept = snapshot.items.find((item) => item.id === token.id);
    expect(cellOf(kept?.environments, "production")).toEqual({
      value: "sk_live_sealed",
      required: true,
    });
    expect(schemaKeys(snapshot.items).map((key) => key.key)).toEqual([
      "STRIPE_KEY",
    ]);
  });

  it("keep their values out of the stored files in the clear", async () => {
    const { store } = await seeded();
    await store.flushPendingWrites();
    await vfsFlush();
    const body = kvGet(tombFileKey(PERSONAL_TOMB, BODY_PATH));
    expect(body).not.toBeNull();
    expect(body).not.toContain("sk_live_sealed");
    expect(body).not.toContain("production");
  });

  it("leave everything as it was when an edit does not fit", async () => {
    const { store, token } = await seeded();
    const before = store.getSnapshot();
    await expect(
      store.editEnvironments({
        op: "set-cell",
        itemId: token.id,
        environment: "qa",
        cell: { value: "nope" },
      }),
    ).rejects.toThrow(/no environment called qa/);
    const after = store.getSnapshot();
    expect(after.environments).toEqual(before.environments);
    expect(
      after.items.find((item) => item.id === token.id)?.environments,
    ).toEqual(before.items.find((item) => item.id === token.id)?.environments);
  });

  it("take a removed environment's values with it, and stay removed", async () => {
    const { store, token } = await seeded();
    await store.editEnvironments({
      op: "remove-environment",
      name: "production",
    });
    const snapshot = store.getSnapshot();
    expect(environmentNames(snapshot.environments)).toEqual(["staging"]);
    expect(snapshot.environments?.production?.removed).toBe(true);
    expect(
      snapshot.items.find((item) => item.id === token.id)?.environments,
    ).toEqual({});
  });
});

describe("writing environments", () => {
  it("is refused, and stores nothing, while the capability is off", async () => {
    await vaultStore.create(PASSWORD);
    expect(
      await writeEnvironments(null, { op: "add-environment", name: "staging" }),
    ).toEqual({ ok: false, reason: "disabled" });
    expect(
      await writeEnvironments(OFF, { op: "add-environment", name: "staging" }),
    ).toEqual({ ok: false, reason: "disabled" });
    expect(vaultStore.getSnapshot().environments).toBeUndefined();

    expect(
      await writeEnvironments(APPROVED, {
        op: "add-environment",
        name: "staging",
      }),
    ).toEqual({ ok: true });
    expect(environmentNames(vaultStore.getSnapshot().environments)).toEqual([
      "staging",
    ]);
    vaultStore.lock();
  });

  it("remembers, per tab, which environment a vault's sheet is looking at", () => {
    const names = ["development", "production"];
    expect(environmentInView("personal", names)).toBe("development");
    viewEnvironment("personal", "production");
    expect(environmentInView("personal", names)).toBe("production");
    expect(environmentInView("project", names)).toBe("development");
    // A name that has since been removed falls back to the first.
    expect(environmentInView("personal", ["development"])).toBe("development");
    expect(environmentInView("personal", [])).toBeNull();
  });
});

describe("the tray", () => {
  function keys(cells: ItemEnvironments) {
    return [{ id: "a", key: "STRIPE_KEY", name: "Stripe key", cells }];
  }

  it("says which required values are missing, in which environment, and where to fix it", () => {
    syncEnvironmentNotices(
      ["staging", "production"],
      keys({ production: { required: true } }),
    );
    const [notice, ...rest] = listNotices();
    expect(rest).toEqual([]);
    expect(notice).toMatchObject({
      id: ENVIRONMENT_NOTICE_ID,
      kind: "status",
      tone: "warn",
      title: "Environment values missing",
      body: "production: STRIPE_KEY",
      open: { to: ENVIRONMENTS_PATH },
    });
  });

  it("clears the moment the last gap is filled", () => {
    syncEnvironmentNotices(
      ["production"],
      keys({ production: { required: true } }),
    );
    expect(listNotices()).toHaveLength(1);
    syncEnvironmentNotices(
      ["production"],
      keys({ production: { required: true, value: "now set" } }),
    );
    expect(listNotices()).toEqual([]);
  });

  it("checks every environment, not just the one in view", () => {
    syncEnvironmentNotices(
      ["development", "staging", "production"],
      [
        ...keys({ staging: { required: true } }),
        {
          id: "b",
          key: "DB_URL",
          name: "Db",
          cells: { production: { required: true } },
        },
      ],
    );
    expect(listNotices()[0]?.body).toBe(
      "staging: STRIPE_KEY · production: DB_URL",
    );
  });

  it("shortens a long list and never carries a value", () => {
    const many = Array.from({ length: 7 }, (_, index) => ({
      id: `k${index}`,
      key: `KEY_${index}`,
      name: `Key ${index}`,
      cells: { production: { required: true, value: "" } },
    }));
    syncEnvironmentNotices(["production"], many);
    expect(listNotices()[0]?.body).toBe(
      "production: KEY_0, KEY_1, KEY_2, KEY_3 +3",
    );
  });

  it("warns when production shares a value, naming the key only", () => {
    syncEnvironmentNotices(
      ["staging", "production"],
      keys({
        staging: { value: "the-same-secret" },
        production: { value: "the-same-secret" },
      }),
    );
    const notice = listNotices().find(
      (entry) => entry.id === ENVIRONMENT_REUSE_NOTICE_ID,
    );
    expect(notice?.body).toBe("STRIPE_KEY");
    expect(JSON.stringify(listNotices())).not.toContain("the-same-secret");
  });

  it("is withdrawn with the capability", () => {
    syncEnvironmentNotices(
      ["staging", "production"],
      keys({
        staging: { value: "x", required: true },
        production: { value: "x", required: true },
      }),
    );
    clearEnvironmentNotices();
    expect(listNotices()).toEqual([]);
  });
});
