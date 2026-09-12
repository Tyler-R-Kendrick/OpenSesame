/**
 * The seams every UnlockScreen suite shares: the vault store's state and
 * methods, WebAuthn, guest, federation, identity, organisations, the provider
 * catalog, and the setup record. Imported by `UnlockScreen.test.tsx` and
 * `UnlockScreen.door.test.tsx`; each file resets it before every test.
 */
import {
  type BoundaryValue,
  type JsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import { fireEvent, screen, within } from "@testing-library/react";
import { vi } from "vitest";
import type { SignInMethods } from "../lib/settings.js";
import type { UnlockMethodId } from "../lib/vault/unlock-methods.js";

export type TestVaultState = {
  status: "empty" | "locked";
  header: { hint?: string; unlocks?: Record<string, JsonObject> } | null;
  lockedOutUntil: number | null;
  failedAttempts: number;
  durable: boolean;
  awaitingSecondStep: boolean;
};

export type TestHostCheck = {
  ok: boolean;
  reason?: string;
  fixUrl?: string | null;
};

export type StoreMethod =
  | "create"
  | "createWithPasskey"
  | "createWithPin"
  | "unlock"
  | "unlockWithPin"
  | "unlockWithPasskey"
  | "confirmTotp"
  | "cancelTotpChallenge"
  | "destroy";

export type TestHarness = {
  state: TestVaultState;
  methods: UnlockMethodId[];
  preferred: UnlockMethodId;
  host: TestHostCheck;
  store: Record<StoreMethod, ReturnType<typeof vi.fn>>;
};

export const v = ((): TestHarness => {
  const state: TestVaultState = {
    status: "locked",
    header: null,
    lockedOutUntil: null,
    failedAttempts: 0,
    durable: true,
    awaitingSecondStep: false,
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
})();

import { vaultHooksSeams } from "../lib/vault/hooks.js";
export const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => v.state,
  useVaultStore: () => v.store,
});

import { unlockMethodsSeams } from "../lib/vault/unlock-methods.js";
export const originalUnlockMethodsSeams = { ...unlockMethodsSeams };
Object.assign(unlockMethodsSeams, {
  listAvailableUnlockMethods: () => v.methods,
  preferredUnlockMethod: () => v.preferred,
  checkWebauthnHost: () => v.host,
  describeWebauthnError: (error: BoundaryValue) =>
    `webauthn: ${error instanceof Error ? error.message : String(error)}`,
});

import { guestAuthSeams } from "../lib/guest-auth.js";
export const continueAsGuest = vi.fn();
Object.assign(guestAuthSeams, { continueAsGuest });

import { federationSeams } from "../lib/federation.js";
export const beginSignIn = vi.fn();
export const UPSTREAM = {
  id: "shoo",
  displayName: "Shoo",
  issuer: "https://shoo.dev",
  accountKind: "Google",
};
/** Tests that need a different default upstream (e.g. the dev mock) swap this. */
export const upstreamHolder = { current: UPSTREAM };
Object.assign(federationSeams, {
  beginSignIn,
  defaultUpstream: () => upstreamHolder.current,
});

export const FEDERATED_BUTTON = `Continue with ${UPSTREAM.accountKind}`;

import { identitySeams } from "../lib/identity.js";
import type { IdentitySession } from "../lib/identity.js";
identitySeams.identityBase = () => "http://127.0.0.1:18788";
export const endSession = vi.fn();
export type SessionHolder = { current: IdentitySession | null };
export const sessionHolder: SessionHolder = { current: null };
identitySeams.useIdentitySession = () => sessionHolder.current;
identitySeams.endSession = endSession;

import { orgSeams } from "../lib/orgs.js";
export const lookupOrgTenant = vi.fn();
export const lookupOrgByDomain = vi.fn();
Object.assign(orgSeams, { lookupOrgTenant, lookupOrgByDomain });

import { providersSeams } from "../lib/providers.js";
export const listFederatedProviders = vi.fn();
export const requestEmailMagicLink = vi.fn();
Object.assign(providersSeams, {
  listFederatedProviders,
  requestEmailMagicLink,
});

import { setupScreenDependencies } from "./SetupScreen.js";
import { unlockScreenDependencies } from "./UnlockScreen.js";

// Setup is never a gate (ADR 0090); this suite tests the unlock form and handoff.
export type InviteHolder = {
  current: ReturnType<typeof setupScreenDependencies.readJoinFromLocation>;
};
export const inviteHolder: InviteHolder = { current: null };
export const identityBaseHolder = { current: "http://127.0.0.1:18788" };
/** What setup left as the ways in — the screen reads this, not the URL. */
export type WaysInHolder = { current: SignInMethods };
export const waysInHolder: WaysInHolder = {
  current: { builtin: true, providers: [] },
};
export const completeSetup = vi.fn<() => Promise<void>>();
/** The setup record: null is a device nobody has set up — the front door. */
export type SetupHolder = {
  current: ReturnType<typeof unlockScreenDependencies.loadSetup>;
};
export const setupHolder: SetupHolder = { current: null };
export const ANSWERED: NonNullable<SetupHolder["current"]> = {
  completedAt: "2026-09-12T00:00:00.000Z",
  ways: ["builtin"],
  service: false,
  joined: false,
  skipped: [],
};
Object.assign(unlockScreenDependencies, {
  loadSetup: () => setupHolder.current,
  readJoinFromLocation: () => inviteHolder.current,
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
    accountKind: "Google",
  }),
  resumeStashedJoin: async () => false,
});
Object.assign(setupScreenDependencies, {
  // The ceremony's own behaviour is covered in SetupScreen.test.tsx; these
  // tests only care that it is reached and handed back from.
  completeSetup,
  readJoinFromLocation: () => null,
});

export const STRONG = "correct horse battery staple";

export function submitButton(): HTMLButtonElement {
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

export function masterInput(): HTMLInputElement {
  return overlapCast(screen.getByLabelText(/Master password|^Password$/));
}

export function chooseSealMethod(name: string): void {
  fireEvent.click(screen.getByRole("tab", { name }));
}

/** First run lands on sign-in; the seal form is the explicit local-only road. */
export function goLocalOnly(): void {
  fireEvent.click(
    screen.getByRole("button", { name: "Use without an account" }),
  );
}

export function userMenuTrigger(): HTMLElement {
  return screen.getByRole("button", { name: /Signed in as / });
}

export function openSignIn(): void {
  fireEvent.click(userMenuTrigger());
  fireEvent.click(screen.getByRole("menuitem", { name: "Sign in" }));
}

export function identifierInput(): HTMLInputElement {
  return overlapCast(screen.getByLabelText("Email or organization"));
}

export function submitIdentifier(value: string): void {
  fireEvent.change(identifierInput(), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

// Every unlock screen now fetches the catalog and can start a leg, not just
// first run, so the federation seams need a known state before every test in
// this file rather than inside the one block that used to be the sole caller.
/** Every suite starts from the same device: no note, no catalog, no record. */
export function resetUnlockHarness(): void {
  // A sign-out or a switch leaves a one-shot note for the next unlock screen;
  // one test's note must never open another's sign-in panel.
  sessionStorage.clear();
  localStorage.clear();
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
  inviteHolder.current = null;
  identityBaseHolder.current = "http://127.0.0.1:18788";
  waysInHolder.current = { builtin: true, providers: [] };
  completeSetup.mockReset();
  // Answering — or skipping — the ceremony writes the record, which is what
  // retires the front door; the mock keeps that half of the contract.
  completeSetup.mockImplementation(async () => {
    setupHolder.current = ANSWERED;
  });
  setupHolder.current = null;
  sessionHolder.current = null;
  upstreamHolder.current = UPSTREAM;
}
