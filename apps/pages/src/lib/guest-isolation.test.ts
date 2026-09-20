/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ensureGithubAccessGrant,
  loadGithubInstallationSnapshot,
} from "./github-installation-access.js";
import {
  assertNotGuestSession,
  isGuestSession,
  memberSurfaceBlockedReason,
} from "./guest-isolation.js";
import { vaultStore } from "./vault/store.js";
import { GUEST_TOMB } from "./vfs.js";

function guestSnapshot() {
  return {
    status: "unlocked" as const,
    tomb: GUEST_TOMB,
    guest: true,
    header: null,
    items: [],
    folders: [],
    prefs: {
      autoLockMinutes: 0,
      lockOnHide: false,
      signOutOnLock: false,
      clipboardClearSeconds: 30,
      theme: "system" as const,
    },
    lockedOutUntil: null,
    failedAttempts: 0,
    awaitingSecondStep: false,
    durable: false,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(vaultStore, "getSnapshot").mockReturnValue(guestSnapshot());
});

it("treats an ephemeral guest session as blocked from member surfaces", () => {
  expect(isGuestSession()).toBe(true);
  expect(memberSurfaceBlockedReason()).toMatch(/separate vault/i);
  expect(() => assertNotGuestSession("touch member grants")).toThrow(
    /Guests cannot/,
  );
});

it("does not load Host installs or mint grants for a guest session", async () => {
  const snapshot = await loadGithubInstallationSnapshot(GUEST_TOMB, null);
  expect(snapshot).toEqual({
    integrations: [],
    installations: [],
    repos: [],
    shares: [],
    events: [],
    auditEvents: [],
  });
  await expect(ensureGithubAccessGrant(GUEST_TOMB, null)).rejects.toThrow(
    /Guests cannot/,
  );
});
