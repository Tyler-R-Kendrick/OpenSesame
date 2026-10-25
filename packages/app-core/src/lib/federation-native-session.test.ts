import { afterEach, expect, it, vi } from "vitest";
import {
  type NativeFederationIdentity,
  advanceFederationSessionGeneration,
  bindNativeFederationSession,
  federationSessionGeneration,
  readNativeFederationSession,
} from "./federation-native-session.js";
import { readFederationSessionJson } from "./federation-session-store.js";
import { clearSession, loadSession, saveSession } from "./federation.js";

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});
function fixture() {
  let identity: NativeFederationIdentity | null = Object.freeze({
    assertionFormat: "saml",
    issuer: "urn:synthetic:idp",
    audience: "urn:synthetic:sp",
    upstreamId: "identity:fixture",
    idToken: "",
    jwksUri: "",
    pairwiseSub: "synthetic-origin-bound-subject",
    expiresAt: Date.now() + 60000,
  });
  const clear = () => {
    identity = null;
  };
  const dispose = bindNativeFederationSession({ read: () => identity, clear });
  disposers.push(dispose);
  return { clear, dispose, original: identity };
}
it("reads the adapter's actual immutable native session reference without creating an OIDC token", () => {
  const state = fixture();
  expect(readNativeFederationSession()).toBe(state.original);
  expect(readNativeFederationSession()?.idToken).toBe("");
});
it("advancing the originating federation generation clears native session state synchronously", () => {
  fixture();
  const previous = federationSessionGeneration();
  advanceFederationSessionGeneration();
  expect(federationSessionGeneration()).not.toBe(previous);
  expect(readNativeFederationSession()).toBeNull();
});
it("an old adapter disposer cannot clear a newly installed native session", () => {
  const first = fixture();
  const second = fixture();
  first.dispose();
  expect(readNativeFederationSession()).toBe(second.original);
});
it("disposing the active adapter invalidates its generation and session", () => {
  const state = fixture();
  const previous = federationSessionGeneration();
  state.dispose();
  expect(readNativeFederationSession()).toBeNull();
  expect(federationSessionGeneration()).not.toBe(previous);
});
it("expiry is checked while reading so a previously valid session cannot survive its signed deadline", () => {
  const state = fixture();
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 120000);
  try {
    expect(readNativeFederationSession()).toBeNull();
  } finally {
    clock.mockRestore();
  }
  expect(readNativeFederationSession()).toBeNull();
  expect(state.original?.expiresAt).toBeLessThan(now + 120000);
});
it("revoked owner/configuration in an adapter read clears the session instead of returning stale claims", () => {
  let live = true;
  const state = fixture();
  const dispose = bindNativeFederationSession({
    read: () => {
      if (!live) throw new Error("original lineage or configuration ended");
      return state.original;
    },
    clear: state.clear,
  });
  disposers.push(dispose);
  live = false;
  expect(readNativeFederationSession()).toBeNull();
});

it("canonical federation reads the native adapter session without deserializing an assertion", () => {
  const state = fixture();
  expect(loadSession()).toBe(state.original);
});
it.each(["saml", "native-oidc", "ldap"])(
  "canonical save refuses scalar serialization of %s evidence before any generation or storage change",
  (format) => {
    const state = fixture();
    const storedBefore = readFederationSessionJson();
    const generation = federationSessionGeneration();
    if (!state.original) throw new Error("fixture was not created");
    const untrusted = { ...state.original };
    Object.defineProperty(untrusted, "assertionFormat", { value: format });
    expect(() => saveSession(untrusted)).toThrow(/must remain/);
    expect(readFederationSessionJson()).toBe(storedBefore);
    expect(federationSessionGeneration()).toBe(generation);
    expect(readNativeFederationSession()).toBe(state.original);
  },
);
it("saving a different provider session retires the native identity before replacement", () => {
  fixture();
  const generation = federationSessionGeneration();
  saveSession({
    issuer: "https://shoo.dev",
    upstreamId: "shoo",
    idToken: "opaque-assertion-fixture",
    assertionFormat: "opaque",
    pairwiseSub: "different-subject",
    audience: "origin:fixture",
    jwksUri: "https://shoo.dev/keys",
    expiresAt: Date.now() + 60000,
  });
  expect(readNativeFederationSession()).toBeNull();
  expect(federationSessionGeneration()).not.toBe(generation);
  clearSession();
});
it("canonical sign-out clears native identity and invalidates its initiating generation", () => {
  fixture();
  const generation = federationSessionGeneration();
  clearSession();
  expect(loadSession()).toBeNull();
  expect(federationSessionGeneration()).not.toBe(generation);
});

it("preserves the original adapter receiver and does not return a session replaced during read", () => {
  const first = fixture();
  let successor: ReturnType<typeof fixture> | null = null;
  const port = {
    original: first.original,
    read() {
      expect(this.original).toBe(first.original);
      successor = fixture();
      return this.original;
    },
    clear() {},
  };
  disposers.push(bindNativeFederationSession(port));
  expect(readNativeFederationSession()).toBeNull();
  expect(successor).not.toBeNull();
  expect(readNativeFederationSession()).not.toBeNull();
});
it("original adapter method withdrawal cannot adopt a replacement read", () => {
  const state = fixture();
  const replacement = vi.fn(() => state.original);
  const port = { read: () => state.original, clear: vi.fn() };
  disposers.push(bindNativeFederationSession(port));
  port.read = replacement;
  expect(readNativeFederationSession()).toBeNull();
  expect(replacement).not.toHaveBeenCalled();
  expect(port.clear).toHaveBeenCalledOnce();
});
it("an original disposer cannot erase a new adapter installed reentrantly during clear", () => {
  const state = fixture();
  let replace = false;
  const old = bindNativeFederationSession({
    read: () => state.original,
    clear: () => {
      if (!replace) return;
      replace = false;
      fixture();
    },
  });
  disposers.push(old);
  replace = true;
  old();
  expect(readNativeFederationSession()).not.toBeNull();
});

it("returns the exact immutable generation allocated by this transition", () => {
  const previous = federationSessionGeneration();
  const published = advanceFederationSessionGeneration();
  expect(published).not.toBe(previous);
  expect(Object.isFrozen(published)).toBe(true);
  expect(federationSessionGeneration()).toBe(published);
});
it("never returns a reentrant successor as the outer publication's owner", () => {
  let reenter = false;
  let clears = 0;
  const dispose = bindNativeFederationSession({
    read: () => null,
    clear() {
      clears++;
      if (reenter) {
        reenter = false;
        advanceFederationSessionGeneration();
      }
    },
  });
  disposers.push(dispose);
  reenter = true;
  const published = advanceFederationSessionGeneration();
  expect(clears).toBe(2);
  expect(federationSessionGeneration()).not.toBe(published);
  expect(Object.isFrozen(published)).toBe(true);
});
