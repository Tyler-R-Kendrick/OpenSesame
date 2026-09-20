/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import {
  claimGuestConnection,
  clearGuestConnections,
  guestClaimedConnections,
  visibleToGuest,
} from "./guest-connections.js";
import {
  clearGuestSessionPerson,
  mintGuestSessionPerson,
} from "./local-guest.js";

describe("guest-connections isolation", () => {
  beforeEach(() => {
    clearGuestSessionPerson();
    clearGuestConnections();
    try {
      sessionStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it("keeps connector claims on the Guest N who claimed them", () => {
    const first = mintGuestSessionPerson();
    claimGuestConnection("conn-a");
    expect([...guestClaimedConnections()]).toEqual(["conn-a"]);
    expect(
      visibleToGuest(
        [{ connectionId: "conn-a" }, { connectionId: "conn-b" }],
        true,
      ),
    ).toEqual([{ connectionId: "conn-a" }]);

    const second = mintGuestSessionPerson();
    expect(second.id).not.toBe(first.id);
    clearGuestConnections();
    expect([...guestClaimedConnections()]).toEqual([]);
    claimGuestConnection("conn-b");
    expect([...guestClaimedConnections()]).toEqual(["conn-b"]);
    expect(
      visibleToGuest(
        [{ connectionId: "conn-a" }, { connectionId: "conn-b" }],
        true,
      ),
    ).toEqual([{ connectionId: "conn-b" }]);
  });
});
