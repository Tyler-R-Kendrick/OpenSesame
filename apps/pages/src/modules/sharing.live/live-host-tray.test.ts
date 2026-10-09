/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { afterEach, describe, expect, it } from "vitest";
import {
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
        },
      ],
      log: [],
      misses: 0,
      locked: false,
      status: "live" as const,
      endedBecause: null,
    };
    noteGuestAsking(state);
    noteGuestAsking(state);
    const bodies = listNotices().map((notice) => notice.body);
    expect(bodies).toEqual(["Ada is asking to join"]);
  });
});
