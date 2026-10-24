import { createItem } from "@opensesame/vault-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  accountsBoundTo,
  autonomousPasswordResetReady,
  installAutonomousResetReady,
  mailboxOf,
  matchResetMail,
  normalizeResetAddress,
  resetMailboxes,
  resetPasswordResetMailForTest,
} from "./password-reset-mail.js";
import {
  JMAP_MAILBOX,
  type MailboxValues,
  mailboxItem,
} from "./password-reset/mailbox.test-support.js";
import { entryToVaultItem, vaultItemToEntry } from "./vault/store-sync.js";

afterEach(() => {
  resetPasswordResetMailForTest();
});

describe("reset mailboxes", () => {
  it("keeps a trimmed address, and refuses an address that is not one", () => {
    expect(normalizeResetAddress("  A@Example.com ")).toBe("a@example.com");
    expect(normalizeResetAddress("a@b")).toBeNull();
    expect(normalizeResetAddress("a@@b.com")).toBeNull();
    expect(normalizeResetAddress("not-an-email")).toBeNull();
  });

  it("reads a mailbox from an email-account item, by name else address", () => {
    expect(
      mailboxOf(mailboxItem({ address: " A@Example.com " })),
    ).toMatchObject({
      address: "a@example.com",
      name: "a@example.com",
      readable: false,
    });
    expect(
      mailboxOf(mailboxItem({ address: "a@example.com" }, "Home")),
    ).toMatchObject({ name: "Home" });
  });

  it("calls a mailbox readable only with a JMAP server over TLS and a password", () => {
    const readable = (values: MailboxValues) =>
      mailboxOf(mailboxItem(values))?.readable;
    expect(readable(JMAP_MAILBOX)).toBe(true);
    expect(readable({ ...JMAP_MAILBOX, incomingProtocol: "imap" })).toBe(false);
    expect(readable({ ...JMAP_MAILBOX, security: "none" })).toBe(false);
    expect(readable({ address: "a@example.com" })).toBe(false);
    const { incoming: _server, ...noServer } = JMAP_MAILBOX;
    expect(readable(noServer)).toBe(false);
    const { password: _password, ...noPassword } = JMAP_MAILBOX;
    expect(readable(noPassword)).toBe(false);
    expect(
      readable({ ...JMAP_MAILBOX, incoming: { host: " ", port: "" } }),
    ).toBe(false);
  });

  it("ignores items that are not mailboxes, trashed ones, and ones with no address", () => {
    const home = mailboxItem({ address: "a@example.com" }, "Home");
    const trashed = {
      ...mailboxItem({ address: "b@example.com" }),
      deletedAt: "2026-10-01T00:00:00.000Z",
    };
    const unaddressed = mailboxItem({ address: "nope" });
    expect(mailboxOf(createItem("account", "Example"))).toBeNull();
    expect(
      resetMailboxes([home, trashed, unaddressed, createItem("account", "x")]),
    ).toEqual([expect.objectContaining({ id: home.id, name: "Home" })]);
  });

  it("finds the accounts bound to a mailbox", () => {
    const mailbox = mailboxItem({ address: "a@example.com" });
    const bound = createItem("account", "Bound");
    bound.resetEmailId = mailbox.id;
    const trashed = {
      ...createItem("account", "Gone"),
      deletedAt: "2026-10-01T00:00:00.000Z",
    };
    trashed.resetEmailId = mailbox.id;
    const other = createItem("account", "Other");
    other.resetEmailId = "elsewhere";
    expect(
      accountsBoundTo([mailbox, bound, trashed, other], mailbox.id).map(
        (item) => item.id,
      ),
    ).toEqual([bound.id]);
  });

  it("reports the ceremony only while a plane is installed", async () => {
    expect(await autonomousPasswordResetReady()).toBe(false);
    const uninstall = installAutonomousResetReady(() => true);
    expect(await autonomousPasswordResetReady()).toBe(true);
    uninstall();
    expect(await autonomousPasswordResetReady()).toBe(false);
  });
});

describe("matchResetMail", () => {
  const email = { id: "mail-1", address: "a@example.com" };
  const login = {
    id: "login-1",
    resetEmailId: "mail-1",
    uris: ["https://example.com/login"],
  };

  it("uses the login's https origin when the link names that host", () => {
    const matches = matchResetMail(
      [email],
      [login],
      [
        {
          mailbox: "A@Example.com",
          subject: "Reset your password",
          text: "Open https://example.com/reset/abc?token=1.",
        },
      ],
    );
    expect(matches).toEqual([
      { itemId: "login-1", origin: "https://example.com" },
    ]);
  });

  it("ignores another mailbox, a login with no mailbox, and mail that is not a reset", () => {
    expect(
      matchResetMail(
        [email],
        [login],
        [
          {
            mailbox: "other@example.com",
            subject: "Reset your password",
            text: "https://example.com/reset/abc",
          },
          {
            mailbox: "a@example.com",
            subject: "Your receipt",
            text: "https://example.com/account",
          },
          {
            mailbox: "a@example.com",
            subject: "Reset your password",
            text: "http://example.com/reset/abc",
          },
        ],
      ),
    ).toEqual([]);
    expect(
      matchResetMail(
        [email],
        [{ id: "login-2", uris: [] }],
        [
          {
            mailbox: "a@example.com",
            subject: "Reset your password",
            text: "https://example.com/reset/abc",
          },
        ],
      ),
    ).toEqual([]);
  });

  it("refuses a link whose host is not one of the login's registered URIs", () => {
    const matches = matchResetMail(
      [email],
      [login, { ...login, id: "login-1" }],
      [
        {
          mailbox: "a@example.com",
          subject: "Recover your account",
          text: "https://other.example/forgot",
        },
        {
          mailbox: "a@example.com",
          subject: "Recover your account",
          text: "https://other.example/forgot",
        },
      ],
    );
    expect(matches).toEqual([]);
  });
});

describe("account resetEmailId", () => {
  it("round-trips through a sealed-store entry and stays off a fresh account", () => {
    const fresh = createItem("account", "Example");
    expect(fresh.resetEmailId).toBeUndefined();
    const plain = entryToVaultItem(vaultItemToEntry(fresh, []));
    expect(plain.kind === "account" && plain.resetEmailId).toBeFalsy();
    fresh.resetEmailId = "mail-1";
    const loaded = entryToVaultItem(vaultItemToEntry(fresh, []));
    expect(loaded.kind === "account" && loaded.resetEmailId).toBe("mail-1");
  });
});
