import { describe, expect, it } from "vitest";
import { connectionOf } from "./mailbox-connection.js";
import { JMAP_MAILBOX, mailboxItem } from "./mailbox.test-support.js";

describe("the connection a mailbox describes", () => {
  it("is an https origin, the login and the address", () => {
    expect(
      connectionOf(
        mailboxItem({
          ...JMAP_MAILBOX,
          address: "Me@Example.com",
          username: " me@example.com ",
        }),
      ),
    ).toEqual({
      origin: "https://mail.example.com",
      username: "me@example.com",
      password: "app-password-1",
      address: "me@example.com",
    });
  });

  it("keeps a port other than 443 and takes a pasted scheme and slash", () => {
    expect(
      connectionOf(
        mailboxItem({
          ...JMAP_MAILBOX,
          incoming: { host: "https://Mail.Example.com/", port: "8443" },
        }),
      )?.origin,
    ).toBe("https://mail.example.com:8443");
  });

  it("is none for a mailbox the reader cannot use", () => {
    expect(connectionOf(mailboxItem({ address: "me@example.com" }))).toBeNull();
    expect(
      connectionOf(mailboxItem({ ...JMAP_MAILBOX, incomingProtocol: "imap" })),
    ).toBeNull();
    expect(
      connectionOf(mailboxItem({ ...JMAP_MAILBOX, security: "none" })),
    ).toBeNull();
    expect(
      connectionOf(mailboxItem({ ...JMAP_MAILBOX, password: "" })),
    ).toBeNull();
  });

  it("is none for a host that is not a plain name, or a port that is not one", () => {
    for (const host of [
      "mail.example.com/jmap",
      "user@mail.example.com",
      "localhost",
      "a b.example.com",
    ]) {
      expect(
        connectionOf(
          mailboxItem({ ...JMAP_MAILBOX, incoming: { host, port: "" } }),
        ),
      ).toBeNull();
    }
    expect(
      connectionOf(
        mailboxItem({
          ...JMAP_MAILBOX,
          incoming: { host: "mail.example.com", port: "99999" },
        }),
      ),
    ).toBeNull();
  });

  it("is none for something that is not a mailbox", () => {
    expect(
      connectionOf({ ...mailboxItem(JMAP_MAILBOX), typeId: "other" }),
    ).toBeNull();
  });
});
