/** @vitest-environment jsdom */
/**
 * The roads out of an account. Sign-out ends both halves of "who" — the
 * upstream assertion and the Identity session — and leaves a note for the
 * unlock screen; switching leaves the note that arms a fresh login; attaching
 * keeps the session and asks only for the Sign in tab.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAuthOutcome } from "./auth-outcome.js";
import { federationSeams } from "./federation.js";
import { identitySeams } from "./identity.js";
import { attachAccount, signOut, switchAccount } from "./session-exit.js";
import { vaultStore } from "./vault/store.js";

const PENDING_LINK_KEY = "opensesame:federation:pending-link";

const endSession = vi.fn();
const clearFederation = vi.fn();
const originalIdentity = { ...identitySeams };
const originalFederation = { ...federationSeams };

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  endSession.mockReset();
  clearFederation.mockReset();
  identitySeams.endSession = endSession;
  federationSeams.clearSession = clearFederation;
});

afterEach(() => {
  Object.assign(identitySeams, originalIdentity);
  Object.assign(federationSeams, originalFederation);
  if (vaultStore.isUnlocked()) vaultStore.lock();
});

describe("signOut", () => {
  it("forgets the assertion, revokes the session, drops a pending link, and leaves a note", () => {
    sessionStorage.setItem(PENDING_LINK_KEY, "1");

    signOut();

    expect(clearFederation).toHaveBeenCalledTimes(1);
    expect(endSession).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(PENDING_LINK_KEY)).toBeNull();
    expect(readAuthOutcome()).toEqual({ kind: "signed_out" });
  });

  it("locks an open vault — sign-out never leaves the key for the next person", async () => {
    await vaultStore.createGuest();
    expect(vaultStore.isUnlocked()).toBe(true);

    signOut();

    expect(vaultStore.isUnlocked()).toBe(false);
    expect(endSession).toHaveBeenCalledTimes(1);
  });
});

describe("switchAccount", () => {
  it("is a sign-out whose note arms the next sign-in to authenticate afresh", () => {
    switchAccount();

    expect(clearFederation).toHaveBeenCalledTimes(1);
    expect(endSession).toHaveBeenCalledTimes(1);
    expect(readAuthOutcome()).toEqual({ kind: "signed_out", switching: true });
  });
});

describe("attachAccount", () => {
  it("keeps the session and asks the Sign in tab for another identity", async () => {
    await vaultStore.createGuest();

    attachAccount();

    expect(endSession).not.toHaveBeenCalled();
    expect(clearFederation).not.toHaveBeenCalled();
    expect(vaultStore.isUnlocked()).toBe(false);
    expect(readAuthOutcome()).toEqual({ kind: "attach" });
  });
});
