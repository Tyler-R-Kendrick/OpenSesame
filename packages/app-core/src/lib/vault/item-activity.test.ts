import {
  type VaultItem,
  createItem,
  passwordMethod,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { typePassword } from "../account.test-support.js";
import {
  ACTIVITY_LOG_PATH,
  type ActivityEvent,
  listActivityEvents,
} from "../activity-log.js";
import { kvDelete } from "../kv.js";
import {
  BODY_PATH,
  GUEST_TOMB,
  HEADER_PATH,
  INDEX_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
} from "../vfs.js";
import { writeSavedItems } from "./item-writes.js";
import { vaultStore } from "./store.js";

const PASSWORD = "correct horse battery staple";
const CANARY = "canary-secret-value-9f3a";
const CANARY_NEXT = "canary-secret-value-rotated";

function openTomb(): string {
  const tomb = vaultStore.getSnapshot().tomb;
  if (!tomb) throw new Error("expected an open vault");
  return tomb;
}

async function eventsOf(tomb: string): Promise<ActivityEvent[]> {
  return listActivityEvents(tomb);
}

beforeEach(async () => {
  vaultStore.lock();
  await vfsFlush();
  for (const tomb of [PERSONAL_TOMB, GUEST_TOMB]) {
    kvDelete(tombFileKey(tomb, HEADER_PATH));
    kvDelete(tombFileKey(tomb, BODY_PATH));
    kvDelete(tombFileKey(tomb, INDEX_PATH));
    kvDelete(tombFileKey(tomb, ACTIVITY_LOG_PATH));
  }
});

afterEach(() => {
  vaultStore.lock();
});

describe("item activity", () => {
  it("logs a generated secret and a later update, without the value", async () => {
    await vaultStore.create(PASSWORD);
    const tomb = openTomb();
    const secret = createItem("secret", "Deploy key");
    secret.value = CANARY;

    await vaultStore.saveItem(secret);
    await vi.waitFor(async () => {
      const types = (await eventsOf(tomb)).map((event) => event.type);
      expect(types).toContain("vault.secret.created");
      expect(types).toContain("vault.body.persisted");
    });

    const created = (await eventsOf(tomb)).find(
      (event) => event.type === "vault.secret.created",
    );
    expect(created).toMatchObject({
      category: "vault",
      summary: "A new secret was generated: Deploy key",
      outcome: "succeeded",
      targetType: "secret",
      targetId: secret.id,
      metadata: { kind: "secret", action: "created" },
    });
    expect(JSON.stringify(await eventsOf(tomb))).not.toContain(CANARY);

    secret.value = CANARY_NEXT;
    await vaultStore.saveItem(secret);
    await vi.waitFor(async () => {
      const updates = (await eventsOf(tomb)).filter(
        (event) => event.type === "vault.secret.updated",
      );
      expect(updates).toHaveLength(1);
    });
    const updated = (await eventsOf(tomb)).find(
      (event) => event.type === "vault.secret.updated",
    );
    expect(updated).toMatchObject({
      summary: "A secret was updated: Deploy key",
      targetType: "secret",
      targetId: secret.id,
      metadata: { kind: "secret", action: "updated" },
    });
    const wire = JSON.stringify(await eventsOf(tomb));
    expect(wire).not.toContain(CANARY);
    expect(wire).not.toContain(CANARY_NEXT);
  });

  it("keeps two updates of the same secret", async () => {
    await vaultStore.create(PASSWORD);
    const tomb = openTomb();
    const secret = createItem("secret", "Deploy key");
    secret.value = CANARY;
    await vaultStore.saveItem(secret);
    secret.value = `${CANARY}-2`;
    await vaultStore.saveItem(secret);
    secret.value = `${CANARY}-3`;
    await vaultStore.saveItem(secret);
    await vi.waitFor(async () => {
      const updates = (await eventsOf(tomb)).filter(
        (event) => event.type === "vault.secret.updated",
      );
      expect(updates).toHaveLength(2);
    });
    expect(JSON.stringify(await eventsOf(tomb))).not.toContain(CANARY);
  });

  it("names a created and updated account", async () => {
    await vaultStore.create(PASSWORD);
    const tomb = openTomb();
    const account = createItem("account", "Work");
    const method = passwordMethod(account);
    if (!method) throw new Error("expected a password method");
    typePassword(method, "login-canary-password");
    await vaultStore.saveItem(account);
    typePassword(method, "login-canary-password-2");
    await vaultStore.saveItem(account);
    await vi.waitFor(async () => {
      const types = (await eventsOf(tomb)).map((event) => event.type);
      expect(types).toContain("vault.account.created");
      expect(types).toContain("vault.account.updated");
    });
    const summaries = (await eventsOf(tomb)).map((event) => event.summary);
    expect(summaries).toContain("A new account was created: Work");
    expect(summaries).toContain("An account was updated: Work");
    const wire = JSON.stringify(await eventsOf(tomb));
    expect(wire).not.toContain("login-canary-password");
  });

  it("logs a guest secret in the guest tomb", async () => {
    await vaultStore.createGuest();
    const secret = createItem("secret", "Guest token");
    secret.value = CANARY;
    await vaultStore.saveItem(secret);
    await vi.waitFor(async () => {
      const summaries = (await eventsOf(GUEST_TOMB)).map(
        (event) => event.summary,
      );
      expect(summaries).toContain("A new secret was generated: Guest token");
    });
    expect(JSON.stringify(await eventsOf(GUEST_TOMB))).not.toContain(CANARY);
    const personal = await eventsOf(PERSONAL_TOMB).catch(() => []);
    expect(JSON.stringify(personal)).not.toContain("Guest token");
  });

  it("records nothing when the seal fails", async () => {
    await vaultStore.create(PASSWORD);
    const tomb = openTomb();
    const secret = createItem("secret", "Deploy key");
    secret.value = CANARY;
    const prior: readonly VaultItem[] = [];
    const host = {
      tomb,
      items: prior,
      mutate: async () => {
        throw new Error("seal failed");
      },
    };
    await expect(writeSavedItems(host, [secret])).rejects.toThrow(
      /seal failed/u,
    );
    const types = (await eventsOf(tomb)).map((event) => event.type);
    expect(types).not.toContain("vault.secret.created");
    expect(JSON.stringify(await eventsOf(tomb))).not.toContain(CANARY);
  });
});
