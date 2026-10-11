import { kvDelete } from "@opensesame/app-core/lib/kv.js";
/** @vitest-environment jsdom */
/**
 * The Password reset section's mailboxes, against the real vault store: zero,
 * one or many email accounts as vault items, an address alone or with the
 * server and login that let the app read its mail.
 */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  accountsBoundTo,
  isMailboxItem,
  resetMailboxes,
} from "@opensesame/app-core/lib/password-reset-mail.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
} from "@opensesame/app-core/lib/vfs.js";
import { createItem, syncInstalledTypes } from "@opensesame/vault-core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PasswordResetMailPanel } from "./panel.js";

const PASSWORD = "correct horse battery staple";

const mailboxes = () => resetMailboxes(vaultStore.getSnapshot().items);

beforeEach(async () => {
  await vfsFlush();
  syncInstalledTypes({});
  for (const path of [
    BODY_PATH,
    HEADER_PATH,
    INDEX_PATH,
    MIGRATION_MARKER_PATH,
  ]) {
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
  }
  clearNotices();
});

afterEach(async () => {
  cleanup();
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  vaultStore.lock();
  await vaultStore.destroy();
  clearNotices();
});

const open = () => act(() => vaultStore.create(PASSWORD));

const type = (
  name: string,
  value: string,
  scope: Pick<typeof screen, "getByRole" | "getByLabelText"> = screen,
) => fireEvent.change(scope.getByLabelText(name), { target: { value } });

/** Press a key, then wait for a save in flight to finish: the submit keys re-enable. */
const press = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
  await waitFor(() => {
    const saves = screen.queryAllByRole("button", {
      name: /^(Add|Save) reset email$/,
    });
    expect(saves.every((key) => !key.hasAttribute("disabled"))).toBe(true);
  });
};

describe("PasswordResetMailPanel", () => {
  it("draws nothing while the vault is locked", () => {
    const { container } = render(<PasswordResetMailPanel />);
    expect(container.firstChild).toBeNull();
  });

  it("starts with an empty list and a field to add one", async () => {
    await open();
    render(<PasswordResetMailPanel />);
    expect(screen.getByRole("textbox", { name: "Reset email" })).toBeTruthy();
    expect(screen.queryByLabelText("Mail server")).toBeNull();
    expect(mailboxes()).toEqual([]);
  });

  it("adds an address as a vault item and removes it to the trash", async () => {
    await open();
    render(<PasswordResetMailPanel />);
    type("Reset email", "  A@Example.com ");
    await press("Add reset email");
    expect(screen.getByText("a@example.com")).toBeTruthy();
    expect(vaultStore.getSnapshot().items.filter(isMailboxItem)).toHaveLength(
      1,
    );
    expect(screen.getByRole("textbox", { name: "Reset email" })).toHaveProperty(
      "value",
      "",
    );

    await press("Remove a@example.com");
    await waitFor(() => expect(mailboxes()).toEqual([]));
    expect(screen.queryByText("a@example.com")).toBeNull();
  });

  it("holds many mailboxes at once", async () => {
    await open();
    render(<PasswordResetMailPanel />);
    for (const address of ["a@example.com", "b@example.com", "c@example.com"]) {
      type("Reset email", address);
      await press("Add reset email");
    }
    expect(mailboxes().map((mailbox) => mailbox.address)).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(3);
  });

  it("keeps a shapeless address in the field, marks it, and tells the tray", async () => {
    await open();
    render(<PasswordResetMailPanel />);
    type("Reset email", "not-an-email");
    await press("Add reset email");
    const field = screen.getByRole("textbox", { name: "Reset email" });
    expect(field).toHaveProperty("value", "not-an-email");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(listNotices().map((notice) => notice.body)).toContain(
      "That is not an email address.",
    );
    expect(mailboxes()).toEqual([]);
  });

  it("refuses an address that is already a mailbox", async () => {
    await open();
    render(<PasswordResetMailPanel />);
    type("Reset email", "a@example.com");
    await press("Add reset email");
    type("Reset email", "A@example.com");
    await press("Add reset email");
    expect(mailboxes()).toHaveLength(1);
    expect(listNotices().map((notice) => notice.body)).toContain(
      "That address is already a mailbox.",
    );
  });

  it("adds a mailbox with a server and login, shown as one whose mail can be read", async () => {
    await open();
    render(<PasswordResetMailPanel />);
    await press("Show mail server");
    type("Reset email", "me@example.com");
    type("Name", "Home");
    type("Mail server", "mail.example.com");
    type("Port", "443");
    type("Username", "me@example.com");
    type("Password", "app-password-1");
    await press("Add reset email");

    expect(mailboxes()).toEqual([
      expect.objectContaining({
        name: "Home",
        address: "me@example.com",
        readable: true,
      }),
    ]);
    expect(
      screen.getByRole("img", { name: "Its mail can be read" }),
    ).toBeTruthy();
    // The password is in the item and nowhere on the page.
    expect(document.body.textContent).not.toContain("app-password-1");
    expect(
      vaultStore.getSnapshot().items.find(isMailboxItem)?.values.password,
    ).toBe("app-password-1");
  });

  it("marks a named server it cannot read, and draws no mark for an address alone", async () => {
    await open();
    render(<PasswordResetMailPanel />);
    type("Reset email", "plain@example.com");
    await press("Add reset email");
    expect(screen.queryByRole("img")).toBeNull();

    await press("Show mail server");
    type("Reset email", "old@example.com");
    type("Mail server", "imap.example.com");
    fireEvent.change(screen.getByLabelText("Protocol"), {
      target: { value: "imap" },
    });
    await press("Add reset email");
    expect(
      screen.getByRole("img", {
        name: "Its mail is not read: it needs a JMAP server over TLS and a password",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("img", { name: "Its mail can be read" }),
    ).toBeNull();
  });

  it("marks a server that cannot be opened on the mail server field", async () => {
    await open();
    render(<PasswordResetMailPanel />);
    await press("Show mail server");
    type("Reset email", "me@example.com");
    type("Mail server", "mail.example.com:8443");
    await press("Add reset email");
    expect(
      screen.getByLabelText("Mail server").getAttribute("aria-invalid"),
    ).toBe("true");
    expect(listNotices().map((notice) => notice.body)).toContain(
      "The mail server is a host name, such as mail.example.com.",
    );
    expect(mailboxes()).toEqual([]);
  });

  it("marks a bad port on the port field", async () => {
    await open();
    render(<PasswordResetMailPanel />);
    await press("Show mail server");
    type("Reset email", "me@example.com");
    type("Mail server", "mail.example.com");
    type("Port", "99999");
    await press("Add reset email");
    expect(screen.getByLabelText("Port").getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(mailboxes()).toEqual([]);
  });

  it("edits in place and keeps the saved password when the field is left blank", async () => {
    await open();
    render(<PasswordResetMailPanel />);
    await press("Show mail server");
    type("Reset email", "me@example.com");
    type("Mail server", "mail.example.com");
    type("Password", "app-password-1");
    await press("Add reset email");

    await press("Edit me@example.com");
    // The row opens its own editor, beside the form for a new mailbox.
    const [editor] = screen.getAllByLabelText("Name");
    if (!editor) throw new Error("the edit form did not open");
    fireEvent.change(editor, { target: { value: "Renamed" } });
    await press("Save reset email");

    expect(mailboxes()).toEqual([
      expect.objectContaining({ name: "Renamed", readable: true }),
    ]);
    expect(
      vaultStore.getSnapshot().items.find(isMailboxItem)?.values.password,
    ).toBe("app-password-1");
  });

  it("offers no remove key while a login is bound to the mailbox", async () => {
    await open();
    render(<PasswordResetMailPanel />);
    type("Reset email", "me@example.com");
    await press("Add reset email");
    const mailbox = mailboxes()[0];
    if (!mailbox) throw new Error("no mailbox");
    const login = createItem("account", "Example");
    login.resetEmailId = mailbox.id;
    await act(async () => {
      await vaultStore.saveItem(login);
    });
    expect(
      accountsBoundTo(vaultStore.getSnapshot().items, mailbox.id),
    ).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Remove me@example.com" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Edit me@example.com" }),
    ).toBeTruthy();
  });
});
