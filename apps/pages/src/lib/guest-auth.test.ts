/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimGuestAuth,
  continueAsGuest,
  guestAuthDependencies,
  linkGuestAccount,
  restoreStashedGuestSession,
  stashCurrentSession,
  takeStashedSession,
} from "./guest-auth.js";
import { clearNotices, listNotices } from "./notices.js";
import { vaultStore } from "./vault/store.js";

const STASH_KEY = "opensesame:guest-claim-session";
const GUEST_SESSION = {
  principalId: "prn_guest",
  accessToken: "guest-tok",
  issuerOrigin: "http://127.0.0.1:18788",
};

/** Captured before the mocks land so the real seam defaults stay reachable. */
const realDependencies = { ...guestAuthDependencies };

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
      body: expect.stringContaining("the id stays the same"),
    });
    expect(sessionStorage.getItem(STASH_KEY)).toContain("guest-tok");
  });

  it("still enters as a guest when Identity minting fails", async () => {
    connectProvisional.mockRejectedValue(new Error("Identity unreachable"));
    await continueAsGuest();
    expect(createGuest).toHaveBeenCalledTimes(1);
    const notices = listNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.kind).toBe("guest_claim");
    expect(notices[0]?.title).toBe("Claim this guest session");
    expect(notices[0]?.body).toMatch(/Identity unreachable/);
  });

  it("falls back to generic advice when the failure is not an Error", async () => {
    connectProvisional.mockRejectedValue("not-an-error");
    await continueAsGuest();
    const notices = listNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.kind).toBe("guest_claim");
    expect(notices[0]?.body).toBe(
      "Continue as guest succeeded. Claim auth from the notifications bell when you want a registered sign-in.",
    );
  });

  it("re-stashes without minting or announcing a second claim", async () => {
    await continueAsGuest();
    expect(listNotices()).toHaveLength(1);
    connectProvisional.mockClear();
    sessionStorage.clear();

    await claimGuestAuth();

    // The pending notice short-circuits the mint but must still refresh the
    // stash — the redirect that follows drops in-memory session state.
    expect(connectProvisional).not.toHaveBeenCalled();
    expect(listNotices()).toHaveLength(1);
    expect(sessionStorage.getItem(STASH_KEY)).toContain("guest-tok");
  });
});

describe("stashCurrentSession", () => {
  it("refuses a cookie-only session", () => {
    currentSession.mockReturnValue({ ...GUEST_SESSION, cookieOnly: true });
    stashCurrentSession();
    expect(sessionStorage.getItem(STASH_KEY)).toBeNull();
  });

  it("refuses when there is no session at all", () => {
    currentSession.mockReturnValue(null);
    stashCurrentSession();
    expect(sessionStorage.getItem(STASH_KEY)).toBeNull();
  });

  it("omits expiresAt when the session carries none", () => {
    currentSession.mockReturnValue({ ...GUEST_SESSION });
    stashCurrentSession();
    const raw = sessionStorage.getItem(STASH_KEY) ?? "";
    expect(Object.hasOwn(JSON.parse(raw), "expiresAt")).toBe(false);
  });

  it("carries expiresAt through when the session has one", () => {
    currentSession.mockReturnValue({
      ...GUEST_SESSION,
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    stashCurrentSession();
    const raw = sessionStorage.getItem(STASH_KEY) ?? "";
    expect(JSON.parse(raw).expiresAt).toBe("2030-01-01T00:00:00.000Z");
  });
});

describe("takeStashedSession", () => {
  it("returns null when nothing is stashed", () => {
    expect(takeStashedSession()).toBeNull();
  });

  it("is single use — a second take finds nothing", () => {
    currentSession.mockReturnValue({ ...GUEST_SESSION });
    stashCurrentSession();

    expect(takeStashedSession()).toMatchObject({ accessToken: "guest-tok" });
    expect(takeStashedSession()).toBeNull();
    expect(sessionStorage.getItem(STASH_KEY)).toBeNull();
  });

  it("rejects a record missing any required field", () => {
    for (const missing of ["principalId", "accessToken", "issuerOrigin"]) {
      const partial: Record<string, string> = { ...GUEST_SESSION };
      delete partial[missing];
      sessionStorage.setItem(STASH_KEY, JSON.stringify(partial));
      expect(takeStashedSession()).toBeNull();
    }
  });

  it("returns null rather than throwing on an unparseable record", () => {
    sessionStorage.setItem(STASH_KEY, "{not json");
    expect(takeStashedSession()).toBeNull();
  });
});

describe("restoreStashedGuestSession", () => {
  it("reports false and restores nothing when no session is stashed", () => {
    expect(restoreStashedGuestSession()).toBe(false);
    expect(restoreSession).not.toHaveBeenCalled();
  });

  it("reports true and restores the stashed session", () => {
    currentSession.mockReturnValue({ ...GUEST_SESSION });
    stashCurrentSession();

    expect(restoreStashedGuestSession()).toBe(true);
    expect(restoreSession).toHaveBeenCalledWith(GUEST_SESSION);
  });

  it("restores expiresAt only when the stash carried one", () => {
    currentSession.mockReturnValue({ ...GUEST_SESSION });
    stashCurrentSession();
    restoreStashedGuestSession();
    expect(Object.hasOwn(restoreSession.mock.calls[0][0], "expiresAt")).toBe(
      false,
    );

    restoreSession.mockClear();
    currentSession.mockReturnValue({
      ...GUEST_SESSION,
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    stashCurrentSession();
    restoreStashedGuestSession();
    expect(restoreSession.mock.calls[0][0].expiresAt).toBe(
      "2030-01-01T00:00:00.000Z",
    );
  });
});

describe("seam defaults", () => {
  it("opens the guest vault through the vault store", async () => {
    const createGuestSpy = vi
      .spyOn(vaultStore, "createGuest")
      .mockResolvedValue(undefined as never);

    await realDependencies.createGuest();

    expect(createGuestSpy).toHaveBeenCalledTimes(1);
    createGuestSpy.mockRestore();
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
