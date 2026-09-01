import type { JsonObject } from "@opensesame/os-domain";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
  }),
});

import { qrSeams } from "../../components/QrCode.js";
const originalQrSeams = { ...qrSeams };
Object.assign(qrSeams, {
  QrCode: ({ value }: { value: string }) => <div data-testid="qr">{value}</div>,
});

import { UnlockMethodsPanel } from "./UnlockMethodsPanel.js";

function pinHeader() {
  vault.current = {
    header: { wrap: {}, kdf: {}, unlocks: { pin: {} } },
  };
  listAvailableUnlockMethods.mockReturnValue(["password", "pin"]);
}

// Password enrolled, PIN not — renders the PIN enrollment form.
function passwordOnlyHeader() {
  vault.current = {
    header: { wrap: {}, kdf: {}, unlocks: {} },
  };
  listAvailableUnlockMethods.mockReturnValue(["password"]);
}

describe("UnlockMethodsPanel", () => {
  beforeEach(() => {
    vault.current = { header: { wrap: {}, kdf: {}, unlocks: {} } };
    listAvailableUnlockMethods.mockReturnValue(["password"]);
    checkWebauthnHost.mockReturnValue({
      ok: true,
      hostname: "localhost",
      reason: "",
      fixUrl: null,
    });
    store.enrollPasskey.mockResolvedValue(undefined);
    store.removePasskey.mockResolvedValue(undefined);
    store.enrollPin.mockResolvedValue(undefined);
    store.removePin.mockResolvedValue(undefined);
    store.enrollPassword.mockResolvedValue(undefined);
    store.removePassword.mockResolvedValue(undefined);
    store.beginTotpEnrollment.mockResolvedValue(
      "otpauth://totp/vault?secret=ABC",
    );
    store.confirmTotpEnrollment.mockResolvedValue(undefined);
    store.removeTotp.mockResolvedValue(undefined);
    window.history.replaceState(null, "", "/settings");
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("offers passkey, PIN, password, and MFA enrollment when none exist", () => {
    vault.current = { header: null };
    render(<UnlockMethodsPanel />);
    expect(
      screen.getByRole("button", { name: /Enroll passkey/i }),
    ).toBeTruthy();
    expect(screen.getByLabelText("New PIN")).toBeTruthy();
    expect(screen.getByLabelText("New master password")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Enroll MFA/i })).toBeTruthy();
  });

  it("enrolls a matching PIN and clears the form", async () => {
    passwordOnlyHeader();
    render(<UnlockMethodsPanel />);
    await userEvent.type(screen.getByLabelText("New PIN"), "48291037");
    await userEvent.type(screen.getByLabelText("Confirm PIN"), "48291037");
    await userEvent.click(screen.getByRole("button", { name: /Enroll PIN/i }));
    expect(store.enrollPin).toHaveBeenCalledWith("48291037");
    expect((await screen.findByRole("status")).textContent).toMatch(
      /PIN unlock enrolled/,
    );
    expect(screen.getByLabelText<HTMLInputElement>("New PIN").value).toBe("");
  });

  it("rejects mismatched PINs", async () => {
    passwordOnlyHeader();
    render(<UnlockMethodsPanel />);
    await userEvent.type(screen.getByLabelText("New PIN"), "12345678");
    await userEvent.type(screen.getByLabelText("Confirm PIN"), "87654321");
    // The submit button is disabled on mismatch; submit the form directly.
    const form = screen.getByLabelText("New PIN").closest("form");
    expect(form).toBeTruthy();
    if (!(form instanceof HTMLFormElement)) throw new Error("form not found");
    fireEvent.submit(form);
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /PINs do not match/,
    );
    expect(store.enrollPin).not.toHaveBeenCalled();
  });

  it("keeps the PIN button disabled until the PIN is long enough", async () => {
    passwordOnlyHeader();
    render(<UnlockMethodsPanel />);
    await userEvent.type(screen.getByLabelText("New PIN"), "1234");
    await userEvent.type(screen.getByLabelText("Confirm PIN"), "1234");
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: /Enroll PIN/i })
        .disabled,
    ).toBe(true);
    // The requirement is named live, not discovered at submit.
    expect(
      await screen.findByText("PIN must be 8–12 characters."),
    ).toBeTruthy();
  });

  it("blocks repeated and sequential PINs live, with the rule named", async () => {
    passwordOnlyHeader();
    render(<UnlockMethodsPanel />);
    const pinField = screen.getByLabelText("New PIN");
    await userEvent.type(pinField, "11111111");
    expect(
      await screen.findByText("PIN cannot be a repeated character."),
    ).toBeTruthy();
    await userEvent.clear(pinField);
    await userEvent.type(pinField, "12345678");
    expect(
      await screen.findByText("PIN cannot be a sequential run of digits."),
    ).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: /Enroll PIN/i })
        .disabled,
    ).toBe(true);
    expect(store.enrollPin).not.toHaveBeenCalled();
  });

  it("changes an enrolled PIN from the same form", async () => {
    vault.current = {
      header: { wrap: {}, kdf: {}, unlocks: { pin: { kdf: {}, wrap: {} } } },
    };
    listAvailableUnlockMethods.mockReturnValue(["password", "pin"]);
    render(<UnlockMethodsPanel />);
    await userEvent.type(screen.getByLabelText("New PIN"), "48291037");
    await userEvent.type(screen.getByLabelText("Confirm PIN"), "48291037");
    await userEvent.click(screen.getByRole("button", { name: /Change PIN/i }));
    expect(store.enrollPin).toHaveBeenCalledWith("48291037");
    expect((await screen.findByRole("status")).textContent).toMatch(
      /PIN updated/,
    );
  });

  it("surfaces PIN enrollment failures", async () => {
    passwordOnlyHeader();
    store.enrollPin.mockRejectedValue(new Error("wrap failed"));
    render(<UnlockMethodsPanel />);
    await userEvent.type(screen.getByLabelText("New PIN"), "48291037");
    await userEvent.type(screen.getByLabelText("Confirm PIN"), "48291037");
    await userEvent.click(screen.getByRole("button", { name: /Enroll PIN/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /webauthn: wrap failed/,
    );
  });

  it("enrolls a strong master password", async () => {
    vault.current = { header: { unlocks: {} } };
    render(<UnlockMethodsPanel />);
    await userEvent.type(
      screen.getByLabelText("New master password"),
      "correct horse battery",
    );
    await userEvent.type(
      screen.getByLabelText("Confirm master password"),
      "correct horse battery",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Enroll password/i }),
    );
    expect(store.enrollPassword).toHaveBeenCalledWith("correct horse battery");
    expect((await screen.findByRole("status")).textContent).toMatch(
      /Password unlock enrolled/,
    );
  });

  it("rejects mismatched passwords", async () => {
    vault.current = { header: { unlocks: {} } };
    render(<UnlockMethodsPanel />);
    await userEvent.type(
      screen.getByLabelText("New master password"),
      "correct horse battery",
    );
    await userEvent.type(
      screen.getByLabelText("Confirm master password"),
      "correct horse staples",
    );
    const form = screen.getByLabelText("New master password").closest("form");
    if (!(form instanceof HTMLFormElement)) throw new Error("form not found");
    fireEvent.submit(form);
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /passwords do not match/,
    );
    expect(store.enrollPassword).not.toHaveBeenCalled();
  });

  it("keeps the password button disabled for weak passwords", async () => {
    vault.current = { header: { unlocks: {} } };
    render(<UnlockMethodsPanel />);
    await userEvent.type(screen.getByLabelText("New master password"), "short");
    await userEvent.type(
      screen.getByLabelText("Confirm master password"),
      "short",
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: /Enroll password/i,
      }).disabled,
    ).toBe(true);
  });

  it("enrolls a passkey", async () => {
    render(<UnlockMethodsPanel />);
    await userEvent.click(
      screen.getByRole("button", { name: /Enroll passkey/i }),
    );
    expect(store.enrollPasskey).toHaveBeenCalled();
    expect((await screen.findByRole("status")).textContent).toMatch(
      /Passkey unlock enrolled/,
    );
  });

  it("shows the enrolled passkey state with a removable method", async () => {
    vault.current = {
      header: { wrap: {}, kdf: {}, unlocks: { passkey: {} } },
    };
    listAvailableUnlockMethods.mockReturnValue(["password", "passkey"]);
    render(<UnlockMethodsPanel />);
    expect(screen.getByText("Enrolled.")).toBeTruthy();
    const remove = screen.getAllByRole<HTMLButtonElement>("button", {
      name: /^Remove$/i,
    })[0];
    if (!remove) throw new Error("remove button not found");
    await userEvent.click(remove);
    expect(store.removePasskey).toHaveBeenCalled();
    expect((await screen.findByRole("status")).textContent).toMatch(
      /Passkey unlock removed/,
    );
  });

  it("disables removing the last remaining unlock method", () => {
    vault.current = {
      header: { unlocks: { passkey: {} } },
    };
    listAvailableUnlockMethods.mockReturnValue(["passkey"]);
    render(<UnlockMethodsPanel />);
    const remove = screen.getAllByRole<HTMLButtonElement>("button", {
      name: /^Remove$/i,
    })[0];
    if (!remove) throw new Error("remove button not found");
    expect(remove.disabled).toBe(true);
  });

  it("warns when the host cannot do WebAuthn and offers no fix", () => {
    checkWebauthnHost.mockReturnValue({
      ok: false,
      hostname: "example.test",
      reason: "WebAuthn is unavailable here.",
      fixUrl: null,
    });
    render(<UnlockMethodsPanel />);
    expect(screen.getByText(/WebAuthn is unavailable here/)).toBeTruthy();
    expect(screen.getByText(/Use a DNS hostname/)).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: /Enroll passkey/i,
      }).disabled,
    ).toBe(true);
  });

  it("offers a localhost fix when WebAuthn needs a DNS hostname", async () => {
    checkWebauthnHost.mockReturnValue({
      ok: false,
      hostname: "127.0.0.1",
      reason: "Passkeys need a secure DNS hostname.",
      fixUrl: "http://localhost:5180/settings",
    });
    render(<UnlockMethodsPanel />);
    expect(screen.getByText(/Passkeys cannot use a raw IP/)).toBeTruthy();
    const button = screen.getByRole("button", {
      name: /Continue on localhost/i,
    });
    // jsdom cannot navigate; assert the click path runs without throwing.
    await userEvent.click(button);
    expect(checkWebauthnHost).toHaveBeenCalled();
  });

  it("shows the fallback error when there is no fix URL", async () => {
    checkWebauthnHost.mockReturnValue({
      ok: false,
      hostname: "example.test",
      reason: "WebAuthn is unavailable here.",
      fixUrl: null,
    });
    render(<UnlockMethodsPanel />);
    // The heal path is only reachable with a fixUrl; when missing the enroll
    // button is disabled, so the fallback shows via the inline warning.
    expect(screen.getByText(/WebAuthn is unavailable here/)).toBeTruthy();
  });

  it("auto-enrolls a passkey when returning with ?enroll-passkey=1", async () => {
    window.history.replaceState(null, "", "/settings?enroll-passkey=1");
    render(<UnlockMethodsPanel />);
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(store.enrollPasskey).toHaveBeenCalled();
    // The param is consumed so a reload does not enroll again.
    expect(window.location.search).not.toMatch(/enroll-passkey/);
  });

  it("ignores the enroll-passkey param when the host cannot do WebAuthn", () => {
    checkWebauthnHost.mockReturnValue({
      ok: false,
      hostname: "example.test",
      reason: "no webauthn",
      fixUrl: null,
    });
    window.history.replaceState(null, "", "/settings?enroll-passkey=1");
    render(<UnlockMethodsPanel />);
    expect(store.enrollPasskey).not.toHaveBeenCalled();
  });

  it("turns authenticator MFA on only once a code from the app matches", async () => {
    render(<UnlockMethodsPanel />);
    await userEvent.click(screen.getByRole("button", { name: /Enroll MFA/i }));
    expect(store.beginTotpEnrollment).toHaveBeenCalled();
    expect(store.confirmTotpEnrollment).not.toHaveBeenCalled();
    expect(screen.getByTestId("qr").textContent).toBe(
      "otpauth://totp/vault?secret=ABC",
    );
    const turnOn = screen.getByRole("button", { name: "Turn on" });
    expect(turnOn.hasAttribute("disabled")).toBe(true);
    await userEvent.type(
      screen.getByRole("textbox", { name: "Authenticator code" }),
      "123456",
    );
    expect(turnOn.hasAttribute("disabled")).toBe(false);
    await userEvent.click(turnOn);
    expect(store.confirmTotpEnrollment).toHaveBeenCalledWith("123456");
    expect((await screen.findByRole("status")).textContent).toMatch(
      /Authenticator MFA is on/,
    );
    expect(screen.queryByTestId("qr")).toBeNull();
  });

  it("cancels an enrollment before any code matched", async () => {
    render(<UnlockMethodsPanel />);
    await userEvent.click(screen.getByRole("button", { name: /Enroll MFA/i }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(store.cancelTotpEnrollment).toHaveBeenCalled();
    expect(store.confirmTotpEnrollment).not.toHaveBeenCalled();
    expect(screen.queryByTestId("qr")).toBeNull();
    expect(screen.getByRole("button", { name: /Enroll MFA/i })).toBeTruthy();
  });

  it("walks a guest into setting a key first, then straight on to the code", async () => {
    // A guest session has no key on disk; asking for MFA asks for the key
    // in the same row, and the scan step begins on its own once it exists.
    vault.current = { header: { unlocks: {} }, guest: true };
    listAvailableUnlockMethods.mockReturnValue([]);
    const view = render(<UnlockMethodsPanel />);
    await userEvent.click(screen.getByRole("button", { name: /Enroll MFA/i }));
    expect(store.beginTotpEnrollment).not.toHaveBeenCalled();
    expect(screen.getByText("1 · Set a key")).toBeTruthy();
    expect(screen.getByRole("form", { name: "Set a PIN" })).toBeTruthy();
    expect(screen.getByRole("form", { name: "Set a password" })).toBeTruthy();
    await userEvent.type(
      screen.getByLabelText("PIN for this vault"),
      "48291037",
    );
    await userEvent.type(
      screen.getByLabelText("Confirm PIN for this vault"),
      "48291037",
    );
    await userEvent.click(screen.getByRole("button", { name: "Use a PIN" }));
    expect(store.enrollPin).toHaveBeenCalledWith("48291037");
    // The store now reports a key: the same panel, re-rendered, moves on.
    vault.current = { header: { unlocks: { pin: {} } }, guest: false };
    listAvailableUnlockMethods.mockReturnValue(["pin"]);
    view.rerender(<UnlockMethodsPanel />);
    await waitFor(() => expect(store.beginTotpEnrollment).toHaveBeenCalled());
    expect(await screen.findByTestId("qr")).toBeTruthy();
    expect(screen.getByText("2 · Scan and confirm")).toBeTruthy();
  });

  it("lets a guest back out of step 1 without touching anything", async () => {
    vault.current = { header: { unlocks: {} }, guest: true };
    listAvailableUnlockMethods.mockReturnValue([]);
    render(<UnlockMethodsPanel />);
    await userEvent.click(screen.getByRole("button", { name: /Enroll MFA/i }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("1 · Set a key")).toBeNull();
    expect(store.enrollPin).not.toHaveBeenCalled();
    expect(store.beginTotpEnrollment).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Enroll MFA/i })).toBeTruthy();
  });

  it("removes authenticator MFA", async () => {
    vault.current = {
      header: { wrap: {}, kdf: {}, unlocks: { totp: {} } },
    };
    render(<UnlockMethodsPanel />);
    expect(
      screen.getByText(/Required after every primary unlock/),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Remove MFA/i }));
    expect(store.removeTotp).toHaveBeenCalled();
    expect((await screen.findByRole("status")).textContent).toMatch(
      /Authenticator MFA removed/,
    );
  });

  it("removes an enrolled PIN", async () => {
    pinHeader();
    render(<UnlockMethodsPanel />);
    const remove = screen.getAllByRole<HTMLButtonElement>("button", {
      name: /^Remove$/i,
    })[0];
    if (!remove) throw new Error("remove button not found");
    await userEvent.click(remove);
    expect(store.removePin).toHaveBeenCalled();
    expect((await screen.findByRole("status")).textContent).toMatch(
      /PIN unlock removed/,
    );
  });

  it("removes an enrolled password", async () => {
    pinHeader();
    render(<UnlockMethodsPanel />);
    const remove = screen.getAllByRole<HTMLButtonElement>("button", {
      name: /^Remove$/i,
    })[1];
    if (!remove) throw new Error("remove button not found");
    await userEvent.click(remove);
    expect(store.removePassword).toHaveBeenCalled();
    expect((await screen.findByRole("status")).textContent).toMatch(
      /Password unlock removed/,
    );
  });
});
