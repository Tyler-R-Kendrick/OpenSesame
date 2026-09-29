import type { BoundaryObject } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  MAX_NOTICES,
  parseNoticeList,
  parsePluginList,
  parsePluginState,
  standingOf,
} from "./wire.js";

const SURROGATE = "osr_7Hq2mV9xK3pL8wN4rT6yB1cD5fG0jZ";

function state(overrides: BoundaryObject = {}) {
  return {
    id: "surrogate-proxy",
    capability: "agents.surrogate-credentials",
    installed: true,
    version: "0.1.0",
    enabled: true,
    forced_off: false,
    active: true,
    ...overrides,
  };
}

function notice(overrides: BoundaryObject = {}) {
  return {
    event_type: "surrogate.wrong_host",
    severity: "high",
    occurred_at: "2026-09-28T10:00:00Z",
    summary: "summary text the page never reads",
    subject_id: "run-4f2a",
    ...overrides,
  };
}

describe("a hostile daemon's tripwire feed", () => {
  it("cannot put an osr_ surrogate on the page through a notice subject", () => {
    const [read] = parseNoticeList({
      notices: [notice({ subject_id: SURROGATE })],
    }) ?? [null];
    expect(read?.event).toBe("surrogate.wrong_host");
    expect(read?.subject).toBeNull();
    expect(JSON.stringify(read)).not.toContain("osr_");
  });

  it("cannot put a surrogate on the page inside a subject, in any case", () => {
    const list = parseNoticeList({
      notices: [
        notice({ subject_id: `run/${SURROGATE}` }),
        notice({ subject_id: SURROGATE.toUpperCase() }),
      ],
    });
    expect(list?.map((entry) => entry.subject)).toEqual([null, null]);
  });

  it("cannot smuggle a surrogate through an event name", () => {
    expect(
      parseNoticeList({
        notices: [
          notice({ event_type: `surrogate.${SURROGATE.toLowerCase()}` }),
        ],
      }),
    ).toEqual([]);
  });

  it("cannot put its summary on the page: the summary is never read", () => {
    const list = parseNoticeList({ notices: [notice()] });
    expect(JSON.stringify(list)).not.toContain("summary text");
  });

  it("cannot flood the page: at most MAX_NOTICES are kept", () => {
    const notices = Array.from({ length: MAX_NOTICES + 25 }, () => notice());
    expect(parseNoticeList({ notices })).toHaveLength(MAX_NOTICES);
  });

  it("drops a notice that is not an event name, or not a time", () => {
    const list = parseNoticeList({
      notices: [
        notice({ event_type: "<img src=x onerror=alert(1)>" }),
        notice({ event_type: "surrogate" }),
        notice({ occurred_at: "yesterday" }),
        notice({ occurred_at: 5 }),
        notice(),
      ],
    });
    expect(list).toHaveLength(1);
    expect(list?.[0]?.at).toBe("2026-09-28T10:00:00.000Z");
  });

  it("refuses a body that is not a notice list", () => {
    expect(parseNoticeList({ notice: [] })).toBeNull();
    expect(parseNoticeList([])).toBeNull();
  });
});

describe("a hostile daemon's plugin list", () => {
  it("cannot inject a plugin the catalog does not list", () => {
    const list = parsePluginList({
      plugins: [
        state({ id: "keylogger", capability: "agents.surrogate-credentials" }),
        state({ id: "__proto__" }),
        state(),
      ],
    });
    expect(list?.map((entry) => entry.id)).toEqual(["surrogate-proxy"]);
  });

  it("cannot move a plugin under another capability", () => {
    expect(
      parsePluginState(state({ capability: "vault.browser-autofill" })),
    ).toBeNull();
  });

  it("cannot answer twice for one plugin: the first answer stands", () => {
    const list = parsePluginList({
      plugins: [state({ enabled: false, active: false }), state()],
    });
    expect(list).toHaveLength(1);
    expect(list?.[0]?.enabled).toBe(false);
  });

  it("cannot make a forced-off or uninstalled plugin read as running", () => {
    const forced = parsePluginState(state({ forced_off: true }));
    const missing = parsePluginState(state({ installed: false }));
    const unrecorded = parsePluginState(state({ enabled: false }));
    expect(forced && standingOf(forced)).toBe("forced-off");
    expect(missing && standingOf(missing)).toBe("not-installed");
    expect(unrecorded && standingOf(unrecorded)).toBe("off");
  });

  it("refuses a state whose flags are not booleans, or whose version is not a version", () => {
    expect(parsePluginState(state({ active: "true" }))).toBeNull();
    expect(parsePluginState(state({ installed: 1 }))).toBeNull();
    expect(parsePluginState(state({ version: "1.0 <script>" }))).toBeNull();
    expect(parsePluginState(state({ version: null }))?.version).toBeNull();
  });

  it("reads the four standings a person can see", () => {
    const on = parsePluginState(state());
    const off = parsePluginState(state({ enabled: false, active: false }));
    expect(on && standingOf(on)).toBe("on");
    expect(off && standingOf(off)).toBe("off");
  });
});
