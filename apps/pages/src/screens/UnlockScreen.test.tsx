import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnlockMethodId } from "../lib/vault/unlock-methods.js";

type TestVaultState = {
  status: "empty" | "locked";
  header: { hint: string } | null;
  lockedOutUntil: number | null;
  failedAttempts: number;
  durable: boolean;
  awaitingTotp: boolean;
};

type TestHostCheck = {
  ok: boolean;
  reason?: string;
  fixUrl?: string | null;
};

type StoreMethod =
  | "create"
  | "createWithPasskey"
  | "createWithPin"
  | "unlock"
  | "unlockWithPin"
  | "unlockWithPasskey"
  | "confirmTotp"
  | "cancelTotpChallenge"
  | "destroy";

type TestHarness = {
  state: TestVaultState;
  methods: UnlockMethodId[];
  preferred: UnlockMethodId;
  host: TestHostCheck;
  store: Record<StoreMethod, ReturnType<typeof vi.fn>>;
};

const v = vi.hoisted((): TestHarness => {
  const state: TestVaultState = {
    status: "locked",
    header: null,
    lockedOutUntil: null,
    failedAttempts: 0,
    durable: true,
    awaitingTotp: false,
  };
  const methods: UnlockMethodId[] = ["password"];
  const preferred: UnlockMethodId = "password";
  const host: TestHostCheck = { ok: true };
  return {
    state,
    methods,
    preferred,
    host,
    store: {
      create: vi.fn(),
      createWithPasskey: vi.fn(),
      createWithPin: vi.fn(),
      unlock: vi.fn(),
      unlockWithPin: vi.fn(),
      unlockWithPasskey: vi.fn(),
      confirmTotp: vi.fn(),
      cancelTotpChallenge: vi.fn(),
      destroy: vi.fn(),
    },
  };
});

import { vaultHooksSeams } from "../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => v.state,
  useVaultStore: () => v.store,
});

import { unlockMethodsSeams } from "../lib/vault/unlock-methods.js";
const originalUnlockMethodsSeams = { ...unlockMethodsSeams };
Object.assign(unlockMethodsSeams, {
  listAvailableUnlockMethods: () => v.methods,
  preferredUnlockMethod: () => v.preferred,
  checkWebauthnHost: () => v.host,
  describeWebauthnError: (error: BoundaryValue) =>
    `webauthn: ${error instanceof Error ? error.message : String(error)}`,
});

import { guestAuthSeams } from "../lib/guest-auth.js";
const continueAsGuest = vi.fn();
Object.assign(guestAuthSeams, { continueAsGuest });

import { UnlockScreen } from "./UnlockScreen.js";

const STRONG = "correct horse battery staple";

function submitButton(): HTMLButtonElement {
  const buttons = screen
    .getAllByRole("button")
    .filter((el) => el.getAttribute("type") === "submit");
  if (buttons.length !== 1) throw new Error("submit button not found");
  return overlapCast(buttons[0]);
}

function masterInput(): HTMLInputElement {
  return overlapCast(screen.getByLabelText(/Master password|^Password$/));
}

function chooseSealMethod(name: string): void {
  fireEvent.click(screen.getByRole("tab", { name }));
}

describe("UnlockScreen — first run", () => {
  beforeEach(() => {
    v.state = {
      status: "empty",
      header: null,
      lockedOutUntil: null,
      failedAttempts: 0,
      durable: true,
      awaitingTotp: false,
    };
    v.methods = ["password"];
    v.preferred = "password";
    v.host = { ok: true };
    for (const fn of Object.values(v.store)) fn.mockReset();
    v.store.create.mockResolvedValue(undefined);
    v.store.createWithPasskey.mockResolvedValue(undefined);
    v.store.createWithPin.mockResolvedValue(undefined);
    continueAsGuest.mockReset();
    continueAsGuest.mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("seals with a passkey without asking for a master password", async () => {
    render(<UnlockScreen />);
    expect(
      screen.getByRole("heading", { name: "Seal this device" }),
    ).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Passkey" })).toBeTruthy();
    expect(screen.queryByLabelText(/Master password/)).toBeNull();
    expect(submitButton().textContent).toContain("Seal with passkey");
    expect(submitButton().disabled).toBe(true);
    expect(v.store.createWithPasskey).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByLabelText("I understand this vault cannot be recovered."),
    );
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(v.store.createWithPasskey).toHaveBeenCalledTimes(1),
    );
    expect(v.store.create).not.toHaveBeenCalled();
  });

  it("seals with a PIN without asking for a master password", async () => {
    render(<UnlockScreen />);
    chooseSealMethod("PIN");
    expect(screen.queryByLabelText(/Master password/)).toBeNull();
    expect(submitButton().textContent).toContain("Seal with PIN");
    expect(submitButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Device PIN"), {
      target: { value: "12345678" },
    });
    fireEvent.change(screen.getByLabelText("Confirm PIN"), {
      target: { value: "12345678" },
    });
    expect(submitButton().disabled).toBe(true);
    fireEvent.click(
      screen.getByLabelText("I understand this vault cannot be recovered."),
    );
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(v.store.createWithPin).toHaveBeenCalledWith("12345678"),
    );
    expect(v.store.create).not.toHaveBeenCalled();
  });

  it("hides passkey and falls back to password when WebAuthn cannot run", () => {
    v.host = {
      ok: false,
      reason: "Passkeys need a DNS hostname.",
      fixUrl: "http://localhost:5180/",
    };
    render(<UnlockScreen />);
    expect(screen.queryByRole("tab", { name: "Passkey" })).toBeNull();
    expect(screen.getByRole("tab", { name: "PIN" })).toBeTruthy();
    expect(screen.getByLabelText(/Master password/)).toBeTruthy();
    expect(screen.getByText(/600,000 PBKDF2-SHA256/)).toBeTruthy();
  });

  it("switching methods cancels a pending first-run passkey seal", async () => {
    v.store.createWithPasskey.mockImplementation(
      (signal?: AbortSignal) =>
        new Promise((_, reject) => {
          signal?.addEventListener("abort", () =>
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            ),
          );
        }),
    );
    render(<UnlockScreen />);
    fireEvent.click(
      screen.getByLabelText("I understand this vault cannot be recovered."),
    );
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(v.store.createWithPasskey).toHaveBeenCalledTimes(1),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Password" }));
    await waitFor(() => expect(masterInput().disabled).toBe(false));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(v.store.create).not.toHaveBeenCalled();
  });

  it("explains the seal and keeps the submit disabled until the form is valid", () => {
    render(<UnlockScreen />);
    chooseSealMethod("Password");
    expect(
      screen.getByRole("heading", { name: "Seal this device" }),
    ).toBeTruthy();
    expect(screen.getByText("Enter a master password")).toBeTruthy();
    expect(screen.getByText(/600,000 PBKDF2-SHA256/)).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
  });

  it("warns about weak passwords as they are typed", () => {
    render(<UnlockScreen />);
    chooseSealMethod("Password");
    fireEvent.change(masterInput(), { target: { value: "hunter2" } });
    expect(screen.getByText(/Very weak|Weak/)).toBeTruthy();
    expect(
      screen.getByText(/would not survive an offline attack/),
    ).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
  });

  it("creates the vault once password, confirmation, and acknowledgement line up", async () => {
    render(<UnlockScreen />);
    chooseSealMethod("Password");
    fireEvent.change(masterInput(), { target: { value: STRONG } });
    fireEvent.change(screen.getByLabelText("Confirm master password"), {
      target: { value: STRONG },
    });
    fireEvent.change(screen.getByLabelText(/Reminder/), {
      target: { value: "  my usual place  " },
    });
    // Still blocked until the no-recovery acknowledgement.
    expect(submitButton().disabled).toBe(true);
    fireEvent.click(
      screen.getByLabelText("I understand this vault cannot be recovered."),
    );
    expect(submitButton().disabled).toBe(false);

    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(v.store.create).toHaveBeenCalledWith(STRONG, "my usual place"),
    );
  });

  it("shows create failures inline", async () => {
    v.store.create.mockRejectedValue(new Error("storage quota exceeded"));
    render(<UnlockScreen />);
    chooseSealMethod("Password");
    fireEvent.change(masterInput(), { target: { value: STRONG } });
    fireEvent.change(screen.getByLabelText("Confirm master password"), {
      target: { value: STRONG },
    });
    fireEvent.click(
      screen.getByLabelText("I understand this vault cannot be recovered."),
    );
    fireEvent.click(submitButton());
    expect(await screen.findByText("storage quota exceeded")).toBeTruthy();
  });

  it("reveals and hides both password fields together", () => {
    render(<UnlockScreen />);
    chooseSealMethod("Password");
    const master = masterInput();
    expect(master.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(master.type).toBe("text");
    expect(
      overlapCast(screen.getByLabelText("Confirm master password")).type,
    ).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(master.type).toBe("password");
  });

  it("continues as a guest without a passkey or password", async () => {
    render(<UnlockScreen />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Continue as guest — no passkey or password",
      }),
    );
    await waitFor(() => expect(continueAsGuest).toHaveBeenCalledTimes(1));
    expect(v.store.create).not.toHaveBeenCalled();
    expect(v.store.createWithPasskey).not.toHaveBeenCalled();
    expect(v.store.createWithPin).not.toHaveBeenCalled();
  });

  it("does not offer the reset affordance on first run", () => {
    render(<UnlockScreen />);
    expect(
      screen.queryByRole("button", { name: "Forgotten how to unlock?" }),
    ).toBeNull();
  });
});

describe("UnlockScreen — password unlock", () => {
  beforeEach(() => {
    v.state = {
      status: "locked",
      header: { hint: "my usual place" },
      lockedOutUntil: null,
      failedAttempts: 0,
      durable: true,
      awaitingTotp: false,
    };
    v.methods = ["password"];
    v.preferred = "password";
    v.host = { ok: true };
    for (const fn of Object.values(v.store)) fn.mockReset();
    v.store.unlock.mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("shows the stored reminder and the passkey-enrolment nudge", () => {
    render(<UnlockScreen />);
    expect(screen.getByRole("heading", { name: "OpenSesame" })).toBeTruthy();
    expect(screen.getByText(/my usual place/)).toBeTruthy();
    expect(
      screen.getByText(/No passkey unlock on this vault yet/),
    ).toBeTruthy();
    // No method tabs for a password-only vault.
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("unlocks with the typed password and clears the field", async () => {
    render(<UnlockScreen />);
    const master = masterInput();
    expect(submitButton().disabled).toBe(true);
    fireEvent.change(master, { target: { value: "open sesame" } });
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(v.store.unlock).toHaveBeenCalledWith("open sesame"),
    );
    await waitFor(() => expect(master.value).toBe(""));
  });

  it("shows unlock failures and clears the field", async () => {
    v.store.unlock.mockRejectedValue(new Error("wrong password"));
    render(<UnlockScreen />);
    const master = masterInput();
    fireEvent.change(master, { target: { value: "nope" } });
    fireEvent.click(submitButton());
    expect(await screen.findByText("wrong password")).toBeTruthy();
    expect(master.value).toBe("");
  });

  it("translates WebAuthn-flavoured errors into remediation text", async () => {
    v.store.unlock.mockRejectedValue(
      new Error("SecurityError: invalid domain"),
    );
    render(<UnlockScreen />);
    fireEvent.change(masterInput(), { target: { value: "nope" } });
    fireEvent.click(submitButton());
    expect(
      await screen.findByText("webauthn: SecurityError: invalid domain"),
    ).toBeTruthy();
  });

  it("points at localhost when passkeys cannot work on this host", () => {
    v.host = {
      ok: false,
      reason: "Passkeys need a DNS hostname.",
      fixUrl: "http://localhost:5180/",
    };
    render(<UnlockScreen />);
    expect(
      screen.getByText(/Passkey unlock needs a DNS hostname/),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "localhost" }).getAttribute("href"),
    ).toBe("http://localhost:5180/");
  });

  it("warns when the browser offers no persistent storage", () => {
    v.state.durable = false;
    render(<UnlockScreen />);
    expect(screen.getByText(/no persistent storage/)).toBeTruthy();
  });

  it("offers vault deletion behind a confirm step", async () => {
    render(<UnlockScreen />);
    fireEvent.click(
      screen.getByRole("button", { name: "Forgotten how to unlock?" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete this vault" }));
    await waitFor(() => expect(v.store.destroy).toHaveBeenCalledTimes(1));
  });

  it("backs out of the reset affordance without destroying", () => {
    render(<UnlockScreen />);
    fireEvent.click(
      screen.getByRole("button", { name: "Forgotten how to unlock?" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(v.store.destroy).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Forgotten how to unlock?" }),
    ).toBeTruthy();
  });

  it("counts down the lockout and disables input", () => {
    v.state.lockedOutUntil = Date.now() + 45_000;
    v.state.failedAttempts = 3;
    render(<UnlockScreen />);
    expect(
      screen.getByText(/3 failed attempts\. Try again in 4[45]s\./),
    ).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
    expect(masterInput().disabled).toBe(true);
  });
});

describe("UnlockScreen — PIN unlock", () => {
  beforeEach(() => {
    v.state = {
      status: "locked",
      header: null,
      lockedOutUntil: null,
      failedAttempts: 0,
      durable: true,
      awaitingTotp: false,
    };
    v.methods = ["password", "pin"];
    v.preferred = "password";
    v.host = { ok: true };
    for (const fn of Object.values(v.store)) fn.mockReset();
    v.store.unlockWithPin.mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("switches to the PIN tab and unlocks with the PIN", async () => {
    render(<UnlockScreen />);
    const tab = screen.getByRole("tab", { name: "PIN" });
    expect(tab.getAttribute("aria-selected")).toBe("false");
    fireEvent.click(tab);
    expect(tab.getAttribute("aria-selected")).toBe("true");

    const pin = overlapCast<unknown, HTMLInputElement>(
      screen.getByLabelText("PIN"),
    );
    fireEvent.change(pin, { target: { value: "123" } });
    expect(submitButton().disabled).toBe(true);
    fireEvent.change(pin, { target: { value: "12345678" } });
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(v.store.unlockWithPin).toHaveBeenCalledWith("12345678"),
    );
    await waitFor(() => expect(pin.value).toBe(""));
  });

  it("shows PIN failures", async () => {
    v.store.unlockWithPin.mockRejectedValue(new Error("bad PIN"));
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "PIN" }));
    fireEvent.change(screen.getByLabelText("PIN"), {
      target: { value: "12345678" },
    });
    fireEvent.click(submitButton());
    expect(await screen.findByText("bad PIN")).toBeTruthy();
  });
});

describe("UnlockScreen — passkey unlock", () => {
  beforeEach(() => {
    v.state = {
      status: "locked",
      header: null,
      lockedOutUntil: null,
      failedAttempts: 0,
      durable: true,
      awaitingTotp: false,
    };
    v.methods = ["passkey", "password"];
    v.preferred = "passkey";
    v.host = { ok: true };
    for (const fn of Object.values(v.store)) fn.mockReset();
  });

  afterEach(cleanup);

  it("offers the platform prompt once, automatically", async () => {
    v.store.unlockWithPasskey.mockResolvedValue(undefined);
    render(<UnlockScreen />);
    await waitFor(() =>
      expect(v.store.unlockWithPasskey).toHaveBeenCalledTimes(1),
    );
    expect(screen.getByText(/Use your platform authenticator/)).toBeTruthy();
    expect(submitButton().textContent).toContain("Unlock with passkey");
  });

  it("describes WebAuthn failures from the automatic prompt", async () => {
    v.store.unlockWithPasskey.mockRejectedValue(
      new Error("The operation was cancelled."),
    );
    render(<UnlockScreen />);
    expect(
      await screen.findByText("webauthn: The operation was cancelled."),
    ).toBeTruthy();
  });

  it("warns instead of prompting on a host where WebAuthn cannot work", async () => {
    v.host = {
      ok: false,
      reason: "Passkeys need a DNS hostname.",
      fixUrl: null,
    };
    v.store.unlockWithPasskey.mockResolvedValue(undefined);
    render(<UnlockScreen />);
    expect(screen.getByText(/Passkeys need a DNS hostname/)).toBeTruthy();
    expect(screen.getByText(/Open this app on a DNS hostname/)).toBeTruthy();
    expect(v.store.unlockWithPasskey).not.toHaveBeenCalled();
    expect(submitButton().disabled).toBe(true);
  });

  it("links to the localhost equivalent when one exists", async () => {
    v.host = {
      ok: false,
      reason: "Passkeys need a DNS hostname.",
      fixUrl: "http://localhost:5180/",
    };
    v.store.unlockWithPasskey.mockResolvedValue(undefined);
    render(<UnlockScreen />);
    expect(
      screen
        .getByRole("link", { name: "Continue on localhost" })
        .getAttribute("href"),
    ).toBe("http://localhost:5180/");
    expect(v.store.unlockWithPasskey).not.toHaveBeenCalled();
  });

  it("manual submit retries the passkey ceremony", async () => {
    v.store.unlockWithPasskey.mockResolvedValue(undefined);
    render(<UnlockScreen />);
    await waitFor(() =>
      expect(v.store.unlockWithPasskey).toHaveBeenCalledTimes(1),
    );
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(v.store.unlockWithPasskey).toHaveBeenCalledTimes(2),
    );
  });

  it("switching methods cancels a blocking passkey prompt and frees the form", async () => {
    v.store.unlockWithPasskey.mockImplementation(
      (signal?: AbortSignal) =>
        new Promise((_, reject) => {
          signal?.addEventListener("abort", () =>
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            ),
          );
        }),
    );
    render(<UnlockScreen />);
    await waitFor(() =>
      expect(v.store.unlockWithPasskey).toHaveBeenCalledTimes(1),
    );
    // The prompt is pending ("blocking") — the Password tab must still be live.
    const passwordTab = overlapCast<unknown, HTMLButtonElement>(
      screen.getByRole("tab", {
        name: /Password/,
      }),
    );
    expect(passwordTab.disabled).toBe(false);
    fireEvent.click(passwordTab);
    // The ceremony was aborted, no error surfaced, and the password form works.
    await waitFor(() => expect(masterInput().disabled).toBe(false));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(submitButton().textContent).toContain("Unlock");
    fireEvent.change(masterInput(), { target: { value: "hunter2" } });
    expect(submitButton().disabled).toBe(false);
  });

  it("a cancelled passkey prompt never surfaces as an error", async () => {
    v.store.unlockWithPasskey.mockImplementation(
      (signal?: AbortSignal) =>
        new Promise((_, reject) => {
          signal?.addEventListener("abort", () =>
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            ),
          );
        }),
    );
    render(<UnlockScreen />);
    await waitFor(() =>
      expect(v.store.unlockWithPasskey).toHaveBeenCalledTimes(1),
    );
    fireEvent.click(screen.getByRole("tab", { name: /Password/ }));
    await waitFor(() => expect(masterInput().disabled).toBe(false));
    expect(screen.queryByText(/^webauthn:/)).toBeNull();
  });
});

describe("UnlockScreen — TOTP step-up", () => {
  beforeEach(() => {
    v.state = {
      status: "locked",
      header: null,
      lockedOutUntil: null,
      failedAttempts: 0,
      durable: true,
      awaitingTotp: true,
    };
    v.methods = ["password"];
    v.preferred = "password";
    v.host = { ok: true };
    for (const fn of Object.values(v.store)) fn.mockReset();
    v.store.confirmTotp.mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("confirms the authenticator code after primary unlock", async () => {
    render(<UnlockScreen />);
    expect(
      screen.getByText(/Enter the code from your authenticator/),
    ).toBeTruthy();
    const input = screen.getByLabelText("Authenticator code");
    expect(submitButton().disabled).toBe(true);
    fireEvent.change(input, { target: { value: "123 456" } });
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(v.store.confirmTotp).toHaveBeenCalledWith("123 456"),
    );
  });

  it("shows TOTP failures", async () => {
    v.store.confirmTotp.mockRejectedValue(new Error("code expired"));
    render(<UnlockScreen />);
    fireEvent.change(screen.getByLabelText("Authenticator code"), {
      target: { value: "123456" },
    });
    fireEvent.click(submitButton());
    expect(await screen.findByText("code expired")).toBeTruthy();
  });

  it("can bail back to the primary unlock methods", () => {
    render(<UnlockScreen />);
    fireEvent.click(
      screen.getByRole("button", { name: "Use a different unlock method" }),
    );
    expect(v.store.cancelTotpChallenge).toHaveBeenCalledTimes(1);
  });
});
