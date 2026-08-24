/** @vitest-environment jsdom */
import { isJsonObject, isString } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Behaviour: a person who wants nothing to do with passwords can sign in with
 * a provider on their very first visit, and still ends up as one durable
 * identity — the promise ADR 0033 §4 makes ("the PWA's first run asks who you
 * are before it asks for a master password").
 *
 * Given/When/Then without a second framework — same decision as
 * guest-login.behavior.test.ts and the control-plane ceremony journeys.
 *
 * These are journeys, not units: they assert what the person gets, not which
 * function was called. The unit tests in guest-auth.units.test.ts pin the
 * mechanics underneath.
 */

import {
  adoptFederatedIdentity,
  guestAuthDependencies,
  guestAuthSeams,
} from "./guest-auth.js";
import { IdentityError } from "./identity.js";
import { clearNotices, listNotices } from "./notices.js";

const REAL = { ...guestAuthDependencies };

type World = {
  vaultCreated: boolean;
  linkedTokens: string[];
  provisionalMints: number;
};

type DeviceOptions = {
  vault: "empty" | "locked" | "unlocked";
  hasSession?: boolean;
  linkFails?: Error;
};

let world: World;

function givenADevice(options: DeviceOptions): void {
  world = { vaultCreated: false, linkedTokens: [], provisionalMints: 0 };
  Object.assign(guestAuthDependencies, {
    vaultStatus: () => options.vault,
    createGuest: vi.fn(async () => {
      world.vaultCreated = true;
    }),
    currentSession: () =>
      options.hasSession === false
        ? null
        : {
            principalId: "prn_same",
            accessToken: "pst_1",
            issuerOrigin: "https://id.test",
          },
    connectProvisional: vi.fn(async () => {
      world.provisionalMints += 1;
    }),
    identityJson: vi.fn(async (_path: string, init?: RequestInit) => {
      if (options.linkFails) throw options.linkFails;
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (!isJsonObject(body) || !isString(body.idToken)) {
        throw new Error("identityJson test seam received an invalid body");
      }
      world.linkedTokens.push(body.idToken);
      return {};
    }),
    restoreSession: vi.fn(),
    loadFederationSession: () => null,
  });
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

describe("first-run federated sign-in journey", () => {
  it("lets a brand-new visitor in with a provider and no password at all", async () => {
    // Given a device that has never been used
    givenADevice({ vault: "empty" });

    // When they come back from the provider having signed in
    await adoptFederatedIdentity("id-token-from-provider");

    // Then they are inside the app — a vault exists without them choosing a
    // passkey, PIN or master password ...
    expect(world.vaultCreated).toBe(true);
    // ... and the provider's assertion has been attached to their principal.
    expect(world.linkedTokens).toEqual(["id-token-from-provider"]);
    // Nothing is nagging them: the sign-in completed.
    expect(listNotices()).toHaveLength(0);
  });

  it("does not lock a first-time visitor out when Identity is unreachable", async () => {
    // Given a brand-new device, and an Identity plane that is down
    givenADevice({
      vault: "empty",
      linkFails: new Error("connection refused"),
    });

    // When they return from a provider that did authenticate them
    await adoptFederatedIdentity("id-token");

    // Then they still get into the app — being unable to record the sign-in
    // is our problem, not a reason to bounce them back out ...
    expect(world.vaultCreated).toBe(true);
    // ... and they are told, in their own terms, what is still outstanding.
    const notice = listNotices()[0];
    expect(notice?.body).toContain("connection refused");
  });

  it("tells someone whose account is already taken, in plain words", async () => {
    // Given a brand-new device, and a provider account already attached to a
    // different OpenSesame identity
    givenADevice({
      vault: "empty",
      linkFails: new IdentityError("conflict", 409),
    });

    // When they sign in with it
    await adoptFederatedIdentity("id-token");

    // Then the message names the situation rather than leaking a status code
    const notice = listNotices()[0];
    expect(notice?.body).toContain("already attached to a different");
    expect(notice?.body).not.toContain("409");
  });
});

describe("returning-visitor journey", () => {
  it("upgrades an existing guest in place, without minting a second identity", async () => {
    // Given someone already using the app as a guest
    givenADevice({ vault: "unlocked" });

    // When they finally sign in with a provider
    await adoptFederatedIdentity("id-token");

    // Then no new vault and no second principal were created — the point of
    // ADR 0033 is that the id they already have survives the upgrade.
    expect(world.vaultCreated).toBe(false);
    expect(world.provisionalMints).toBe(0);
    expect(world.linkedTokens).toEqual(["id-token"]);
  });

  it("waits for the vault rather than attaching the sign-in to a throwaway", async () => {
    // Given a returning device whose vault is locked, with no session in hand
    givenADevice({ vault: "locked", hasSession: false });

    // When they come back from the provider before unlocking
    await adoptFederatedIdentity("id-token");

    // Then nothing was minted and nothing was linked: binding this identity
    // now would attach it to a throwaway principal, and if it already belongs
    // to the real one behind the locked vault, that link could never be made.
    expect(world.provisionalMints).toBe(0);
    expect(world.linkedTokens).toEqual([]);

    // And they are told what to do next, rather than being silently dropped.
    const notice = listNotices().find((n) => n.kind === "federated_link");
    expect(notice?.title).toBe("Finish attaching your sign-in");
    expect(notice?.body).toContain("Unlock the vault");
  });

  it("still finishes the sign-in after a reload drops the in-memory prompt", async () => {
    // Given a sign-in that was deferred while the vault was locked ...
    givenADevice({ vault: "locked", hasSession: false });
    await adoptFederatedIdentity("id-token");
    expect(listNotices()).toHaveLength(1);

    // ... and then the tab is reloaded, which drops in-memory notices while
    // the provider's assertion lives on in sessionStorage.
    clearNotices();
    expect(listNotices()).toHaveLength(0);
    Object.assign(guestAuthDependencies, {
      loadFederationSession: () => ({ idToken: "id-token" }),
    });

    // When the app starts up again
    guestAuthSeams.recoverPendingFederatedLink();

    // Then the prompt comes back, so the sign-in is not quietly lost.
    expect(listNotices().find((n) => n.kind === "federated_link")).toBeTruthy();
  });

  it("stops asking once the assertion has expired", async () => {
    // Given a deferred sign-in whose upstream assertion is gone
    givenADevice({ vault: "locked", hasSession: false });
    await adoptFederatedIdentity("id-token");
    clearNotices();
    Object.assign(guestAuthDependencies, {
      loadFederationSession: () => null,
    });

    // When the app starts up again
    guestAuthSeams.recoverPendingFederatedLink();

    // Then it does not nag about something that can no longer be finished.
    expect(listNotices()).toHaveLength(0);
  });
});
