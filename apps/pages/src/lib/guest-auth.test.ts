import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { continueAsGuest } from "./guest-auth.js";
import { clearNotices, listNotices } from "./notices.js";

beforeEach(() => {
  clearNotices();
  connectProvisional.mockReset();
  identityJson.mockReset();
  createGuest.mockReset();
  createGuest.mockResolvedValue(undefined);
  connectProvisional.mockResolvedValue({ principalId: "prn_guest" });
  identityJson.mockResolvedValue({
    claimId: "clm_1",
    claimToken: "osc_clm_guest.secret",
    userCode: "WORD-WORD",
    verificationUri: "http://127.0.0.1:18788/v1/claims/clm_1/verify",
  });
});

afterEach(() => {
  clearNotices();
});

describe("continueAsGuest", () => {
  it("opens a guest vault and stages a claim-ceremony notice", async () => {
    await continueAsGuest();
    expect(createGuest).toHaveBeenCalledTimes(1);
    expect(connectProvisional).toHaveBeenCalledTimes(1);
    expect(identityJson).toHaveBeenCalledWith(
      "/v1/claims",
      expect.objectContaining({ method: "POST" }),
    );
    const notices = listNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: "guest_claim",
      userCode: "WORD-WORD",
    });
  });

  it("still enters as a guest when Identity claim minting fails", async () => {
    identityJson.mockRejectedValue(new Error("Identity unreachable"));
    await continueAsGuest();
    expect(createGuest).toHaveBeenCalledTimes(1);
    const notices = listNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toMatch(/Identity unreachable/);
  });
});
