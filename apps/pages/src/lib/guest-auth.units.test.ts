/** @vitest-environment jsdom */
/**
 * Atomic unit tests for the guest/federated session plumbing.
 *
 * `guest-auth.ts` is in the Stryker `mutate` set at a 100% break threshold.
 * These tests exist to pin the small decisions that a reader would otherwise
 * have to take on trust: no bearer is stashed, which failures are swallowed or
 * surfaced, and exactly when a pending federated link is marked or cleared.
 * Each is load-bearing for
 * ADR 0033 §4 — a first-time visitor must end up on one durable principal
 * without ever typing a password.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  guestAuthDependencies,
  guestAuthSeams,
  storedKeyPresent,
} from "./guest-auth.js";
import { IdentityError, type IdentitySession } from "./identity.js";
import { clearNotices, listNotices, pushNotice } from "./notices.js";
import { type VaultStatus, vaultStore } from "./vault/store.js";

const PENDING_LINK_KEY = "opensesame:federation:pending-link";

const REAL = { ...guestAuthDependencies };

type FederationSessionFixture = {
  idToken: string;
};

type GuestAuthDependencyOverrides = {
  connectProvisional?: () => Promise<IdentitySession | undefined>;
  currentSession?: () => IdentitySession | null;
  identityJson?: (
    path: string,
    init?: RequestInit,
  ) => Promise<Record<string, never>>;
  createGuest?: () => Promise<void>;
  vaultStatus?: () => VaultStatus;
  loadFederationSession?: () => FederationSessionFixture | null;
};

type SessionOverrides = Partial<IdentitySession>;

function withDeps(overrides: GuestAuthDependencyOverrides): void {
  Object.assign(guestAuthDependencies, overrides);
}

function session(extra: SessionOverrides = {}): IdentitySession {
  return {
    principalId: "prn_1",
    accessToken: "pst_1",
    issuerOrigin: "https://id.test",
    ...extra,
  };
}

beforeEach(() => {
  sessionStorage.clear();
  clearNotices();
  Object.assign(guestAuthDependencies, REAL);
});

afterEach(() => {
  Object.assign(guestAuthDependencies, REAL);
  vi.restoreAllMocks();
});

describe("claimGuestAuth", () => {
  it("does not mint or persist a bearer when already prompted", async () => {
    const connectProvisional = vi.fn();
    const currentSession = vi.fn(() => session());
    withDeps({ connectProvisional, currentSession });
    pushNotice({ kind: "guest_claim", title: "t", body: "b" });

    await guestAuthSeams.claimGuestAuth();

    expect(connectProvisional).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
  });

  it("mints a provisional principal and raises the claim prompt", async () => {
    withDeps({
      connectProvisional: vi.fn(async () => undefined),
      currentSession: () => session(),
    });

    await guestAuthSeams.claimGuestAuth();

    const notice = listNotices().find((n) => n.kind === "guest_claim");
    expect(notice?.title).toBe("Claim this guest session");
    expect(notice?.body).toContain("the id stays the same");
  });

  it("still raises the prompt when Identity is unreachable, naming the cause", async () => {
    withDeps({
      connectProvisional: vi.fn(async () => {
        throw new Error("offline");
      }),
      currentSession: () => session(),
    });

    await guestAuthSeams.claimGuestAuth();

    const notice = listNotices().find((n) => n.kind === "guest_claim");
    expect(notice?.body).toContain("offline");
  });

  it("falls back to generic words when the failure is not an Error", async () => {
    withDeps({
      connectProvisional: vi.fn(async () => {
        // A bare string, not an Error: the notice must still read sensibly.
        throw "not-an-error";
      }),
      currentSession: () => session(),
    });

    await guestAuthSeams.claimGuestAuth();

    const notice = listNotices().find((n) => n.kind === "guest_claim");
    expect(notice?.body).toContain("notifications bell");
  });
});

describe("adoptFederatedIdentity", () => {
  function deps(overrides: GuestAuthDependencyOverrides = {}): void {
    withDeps({
      vaultStatus: () => "unlocked",
      currentSession: () => session(),
      connectProvisional: vi.fn(async () => undefined),
      identityJson: vi.fn(async () => ({})),
      createGuest: vi.fn(async () => undefined),
      loadFederationSession: () => null,
      ...overrides,
    });
  }

  it("creates the ephemeral guest vault on a true first run, then links", async () => {
    const createGuest = vi.fn(async () => undefined);
    const identityJson = vi.fn(async () => ({}));
    deps({ vaultStatus: () => "empty", createGuest, identityJson });

    await guestAuthSeams.adoptFederatedIdentity("id-token");

    expect(createGuest).toHaveBeenCalledTimes(1);
    expect(identityJson).toHaveBeenCalledWith(
      "/v1/principals/link-identities",
      expect.objectContaining({ method: "POST" }),
    );
    expect(sessionStorage.getItem(PENDING_LINK_KEY)).toBeNull();
  });

  it("does not create a vault when one is already open", async () => {
    const createGuest = vi.fn(async () => undefined);
    deps({ createGuest });

    await guestAuthSeams.adoptFederatedIdentity("id-token");

    expect(createGuest).not.toHaveBeenCalled();
  });

  it("keeps a first-run user inside the app when the link fails, and marks it pending", async () => {
    deps({
      vaultStatus: () => "empty",
      identityJson: vi.fn(async () => {
        throw new Error("identity down");
      }),
    });

    await expect(
      guestAuthSeams.adoptFederatedIdentity("id-token"),
    ).resolves.toBeUndefined();

    expect(sessionStorage.getItem(PENDING_LINK_KEY)).toBe("1");
    const notice = listNotices().find((n) => n.kind === "guest_claim");
    expect(notice?.body).toContain("identity down");
  });

  it("names a 409 collision in plain words on first run", async () => {
    deps({
      vaultStatus: () => "empty",
      identityJson: vi.fn(async () => {
        throw new IdentityError("conflict", 409);
      }),
    });

    await guestAuthSeams.adoptFederatedIdentity("id-token");

    const notice = listNotices().find((n) => n.kind === "guest_claim");
    expect(notice?.body).toContain("already attached to a different");
  });

  it("falls back to generic words for a non-Error first-run failure", async () => {
    deps({
      vaultStatus: () => "empty",
      identityJson: vi.fn(async () => {
        throw "nope";
      }),
    });

    await guestAuthSeams.adoptFederatedIdentity("id-token");

    const notice = listNotices().find((n) => n.kind === "guest_claim");
    expect(notice?.body).toContain("Attaching the account failed.");
  });

  it("defers on a locked vault rather than binding the identity to a throwaway", async () => {
    const identityJson = vi.fn(async () => ({}));
    const connectProvisional = vi.fn(async () => undefined);
    deps({
      vaultStatus: () => "locked",
      currentSession: () => null,
      identityJson,
      connectProvisional,
    });

    await guestAuthSeams.adoptFederatedIdentity("id-token");

    expect(connectProvisional).not.toHaveBeenCalled();
    expect(identityJson).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(PENDING_LINK_KEY)).toBe("1");
    expect(listNotices().find((n) => n.kind === "federated_link")).toBeTruthy();
  });

  it("links on a locked vault when a live session is still in hand", async () => {
    const identityJson = vi.fn(async () => ({}));
    deps({
      vaultStatus: () => "locked",
      currentSession: () => session(),
      identityJson,
    });

    await guestAuthSeams.adoptFederatedIdentity("id-token");

    expect(identityJson).toHaveBeenCalled();
  });

  it("surfaces a 409 as a collision on the upgrade path", async () => {
    deps({
      identityJson: vi.fn(async () => {
        throw new IdentityError("conflict", 409);
      }),
    });

    await expect(
      guestAuthSeams.adoptFederatedIdentity("id-token"),
    ).rejects.toThrow(/already attached to a different/);
  });

  it("rethrows a non-409 failure unchanged on the upgrade path", async () => {
    deps({
      identityJson: vi.fn(async () => {
        throw new IdentityError("boom", 503);
      }),
    });

    await expect(
      guestAuthSeams.adoptFederatedIdentity("id-token"),
    ).rejects.toThrow(/boom/);
  });

  it("clears the pending marker once the link lands", async () => {
    sessionStorage.setItem(PENDING_LINK_KEY, "1");
    deps();

    await guestAuthSeams.adoptFederatedIdentity("id-token");

    expect(sessionStorage.getItem(PENDING_LINK_KEY)).toBeNull();
  });
});

describe("recoverPendingFederatedLink", () => {
  it("does nothing when no link is pending", () => {
    withDeps({ loadFederationSession: () => ({ idToken: "t" }) });
    guestAuthSeams.recoverPendingFederatedLink();
    expect(listNotices()).toHaveLength(0);
  });

  it("re-raises the prompt when a pending link still has its assertion", () => {
    sessionStorage.setItem(PENDING_LINK_KEY, "1");
    withDeps({ loadFederationSession: () => ({ idToken: "t" }) });

    guestAuthSeams.recoverPendingFederatedLink();

    const notice = listNotices().find((n) => n.kind === "federated_link");
    expect(notice?.title).toBe("Finish attaching your sign-in");
    expect(notice?.body).toContain("Unlock the vault");
  });

  it("gives up and clears the marker when the assertion is gone", () => {
    sessionStorage.setItem(PENDING_LINK_KEY, "1");
    withDeps({ loadFederationSession: () => null });

    guestAuthSeams.recoverPendingFederatedLink();

    expect(sessionStorage.getItem(PENDING_LINK_KEY)).toBeNull();
    expect(listNotices()).toHaveLength(0);
  });

  it("does not stack a second prompt when one is already showing", () => {
    sessionStorage.setItem(PENDING_LINK_KEY, "1");
    withDeps({ loadFederationSession: () => ({ idToken: "t" }) });
    pushNotice({ kind: "federated_link", title: "existing", body: "b" });

    guestAuthSeams.recoverPendingFederatedLink();

    const federated = listNotices().filter((n) => n.kind === "federated_link");
    expect(federated).toHaveLength(1);
    expect(federated[0]?.title).toBe("existing");
  });
});

describe("default dependency wiring", () => {
  it("reads the vault status from the real store", () => {
    // Guards the arrow bodies in guestAuthDependencies: a mutant that empties
    // them returns undefined instead of a real status string.
    expect(["empty", "locked", "unlocked"]).toContain(REAL.vaultStatus());
  });

  it("exposes the real identity and federation helpers", () => {
    expect(REAL.createGuest).toBeInstanceOf(Function);
    expect(REAL.loadFederationSession).toBeInstanceOf(Function);
    expect(REAL.connectProvisional).toBeInstanceOf(Function);
  });
});
/**
 * Storage-hostile paths. Private mode, a full quota, or a browser configured to
 * block site data all make `sessionStorage` *throw* rather than return null.
 * Every read here is wrapped for that reason, and each wrapper has to fail
 * closed: a throwing probe must read as "nothing pending", never as "pending".
 */
describe("when sessionStorage itself throws", () => {
  function throwOnRead(): void {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError: storage is blocked");
    });
  }

  it("defers a locked-vault link when storage is unavailable", async () => {
    const identityJson = vi.fn(async () => ({}));
    const connectProvisional = vi.fn(async () => undefined);
    withDeps({
      vaultStatus: () => "locked",
      currentSession: () => null,
      identityJson,
      connectProvisional,
      createGuest: vi.fn(async () => undefined),
      loadFederationSession: () => null,
    });
    throwOnRead();

    await guestAuthSeams.adoptFederatedIdentity("id-token");

    expect(connectProvisional).not.toHaveBeenCalled();
    expect(identityJson).not.toHaveBeenCalled();
    expect(listNotices().find((n) => n.kind === "federated_link")).toBeTruthy();
  });

  it("treats an unreadable pending marker as nothing to recover", () => {
    const loadFederationSession = vi.fn(() => ({ idToken: "t" }));
    withDeps({ loadFederationSession });
    throwOnRead();

    guestAuthSeams.recoverPendingFederatedLink();

    // pendingLinkMarked() answered false, so we never looked for an assertion.
    expect(loadFederationSession).not.toHaveBeenCalled();
    expect(listNotices()).toHaveLength(0);
  });
});

describe("default dependencies delegate to the real vault store", () => {
  it("createGuest calls through to the store", async () => {
    const spy = vi
      .spyOn(vaultStore, "createGuest")
      .mockResolvedValue(undefined);
    await REAL.createGuest();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("vaultStatus reads the store's current snapshot", () => {
    const expected = vaultStore.getSnapshot().status;
    const spy = vi.spyOn(vaultStore, "getSnapshot");
    expect(REAL.vaultStatus()).toBe(expected);
    expect(spy).toHaveBeenCalled();
  });
});

/**
 * Cases aimed at decisions the broader tests happen to step over. Each pins a
 * branch whose two sides are easy to conflate — and each one failed against a
 * deliberately mutated copy of the source before being kept.
 */
describe("branches the journey tests do not separate", () => {
  it("does not call a 503 a collision, on the first-run path", async () => {
    // `caught instanceof IdentityError && caught.status === 409` — widening
    // that `&&` to `||`, or forcing it true, would report every upstream
    // failure as "that account is already taken", which is a lie the user
    // cannot act on.
    withDeps({
      vaultStatus: () => "empty",
      createGuest: vi.fn(async () => undefined),
      currentSession: () => session(),
      identityJson: vi.fn(async () => {
        throw new IdentityError("service unavailable", 503);
      }),
      loadFederationSession: () => null,
    });

    await guestAuthSeams.adoptFederatedIdentity("id-token");

    const body = listNotices()[0]?.body ?? "";
    expect(body).toContain("service unavailable");
    expect(body).not.toContain("already attached to a different");
  });

  it("clears a stale pending marker when first-run linking succeeds", async () => {
    // The marker survives in sessionStorage across reloads; leaving it set
    // after a successful link means prompting forever for finished work.
    sessionStorage.setItem(PENDING_LINK_KEY, "1");
    withDeps({
      vaultStatus: () => "empty",
      createGuest: vi.fn(async () => undefined),
      currentSession: () => session(),
      identityJson: vi.fn(async () => ({})),
      loadFederationSession: () => null,
    });

    await guestAuthSeams.adoptFederatedIdentity("id-token");

    expect(sessionStorage.getItem(PENDING_LINK_KEY)).toBeNull();
  });

  it("links rather than defers when the vault is open but no session is held", async () => {
    // Only a *locked* vault defers. An open vault with no session yet is the
    // ordinary first federated sign-in of a session: mint and link.
    const identityJson = vi.fn(async () => ({}));
    const connectProvisional = vi.fn(async () => undefined);
    withDeps({
      vaultStatus: () => "unlocked",
      currentSession: () => null,
      connectProvisional,
      identityJson,
      createGuest: vi.fn(async () => undefined),
      loadFederationSession: () => null,
    });

    await guestAuthSeams.adoptFederatedIdentity("id-token");

    expect(connectProvisional).toHaveBeenCalledTimes(1);
    expect(identityJson).toHaveBeenCalled();
    expect(listNotices().find((n) => n.kind === "federated_link")).toBeFalsy();
  });
});

/**
 * The two "is this prompt already showing?" guards must key on the notice
 * *kind*, not on whether any notice exists at all. A guard that fired for any
 * notice would let a lingering guest-claim prompt suppress the "finish
 * attaching your sign-in" one, and the person would never be told that their
 * federated sign-in was left half-done.
 */
describe("prompt de-duplication is per kind, not per any-notice", () => {
  it("still raises the guest-claim prompt when an unrelated notice is showing", async () => {
    pushNotice({ kind: "federated_link", title: "other", body: "b" });
    const connectProvisional = vi.fn(async () => undefined);
    withDeps({ connectProvisional, currentSession: () => session() });

    await guestAuthSeams.claimGuestAuth();

    // The federated_link notice must not have masked this one.
    expect(connectProvisional).toHaveBeenCalledTimes(1);
    expect(listNotices().find((n) => n.kind === "guest_claim")).toBeTruthy();
  });

  it("still raises the federated prompt when an unrelated notice is showing", () => {
    sessionStorage.setItem(PENDING_LINK_KEY, "1");
    pushNotice({ kind: "guest_claim", title: "other", body: "b" });
    withDeps({ loadFederationSession: () => ({ idToken: "t" }) });

    guestAuthSeams.recoverPendingFederatedLink();

    expect(listNotices().find((n) => n.kind === "federated_link")).toBeTruthy();
  });
});

describe("storedKeyPresent", () => {
  it("reports presence and absence of a key", () => {
    expect(storedKeyPresent("absent-key")).toBe(false);
    sessionStorage.setItem("present-key", "v");
    expect(storedKeyPresent("present-key")).toBe(true);
  });

  it("answers exactly false — not undefined — when the store throws", () => {
    // Every caller negates this, so `undefined` would behave identically at
    // every call site. Asserting the exact value is the only way a broken
    // fail-closed path becomes visible at all.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError: storage is blocked");
    });
    expect(storedKeyPresent("anything")).toBe(false);
  });
});
