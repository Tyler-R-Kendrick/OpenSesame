/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adoptFederatedIdentity,
  continueAsGuest,
  guestAuthDependencies,
  linkGuestAccount,
  recoverPendingFederatedLink,
} from "./guest-auth.js";
import { IdentityError } from "./identity.js";
import { clearNotices, listNotices } from "./notices.js";
const connectProvisional = vi.fn();
const identityJson = vi.fn();
const currentSession = vi.fn();
const createGuest = vi.fn();
const vaultStatus = vi.fn();
const loadFederationSession = vi.fn();

Object.assign(guestAuthDependencies, {
  connectProvisional,
  identityJson,
  currentSession,
  createGuest,
  vaultStatus,
  loadFederationSession,
});

beforeEach(() => {
  clearNotices();
  sessionStorage.clear();
  connectProvisional.mockReset();
  identityJson.mockReset();
  currentSession.mockReset();
  createGuest.mockReset();
  createGuest.mockResolvedValue(undefined);
  vaultStatus.mockReset();
  vaultStatus.mockReturnValue("unlocked");
  loadFederationSession.mockReset();
  loadFederationSession.mockReturnValue(null);
  connectProvisional.mockResolvedValue({
    principalId: "prn_guest",
    accessToken: "guest-tok",
    issuerOrigin: "http://127.0.0.1:18788",
  });
  currentSession.mockReturnValue({
    principalId: "prn_guest",
    accessToken: "guest-tok",
    issuerOrigin: "http://127.0.0.1:18788",
  });
  identityJson.mockResolvedValue({
    principalId: "prn_guest",
    identity: { assurance: "verified" },
  });
});

afterEach(() => {
  clearNotices();
  sessionStorage.clear();
});

describe("continueAsGuest", () => {
  it("opens a guest vault and stages a claim notice without minting a resource claim", async () => {
    await continueAsGuest();
    expect(createGuest).toHaveBeenCalledTimes(1);
    expect(connectProvisional).toHaveBeenCalledTimes(1);
    expect(identityJson).not.toHaveBeenCalled();
    const notices = listNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: "guest_claim",
      title: "Claim this guest session",
    });
    expect(sessionStorage).toHaveLength(0);
  });

  it("still enters as a guest when Identity minting fails", async () => {
    connectProvisional.mockRejectedValue(new Error("Identity unreachable"));
    await continueAsGuest();
    expect(createGuest).toHaveBeenCalledTimes(1);
    const notices = listNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toMatch(/Identity unreachable/);
  });
});

describe("linkGuestAccount", () => {
  it("uses the active guest session without persisting its bearer", async () => {
    await continueAsGuest();
    connectProvisional.mockClear();
    await linkGuestAccount("id.token.here");
    expect(connectProvisional).not.toHaveBeenCalled();
    expect(sessionStorage).toHaveLength(0);
    expect(identityJson).toHaveBeenCalledWith(
      "/v1/principals/link-identities",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ idToken: "id.token.here" }),
      }),
    );
    expect(listNotices()).toHaveLength(0);
  });

  it("resumes the HttpOnly cookie when navigation cleared memory", async () => {
    currentSession.mockReturnValue(null);
    await linkGuestAccount("id.token.here");
    expect(connectProvisional).toHaveBeenCalledTimes(1);
    expect(identityJson).toHaveBeenCalledWith(
      "/v1/principals/link-identities",
      expect.objectContaining({
        body: JSON.stringify({ idToken: "id.token.here" }),
      }),
    );
  });
});

const FEDERATION_SESSION_KEY = "opensesame:federation:session";
const PENDING_LINK_KEY = "opensesame:federation:pending-link";

describe("adoptFederatedIdentity", () => {
  it("opens a guest vault on first run, then attaches the identity", async () => {
    vaultStatus.mockReturnValue("empty");
    await adoptFederatedIdentity("id.token.here");
    expect(createGuest).toHaveBeenCalledTimes(1);
    expect(identityJson).toHaveBeenCalledWith(
      "/v1/principals/link-identities",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ idToken: "id.token.here" }),
      }),
    );
    expect(listNotices()).toHaveLength(0);
    expect(sessionStorage.getItem(PENDING_LINK_KEY)).toBeNull();
  });

  it("attaches to the open vault without creating a second one", async () => {
    vaultStatus.mockReturnValue("unlocked");
    await adoptFederatedIdentity("id.token.here");
    expect(createGuest).not.toHaveBeenCalled();
    expect(identityJson).toHaveBeenCalledTimes(1);
  });

  it("defers on a locked vault instead of minting a throwaway principal", async () => {
    vaultStatus.mockReturnValue("locked");
    currentSession.mockReturnValue(null);
    sessionStorage.setItem(FEDERATION_SESSION_KEY, '{"idToken":"kept"}');

    await adoptFederatedIdentity("id.token.here");

    expect(createGuest).not.toHaveBeenCalled();
    expect(connectProvisional).not.toHaveBeenCalled();
    expect(identityJson).not.toHaveBeenCalled();
    const notices = listNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: "federated_link",
      title: "Finish attaching your sign-in",
    });
    // The verified assertion must survive so the link can be finished later.
    expect(sessionStorage.getItem(FEDERATION_SESSION_KEY)).toBe(
      '{"idToken":"kept"}',
    );
    expect(sessionStorage.getItem(PENDING_LINK_KEY)).not.toBeNull();
  });

  it("links through a locked vault when a guest session is already stashed", async () => {
    vaultStatus.mockReturnValue("locked");
    currentSession.mockReturnValue(null);
    sessionStorage.setItem(
      "opensesame:guest-claim-session",
      JSON.stringify({
        principalId: "prn_guest",
        accessToken: "guest-tok",
        issuerOrigin: "http://127.0.0.1:18788",
      }),
    );

    await adoptFederatedIdentity("id.token.here");

    expect(restoreSession).toHaveBeenCalledTimes(1);
    expect(identityJson).toHaveBeenCalledTimes(1);
    expect(listNotices()).toHaveLength(0);
  });

  it("still lands the user in the app when the first-run link fails", async () => {
    vaultStatus.mockReturnValue("empty");
    identityJson.mockRejectedValue(new Error("Identity unreachable"));

    await expect(
      adoptFederatedIdentity("id.token.here"),
    ).resolves.toBeUndefined();

    expect(createGuest).toHaveBeenCalledTimes(1);
    const notices = listNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "guest_claim" });
    expect(notices[0]?.body).toMatch(/Identity unreachable/);
    expect(sessionStorage.getItem(PENDING_LINK_KEY)).not.toBeNull();
  });

  it("says plainly when the account belongs to another identity", async () => {
    vaultStatus.mockReturnValue("unlocked");
    identityJson.mockRejectedValue(
      new IdentityError("identity_collision", 409),
    );

    await expect(adoptFederatedIdentity("id.token.here")).rejects.toThrow(
      "That account is already attached to a different OpenSesame identity.",
    );
  });

  it("uses the collision wording in the first-run notice too", async () => {
    vaultStatus.mockReturnValue("empty");
    identityJson.mockRejectedValue(
      new IdentityError("identity_collision", 409),
    );

    await adoptFederatedIdentity("id.token.here");

    expect(listNotices()[0]?.body).toMatch(
      /already attached to a different OpenSesame identity/,
    );
  });

  it("passes non-collision failures through untouched", async () => {
    vaultStatus.mockReturnValue("unlocked");
    identityJson.mockRejectedValue(new IdentityError("nope", 503));
    await expect(adoptFederatedIdentity("id.token.here")).rejects.toThrow(
      "nope",
    );
  });
});

describe("recoverPendingFederatedLink", () => {
  it("does nothing when no link is outstanding", () => {
    loadFederationSession.mockReturnValue({ idToken: "still-here" });
    recoverPendingFederatedLink();
    expect(listNotices()).toHaveLength(0);
  });

  it("raises the prompt again after a reload dropped the notice", async () => {
    vaultStatus.mockReturnValue("locked");
    currentSession.mockReturnValue(null);
    await adoptFederatedIdentity("id.token.here");
    // A reload keeps sessionStorage but empties the in-memory notice list.
    clearNotices();

    loadFederationSession.mockReturnValue({ idToken: "still-here" });
    recoverPendingFederatedLink();

    expect(listNotices()).toHaveLength(1);
    expect(listNotices()[0]).toMatchObject({ kind: "federated_link" });
  });

  it("forgets the pending link once the assertion has expired", async () => {
    vaultStatus.mockReturnValue("locked");
    currentSession.mockReturnValue(null);
    await adoptFederatedIdentity("id.token.here");
    clearNotices();

    loadFederationSession.mockReturnValue(null);
    recoverPendingFederatedLink();

    expect(listNotices()).toHaveLength(0);
    expect(sessionStorage.getItem(PENDING_LINK_KEY)).toBeNull();
  });

  it("does not stack a second prompt on top of the one already showing", async () => {
    vaultStatus.mockReturnValue("locked");
    currentSession.mockReturnValue(null);
    await adoptFederatedIdentity("id.token.here");

    loadFederationSession.mockReturnValue({ idToken: "still-here" });
    recoverPendingFederatedLink();

    expect(listNotices()).toHaveLength(1);
  });
});
