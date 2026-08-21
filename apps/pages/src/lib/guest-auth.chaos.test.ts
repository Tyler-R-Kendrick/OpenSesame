import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Chaos: Identity flaps while a guest is trying to enter.
 *
 * Guest login must not require the claim mint to succeed — a partition
 * still leaves them in the tab, with a notice to claim later.
 */

const connectProvisional = vi.hoisted(() => vi.fn());
const identityJson = vi.hoisted(() => vi.fn());
const createGuest = vi.hoisted(() => vi.fn());

vi.mock("./identity.js", () => ({
  connectProvisional,
  identityJson,
}));

vi.mock("./vault/store.js", () => ({
  vaultStore: { createGuest },
}));

import { claimGuestAuth, continueAsGuest } from "./guest-auth.js";
import { clearNotices, listNotices, pushNotice } from "./notices.js";

describe("chaos — guest login under a broken Identity plane", () => {
  beforeEach(() => {
    clearNotices();
    createGuest.mockReset();
    connectProvisional.mockReset();
    identityJson.mockReset();
    createGuest.mockResolvedValue(undefined);
  });

  afterEach(() => {
    clearNotices();
  });

  it("chaos: a refused provisional mint still opens the guest vault", async () => {
    connectProvisional.mockRejectedValue(new Error("429 slow down"));
    await continueAsGuest();
    expect(createGuest).toHaveBeenCalledTimes(1);
    expect(listNotices()[0]?.body).toMatch(/429 slow down/);
  });

  it("chaos: concurrent claim mints do not stack notices", async () => {
    connectProvisional.mockResolvedValue({ principalId: "prn_guest" });
    identityJson.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                claimId: "clm_1",
                claimToken: "osc_clm_guest.secret",
                userCode: "WORD-WORD",
                verificationUri: "http://127.0.0.1:18788/verify",
              }),
            20,
          );
        }),
    );
    await Promise.all([claimGuestAuth(), claimGuestAuth(), claimGuestAuth()]);
    expect(identityJson).toHaveBeenCalledTimes(1);
    expect(listNotices()).toHaveLength(1);
  });

  it("chaos: replacing a guest notice under overlap keeps the newest body", async () => {
    pushNotice({ kind: "guest_claim", title: "a", body: "one" });
    pushNotice({ kind: "guest_claim", title: "b", body: "two" });
    pushNotice({ kind: "guest_claim", title: "c", body: "three" });
    expect(listNotices().map((notice) => notice.body)).toEqual(["three"]);
  });
});
