import type { JsonObject } from "@opensesame/os-domain";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebauthnHostCheck } from "../../lib/vault/unlock-methods.js";

const vault: { current: { header: JsonObject | null; guest?: boolean } } =
  vi.hoisted(() => ({
    current: { header: null },
  }));
const store = vi.hoisted(() => ({
  enrollPasskey: vi.fn(),
  removePasskey: vi.fn(),
  enrollPin: vi.fn(),
  removePin: vi.fn(),
  enrollPassword: vi.fn(),
  removePassword: vi.fn(),
  beginTotpEnrollment: vi.fn(),
  confirmTotpEnrollment: vi.fn(),
  cancelTotpEnrollment: vi.fn(),
  removeTotp: vi.fn(),
  beginCodeEnrollment: vi.fn(),
  confirmCodeEnrollment: vi.fn(),
  cancelCodeEnrollment: vi.fn(),
  removeCode: vi.fn(),
  describeCodeChannel: vi.fn(),
  recoveryCodes: vi.fn(),
  generateRecoveryCodes: vi.fn(),
}));

import { vaultHooksSeams } from "../../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => store,
});

const listAvailableUnlockMethods = vi.hoisted(() => vi.fn(() => ["password"]));
const checkWebauthnHost = vi.hoisted(() =>
  vi.fn(
    (): WebauthnHostCheck => ({
      ok: true,
      hostname: "localhost",
      reason: "",
      fixUrl: null,
    }),
  ),
);
const describeWebauthnError = vi.hoisted(() =>
  vi.fn((error: { message?: string }) =>
    error instanceof Error ? `webauthn: ${error.message}` : "webauthn failed",
  ),
);

import { unlockMethodsSeams } from "../../lib/vault/unlock-methods.js";
const originalUnlockMethodsSeams = { ...unlockMethodsSeams };
Object.assign(unlockMethodsSeams, {
  listAvailableUnlockMethods,
  checkWebauthnHost,
  describeWebauthnError,
});

import { passwordSeams } from "../../lib/vault/password.js";
const originalPasswordSeams = { ...passwordSeams };
Object.assign(passwordSeams, {
  estimateStrength: (password: string) => ({
    score: password.length >= 12 ? 3 : 1,
    label: password.length >= 12 ? "Strong" : "Weak",
  }),
});

import { qrSeams } from "../../components/QrCode.js";
const originalQrSeams = { ...qrSeams };
Object.assign(qrSeams, {
  QrCode: ({ value }: { value: string }) => <div data-testid="qr">{value}</div>,
});

const identityApi = vi.hoisted(() => ({ current: "http://127.0.0.1:8788" }));
import { identitySeams } from "../../lib/identity.js";
const originalIdentitySeams = { ...identitySeams };
Object.assign(identitySeams, { identityBase: () => identityApi.current });

import { UnlockMethodsPanel } from "./UnlockMethodsPanel.js";

function passwordOnlyHeader() {
  vault.current = { header: { wrap: {}, kdf: {}, unlocks: {} } };
  listAvailableUnlockMethods.mockReturnValue(["password"]);
}

function pinAndPasswordHeader() {
  vault.current = {
    header: { wrap: {}, kdf: {}, unlocks: { pin: {} } },
  };
  listAvailableUnlockMethods.mockReturnValue(["password", "pin"]);
}

function guestHeader() {
  vault.current = { header: null, guest: true };
  listAvailableUnlockMethods.mockReturnValue([]);
}

/** The one row a method has, found by its name. */
function row(name: string) {
  const heading = screen.getByText(name, { selector: ".sw__name" });
  const container = heading.closest(".sw");
  if (!(container instanceof HTMLElement)) {
    throw new Error(`no row for ${name}`);
  }
  return within(container);
}

function sheet() {
  return within(screen.getByRole("dialog"));
}

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
    expect(row("Password").getByText("Enrolled")).toBeTruthy();
    expect(
      row("Authenticator app").getByRole("button", { name: "Add" }),
    ).toBeTruthy();
    expect(row("Email code").getByRole("button", { name: "Add" })).toBeTruthy();
    expect(
      row("Text message").getByRole("button", { name: "Add" }),
    ).toBeTruthy();
    expect(row("Recovery codes").queryByRole("button")).toBeNull();
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
    expect(dialog.getByText("Does not match")).toBeTruthy();
    await userEvent.type(dialog.getByLabelText("Confirm PIN"), "7");
    expect(dialog.getByText("Matches")).toBeTruthy();
    await userEvent.click(dialog.getByRole("button", { name: "Set PIN" }));
    await waitFor(() =>
      expect(store.enrollPin).toHaveBeenCalledWith("48291037"),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText(/PIN unlock enrolled/)).toBeTruthy();
  });

  it("names the PIN rule live and keeps the button disabled until it holds", async () => {
    render(<UnlockMethodsPanel />);
    await userEvent.click(row("PIN").getByRole("button", { name: "Add" }));
    const dialog = sheet();
    await userEvent.type(dialog.getByLabelText("PIN"), "11111111");
    expect(dialog.getByText(/repeated/i)).toBeTruthy();
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

  it("changes a password from its row and closes when it lands", async () => {
    render(<UnlockMethodsPanel />);
    await userEvent.click(
      row("Password").getByRole("button", { name: "Change" }),
    );
    const dialog = sheet();
    expect(dialog.getByText("Enrolled")).toBeTruthy();
    await userEvent.type(
      dialog.getByLabelText("New password"),
      "correct horse battery",
    );
    await userEvent.type(
      dialog.getByLabelText("Confirm new password"),
      "correct horse battery",
    );
    await userEvent.click(
      dialog.getByRole("button", { name: "Change password" }),
    );
    await waitFor(() =>
      expect(store.enrollPassword).toHaveBeenCalledWith(
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
    expect(dialog.getByText("Remove this password?")).toBeTruthy();
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
    await waitFor(() => expect(store.beginTotpEnrollment).toHaveBeenCalled());
    expect(dialog.getByTestId("qr").textContent).toContain("ABCDEFGH");
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
    await waitFor(() => expect(dialog.getByText("Did not match")).toBeTruthy());
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
    expect(sheet().getByTestId("qr")).toBeTruthy();
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
    expect(row("Authenticator app").getByText("On")).toBeTruthy();
    await userEvent.click(
      row("Authenticator app").getByRole("button", { name: "Remove" }),
    );
    const dialog = sheet();
    expect(dialog.getByText("Remove the authenticator?")).toBeTruthy();
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
    expect(dialog.getByText("Code sent")).toBeTruthy();
    expect(dialog.getByText("t•••@example.com")).toBeTruthy();
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

  it("says why email and text codes are unavailable without an Identity API", () => {
    identityApi.current = "";
    render(<UnlockMethodsPanel />);
    expect(row("Email code").getByText("Unavailable")).toBeTruthy();
    expect(
      row("Email code").getByRole("link", { name: "Connectivity" }),
    ).toBeTruthy();
    expect(row("Text message").queryByRole("button")).toBeNull();
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
      row("Recovery codes").getByRole("button", { name: "View" }),
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

afterEach(() => {
  Object.assign(vaultHooksSeams, originalVaultHooksSeams);
  Object.assign(unlockMethodsSeams, originalUnlockMethodsSeams);
  Object.assign(passwordSeams, originalPasswordSeams);
  Object.assign(qrSeams, originalQrSeams);
  Object.assign(identitySeams, originalIdentitySeams);
  Object.assign(vaultHooksSeams, {
    useVault: () => vault.current,
    useVaultStore: () => store,
  });
  Object.assign(unlockMethodsSeams, {
    listAvailableUnlockMethods,
    checkWebauthnHost,
    describeWebauthnError,
  });
  Object.assign(passwordSeams, {
    estimateStrength: (password: string) => ({
      score: password.length >= 12 ? 3 : 1,
      label: password.length >= 12 ? "Strong" : "Weak",
    }),
  });
  Object.assign(qrSeams, {
    QrCode: ({ value }: { value: string }) => (
      <div data-testid="qr">{value}</div>
    ),
  });
  Object.assign(identitySeams, { identityBase: () => identityApi.current });
});
