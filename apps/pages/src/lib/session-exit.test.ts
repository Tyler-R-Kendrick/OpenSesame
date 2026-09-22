/** @vitest-environment jsdom */
/**
 * The roads out of an account. Sign-out ends both halves of "who" — the
 * upstream assertion and the Identity session — and leaves a note for the
 * unlock screen; switching leaves the note that arms a fresh login; attaching
 * keeps the session and asks only for the Sign in tab.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ambientAuthSeams,
  resetAmbientAuthSeams,
} from "./ambient-auth-seam.js";
import {
  fenceLocalSignOut,
  isAutoAuthSuppressed,
} from "./ambient-auth/generation.js";
import { cancelAllTransactions } from "./ambient-auth/transactions.js";
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

/** Node 22 shadows Storage with an unavailable experimental global. */
function ensureWebStorage(): void {
  const memory = (): Storage => {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
      removeItem: (key: string) => {
        map.delete(key);
      },
      clear: () => {
        map.clear();
      },
      get length() {
        return map.size;
      },
      key: (index: number) => [...map.keys()][index] ?? null,
    };
  };
  vi.stubGlobal("localStorage", memory());
  vi.stubGlobal("sessionStorage", memory());
}

// Fencing auto sign-in and cancelling ambient transactions belong to the
// ambient capability, so sign-out reaches them through the seam. This case
// describes an installation that approved it.
beforeEach(() => {
  Object.assign(ambientAuthSeams, {
    autoAuthSuppressed: isAutoAuthSuppressed,
    fenceLocalSignOut,
    cancelAllTransactions,
  });
});
afterEach(resetAmbientAuthSeams);

beforeEach(() => {
  ensureWebStorage();
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
    expect(localStorage.getItem("opensesame:ambient-auth:suppressed")).toBe(
      "1",
    );
    expect(
      Number(localStorage.getItem("opensesame:ambient-auth:generation")),
    ).toBeGreaterThan(0);
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
