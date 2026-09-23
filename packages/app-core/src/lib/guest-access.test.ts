import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GUEST_ACCESS_KEY,
  guestsAllowed,
  setGuestsAllowed,
  subscribeGuestAccess,
} from "./guest-access.js";
import { kvDelete, kvSet } from "./kv.js";

afterEach(() => kvDelete(GUEST_ACCESS_KEY));

describe("guest access", () => {
  it("allows guests when nothing was ever written", () => {
    kvDelete(GUEST_ACCESS_KEY);
    expect(guestsAllowed()).toBe(true);
  });

  it("fails toward the guest road on an unreadable or foreign record", () => {
    for (const raw of ["not json", "null", "[]", '{"allowed":"no"}', "{}"]) {
      kvSet(GUEST_ACCESS_KEY, raw);
      expect(guestsAllowed(), raw).toBe(true);
    }
  });

  it("turns off only on an explicit allowed:false, and tells subscribers", async () => {
    const heard = vi.fn();
    const stop = subscribeGuestAccess(heard);
    await setGuestsAllowed(false);
    expect(guestsAllowed()).toBe(false);
    await setGuestsAllowed(true);
    expect(guestsAllowed()).toBe(true);
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
  });
});
