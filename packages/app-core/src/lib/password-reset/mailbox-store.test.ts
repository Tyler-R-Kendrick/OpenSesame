/** @vitest-environment jsdom */
/**
 * Reset mailboxes as vault items, against the real vault store: the type
 * arrives on first use, zero / one / many mailboxes read back, the password
 * stays in the item and out of every list, and a login keeps its binding when
 * its mailbox is changed.
 */
import { createItem, syncInstalledTypes } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kvDelete, kvGet, kvSet } from "../kv.js";
import {
  RESET_MAILBOX_TYPE,
  accountsBoundTo,
  isMailboxItem,
  resetMailboxes,
} from "../password-reset-mail.js";
import { VaultStore } from "../vault/store.js";
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
  LEGACY_RESET_EMAILS_KEY,
  adoptLegacyResetEmails,
  legacyResetEmails,
} from "./legacy-emails.js";
import {
  EMPTY_DRAFT,
  type MailboxDraft,
  NO_SERVER,
  addMailbox,
  mailboxDraft,
  removeMailbox,
  updateMailbox,
} from "./mailbox-store.js";

const PASSWORD = "correct horse battery staple";

const SERVER: MailboxDraft["server"] = {
  host: "mail.example.com",
  port: "443",
  protocol: "jmap",
  security: "tls",
  username: "me@example.com",
  password: "app-password-1",
};

function wipe(): void {
  for (const path of [
    BODY_PATH,
    HEADER_PATH,
    INDEX_PATH,
    MIGRATION_MARKER_PATH,
  ]) {
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
  }
}

let store: VaultStore;

beforeEach(async () => {
  await vfsFlush();
  syncInstalledTypes({});
  wipe();
  kvDelete(LEGACY_RESET_EMAILS_KEY);
  store = new VaultStore();
  await store.create(PASSWORD);
});

afterEach(async () => {
  await store.flushPendingWrites();
  await vfsFlush();
  store.lock();
  syncInstalledTypes({});
  kvDelete(LEGACY_RESET_EMAILS_KEY);
});

const mailboxes = () => resetMailboxes(store.getSnapshot().items);

describe("a vault's reset mailboxes", () => {
  it("starts with none, and has no mailbox type until one is added", async () => {
    expect(mailboxes()).toEqual([]);
    const saved = await addMailbox(store, {
      ...EMPTY_DRAFT,
      address: "  Me@Example.com ",
    });
    expect(saved).toMatchObject({
      ok: true,
      mailbox: { address: "me@example.com", name: "me@example.com" },
    });
    expect(mailboxes()).toHaveLength(1);
  });

  it("keeps an address alone as an unreadable mailbox, and a server and login as a readable one", async () => {
    await addMailbox(store, { ...EMPTY_DRAFT, address: "a@example.com" });
    await addMailbox(store, {
      address: "b@example.com",
      name: "Work",
      server: SERVER,
    });
    expect(mailboxes()).toEqual([
      expect.objectContaining({
        address: "a@example.com",
        name: "a@example.com",
        readable: false,
      }),
      expect.objectContaining({
        address: "b@example.com",
        name: "Work",
        readable: true,
      }),
    ]);
  });

  it("keeps an IMAP server the browser cannot speak to as a mailbox it does not read", async () => {
    await addMailbox(store, {
      address: "a@example.com",
      name: "",
      server: { ...SERVER, protocol: "imap", port: "993" },
    });
    expect(mailboxes()).toEqual([
      expect.objectContaining({ address: "a@example.com", readable: false }),
    ]);
    const item = store.getSnapshot().items.find(isMailboxItem);
    expect(item?.values.incomingProtocol).toBe("imap");
  });

  it("holds many, listed in name order, and each as an item of the mailbox type", async () => {
    for (const address of ["c@example.com", "a@example.com", "b@example.com"]) {
      await addMailbox(store, { ...EMPTY_DRAFT, address });
    }
    expect(mailboxes().map((mailbox) => mailbox.address)).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
    const typed = store.getSnapshot().items.filter(isMailboxItem);
    expect(typed).toHaveLength(3);
    expect(new Set(typed.map((item) => item.typeId))).toEqual(
      new Set([RESET_MAILBOX_TYPE]),
    );
  });

  it("never lists a credential", async () => {
    await addMailbox(store, {
      address: "a@example.com",
      name: "",
      server: SERVER,
    });
    const listed = JSON.stringify(mailboxes());
    expect(listed).not.toContain("app-password-1");
    expect(listed).not.toContain("mail.example.com");
    const item = store.getSnapshot().items.find(isMailboxItem);
    expect(item?.values.password).toBe("app-password-1");
  });

  it("refuses a bad address, a bad port and a duplicate, and writes nothing", async () => {
    expect(
      await addMailbox(store, { ...EMPTY_DRAFT, address: "nope" }),
    ).toEqual({
      ok: false,
      refusal: "address",
    });
    expect(
      await addMailbox(store, {
        address: "a@example.com",
        name: "",
        server: { ...SERVER, port: "99999" },
      }),
    ).toEqual({ ok: false, refusal: "port" });
    await addMailbox(store, { ...EMPTY_DRAFT, address: "a@example.com" });
    expect(
      await addMailbox(store, { ...EMPTY_DRAFT, address: "A@example.com" }),
    ).toEqual({ ok: false, refusal: "duplicate" });
    expect(mailboxes()).toHaveLength(1);
  });

  it("drops a half-written server: a host is what makes it advanced", async () => {
    await addMailbox(store, {
      address: "a@example.com",
      name: "",
      server: { ...NO_SERVER, username: "x", password: "left-over" },
    });
    const item = store.getSnapshot().items.find(isMailboxItem);
    expect(item?.values).toEqual({ address: "a@example.com" });
  });
});

describe("changing a mailbox", () => {
  it("starts the form from the item without its password", async () => {
    const saved = await addMailbox(store, {
      address: "a@example.com",
      name: "Home",
      server: SERVER,
    });
    if (!saved.ok) throw new Error("not saved");
    const item = store
      .getSnapshot()
      .items.find((entry) => entry.id === saved.mailbox.id);
    expect(item && mailboxDraft(item)).toEqual({
      address: "a@example.com",
      name: "Home",
      server: { ...SERVER, password: "" },
    });
  });

  it("keeps the password on a blank, replaces it on a new one, and keeps the item id", async () => {
    const saved = await addMailbox(store, {
      address: "a@example.com",
      name: "",
      server: SERVER,
    });
    if (!saved.ok) throw new Error("not saved");
    const id = saved.mailbox.id;
    const passwordOf = () =>
      store.getSnapshot().items.find(isMailboxItem)?.values.password;

    await updateMailbox(store, id, {
      address: "a@example.com",
      name: "Renamed",
      server: { ...SERVER, password: "" },
    });
    expect(passwordOf()).toBe("app-password-1");
    expect(mailboxes()[0]).toMatchObject({ id, name: "Renamed" });

    await updateMailbox(store, id, {
      address: "a@example.com",
      name: "Renamed",
      server: { ...SERVER, password: "app-password-2" },
    });
    expect(passwordOf()).toBe("app-password-2");
    expect(mailboxes()).toHaveLength(1);
  });

  it("lets a mailbox keep its own address and refuses another's", async () => {
    const first = await addMailbox(store, {
      ...EMPTY_DRAFT,
      address: "a@example.com",
    });
    await addMailbox(store, { ...EMPTY_DRAFT, address: "b@example.com" });
    if (!first.ok) throw new Error("not saved");
    expect(
      await updateMailbox(store, first.mailbox.id, {
        ...EMPTY_DRAFT,
        address: "a@example.com",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await updateMailbox(store, first.mailbox.id, {
        ...EMPTY_DRAFT,
        address: "b@example.com",
      }),
    ).toEqual({ ok: false, refusal: "duplicate" });
    expect(
      await updateMailbox(store, "missing", {
        ...EMPTY_DRAFT,
        address: "c@example.com",
      }),
    ).toEqual({ ok: false, refusal: "missing" });
  });

  it("removes to the trash, leaves a bound login with none, and does not touch other items", async () => {
    const saved = await addMailbox(store, {
      ...EMPTY_DRAFT,
      address: "a@example.com",
    });
    if (!saved.ok) throw new Error("not saved");
    const login = createItem("account", "Example");
    login.resetEmailId = saved.mailbox.id;
    await store.saveItem(login);
    expect(
      accountsBoundTo(store.getSnapshot().items, saved.mailbox.id),
    ).toHaveLength(1);

    await removeMailbox(store, saved.mailbox.id);
    expect(mailboxes()).toEqual([]);
    const kept = store.getSnapshot().items.find((item) => item.id === login.id);
    expect(kept?.kind === "account" && kept.resetEmailId).toBe(
      saved.mailbox.id,
    );

    await removeMailbox(store, login.id);
    expect(
      store.getSnapshot().items.find((item) => item.id === login.id)?.deletedAt,
    ).toBeNull();
  });
});

describe("the list kept before mailboxes were items", () => {
  const legacy = {
    byVault: {
      [PERSONAL_TOMB]: [
        { id: "mail-1", address: "a@example.com" },
        { id: "mail-2", address: "b@example.com" },
        { id: "bad", address: "nope" },
      ],
      other: [{ id: "mail-9", address: "z@example.com" }],
    },
  };

  it("becomes items under the same ids, so a bound login keeps its mailbox", async () => {
    kvSet(LEGACY_RESET_EMAILS_KEY, JSON.stringify(legacy));
    const made = await adoptLegacyResetEmails(store, PERSONAL_TOMB);
    expect(made).toBe(2);
    expect(mailboxes().map((mailbox) => mailbox.id)).toEqual([
      "mail-1",
      "mail-2",
    ]);
    // The vault's own entry is gone; another vault's is left alone.
    expect(legacyResetEmails(PERSONAL_TOMB)).toEqual([]);
    expect(legacyResetEmails("other")).toHaveLength(1);
  });

  it("drops the whole key once the last vault's list is gone, and is idempotent", async () => {
    kvSet(
      LEGACY_RESET_EMAILS_KEY,
      JSON.stringify({
        byVault: { [PERSONAL_TOMB]: legacy.byVault[PERSONAL_TOMB] },
      }),
    );
    expect(await adoptLegacyResetEmails(store, PERSONAL_TOMB)).toBe(2);
    expect(kvGet(LEGACY_RESET_EMAILS_KEY)).toBeNull();
    expect(await adoptLegacyResetEmails(store, PERSONAL_TOMB)).toBe(0);
    expect(mailboxes()).toHaveLength(2);
  });

  it("does not make a second mailbox for an address already there", async () => {
    await addMailbox(store, { ...EMPTY_DRAFT, address: "a@example.com" });
    kvSet(LEGACY_RESET_EMAILS_KEY, JSON.stringify(legacy));
    expect(await adoptLegacyResetEmails(store, PERSONAL_TOMB)).toBe(1);
    expect(mailboxes().map((mailbox) => mailbox.address)).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });
});
