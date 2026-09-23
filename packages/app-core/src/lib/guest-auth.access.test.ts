/** @vitest-environment jsdom */
/**
 * Allow guests is enforced where the guest roads end, not only by hiding
 * their buttons: with guests switched off neither a fresh guest nor a guest
 * resume opens a guest tomb.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GUESTS_OFF_MESSAGE, setGuestsAllowed } from "./guest-access.js";
import {
  continueAsGuest,
  guestAuthDependencies,
  resumeGuestSession,
} from "./guest-auth.js";

const createGuest = vi.fn();
const original = { ...guestAuthDependencies };

beforeEach(() => {
  createGuest.mockReset();
  createGuest.mockResolvedValue(undefined);
  Object.assign(guestAuthDependencies, {
    createGuest,
    isRemoteIdentityConfigured: () => false,
  });
});

afterEach(async () => {
  Object.assign(guestAuthDependencies, original);
  await setGuestsAllowed(true);
});

describe("guest roads under Allow guests", () => {
  it("opens a guest tomb while guests are allowed", async () => {
    await continueAsGuest();
    expect(createGuest).toHaveBeenCalledTimes(1);
  });

  it("refuses a fresh guest and a resume once guests are off", async () => {
    await setGuestsAllowed(false);
    await expect(continueAsGuest()).rejects.toThrow(GUESTS_OFF_MESSAGE);
    await expect(resumeGuestSession()).rejects.toThrow(GUESTS_OFF_MESSAGE);
    expect(createGuest).not.toHaveBeenCalled();
  });
});
