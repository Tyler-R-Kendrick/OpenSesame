import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kvDelete, kvGet, kvSet } from "../kv.js";
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
import { type SentCode, remoteCodeSeams } from "./remote-code.js";
import { SELF_AUTHENTICATOR_TITLE } from "./self-authenticator.js";
import { ATTEMPTS_KEY, VaultStore } from "./store.js";

const PASSWORD = "correct horse battery staple";

/** The Identity API as a fake: one live code per challenge, spent on use. */
function fakeIdentity() {
  const codes = new Map<string, string>();
  const sent: { channel: string; to: string }[] = [];
  let n = 0;
  const sendCode = vi.fn(async (channel: "email" | "sms", to: string) => {
    n += 1;
    const challengeId = `mfc_${n}`;
    codes.set(challengeId, String(100000 + n));
    sent.push({ channel, to });
    const masked =
      channel === "email"
        ? `${to.slice(0, 1)}•••${to.slice(to.indexOf("@"))}`
        : `${to.slice(0, 2)} ••• ••• ${to.slice(-4)}`;
    const result: SentCode = {
      challengeId,
      channel,
      to: masked,
      expiresAt: "",
    };
    return result;
  });
  const verifyCode = vi.fn(async (challengeId: string, code: string) => {
    const expected = codes.get(challengeId);
    if (!expected || expected !== code.replace(/\s/g, "")) {
      throw new WrongPasswordError("That code did not match.");
    }
    codes.delete(challengeId);
  });
  return { sendCode, verifyCode, sent, codeFor: (id: string) => codes.get(id) };
}

async function enrollTotp(store: VaultStore): Promise<string> {
  const uri = await store.beginTotpEnrollment();
  const secret = new URL(uri).searchParams.get("secret") ?? "";
  const { totpCode, parseTotp } = await import("./totp.js");
  await store.confirmTotpEnrollment(await totpCode(parseTotp(secret)));
  return secret;
}

describe("second steps by email or text, and recovery codes", () => {
  let identity = fakeIdentity();
  const originalSeams = { ...remoteCodeSeams };

  beforeEach(async () => {
    await vfsFlush();
    kvDelete(ATTEMPTS_KEY);
    kvDelete(tombFileKey(PERSONAL_TOMB, HEADER_PATH));
    kvDelete(tombFileKey(PERSONAL_TOMB, BODY_PATH));
    kvDelete(tombFileKey(PERSONAL_TOMB, MIGRATION_MARKER_PATH));
    kvDelete(tombFileKey(PERSONAL_TOMB, INDEX_PATH));
    identity = fakeIdentity();
    Object.assign(remoteCodeSeams, {
      sendCode: identity.sendCode,
      verifyCode: identity.verifyCode,
    });
  });

  afterEach(() => {
    Object.assign(remoteCodeSeams, originalSeams);
  });

  it("refuses to bind a code channel to a vault with no key", async () => {
    const store = new VaultStore();
    await store.createGuest();
    await expect(
      store.beginCodeEnrollment("email", "tyler@example.com"),
    ).rejects.toThrow(/can only guard a key/);
    expect(identity.sendCode).not.toHaveBeenCalled();
  });

  it("turns an email code on only once the first code matches, and asks for one at unlock", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    const sent = await store.beginCodeEnrollment("email", "tyler@example.com");
    expect(sent.to).toBe("t•••@example.com");
    expect(store.getSnapshot().header?.unlocks?.email).toBeUndefined();
    await expect(store.confirmCodeEnrollment("000000")).rejects.toThrow(
      /did not match/,
    );
    expect(store.getSnapshot().header?.unlocks?.email).toBeUndefined();
    await store.confirmCodeEnrollment(identity.codeFor(sent.challengeId) ?? "");
    const record = store.getSnapshot().header?.unlocks?.email;
    expect(record?.toWrap).toBeTruthy();
    // The header on disk says a channel exists, never where it goes.
    expect(JSON.stringify(store.getSnapshot().header)).not.toContain(
      "tyler@example.com",
    );
    expect(await store.describeCodeChannel("email")).toBe("t•••@example.com");
    store.lock();

    const reopened = new VaultStore();
    await reopened.unlock(PASSWORD);
    expect(reopened.getSnapshot().awaitingSecondStep).toBe(true);
    expect(reopened.getSnapshot().status).toBe("locked");
    const challenge = await reopened.requestSecondStepCode("email");
    expect(identity.sent.at(-1)).toEqual({
      channel: "email",
      to: "tyler@example.com",
    });
    await expect(reopened.confirmRemoteCode("999999")).rejects.toThrow();
    expect(reopened.getSnapshot().failedAttempts).toBe(1);
    await reopened.confirmRemoteCode(
      identity.codeFor(challenge.challengeId) ?? "",
    );
    expect(reopened.getSnapshot().status).toBe("unlocked");
  });

  it("closes an unconfirmed enrollment on lock and on cancel", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    await store.beginCodeEnrollment("sms", "+14155550142");
    store.cancelCodeEnrollment();
    await expect(store.confirmCodeEnrollment("123456")).rejects.toThrow(
      /Send a code first/,
    );
    await store.beginCodeEnrollment("sms", "+14155550142");
    store.lock();
    await store.unlock(PASSWORD);
    await expect(store.confirmCodeEnrollment("123456")).rejects.toThrow(
      /Send a code first/,
    );
  });

  it("makes recovery codes only beside a second step, and spends each once", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    await expect(store.generateRecoveryCodes()).rejects.toThrow(/second step/);
    await enrollTotp(store);
    const codes = await store.generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}$/);
    expect(JSON.stringify(store.getSnapshot().header)).not.toContain(codes[0]);
    const ledger = await store.recoveryCodes();
    expect(ledger?.codes).toEqual(codes);
    expect(ledger?.used.every((flag) => !flag)).toBe(true);
    // Withdraw the vault's own authenticator (ADR 0113) so the code is asked.
    const selfId = store.getSnapshot().header?.unlocks?.totp?.selfItemId ?? "";
    await store.trashItem(selfId);
    store.lock();

    const reopened = new VaultStore();
    await reopened.unlock(PASSWORD);
    expect(reopened.getSnapshot().awaitingSecondStep).toBe(true);
    await expect(reopened.redeemRecoveryCode("zzzz-zzzz")).rejects.toThrow(
      WrongPasswordError,
    );
    // Forgiven its case, spaces and dashes.
    await reopened.redeemRecoveryCode(
      ` ${(codes[3] ?? "").toUpperCase().replace("-", " ")} `,
    );
    expect(reopened.getSnapshot().status).toBe("unlocked");
    const after = await reopened.recoveryCodes();
    expect(after?.used[3]).toBe(true);
    expect(after?.used.filter(Boolean)).toHaveLength(1);
    reopened.lock();

    const again = new VaultStore();
    await again.unlock(PASSWORD);
    await expect(again.redeemRecoveryCode(codes[3] ?? "")).rejects.toThrow(
      WrongPasswordError,
    );
    await again.redeemRecoveryCode(codes[4] ?? "");
    expect(again.getSnapshot().status).toBe("unlocked");
  });

  it("drops the recovery codes with the last second step, and keeps them beside another", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    await enrollTotp(store);
    const sent = await store.beginCodeEnrollment("email", "tyler@example.com");
    await store.confirmCodeEnrollment(identity.codeFor(sent.challengeId) ?? "");
    await store.generateRecoveryCodes();
    await store.removeTotp();
    expect(store.getSnapshot().header?.unlocks?.recovery).toBeTruthy();
    expect(store.getSnapshot().header?.unlocks?.email).toBeTruthy();
    await store.removeCode("email");
    expect(store.getSnapshot().header?.unlocks?.recovery).toBeUndefined();
    expect(store.getSnapshot().header?.unlocks?.email).toBeUndefined();
    store.lock();
    const reopened = new VaultStore();
    await reopened.unlock(PASSWORD);
    expect(reopened.getSnapshot().awaitingSecondStep).toBe(false);
    expect(reopened.getSnapshot().status).toBe("unlocked");
  });
});

describe("the vault as its own authenticator (ADR 0113)", () => {
  beforeEach(async () => {
    await vfsFlush();
    kvDelete(ATTEMPTS_KEY);
    kvDelete(tombFileKey(PERSONAL_TOMB, HEADER_PATH));
    kvDelete(tombFileKey(PERSONAL_TOMB, BODY_PATH));
    kvDelete(tombFileKey(PERSONAL_TOMB, MIGRATION_MARKER_PATH));
    kvDelete(tombFileKey(PERSONAL_TOMB, INDEX_PATH));
  });

  function selfItem(store: VaultStore) {
    const item = store
      .getSnapshot()
      .items.find((candidate) => candidate.name === SELF_AUTHENTICATOR_TITLE);
    return item?.kind === "login" ? item : undefined;
  }

  function selfItemId(store: VaultStore): string {
    const id = store.getSnapshot().header?.unlocks?.totp?.selfItemId;
    if (!id) throw new Error("expected a self-authenticator marker");
    return id;
  }

  it("registers a login entry for itself when the gate is enrolled", async () => {
    const { totpCode, parseTotp } = await import("./totp.js");
    const store = new VaultStore();
    await store.create(PASSWORD);
    const secret = await enrollTotp(store);
    const item = selfItem(store);
    expect(selfItemId(store)).toBe(item?.id);
    expect(item?.deletedAt).toBeNull();
    // The entry is a working authenticator: its seed makes the gate's code.
    await expect(totpCode(parseTotp(item?.totp ?? ""))).resolves.toBe(
      await totpCode(parseTotp(secret)),
    );
  });

  it("supplies the code itself at unlock, asking nothing", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    await enrollTotp(store);
    store.lock();

    const reopened = new VaultStore();
    await reopened.unlock(PASSWORD);
    expect(reopened.getSnapshot().status).toBe("unlocked");
    expect(reopened.getSnapshot().awaitingSecondStep).toBe(false);
    expect(selfItem(reopened)).toBeDefined();
  });

  it("asks for the code once the entry is trashed, and does not resurrect it", async () => {
    const { totpCode, parseTotp } = await import("./totp.js");
    const store = new VaultStore();
    await store.create(PASSWORD);
    const secret = await enrollTotp(store);
    const selfId = selfItemId(store);
    await store.trashItem(selfId);
    store.lock();

    const reopened = new VaultStore();
    await reopened.unlock(PASSWORD);
    expect(reopened.getSnapshot().awaitingSecondStep).toBe(true);
    await reopened.confirmTotp(await totpCode(parseTotp(secret)));
    expect(reopened.getSnapshot().status).toBe("unlocked");
    // The trashed entry is left alone: the withdrawal survives a manual code.
    expect(selfItem(reopened)?.id).toBe(selfId);
    expect(selfItem(reopened)?.deletedAt).not.toBeNull();
  });

  it("supplies the code again once the entry is restored", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    await enrollTotp(store);
    const selfId = selfItemId(store);
    await store.trashItem(selfId);
    await store.restoreItem(selfId);
    store.lock();

    const reopened = new VaultStore();
    await reopened.unlock(PASSWORD);
    expect(reopened.getSnapshot().status).toBe("unlocked");
    expect(reopened.getSnapshot().awaitingSecondStep).toBe(false);
  });

  it("registers itself for a gate sealed before the marker existed", async () => {
    const { totpCode, parseTotp } = await import("./totp.js");
    const store = new VaultStore();
    await store.create(PASSWORD);
    const secret = await enrollTotp(store);
    await store.trashItem(selfItemId(store));
    store.lock();

    // A header from before ADR 0113: a gate with no registration marker.
    await vfsFlush();
    const stored = kvGet(tombFileKey(PERSONAL_TOMB, HEADER_PATH));
    if (!stored) throw new Error("expected a sealed header");
    const header = JSON.parse(stored);
    header.unlocks.totp.selfItemId = undefined;
    kvSet(tombFileKey(PERSONAL_TOMB, HEADER_PATH), JSON.stringify(header));

    const reopened = new VaultStore();
    await reopened.unlock(PASSWORD);
    expect(reopened.getSnapshot().awaitingSecondStep).toBe(true);
    await reopened.confirmTotp(await totpCode(parseTotp(secret)));
    expect(reopened.getSnapshot().status).toBe("unlocked");
    // The marker now points at a live entry — a fresh one beside the trashed.
    const marker = reopened.getSnapshot().header?.unlocks?.totp?.selfItemId;
    const item = reopened.getSnapshot().items.find((c) => c.id === marker);
    expect(item?.name).toBe(SELF_AUTHENTICATOR_TITLE);
    expect(item?.deletedAt).toBeNull();
  });

  it("trashes the entry when the gate is removed", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    await enrollTotp(store);
    const selfId = selfItemId(store);
    await store.removeTotp();
    expect(store.getSnapshot().header?.unlocks?.totp).toBeUndefined();
    expect(selfItem(store)?.id).toBe(selfId);
    expect(selfItem(store)?.deletedAt).not.toBeNull();
  });
});
