import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignInMethods } from "../lib/settings.js";
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

import { federationSeams } from "../lib/federation.js";
const beginSignIn = vi.fn();
const UPSTREAM = {
  id: "shoo",
  displayName: "Shoo",
  issuer: "https://shoo.dev",
  accountKind: "Google (via shoo.dev)",
};
/** Tests that need a different default upstream (e.g. the dev mock) swap this. */
const upstreamHolder = { current: UPSTREAM };
Object.assign(federationSeams, {
  beginSignIn,
  defaultUpstream: () => upstreamHolder.current,
});

const FEDERATED_BUTTON = `Continue with ${UPSTREAM.accountKind}`;

import { identitySeams } from "../lib/identity.js";
import type { IdentitySession } from "../lib/identity.js";
identitySeams.identityBase = () => "http://127.0.0.1:18788";
const endSession = vi.fn();
type SessionHolder = { current: IdentitySession | null };
const sessionHolder: SessionHolder = { current: null };
identitySeams.useIdentitySession = () => sessionHolder.current;
identitySeams.endSession = endSession;

import { orgSeams } from "../lib/orgs.js";
const lookupOrgTenant = vi.fn();
const lookupOrgByDomain = vi.fn();
Object.assign(orgSeams, { lookupOrgTenant, lookupOrgByDomain });

import { providersSeams } from "../lib/providers.js";
const listFederatedProviders = vi.fn();
const requestEmailMagicLink = vi.fn();
Object.assign(providersSeams, {
  listFederatedProviders,
  requestEmailMagicLink,
});

import { setupScreenDependencies } from "./SetupScreen.js";
import { UnlockScreen, unlockScreenDependencies } from "./UnlockScreen.js";

// This file exercises the unlock form. Setup has a suite of its own; here the
// ceremony is already answered, which is the state of every device that has a
// vault on it, and the few tests that do reach it only assert the handoff.
const setupRequiredHolder = { current: false };
const identityBaseHolder = { current: "http://127.0.0.1:18788" };
/** What setup left as the ways in — the screen reads this, not the URL. */
type WaysInHolder = { current: SignInMethods };
const waysInHolder: WaysInHolder = {
  current: { builtin: true, providers: [] },
};
const completeSetup = vi.fn<() => Promise<void>>();
Object.assign(unlockScreenDependencies, {
  setupRequired: () => setupRequiredHolder.current,
  currentSession: () => null,
  identityBase: () => identityBaseHolder.current,
  signInMethods: () => waysInHolder.current,
  noWayIn: () =>
    !waysInHolder.current.builtin &&
    waysInHolder.current.providers.length === 0 &&
    identityBaseHolder.current.trim() === "",
  defaultUpstream: () => ({
    id: "shoo",
    displayName: "Shoo",
    issuer: "https://shoo.dev",
    accountKind: "Google (via shoo.dev)",
  }),
});
Object.assign(setupScreenDependencies, {
  // The ceremony's own behaviour is covered in SetupScreen.test.tsx; these
  // tests only care that it is reached and handed back from.
  completeSetup,
});

const STRONG = "correct horse battery staple";

function submitButton(): HTMLButtonElement {
  // Scoped to the unlock form: on an existing vault the sign-in panel below it
  // carries a submit button of its own (the identifier field's "Continue").
  const form = document.querySelector<HTMLElement>(".unlock__form");
  if (!form) throw new Error("unlock form not found");
  const buttons = within(form)
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

/** First run lands on sign-in; the seal form is the explicit local-only road. */
function goLocalOnly(): void {
  fireEvent.click(
    screen.getByRole("button", { name: "Use without an account" }),
  );
}

function identifierInput(): HTMLInputElement {
  return overlapCast(screen.getByLabelText("Email or organization"));
}

function submitIdentifier(value: string): void {
  fireEvent.change(identifierInput(), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

// Every unlock screen now fetches the catalog and can start a leg, not just
// first run, so the federation seams need a known state before every test in
// this file rather than inside the one block that used to be the sole caller.
beforeEach(() => {
  continueAsGuest.mockReset();
  continueAsGuest.mockResolvedValue(undefined);
  beginSignIn.mockReset();
  // Real sign-in navigates away and never settles; a pending promise is the
  // honest stand-in.
  beginSignIn.mockReturnValue(new Promise(() => {}));
  lookupOrgTenant.mockReset();
  lookupOrgByDomain.mockReset();
  lookupOrgByDomain.mockResolvedValue(null);
  requestEmailMagicLink.mockReset();
  requestEmailMagicLink.mockResolvedValue(undefined);
  listFederatedProviders.mockReset();
  // No catalog is the default: every expectation below that names the single
  // fallback button is the empty-catalog path (an unreachable or older
  // Identity API).
  listFederatedProviders.mockResolvedValue([]);
  endSession.mockReset();
  setupRequiredHolder.current = false;
  identityBaseHolder.current = "http://127.0.0.1:18788";
  waysInHolder.current = { builtin: true, providers: [] };
  completeSetup.mockReset();
  completeSetup.mockResolvedValue(undefined);
  sessionHolder.current = null;
  upstreamHolder.current = UPSTREAM;
});

describe("UnlockScreen — setup gate", () => {
  afterEach(cleanup);

  function fresh() {
    v.state = {
      status: "empty",
      header: null,
      lockedOutUntil: null,
      failedAttempts: 0,
      durable: true,
      awaitingTotp: false,
    };
  }

  it("runs the setup ceremony before anything else on a fresh deployment", () => {
    fresh();
    setupRequiredHolder.current = true;
    render(<UnlockScreen />);

    // The screen this replaces led with an amber report of the same state.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "How do people sign in?",
    );
    expect(screen.queryByRole("tab", { name: "Unlock" })).toBeNull();
  });

  it("opens the ceremony once the device is known to be empty", () => {
    // The vault header is hydrated from OPFS before first paint in production,
    // but a one-shot `useState` initializer still races: if the first render
    // saw a sealed tomb (or a live session) the ceremony never ran, even after
    // that reading was corrected. Re-read the gate so a first-time visit
    // cannot miss it.
    v.state = {
      status: "locked",
      header: null,
      lockedOutUntil: null,
      failedAttempts: 0,
      durable: true,
      awaitingTotp: false,
    };
    setupRequiredHolder.current = false;
    const { rerender } = render(<UnlockScreen />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Unlock",
    );

    fresh();
    setupRequiredHolder.current = true;
    rerender(<UnlockScreen />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "How do people sign in?",
    );
  });

  it("leaves a returning vault on unlock when a late hydrate finds one", () => {
    fresh();
    setupRequiredHolder.current = true;
    const { rerender } = render(<UnlockScreen />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "How do people sign in?",
    );

    v.state = {
      status: "locked",
      header: null,
      lockedOutUntil: null,
      failedAttempts: 0,
      durable: true,
      awaitingTotp: false,
    };
    setupRequiredHolder.current = false;
    rerender(<UnlockScreen />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Unlock",
    );
  });

  it("hands back to the unlock screen once setup is answered", () => {
    fresh();
    setupRequiredHolder.current = true;
    render(<UnlockScreen />);
    // One tap: the brokered road needs nothing typed, and there is only the
    // one question.
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    return waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
        "Sign in",
      ),
    );
  });

  it("withholds the Unlock tab while nothing is sealed on this device", () => {
    // Not disabled: a greyed tab still asserts the action exists and merely is
    // unavailable right now, which is a different and untrue claim.
    fresh();
    render(<UnlockScreen />);
    expect(screen.queryByRole("tab", { name: "Unlock" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Sign in" })).toBeNull();
  });

  it("offers the Unlock tab as soon as there is a vault to open", () => {
    v.state = {
      status: "locked",
      header: null,
      lockedOutUntil: null,
      failedAttempts: 0,
      durable: true,
      awaitingTotp: false,
    };
    render(<UnlockScreen />);
    expect(screen.getByRole("tab", { name: "Unlock" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Sign in" })).toBeTruthy();
  });

  it("names the deployment it is pointed at, and the road back into setup", () => {
    v.state = {
      status: "locked",
      header: null,
      lockedOutUntil: null,
      failedAttempts: 0,
      durable: true,
      awaitingTotp: false,
    };
    render(<UnlockScreen />);
    expect(screen.getByText("127.0.0.1:18788")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Deployment setup" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "How do people sign in?",
    );
  });

  it("offers the setup road when setup left no way in at all", () => {
    fresh();
    identityBaseHolder.current = "";
    waysInHolder.current = { builtin: false, providers: [] };
    render(<UnlockScreen />);
    expect(screen.getByText(/No way in is configured/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Set it up" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "How do people sign in?",
    );
  });

  it("says nothing about identity on a deployment that has one", () => {
    fresh();
    render(<UnlockScreen />);
    expect(screen.queryByText(/No way in is configured/)).toBeNull();
  });

  it("says nothing where the ways in need no identity service", () => {
    // The old line was "no identity service", and it read as broken on a
    // deployment whose Google button worked fine (ADR 0078). A provider the
    // operator brought runs in this browser and needs no service at all.
    fresh();
    identityBaseHolder.current = "";
    waysInHolder.current = {
      builtin: false,
      providers: [
        {
          providerId: "google",
          issuer: "https://accounts.google.com",
          clientId: "google-client.apps",
          label: "Google",
        },
      ],
    };
    render(<UnlockScreen />);
    expect(screen.queryByText(/No way in is configured/)).toBeNull();
  });
});

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
  });

  afterEach(cleanup);

  it("seals with a passkey without asking for a master password", async () => {
    render(<UnlockScreen />);
    goLocalOnly();
    expect(
      screen.getByRole("heading", { name: "Seal this device" }),
    ).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Passkey" })).toBeTruthy();
    expect(screen.queryByLabelText(/Master password/)).toBeNull();
    expect(submitButton().getAttribute("aria-label")).toContain(
      "Seal with passkey",
    );
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
    goLocalOnly();
    chooseSealMethod("PIN");
    expect(screen.queryByLabelText(/Master password/)).toBeNull();
    expect(submitButton().getAttribute("aria-label")).toContain(
      "Seal with PIN",
    );
    expect(submitButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Device PIN"), {
      target: { value: "48291037" },
    });
    fireEvent.change(screen.getByLabelText("Confirm PIN"), {
      target: { value: "48291037" },
    });
    expect(submitButton().disabled).toBe(true);
    fireEvent.click(
      screen.getByLabelText("I understand this vault cannot be recovered."),
    );
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(v.store.createWithPin).toHaveBeenCalledWith("48291037"),
    );
    expect(v.store.create).not.toHaveBeenCalled();
  });

  it("names the PIN format problem live on first run", () => {
    render(<UnlockScreen />);
    goLocalOnly();
    chooseSealMethod("PIN");
    fireEvent.change(screen.getByLabelText("Device PIN"), {
      target: { value: "12345678" },
    });
    expect(screen.getByText(/sequential run of digits/)).toBeTruthy();
    fireEvent.click(
      screen.getByLabelText("I understand this vault cannot be recovered."),
    );
    fireEvent.change(screen.getByLabelText("Confirm PIN"), {
      target: { value: "12345678" },
    });
    expect(submitButton().disabled).toBe(true);
    expect(v.store.createWithPin).not.toHaveBeenCalled();
  });

  it("hides passkey and falls back to password when WebAuthn cannot run", () => {
    v.host = {
      ok: false,
      reason: "Passkeys need a DNS hostname.",
      fixUrl: "http://localhost:5180/",
    };
    render(<UnlockScreen />);
    goLocalOnly();
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
    goLocalOnly();
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
    goLocalOnly();
    chooseSealMethod("Password");
    expect(
      screen.getByRole("heading", { name: "Seal this device" }),
    ).toBeTruthy();
    // Nothing to judge yet: the strength meter stays off a pristine field.
    expect(screen.queryByText("Enter a master password")).toBeNull();
    expect(screen.getByText(/600,000 PBKDF2-SHA256/)).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
  });

  it("warns about weak passwords as they are typed", () => {
    render(<UnlockScreen />);
    goLocalOnly();
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
    goLocalOnly();
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
    goLocalOnly();
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
    goLocalOnly();
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
    // Guest is the most common road in, so it sits on the hub itself.
    fireEvent.click(screen.getByRole("button", { name: /Continue as guest/ }));
    await waitFor(() => expect(continueAsGuest).toHaveBeenCalledTimes(1));
    expect(v.store.create).not.toHaveBeenCalled();
    expect(v.store.createWithPasskey).not.toHaveBeenCalled();
    expect(v.store.createWithPin).not.toHaveBeenCalled();
  });

  it("offers a skip link in the top corner that starts the same guest flow", async () => {
    render(<UnlockScreen />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Skip sign-in and continue as guest",
      }),
    );
    await waitFor(() => expect(continueAsGuest).toHaveBeenCalledTimes(1));
    expect(v.store.create).not.toHaveBeenCalled();
  });

  it("drops the skip link on the local-only road and beside an existing vault", () => {
    render(<UnlockScreen />);
    fireEvent.click(
      screen.getByRole("button", { name: "Use without an account" }),
    );
    expect(
      screen.queryByRole("button", {
        name: "Skip sign-in and continue as guest",
      }),
    ).toBeNull();
    cleanup();
    v.state.status = "locked";
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Sign in" }));
    expect(
      screen.queryByRole("button", {
        name: "Skip sign-in and continue as guest",
      }),
    ).toBeNull();
  });

  it("offers federated sign-in before it asks for a password (ADR 0033 §4)", () => {
    render(<UnlockScreen />);
    // Identity first: sign-in is the whole first screen — no master-password
    // field, no seal form, until "Use without an account" is chosen.
    expect(screen.getByRole("button", { name: FEDERATED_BUTTON })).toBeTruthy();
    expect(screen.queryByLabelText(/Master password/)).toBeNull();
    expect(
      screen.queryByLabelText("I understand this vault cannot be recovered."),
    ).toBeNull();
    expect(screen.getByText(/Sign in to sync your vault/)).toBeTruthy();
  });

  it("starts sign-in at the default upstream and returns to the app root", () => {
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("button", { name: FEDERATED_BUTTON }));
    expect(beginSignIn).toHaveBeenCalledWith(UPSTREAM, {});
    expect(continueAsGuest).not.toHaveBeenCalled();
    expect(v.store.create).not.toHaveBeenCalled();
  });

  it("surfaces a failed sign-in and re-enables the card", async () => {
    beginSignIn.mockRejectedValue(new Error("broker unreachable"));
    render(<UnlockScreen />);
    const federated = screen.getByRole("button", { name: FEDERATED_BUTTON });
    fireEvent.click(federated);
    expect(await screen.findByText("broker unreachable")).toBeTruthy();
    await waitFor(() => expect(federated.hasAttribute("disabled")).toBe(false));
  });

  it("falls back to the single default sign-in when no catalog is published", async () => {
    render(<UnlockScreen />);
    await waitFor(() => expect(listFederatedProviders).toHaveBeenCalled());
    // First run must never dead-end on a catalog fetch.
    expect(screen.getByRole("button", { name: FEDERATED_BUTTON })).toBeTruthy();
  });

  it("renders one button per published provider", async () => {
    listFederatedProviders.mockResolvedValue([
      { id: "google", label: "Google", kind: "oidc", browserCapable: false },
      { id: "github", label: "GitHub", kind: "oauth2", browserCapable: false },
      { id: "acme", label: "Acme SSO", kind: "oidc", browserCapable: false },
    ]);
    render(<UnlockScreen />);
    for (const label of ["Google", "GitHub", "Acme SSO"]) {
      expect(
        await screen.findByRole("button", {
          name: `Continue with ${label}`,
        }),
      ).toBeTruthy();
    }
    // The catalog replaces the single default, it does not sit beside it.
    expect(screen.queryByRole("button", { name: FEDERATED_BUTTON })).toBeNull();
  });

  it("starts a brokered provider against the Identity API with a provider hint", async () => {
    listFederatedProviders.mockResolvedValue([
      { id: "google", label: "Google", kind: "oidc", browserCapable: false },
    ]);
    render(<UnlockScreen />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Continue with Google" }),
    );
    expect(beginSignIn).toHaveBeenCalledWith(
      {
        id: "broker:google",
        issuer: "http://127.0.0.1:18788",
        displayName: "Google",
        accountKind: "Google",
      },
      { providerHint: "google" },
    );
  });

  it("keeps a browser-capable provider on the direct upstream leg", async () => {
    listFederatedProviders.mockResolvedValue([
      {
        id: "shoo",
        label: "Google (via shoo.dev)",
        kind: "oidc",
        browserCapable: true,
      },
    ]);
    render(<UnlockScreen />);
    // The branded catalog button appears once the catalog lands — the
    // fallback button's label is the upstream's account kind, not this.
    fireEvent.click(
      await screen.findByRole("button", { name: "Continue with Google" }),
    );
    // The compiled trust list decides this, not the catalog: no hint, no broker.
    expect(beginSignIn).toHaveBeenCalledWith(UPSTREAM, {});
  });

  it("never offers the loopback test account, even when the catalog publishes it", async () => {
    listFederatedProviders.mockResolvedValue([
      {
        id: "mock",
        label: "a local test account",
        kind: "oidc",
        browserCapable: true,
      },
      { id: "google", label: "Google", kind: "oidc", browserCapable: false },
    ]);
    render(<UnlockScreen />);
    expect(
      await screen.findByRole("button", { name: "Continue with Google" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /test account/i })).toBeNull();
  });

  it("shows no fallback button when the only default upstream is the dev mock", () => {
    upstreamHolder.current = {
      id: "mock",
      displayName: "Local mock IdP",
      issuer: "http://127.0.0.1:9090",
      accountKind: "a test account",
    };
    render(<UnlockScreen />);
    expect(screen.queryByRole("button", { name: /test account/i })).toBeNull();
    // The bar still offers the real roads: BYO IdP and the overflow menu.
    expect(
      screen.getByRole("button", { name: "Continue with your IdP" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "More sign-in options" }),
    ).toBeTruthy();
  });

  it("starts an OIDC organization method in this browser", async () => {
    lookupOrgTenant.mockResolvedValue({
      slug: "acme",
      displayName: "Acme",
      state: "active",
      authMethods: [
        { kind: "sso", label: "SSO", issuer: "https://idp.acme.example" },
      ],
    });
    render(<UnlockScreen />);
    submitIdentifier("acme");
    fireEvent.click(
      await screen.findByRole("button", { name: "Continue with SSO" }),
    );
    expect(lookupOrgTenant).toHaveBeenCalledWith("acme");
    const [upstream, options] = beginSignIn.mock.calls[0] ?? [];
    expect(upstream).toMatchObject({ issuer: "https://idp.acme.example" });
    expect(options).toEqual({
      orgSlug: "acme",
      orgMethod: "sso",
    });
  });

  it("routes an organization method with no browser issuer through the broker", async () => {
    lookupOrgTenant.mockResolvedValue({
      slug: "acme",
      displayName: "Acme",
      state: "active",
      // Native SAML: the server holds the metadata and there is no issuer to
      // redirect to. This must produce a working button, not a broken one.
      authMethods: [{ kind: "saml", label: "SAML", native: true }],
    });
    render(<UnlockScreen />);
    submitIdentifier("acme");
    fireEvent.click(
      await screen.findByRole("button", { name: "Continue with SAML" }),
    );
    const [upstream, options] = beginSignIn.mock.calls[0] ?? [];
    expect(upstream).toMatchObject({
      id: "broker:org:acme",
      issuer: "http://127.0.0.1:18788",
    });
    // No org assertion comes back from a brokered leg, so no join is promised —
    // and no returnTo: the return screen lands on the app root by default.
    expect(options).toEqual({});
  });

  it("routes an LDAP organization through the broker rather than asking for the password here", async () => {
    lookupOrgTenant.mockResolvedValue({
      slug: "acme",
      displayName: "Acme",
      state: "active",
      authMethods: [{ kind: "ldap", label: "Directory" }],
    });
    render(<UnlockScreen />);
    submitIdentifier("acme");
    fireEvent.click(
      await screen.findByRole("button", { name: "Continue with Directory" }),
    );
    expect(beginSignIn.mock.calls[0]?.[0]).toMatchObject({
      id: "broker:org:acme",
    });
    // A directory password is typed on the hosted login page, where the POST
    // is CSRF-protected and rate-limited — never collected by this static app.
    expect(screen.queryByLabelText("Directory password")).toBeNull();
    expect(screen.queryByLabelText("Directory username")).toBeNull();
  });

  it("says so when an organization has configured nothing", async () => {
    lookupOrgTenant.mockResolvedValue({
      slug: "acme",
      displayName: "Acme",
      state: "active",
      authMethods: [],
    });
    render(<UnlockScreen />);
    submitIdentifier("acme");
    expect(
      await screen.findByText(/no sign-in methods configured yet/),
    ).toBeTruthy();
  });

  it("surfaces an unknown organization without starting anything", async () => {
    lookupOrgTenant.mockRejectedValue(new Error("No such organization."));
    render(<UnlockScreen />);
    submitIdentifier("nope");
    expect(await screen.findByText("No such organization.")).toBeTruthy();
    expect(beginSignIn).not.toHaveBeenCalled();
  });

  it("resolves a work email to its organization through the one field", async () => {
    lookupOrgByDomain.mockResolvedValue({
      slug: "acme",
      displayName: "Acme",
      state: "active",
      authMethods: [
        { kind: "sso", label: "SSO", issuer: "https://idp.acme.example" },
      ],
    });
    render(<UnlockScreen />);
    submitIdentifier("ada.lovelace@acme.example");
    fireEvent.click(
      await screen.findByRole("button", { name: "Continue with SSO" }),
    );
    // Discovery used only the domain; the local part stayed on this device.
    expect(lookupOrgByDomain).toHaveBeenCalledWith("acme.example");
    expect(JSON.stringify(lookupOrgByDomain.mock.calls)).not.toContain(
      "ada.lovelace",
    );
    expect(beginSignIn.mock.calls[0]?.[0]).toMatchObject({
      issuer: "https://idp.acme.example",
    });
  });

  it("routes an unrecognized work-email domain to the hosted page by domain only", async () => {
    render(<UnlockScreen />);
    submitIdentifier("ada.lovelace@acme.example");
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Use the hosted sign-in page instead",
      }),
    );
    const [upstream, options] = beginSignIn.mock.calls[0] ?? [];
    expect(upstream).toMatchObject({ id: "broker:realm" });
    expect(options).toEqual({ loginHint: "acme.example" });
    // The local part never leaves this screen.
    expect(JSON.stringify(beginSignIn.mock.calls)).not.toContain(
      "ada.lovelace",
    );
  });

  it("offers the magic link when no organization uses the typed domain", async () => {
    render(<UnlockScreen />);
    submitIdentifier("ada@example.com");
    // The identifier's fallback state takes over the step — the hub's
    // same-named link disappears once the lookup resolves.
    await screen.findByText(/No organization uses that email domain/);
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "Email me a sign-in link" }),
      ).toHaveLength(1),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Email me a sign-in link" }),
    );
    await waitFor(() =>
      expect(requestEmailMagicLink).toHaveBeenCalledWith("ada@example.com"),
    );
    expect(await screen.findByText(/Check your inbox/)).toBeTruthy();
  });

  it("asks again when the field is neither an address nor a slug", () => {
    render(<UnlockScreen />);
    submitIdentifier("acme.example");
    expect(screen.getByText(/Enter a work email/)).toBeTruthy();
    expect(beginSignIn).not.toHaveBeenCalled();
    expect(lookupOrgTenant).not.toHaveBeenCalled();
    expect(lookupOrgByDomain).not.toHaveBeenCalled();
  });

  it("sends a magic link from the hub to an address the human owns", async () => {
    render(<UnlockScreen />);
    // The magic link lives behind the bar's ⋯ menu — opening it reveals ONLY
    // the extra roads; picking one opens only that step.
    fireEvent.click(
      screen.getByRole("button", { name: "More sign-in options" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Email me a sign-in link/ }),
    );
    fireEvent.change(screen.getByLabelText("Email me a sign-in link"), {
      target: { value: "ada@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send link" }));
    await waitFor(() =>
      expect(requestEmailMagicLink).toHaveBeenCalledWith("ada@example.com"),
    );
    expect(await screen.findByText(/Check your email/)).toBeTruthy();
  });

  it("surfaces a deployment with no email sign-in", async () => {
    requestEmailMagicLink.mockRejectedValue(
      new Error("Email sign-in is not available on this Identity API."),
    );
    render(<UnlockScreen />);
    fireEvent.click(
      screen.getByRole("button", { name: "More sign-in options" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Email me a sign-in link/ }),
    );
    fireEvent.change(screen.getByLabelText("Email me a sign-in link"), {
      target: { value: "ada@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send link" }));
    expect(await screen.findByText(/not available/)).toBeTruthy();
  });

  it("offers the sign-in entries on an existing vault too, minus the two that would make a second one", async () => {
    v.state.status = "locked";
    render(<UnlockScreen />);
    // Sign-in is its own tab beside Unlock — nothing of it crowds the form.
    expect(screen.queryByLabelText("Email or organization")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Sign in" }));
    expect(screen.getByLabelText("Email or organization")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Continue with your IdP/ }),
    ).toBeTruthy();
    // The magic link is one of the roads behind the ⋯ menu.
    fireEvent.click(
      screen.getByRole("button", { name: "More sign-in options" }),
    );
    expect(
      screen.getByRole("button", { name: /Email me a sign-in link/ }),
    ).toBeTruthy();
    // Sealing a local-only vault beside the existing one is not a road out of
    // this screen, and neither is a guest principal.
    expect(
      screen.queryByRole("button", { name: "Use without an account" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Continue as guest/ }),
    ).toBeNull();
  });

  it("keeps the social bar to one row and moves overflow providers behind the ⋯ menu", async () => {
    listFederatedProviders.mockResolvedValue(
      ["p1", "p2", "p3", "p4", "p5", "p6"].map((id) => ({
        id,
        label: id.toUpperCase(),
        kind: "oidc" as const,
        browserCapable: false,
      })),
    );
    render(<UnlockScreen />);
    for (const id of ["P1", "P2", "P3", "P4"]) {
      expect(
        await screen.findByRole("button", { name: `Continue with ${id}` }),
      ).toBeTruthy();
    }
    // P5 and P6 never become a second row — they wait behind the ⋯ menu.
    expect(
      screen.queryByRole("button", { name: "Continue with P5" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "More sign-in options" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue with P5" }));
    await waitFor(() => expect(beginSignIn).toHaveBeenCalledTimes(1));
    expect(beginSignIn.mock.calls[0]?.[1]).toEqual({ providerHint: "p5" });
  });

  it("focuses the identifier field so typing can start immediately", () => {
    render(<UnlockScreen />);
    expect(document.activeElement).toBe(identifierInput());
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

  it("separates unlock and sign-in into tabs, never one stacked form", () => {
    render(<UnlockScreen />);
    // Unlock is the default ceremony: the challenge form is on screen, the
    // federated panel is not.
    expect(submitButton()).toBeTruthy();
    expect(screen.queryByRole("button", { name: FEDERATED_BUTTON })).toBeNull();
    // The Sign in tab is its own ceremony — and its copy never promises that
    // signing in opens the vault.
    fireEvent.click(screen.getByRole("tab", { name: "Sign in" }));
    expect(screen.getByRole("button", { name: FEDERATED_BUTTON })).toBeTruthy();
    expect(
      screen.getByText(/still opens with your passkey, PIN, or password/),
    ).toBeTruthy();
    expect(document.querySelector(".unlock__form")).toBeNull();
    // …and back.
    fireEvent.click(screen.getByRole("tab", { name: "Unlock" }));
    expect(submitButton()).toBeTruthy();
    expect(screen.queryByRole("button", { name: FEDERATED_BUTTON })).toBeNull();
  });

  it("starts the leg from the sign-in tab", async () => {
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Sign in" }));
    fireEvent.click(screen.getByRole("button", { name: FEDERATED_BUTTON }));
    await waitFor(() => expect(beginSignIn).toHaveBeenCalledTimes(1));
    expect(beginSignIn.mock.calls[0]?.[0]).toEqual(UPSTREAM);
  });

  it("focuses the identifier field when the Sign in tab opens", () => {
    render(<UnlockScreen />);
    expect(screen.queryByLabelText("Email or organization")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Sign in" }));
    expect(document.activeElement).toBe(identifierInput());
  });

  it("offers sign-out on the Sign in tab when the device already holds a session", () => {
    sessionHolder.current = {
      principalId: "prn_1",
      accessToken: "pst_1",
      issuerOrigin: "http://127.0.0.1:18788",
    };
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Sign in" }));
    fireEvent.click(screen.getByRole("button", { name: "sign out" }));
    expect(endSession).toHaveBeenCalledTimes(1);
  });

  it("omits sign-out when there is no session to end", () => {
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Sign in" }));
    expect(screen.queryByRole("button", { name: "sign out" })).toBeNull();
  });

  it("renders the deployment's catalog on an existing vault", async () => {
    listFederatedProviders.mockResolvedValue([
      { id: "google", label: "Google", kind: "oidc", browserCapable: false },
    ]);
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Sign in" }));
    expect(
      await screen.findByRole("button", { name: "Continue with Google" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: FEDERATED_BUTTON })).toBeNull();
  });

  it("renders known providers with their official brand treatment", async () => {
    listFederatedProviders.mockResolvedValue([
      {
        id: "shoo",
        label: "Google (via shoo.dev)",
        kind: "oidc",
        browserCapable: true,
      },
      { id: "github", label: "GitHub", kind: "oauth2", browserCapable: false },
    ]);
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Sign in" }));
    const google = await screen.findByRole("button", {
      name: "Continue with Google",
    });
    expect(google.className).toContain("signin__provider--google");
    const github = screen.getByRole("button", { name: "Continue with GitHub" });
    expect(github.className).toContain("signin__provider--github");
    // The broker is disclosed under the buttons, not baked into the label.
    expect(screen.getByText(/runs through the shoo\.dev broker/)).toBeTruthy();
  });

  it("shows the stored reminder and the same challenge menu as every vault", () => {
    render(<UnlockScreen />);
    expect(screen.getByRole("heading", { name: "Unlock" })).toBeTruthy();
    // The challenge menu is uniform: which methods are enrolled is the user's
    // own knowledge, never something the screen enumerates.
    for (const name of ["Passkey", "PIN", "Password"]) {
      expect(screen.getByRole("tab", { name })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("tab", { name: "Password" }));
    expect(screen.getByText(/my usual place/)).toBeTruthy();
  });

  it("unlocks with the typed password and clears the field", async () => {
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Password" }));
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
    fireEvent.click(screen.getByRole("tab", { name: "Password" }));
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
    fireEvent.click(screen.getByRole("tab", { name: "Password" }));
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
    // The passkey pane is the default tab, so the host problem is the first
    // thing the screen says.
    expect(screen.getByText(/Passkeys need a DNS hostname/)).toBeTruthy();
    // A button, not an anchor — the same in-place repair the Settings twin
    // uses, so the two surfaces stop disagreeing about how to fix the host.
    const move = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign: move });
    fireEvent.click(
      screen.getByRole("button", { name: "Continue on localhost" }),
    );
    expect(move).toHaveBeenCalledWith("http://localhost:5180/");
    vi.unstubAllGlobals();
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
    // Method switching is frozen for the countdown too (the screen-level
    // Unlock/Sign in tabs are not — leaving for the other ceremony is always
    // allowed).
    for (const name of ["Passkey", "PIN", "Password"]) {
      const tab = screen.getByRole("tab", { name });
      expect(overlapCast<unknown, HTMLButtonElement>(tab).disabled).toBe(true);
    }
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

  it("never prompts for a passkey until the button is clicked", async () => {
    v.store.unlockWithPasskey.mockResolvedValue(undefined);
    render(<UnlockScreen />);
    expect(screen.getByText(/Use your platform authenticator/)).toBeTruthy();
    expect(submitButton().getAttribute("aria-label")).toContain(
      "Unlock with passkey",
    );
    // Page load alone must not open a platform prompt.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(v.store.unlockWithPasskey).not.toHaveBeenCalled();
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(v.store.unlockWithPasskey).toHaveBeenCalledTimes(1),
    );
  });

  it("describes WebAuthn failures from the manual prompt", async () => {
    v.store.unlockWithPasskey.mockRejectedValue(
      new Error("The operation was cancelled."),
    );
    render(<UnlockScreen />);
    fireEvent.click(submitButton());
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
    const move = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign: move });
    fireEvent.click(
      screen.getByRole("button", { name: "Continue on localhost" }),
    );
    expect(move).toHaveBeenCalledWith("http://localhost:5180/");
    expect(v.store.unlockWithPasskey).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("manual submit retries the passkey ceremony", async () => {
    v.store.unlockWithPasskey.mockResolvedValue(undefined);
    render(<UnlockScreen />);
    expect(v.store.unlockWithPasskey).not.toHaveBeenCalled();
    fireEvent.click(submitButton());
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
    fireEvent.click(submitButton());
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
    expect(submitButton().getAttribute("aria-label")).toContain("Unlock");
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
    fireEvent.click(submitButton());
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

  it("withholds sign-in while the authenticator code is the question", () => {
    render(<UnlockScreen />);
    expect(screen.queryByRole("button", { name: FEDERATED_BUTTON })).toBeNull();
    expect(screen.queryByLabelText("Email or organization")).toBeNull();
  });
});
