/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { UnlockMethodsPanel } from "./UnlockMethodsPanel.js";
import {
  checkWebauthnHost,
  guestHeader,
  identityApi,
  installUnlockSeams,
  listAvailableUnlockMethods,
  passwordOnlyHeader,
  pinAndPasswordHeader,
  row,
  sheet,
  store,
  vault,
} from "./unlock-methods-panel.test-support.js";

const restoreSeams = installUnlockSeams();
afterAll(restoreSeams);

describe("UnlockMethodsPanel", () => {
  beforeEach(() => {
    passwordOnlyHeader();
    identityApi.current = "http://127.0.0.1:8788";
    checkWebauthnHost.mockReturnValue({
      ok: true,
      hostname: "localhost",
      reason: "",
      fixUrl: null,
    });
    for (const fn of Object.values(store)) fn.mockReset();
    store.enrollPasskey.mockResolvedValue(undefined);
    store.removePasskey.mockResolvedValue(undefined);
    store.enrollPin.mockResolvedValue(undefined);
    store.removePin.mockResolvedValue(undefined);
    store.enrollPassword.mockResolvedValue(undefined);
    store.removePassword.mockResolvedValue(undefined);
    store.beginTotpEnrollment.mockResolvedValue(
      "otpauth://totp/vault?secret=ABCDEFGH",
    );
    store.confirmTotpEnrollment.mockResolvedValue(undefined);
    store.removeTotp.mockResolvedValue(undefined);
    store.beginCodeEnrollment.mockResolvedValue({
      challengeId: "mfc_1",
      channel: "email",
      to: "t•••@example.com",
      expiresAt: "",
    });
    store.confirmCodeEnrollment.mockResolvedValue(undefined);
    store.removeCode.mockResolvedValue(undefined);
    store.describeCodeChannel.mockResolvedValue("t•••@example.com");
    store.recoveryCodes.mockResolvedValue(null);
    store.generateRecoveryCodes.mockResolvedValue(["aaaa-bbbb", "cccc-dddd"]);
    window.history.replaceState(null, "", "/settings");
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("lists every method as read-only state with one action and no inputs", () => {
    render(<UnlockMethodsPanel />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.querySelectorAll("input")).toHaveLength(0);
    expect(row("Passkey").getByRole("button", { name: "Add" })).toBeTruthy();
    expect(row("PIN").getByRole("button", { name: "Add" })).toBeTruthy();
    expect(
      row("Password").getByRole("button", { name: "Change" }),
    ).toBeTruthy();
    // State is a glyph whose sentence is its accessible name, never a pill.
    expect(row("Password").getByRole("img", { name: "Enrolled" })).toBeTruthy();
    expect(
      row("Authenticator app").getByRole("button", { name: "Add" }),
    ).toBeTruthy();
    expect(row("Email code").getByRole("button", { name: "Add" })).toBeTruthy();
    expect(
      row("Text message").getByRole("button", { name: "Add" }),
    ).toBeTruthy();
    expect(
      row("Sign-in service").getByRole("button", { name: "Change" }),
    ).toBeTruthy();
    // No codes made yet: the row would be a lock with no key, so it is absent.
    expect(screen.queryByText("Recovery codes")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("adds a PIN through the sheet: matching entries, then the row reports it", async () => {
    render(<UnlockMethodsPanel />);
    await userEvent.click(row("PIN").getByRole("button", { name: "Add" }));
    const dialog = sheet();
    expect(dialog.getByRole("heading", { name: "PIN" })).toBeTruthy();
    const set = dialog.getByRole("button", { name: "Set PIN" });
    expect(set).toHaveProperty("disabled", true);
    await userEvent.type(dialog.getByLabelText("PIN"), "48291037");
    await userEvent.type(dialog.getByLabelText("Confirm PIN"), "4829103");
    expect(dialog.getByRole("img", { name: "Does not match" })).toBeTruthy();
    expect(dialog.getByRole("button", { name: "Set PIN" })).toHaveProperty(
      "disabled",
      true,
    );
    await userEvent.type(dialog.getByLabelText("Confirm PIN"), "7");
    expect(dialog.getByRole("img", { name: "Matches" })).toBeTruthy();
    await userEvent.click(dialog.getByRole("button", { name: "Set PIN" }));
    await waitFor(() =>
      expect(store.enrollPin).toHaveBeenCalledWith("48291037"),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText(/PIN unlock enrolled/)).toBeTruthy();
  });

  it("names the PIN rule live and keeps the button disabled until it holds", async () => {
    render(<UnlockMethodsPanel />);
    await userEvent.click(row("PIN").getByRole("button", { name: "Add" }));
    const dialog = sheet();
    await userEvent.type(dialog.getByLabelText("PIN"), "11111111");
    expect(dialog.getByRole("img", { name: /repeated/i })).toBeTruthy();
    await userEvent.type(dialog.getByLabelText("Confirm PIN"), "11111111");
    expect(dialog.getByRole("button", { name: "Set PIN" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(store.enrollPin).not.toHaveBeenCalled();
  });

  it("offers the other keys as alternatives inside the same sheet, never a second form", async () => {
    render(<UnlockMethodsPanel />);
    await userEvent.click(row("PIN").getByRole("button", { name: "Add" }));
    const dialog = sheet();
    expect(dialog.getAllByRole("form")).toHaveLength(1);
    await userEvent.click(
      dialog.getByRole("button", { name: "Use a passkey instead" }),
    );
    await userEvent.click(
      dialog.getByRole("button", { name: "Create passkey" }),
    );
    await waitFor(() => expect(store.enrollPasskey).toHaveBeenCalled());
    expect(
      dialog.queryByRole("button", { name: "Use a password instead" }),
    ).toBeNull();
  });

  it("changes a password from its row, asking for the current one", async () => {
    render(<UnlockMethodsPanel />);
    await userEvent.click(
      row("Password").getByRole("button", { name: "Change" }),
    );
    const dialog = sheet();
    for (const [label, value] of [
      ["Current password", "old-password-1"],
      ["New password", "correct horse battery"],
      ["Confirm new password", "correct horse battery"],
    ] as const) {
      await userEvent.type(dialog.getByLabelText(label), value);
    }
    await userEvent.click(
      dialog.getByRole("button", { name: "Change password" }),
    );
    await waitFor(() =>
      expect(store.changeMasterPassword).toHaveBeenCalledWith(
        "old-password-1",
        "correct horse battery",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("confirms a removal in the card and refuses to remove the last key", async () => {
    render(<UnlockMethodsPanel />);
    await userEvent.click(
      row("Password").getByRole("button", { name: "Change" }),
    );
    const dialog = sheet();
    await userEvent.click(
      dialog.getByRole("button", { name: "Remove this password" }),
    );
    expect(document.querySelector(".found--ask .go--danger")).toBeTruthy();
    expect(
      dialog.getByRole("button", { name: "Remove password" }),
    ).toHaveProperty("disabled", true);
    expect(dialog.getByText(/only key/)).toBeTruthy();
    expect(dialog.getByRole("button", { name: "Add a PIN" })).toBeTruthy();
    await userEvent.click(dialog.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(store.removePassword).not.toHaveBeenCalled();
  });

  it("removes a key once another exists, after the confirmation", async () => {
    pinAndPasswordHeader();
    render(<UnlockMethodsPanel />);
    await userEvent.click(row("PIN").getByRole("button", { name: "Change" }));
    const dialog = sheet();
    await userEvent.click(
      dialog.getByRole("button", { name: "Remove this PIN" }),
    );
    expect(dialog.getByText(/unlock with the password only/)).toBeTruthy();
    await userEvent.click(dialog.getByRole("button", { name: "Remove PIN" }));
    await waitFor(() => expect(store.removePin).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("turns the passkey card attentive on a raw IP and offers the localhost road", async () => {
    checkWebauthnHost.mockReturnValue({
      ok: false,
      hostname: "127.0.0.1",
      reason: "WebAuthn needs a hostname.",
      fixUrl: "http://localhost:5180/settings",
    });
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", {
      value: { ...original, assign, href: "http://127.0.0.1:5180/settings" },
      writable: true,
    });
    try {
      render(<UnlockMethodsPanel />);
      await userEvent.click(
        row("Passkey").getByRole("button", { name: "Add" }),
      );
      const dialog = sheet();
      expect(dialog.getByText("Passkeys need a hostname")).toBeTruthy();
      await userEvent.click(
        dialog.getByRole("button", { name: "Continue on localhost" }),
      );
      expect(assign).toHaveBeenCalledTimes(1);
      expect(String(assign.mock.calls[0]?.[0])).toContain("enroll-passkey=1");
    } finally {
      Object.defineProperty(window, "location", {
        value: original,
        writable: true,
      });
    }
  });

  it("auto-enrolls a passkey when returning with ?enroll-passkey=1", async () => {
    window.history.replaceState(null, "", "/settings?enroll-passkey=1");
    render(<UnlockMethodsPanel />);
    await waitFor(() => expect(store.enrollPasskey).toHaveBeenCalled());
    expect(window.location.search).toBe("");
  });

  it("turns the authenticator on only once a code matches, then hands over recovery codes", async () => {
    store.confirmTotpEnrollment
      .mockRejectedValueOnce(new Error("That code did not match."))
      .mockResolvedValueOnce(undefined);
    render(<UnlockMethodsPanel />);
    await userEvent.click(
      row("Authenticator app").getByRole("button", { name: "Add" }),
    );
    const dialog = sheet();
    const qr = await dialog.findByTestId("qr");
    expect(qr.textContent).toContain("ABCDEFGH");
    expect(store.beginTotpEnrollment).toHaveBeenCalled();
    // A keyed vault: the rail starts at Scan, no key step.
    expect(dialog.getByText("1 · Scan")).toBeTruthy();
    expect(dialog.queryByText(/Key/)).toBeNull();
    await userEvent.click(
      dialog.getByRole("button", { name: "Can't scan? Type the key instead" }),
    );
    expect(dialog.getByLabelText("Setup key")).toHaveProperty(
      "value",
      "ABCD EFGH",
    );
    await userEvent.click(dialog.getByRole("button", { name: "I scanned it" }));
    await userEvent.type(dialog.getByLabelText("Six digits"), "000000");
    await userEvent.click(dialog.getByRole("button", { name: "Turn on" }));
    await waitFor(() =>
      expect(dialog.getByRole("img", { name: "Did not match" })).toBeTruthy(),
    );
    expect(store.generateRecoveryCodes).not.toHaveBeenCalled();
    await userEvent.clear(dialog.getByLabelText("Six digits"));
    await userEvent.type(dialog.getByLabelText("Six digits"), "123456");
    await userEvent.click(dialog.getByRole("button", { name: "Turn on" }));
    await waitFor(() =>
      expect(store.confirmTotpEnrollment).toHaveBeenLastCalledWith("123456"),
    );
    await waitFor(() => expect(dialog.getByText("aaaa-bbbb")).toBeTruthy());
    expect(store.generateRecoveryCodes).toHaveBeenCalledTimes(1);
    await userEvent.click(dialog.getByRole("button", { name: "I saved them" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("walks a keyless vault through the key first, in the same card the PIN sheet uses", async () => {
    guestHeader();
    checkWebauthnHost.mockReturnValue({
      ok: false,
      hostname: "127.0.0.1",
      reason: "no",
      fixUrl: null,
    });
    store.enrollPin.mockImplementation(async () => {
      vault.current = { header: { unlocks: { pin: {} } } };
      listAvailableUnlockMethods.mockReturnValue(["pin"]);
    });
    const view = render(<UnlockMethodsPanel />);
    expect(screen.getByText(/You are a guest/)).toBeTruthy();
    await userEvent.click(
      row("Authenticator app").getByRole("button", { name: "Add" }),
    );
    const dialog = sheet();
    expect(dialog.getByText("1 · Key")).toBeTruthy();
    expect(dialog.getByText("3 · Confirm")).toBeTruthy();
    expect(store.beginTotpEnrollment).not.toHaveBeenCalled();
    await userEvent.type(dialog.getByLabelText("PIN"), "48291037");
    await userEvent.type(dialog.getByLabelText("Confirm PIN"), "48291037");
    await userEvent.click(dialog.getByRole("button", { name: "Set PIN" }));
    await waitFor(() => expect(store.enrollPin).toHaveBeenCalled());
    view.rerender(<UnlockMethodsPanel />);
    await waitFor(() => expect(store.beginTotpEnrollment).toHaveBeenCalled());
    expect(await sheet().findByTestId("qr")).toBeTruthy();
  });

  it("drops an enrollment when the sheet closes before a code matched", async () => {
    render(<UnlockMethodsPanel />);
    await userEvent.click(
      row("Authenticator app").getByRole("button", { name: "Add" }),
    );
    await waitFor(() => expect(store.beginTotpEnrollment).toHaveBeenCalled());
    await userEvent.click(sheet().getByRole("button", { name: "Close" }));
    expect(store.cancelTotpEnrollment).toHaveBeenCalled();
    expect(store.confirmTotpEnrollment).not.toHaveBeenCalled();
  });

  it("removes the authenticator only after the confirmation card", async () => {
    vault.current = {
      header: { wrap: {}, kdf: {}, unlocks: { totp: {}, recovery: {} } },
    };
    store.recoveryCodes.mockResolvedValue({
      codes: ["aaaa-bbbb", "cccc-dddd"],
      used: [true, false],
      since: "2026-08-30T00:00:00Z",
    });
    render(<UnlockMethodsPanel />);
    expect(
      row("Authenticator app").getByRole("img", { name: "On" }),
    ).toBeTruthy();
    await userEvent.click(
      row("Authenticator app").getByRole("button", { name: "Remove" }),
    );
    const dialog = sheet();
    expect(document.querySelector(".found--ask .go--danger")).toBeTruthy();
    expect(store.removeTotp).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(dialog.getByText(/1 unused codes are discarded/)).toBeTruthy(),
    );
    await userEvent.click(
      dialog.getByRole("button", { name: "Remove authenticator" }),
    );
    await waitFor(() => expect(store.removeTotp).toHaveBeenCalled());
  });

  it("adds an email code: notice first, the account address offered, the first code confirms", async () => {
    render(<UnlockMethodsPanel />);
    await userEvent.click(
      row("Email code").getByRole("button", { name: "Add" }),
    );
    const dialog = sheet();
    expect(dialog.getByText(/fallback, not a first second step/)).toBeTruthy();
    expect(dialog.getByRole("button", { name: "Send a code" })).toHaveProperty(
      "disabled",
      true,
    );
    await userEvent.type(
      dialog.getByLabelText("Email address"),
      "tyler@example.com",
    );
    await userEvent.click(dialog.getByRole("button", { name: "Send a code" }));
    await waitFor(() =>
      expect(store.beginCodeEnrollment).toHaveBeenCalledWith(
        "email",
        "tyler@example.com",
      ),
    );
    expect(await dialog.findByText("Code sent")).toBeTruthy();
    expect(await dialog.findByText("t•••@example.com")).toBeTruthy();
    await userEvent.type(
      dialog.getByLabelText("Code from the email"),
      "123456",
    );
    await userEvent.click(dialog.getByRole("button", { name: "Turn on" }));
    await waitFor(() =>
      expect(store.confirmCodeEnrollment).toHaveBeenCalledWith("123456"),
    );
    await waitFor(() => expect(dialog.getByText("aaaa-bbbb")).toBeTruthy());
  });

  it("shows the recovery codes left and can make a new set", async () => {
    vault.current = {
      header: { wrap: {}, kdf: {}, unlocks: { totp: {}, recovery: {} } },
    };
    store.recoveryCodes.mockResolvedValue({
      codes: ["aaaa-bbbb", "cccc-dddd"],
      used: [true, false],
      since: "2026-08-30T00:00:00Z",
    });
    store.generateRecoveryCodes.mockResolvedValue(["eeee-ffff", "gggg-hhhh"]);
    render(<UnlockMethodsPanel />);
    await userEvent.click(
      row("Recovery codes").getByRole("button", {
        name: "View recovery codes",
      }),
    );
    const dialog = sheet();
    await waitFor(() => expect(dialog.getByText("1 of 2 left")).toBeTruthy());
    expect(dialog.getByText("aaaa-bbbb").className).toContain("is-used");
    await userEvent.click(
      dialog.getByRole("button", { name: "Make a new set" }),
    );
    // The alternative expanded in place: its own button, under the warning.
    const buttons = dialog.getAllByRole("button", { name: "Make a new set" });
    expect(buttons).toHaveLength(2);
    const confirm = buttons[1];
    if (!confirm) throw new Error("no confirmation button");
    await userEvent.click(confirm);
    await waitFor(() => expect(store.generateRecoveryCodes).toHaveBeenCalled());
    await waitFor(() => expect(dialog.getByText("eeee-ffff")).toBeTruthy());
  });
});
