/**
 * The watcher's rules (ADR 0162), driven through fake ports: what rings, when,
 * for whom, and what it never does.
 */

import { describe, expect, it, vi } from "vitest";
import type { InboxRow } from "../device-inbox.js";
import type { LocalEnvironment } from "./destinations.js";
import { DEFAULT_PREFERENCE, type LocalPreference } from "./preference.js";
import {
  type Deliveries,
  type WatchPorts,
  type WatchTrigger,
  watchInbox,
} from "./watch.js";

const REF_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REF_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function row(ref: string, expiresAt = Date.now() + 300_000): InboxRow {
  return {
    kind: "local-access",
    action: "review",
    ref,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

type RigOptions = {
  environment?: LocalEnvironment;
  preference?: LocalPreference;
  hidden?: boolean;
};

type RigState = {
  rows: InboxRow[];
  hidden: boolean;
  unreadable: boolean;
  environment: LocalEnvironment;
  preference: LocalPreference;
};

function rig(options: RigOptions = {}) {
  const calls: string[] = [];
  const deliver: Deliveries = {
    inApp: vi.fn((waiting) => calls.push(`inApp:${waiting}`)),
    tabTitle: vi.fn((waiting) => calls.push(`tab:${waiting}`)),
    system: vi.fn((notice, waiting) =>
      calls.push(`system:${notice.ref}:${waiting}`),
    ),
    closeSystem: vi.fn(() => calls.push("close")),
  };
  const state: RigState = {
    rows: [],
    hidden: options.hidden ?? false,
    unreadable: false,
    environment: options.environment ?? {
      tabTitle: true,
      system: "granted",
    },
    preference: options.preference ?? DEFAULT_PREFERENCE,
  };
  let trigger: ((why: WatchTrigger) => void) | undefined;
  const timers: { action: () => void; ms: number; live: boolean }[] = [];
  const ports: WatchPorts = {
    list: async () => {
      if (state.unreadable) throw new Error("locked");
      return state.rows;
    },
    preference: async () => state.preference,
    environment: () => state.environment,
    hidden: () => state.hidden,
    deliver,
    subscribe: (next) => {
      trigger = next;
      return () => {
        trigger = undefined;
      };
    },
    now: () => Date.now(),
    later: (action, ms) => {
      const timer = { action, ms, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  };
  const controller = new AbortController();
  const done = watchInbox(ports, controller.signal);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    calls,
    deliver,
    state,
    timers,
    done,
    stop: async () => {
      controller.abort();
      await done;
    },
    fire: async (why: WatchTrigger) => {
      trigger?.(why);
      await settle();
    },
    settle,
    subscribed: () => trigger !== undefined,
  };
}

describe("at start", () => {
  it("marks the bell and the tab for what waits, and rings no doorbell", async () => {
    const r = rig({ hidden: true });
    r.state.rows = [row(REF_A)];
    await r.settle();
    expect(r.calls).toContain("inApp:1");
    expect(r.calls).toContain("tab:1");
    expect(r.deliver.system).not.toHaveBeenCalled();
    await r.stop();
  });

  it("marks nothing when nothing waits", async () => {
    const r = rig();
    await r.settle();
    expect(r.calls).toEqual(["inApp:null", "tab:0", "close"]);
    await r.stop();
  });
});

describe("a request that arrives", () => {
  it("rings a system notification once, naming nothing, when the tab is hidden", async () => {
    const r = rig({ hidden: true });
    await r.settle();
    r.state.rows = [row(REF_A)];
    await r.fire("other-tab");
    expect(r.deliver.system).toHaveBeenCalledOnce();
    expect(r.deliver.system).toHaveBeenCalledWith(
      { kind: "local-access", action: "review", ref: REF_A },
      1,
    );
    // The same request again is not a second ring.
    await r.fire("other-tab");
    expect(r.deliver.system).toHaveBeenCalledOnce();
    await r.stop();
  });

  it("rings for the next one, with how many now wait", async () => {
    const r = rig({ hidden: true });
    r.state.rows = [row(REF_A)];
    await r.settle();
    r.state.rows = [row(REF_B), row(REF_A)];
    await r.fire("other-tab");
    expect(r.calls).toContain(`system:${REF_B}:2`);
    await r.stop();
  });

  it("does not ring while the person is looking, but still marks the bell", async () => {
    const r = rig({ hidden: false });
    await r.settle();
    r.state.rows = [row(REF_A)];
    await r.fire("other-tab");
    expect(r.deliver.system).not.toHaveBeenCalled();
    expect(r.calls).toContain("inApp:1");
    await r.stop();
  });

  it("does not ring when the browser has not permitted it", async () => {
    for (const system of ["default", "denied", "unsupported"] as const) {
      const r = rig({ hidden: true, environment: { tabTitle: true, system } });
      await r.settle();
      r.state.rows = [row(REF_A)];
      await r.fire("other-tab");
      expect(r.deliver.system, system).not.toHaveBeenCalled();
      expect(r.calls, system).toContain("inApp:1");
      await r.stop();
    }
  });

  it("does not ring when the person narrowed the preference to leave it out", async () => {
    const r = rig({
      hidden: true,
      preference: { version: 1, destinations: ["in_app", "tab_title"] },
    });
    await r.settle();
    r.state.rows = [row(REF_A)];
    await r.fire("other-tab");
    expect(r.deliver.system).not.toHaveBeenCalled();
    await r.stop();
  });

  it("leaves the tab's title alone when the preference leaves it out, and the bell on", async () => {
    const r = rig({
      preference: { version: 1, destinations: ["in_app"] },
    });
    r.state.rows = [row(REF_A)];
    await r.settle();
    expect(r.calls).toContain("inApp:1");
    expect(r.calls).toContain("tab:0");
    expect(r.calls).not.toContain("tab:1");
    await r.stop();
  });
});

describe("what takes the marks down", () => {
  it("clears them when the last request is decided, and withdraws the doorbell", async () => {
    const r = rig({ hidden: true });
    r.state.rows = [row(REF_A)];
    await r.settle();
    r.calls.length = 0;
    r.state.rows = [];
    await r.fire("change");
    expect(r.calls).toEqual(["inApp:null", "tab:0", "close"]);
    await r.stop();
  });

  it("withdraws a doorbell once the person is back in front of the page", async () => {
    const r = rig({ hidden: true });
    await r.settle();
    r.state.rows = [row(REF_A)];
    await r.fire("other-tab");
    r.calls.length = 0;
    r.state.hidden = false;
    await r.fire("visible");
    expect(r.calls).toContain("close");
    expect(r.deliver.system).toHaveBeenCalledOnce();
    await r.stop();
  });

  it("clears every mark when the inbox cannot be read, rather than keep a stale one", async () => {
    const r = rig();
    r.state.rows = [row(REF_A)];
    await r.settle();
    r.calls.length = 0;
    r.state.unreadable = true;
    await r.fire("change");
    expect(r.calls).toEqual(["inApp:null", "tab:0", "close"]);
    await r.stop();
  });

  it("clears every mark and stops listening when the vault locks", async () => {
    const r = rig();
    r.state.rows = [row(REF_A)];
    await r.settle();
    r.calls.length = 0;
    await r.stop();
    expect(r.calls).toEqual(["inApp:null", "tab:0", "close"]);
    expect(r.subscribed()).toBe(false);
    expect(r.timers.every((timer) => !timer.live)).toBe(true);
  });

  it("reads again when the soonest waiting request lapses", async () => {
    const r = rig();
    r.state.rows = [row(REF_A, Date.now() + 1000)];
    await r.settle();
    const timer = r.timers.at(-1);
    expect(timer?.live).toBe(true);
    expect(timer?.ms).toBeGreaterThan(900);
    r.state.rows = [];
    timer?.action();
    await r.settle();
    expect(r.calls.at(-3)).toBe("inApp:null");
    await r.stop();
  });

  it("is already stopped when handed a signal that has aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const deliver: Deliveries = {
      inApp: vi.fn(),
      tabTitle: vi.fn(),
      system: vi.fn(),
      closeSystem: vi.fn(),
    };
    await watchInbox(
      {
        list: async () => [row(REF_A)],
        preference: async () => DEFAULT_PREFERENCE,
        environment: () => ({ tabTitle: true, system: "granted" }),
        hidden: () => true,
        deliver,
        subscribe: () => () => undefined,
        now: () => Date.now(),
        later: () => () => undefined,
      },
      controller.signal,
    );
    expect(deliver.system).not.toHaveBeenCalled();
    expect(deliver.inApp).toHaveBeenCalledWith(null);
  });
});

describe("what it never does", () => {
  it("carries the contract and no content through any place it rings", async () => {
    const r = rig({ hidden: true });
    await r.settle();
    r.state.rows = [row(REF_A)];
    await r.fire("other-tab");
    const [notice] = vi.mocked(r.deliver.system).mock.calls[0] ?? [];
    expect(Object.keys(notice ?? {}).sort()).toEqual(["action", "kind", "ref"]);
    await r.stop();
  });
});
