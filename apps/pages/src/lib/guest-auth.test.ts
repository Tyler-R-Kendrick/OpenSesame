/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  continueAsGuest,
  guestAuthDependencies,
  linkGuestAccount,
} from "./guest-auth.js";
import { clearNotices, listNotices } from "./notices.js";
const connectProvisional = vi.fn();
const identityJson = vi.fn();
const currentSession = vi.fn();
const restoreSession = vi.fn();
const createGuest = vi.fn();

Object.assign(guestAuthDependencies, {
  connectProvisional,
  identityJson,
  currentSession,
  restoreSession,
  createGuest,
});

beforeEach(() => {
  clearNotices();
  sessionStorage.clear();
  connectProvisional.mockReset();
  identityJson.mockReset();
  currentSession.mockReset();
  restoreSession.mockReset();
  createGuest.mockReset();
  createGuest.mockResolvedValue(undefined);
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
    expect(sessionStorage.getItem("opensesame:guest-claim-session")).toContain(
      "guest-tok",
    );
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
  it("restores the stashed guest session and posts the id_token", async () => {
    await continueAsGuest();
    connectProvisional.mockClear();
    await linkGuestAccount("id.token.here");
    expect(restoreSession).toHaveBeenCalledWith(
      expect.objectContaining({
        principalId: "prn_guest",
        accessToken: "guest-tok",
      }),
    );
    expect(connectProvisional).not.toHaveBeenCalled();
    expect(identityJson).toHaveBeenCalledWith(
      "/v1/principals/link-identities",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ idToken: "id.token.here" }),
      }),
    );
    expect(listNotices()).toHaveLength(0);
  });

  it("mints a principal when there is no stashed guest, then posts the id_token", async () => {
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
