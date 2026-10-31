import { NO_RESET_DEVICES } from "@opensesame/app-core/lib/live/device-reset-types.js";
import { NO_DEVICES } from "@opensesame/app-core/lib/live/device-types.js";
/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearLiveHostAskingNotices,
  noteDeviceAsking,
  noteGuestAsking,
  resetLiveHostTrayForTests,
} from "./live-host-tray.js";

afterEach(() => {
  clearNotices();
  resetLiveHostTrayForTests();
});

describe("live host tray", () => {
  it("announces each guest asking once", () => {
    const state = {
      guests: [
        {
          key: "g1",
          name: "Ada",
          note: "",
          state: "asking" as const,
          askedAt: 0,
          reply: null,
          kind: "person" as const,
        },
      ],
      log: [],
      misses: 0,
      locked: false,
      status: "live" as const,
      endedBecause: null,
      resets: NO_RESET_DEVICES,
      devices: NO_DEVICES,
    };
    noteGuestAsking(state);
    noteGuestAsking(state);
    const bodies = listNotices().map((notice) => notice.body);
    expect(bodies).toEqual(["Ada is asking to join"]);
  });

  it("takes back the asking row once the guest is in", () => {
    const asking = {
      guests: [
        {
          key: "g1",
          name: "Ada",
          note: "",
          state: "asking" as const,
          askedAt: 0,
          reply: null,
          kind: "person" as const,
        },
      ],
      log: [],
      misses: 0,
      locked: false,
      status: "live" as const,
      endedBecause: null,
      resets: NO_RESET_DEVICES,
      devices: NO_DEVICES,
    };
    noteGuestAsking(asking);
    expect(listNotices()).toHaveLength(1);
    noteGuestAsking({
      ...asking,
      guests: [
        {
          ...asking.guests[0],
          state: "joined" as const,
          reply: null,
        },
      ],
    });
    expect(listNotices().map((notice) => notice.body)).toEqual([
      "Ada joined the live session",
    ]);
  });

  it("announces a device's request once, with its code, and takes it back when answered", () => {
    const base = {
      guests: [],
      log: [],
      misses: 0,
      locked: false,
      status: "live" as const,
      endedBecause: null,
      resets: NO_RESET_DEVICES,
    };
    const asking = {
      ...base,
      devices: {
        grants: [],
        pending: [
          {
            id: "p1",
            seat: "s1",
            name: "work laptop",
            userCode: "BCDF-GHJK",
            want: [],
            askedAt: 0,
            expiresAt: 1,
          },
        ],
      },
    };
    noteDeviceAsking(asking);
    noteDeviceAsking(asking);
    expect(listNotices().map((notice) => notice.body)).toEqual([
      "work laptop wants to use your connections (BCDF-GHJK)",
    ]);
    noteDeviceAsking({ ...base, devices: NO_DEVICES });
    expect(listNotices()).toEqual([]);
    // Answered, it is not announced again by a later state.
    noteDeviceAsking(asking);
    expect(listNotices()).toEqual([]);
  });

  it("clears a device's row when the session ends", () => {
    const asking = {
      guests: [],
      log: [],
      misses: 0,
      locked: false,
      status: "live" as const,
      endedBecause: null,
      resets: NO_RESET_DEVICES,
      devices: {
        grants: [],
        pending: [
          {
            id: "p2",
            seat: "s1",
            name: "ci runner",
            userCode: "BCDF-GHJK",
            want: [],
            askedAt: 0,
            expiresAt: 1,
          },
        ],
      },
    };
    noteDeviceAsking(asking);
    expect(listNotices()).toHaveLength(1);
    clearLiveHostAskingNotices();
    expect(listNotices()).toEqual([]);
  });
});
