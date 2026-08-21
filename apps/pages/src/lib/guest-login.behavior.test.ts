import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Behaviour: a person can enter as a guest, skip registered auth, and still
 * be asked to claim the session later.
 *
 * Given/When/Then without a second framework — same decision as
 * apps/control-plane ceremony journeys.
 */

const connectProvisional = vi.hoisted(() => vi.fn());
const identityJson = vi.hoisted(() => vi.fn());
const createGuest = vi.hoisted(() => vi.fn());

vi.mock("./identity.js", () => ({
  connectProvisional,
  identityJson,
  currentSession: () => ({
    principalId: "prn_guest",
    accessToken: "guest-tok",
    issuerOrigin: "http://127.0.0.1:18788",
  }),
  restoreSession: () => {},
}));

vi.mock("./vault/store.js", () => ({
  vaultStore: { createGuest },
}));

import { continueAsGuest, linkGuestAccount } from "./guest-auth.js";
import { clearNotices, listNotices } from "./notices.js";

describe("guest login journey", () => {
  beforeEach(() => {
    clearNotices();
    createGuest.mockReset();
    connectProvisional.mockReset();
    identityJson.mockReset();
    createGuest.mockResolvedValue(undefined);
    connectProvisional.mockResolvedValue({ principalId: "prn_guest" });
    identityJson.mockResolvedValue({
      principalId: "prn_guest",
      identity: { assurance: "verified" },
    });
  });

  afterEach(() => {
    clearNotices();
  });

  it("Given a first-run device, When they continue as guest, Then the vault opens and a claim notice waits", async () => {
    // Given — an empty device with Identity able to mint a provisional principal.
    expect(listNotices()).toEqual([]);

    // When — they elect not to sign in with registered auth.
    await continueAsGuest();

    // Then — they have a guest vault and a claim ceremony to attach auth later.
    expect(createGuest).toHaveBeenCalledTimes(1);
    const notice = listNotices()[0];
    expect(notice?.kind).toBe("guest_claim");
    expect(notice?.title).toMatch(/Claim this guest session/);
  });

  it("Given a guest claim already waiting, When they continue as guest again, Then Identity is not asked again", async () => {
    await continueAsGuest();
    connectProvisional.mockClear();

    await continueAsGuest();

    expect(createGuest).toHaveBeenCalledTimes(2);
    expect(connectProvisional).not.toHaveBeenCalled();
    expect(listNotices()).toHaveLength(1);
  });

  it("Given a guest notice, When they return from registered sign-in, Then the id_token claims this principal", async () => {
    await continueAsGuest();
    identityJson.mockClear();
    identityJson.mockResolvedValue({
      principalId: "prn_guest",
      identity: { assurance: "verified" },
    });

    await linkGuestAccount("id.token.from.upstream");

    expect(identityJson).toHaveBeenCalledWith(
      "/v1/principals/link-identities",
      expect.objectContaining({
        body: JSON.stringify({ idToken: "id.token.from.upstream" }),
      }),
    );
    expect(listNotices()).toEqual([]);
  });
});
