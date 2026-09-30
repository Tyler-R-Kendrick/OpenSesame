import { createItem } from "@opensesame/vault-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  addResetEmail,
  autonomousPasswordResetReady,
  installAutonomousResetReady,
  listResetEmails,
  matchResetMail,
  normalizeResetAddress,
  removeResetEmail,
  resetPasswordResetMailForTest,
} from "./password-reset-mail.js";
import { applyNamedValues, namedValues } from "./vault/store-sync-values.js";

afterEach(() => {
  resetPasswordResetMailForTest();
});

describe("reset mailboxes", () => {
  it("keeps a trimmed address, and refuses a duplicate or a shapeless one", () => {
    expect(normalizeResetAddress("  A@Example.com ")).toBe("a@example.com");
    expect(normalizeResetAddress("a@b")).toBeNull();
    expect(normalizeResetAddress("a@@b.com")).toBeNull();
    const first = addResetEmail("A@Example.com", "personal");
    expect(first?.address).toBe("a@example.com");
    expect(addResetEmail("a@example.com", "personal")).toBeNull();
    expect(addResetEmail("not-an-email", "personal")).toBeNull();
    expect(listResetEmails("personal").map((email) => email.address)).toEqual([
      "a@example.com",
    ]);
  });

  it("stores each vault's list apart from the others", () => {
    addResetEmail("a@example.com", "personal");
    addResetEmail("b@example.com", "guest");
    expect(listResetEmails("personal").map((email) => email.address)).toEqual([
      "a@example.com",
    ]);
    expect(listResetEmails("guest").map((email) => email.address)).toEqual([
      "b@example.com",
    ]);
    expect(listResetEmails("other")).toEqual([]);
  });

  it("removes one address and leaves a dangling id off the list", () => {
    const email = addResetEmail("a@example.com", "personal");
    removeResetEmail(email?.id ?? "", "personal");
    expect(listResetEmails("personal")).toEqual([]);
    removeResetEmail("missing", "personal");
    expect(listResetEmails("personal")).toEqual([]);
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

  it("falls back to the link origin and keeps one match per login and origin", () => {
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
    expect(matches).toEqual([
      { itemId: "login-1", origin: "https://other.example" },
    ]);
  });
});

describe("login resetEmailId", () => {
  it("round-trips through named values and stays off a fresh login", () => {
    const fresh = createItem("login", "Example");
    expect(fresh.resetEmailId).toBeUndefined();
    expect(namedValues(fresh)?.resetEmailId).toBeUndefined();
    fresh.resetEmailId = "mail-1";
    const values = namedValues(fresh);
    expect(values?.resetEmailId).toBe("mail-1");
    const loaded = createItem("login", "Example");
    applyNamedValues(loaded, values);
    expect(loaded.resetEmailId).toBe("mail-1");
  });
});
