/** @vitest-environment jsdom */
import {
  LOCAL_IAM_CHANNEL,
  notifyLocalIamChange,
  resetLocalIamChannelForTest,
} from "@opensesame/app-core/lib/local-iam-events.js";
import { NOTICE_ROUTE } from "@opensesame/app-core/lib/local-notifications/notice.js";
import { writePreference } from "@opensesame/app-core/lib/local-notifications/preference.js";
import type { WatchTrigger } from "@opensesame/app-core/lib/local-notifications/watch.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { lockAllTombs, unlockTomb } from "@opensesame/app-core/lib/vfs.js";
import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_REQUESTS_NOTICE,
  SYSTEM_NOTIFICATION_TAG,
  browserDeliveries,
  browserPorts,
  readEnvironment,
  systemSupported,
} from "./delivery.js";

const REF = "9f1c1a3e-7d1d-4f56-9f6f-2f9e0a0d4c11";
const NOTICE = { kind: "local-access", action: "review", ref: REF } as const;

type Made = {
  title: string;
  options: NotificationOptions;
  data: unknown;
  close: ReturnType<typeof vi.fn>;
  onclick: (() => void) | null;
};
let made: Made[];

function stubNotification(permission: NotificationPermission = "granted") {
  made = [];
  class Fake {
    static permission = permission;
    title: string;
    options: NotificationOptions;
    data: unknown;
    close = vi.fn();
    onclick: (() => void) | null = null;
    constructor(title: string, options: NotificationOptions = {}) {
      this.title = title;
      this.options = options;
      this.data = options.data;
      made.push(this);
    }
  }
  vi.stubGlobal("Notification", Fake);
}

beforeEach(() => {
  document.title = "OpenSesame";
  clearNotices();
  stubNotification();
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetLocalIamChannelForTest();
  clearNotices();
});

describe("what this browser offers", () => {
  it("reads the permission now, and says unsupported where there is none", () => {
    expect(readEnvironment()).toEqual({ tabTitle: true, system: "granted" });
    expect(systemSupported()).toBe(true);
    vi.stubGlobal("Notification", undefined);
    expect(readEnvironment().system).toBe("unsupported");
    expect(systemSupported()).toBe(false);
  });
});

describe("the bell", () => {
  it("is one tray notice that says how many wait and leads to the list", () => {
    const { inApp } = browserDeliveries(() => undefined);
    inApp(1);
    inApp(2);
    const notices = listNotices().filter(
      (notice) => notice.id === LOCAL_REQUESTS_NOTICE,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: "status",
      tone: "warn",
      title: "Requests waiting",
      body: "2 requests are waiting for you.",
      open: { to: NOTICE_ROUTE, label: "Review requests" },
    });
  });

  it("goes when nothing waits", () => {
    const { inApp } = browserDeliveries(() => undefined);
    inApp(1);
    inApp(null);
    expect(listNotices()).toEqual([]);
  });
});

describe("the tab's mark", () => {
  it("puts the count before the title, once, and takes it away", () => {
    const { tabTitle } = browserDeliveries(() => undefined);
    tabTitle(2);
    tabTitle(3);
    expect(document.title).toBe("(3) OpenSesame");
    tabTitle(0);
    expect(document.title).toBe("OpenSesame");
    tabTitle(0);
    expect(document.title).toBe("OpenSesame");
  });

  it("badges the installed app where the browser can, and survives where it cannot", async () => {
    const setAppBadge = vi.fn(async () => undefined);
    const clearAppBadge = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, setAppBadge, clearAppBadge });
    const { tabTitle } = browserDeliveries(() => undefined);
    tabTitle(2);
    tabTitle(0);
    expect(setAppBadge).toHaveBeenCalledWith(2);
    expect(clearAppBadge).toHaveBeenCalledOnce();
    vi.stubGlobal("navigator", {
      setAppBadge: () => Promise.reject(new Error("not installed")),
    });
    expect(() => tabTitle(1)).not.toThrow();
  });
});

describe("the system notification", () => {
  it("says the same words for every request and carries only the contract", () => {
    const { system } = browserDeliveries(() => undefined);
    system(NOTICE, 1);
    expect(made).toHaveLength(1);
    expect(made[0]?.title).toBe("Request waiting");
    expect(made[0]?.options).toEqual({
      body: "A request is waiting for you.",
      tag: SYSTEM_NOTIFICATION_TAG,
      data: NOTICE,
    });
  });

  it("replaces what is showing rather than stack another", () => {
    const { system } = browserDeliveries(() => undefined);
    system(NOTICE, 1);
    system(NOTICE, 2);
    expect(made[0]?.close).toHaveBeenCalledOnce();
    expect(made[1]?.title).toBe("Requests waiting");
  });

  it("brings the app forward and leads to the list on a click, deciding nothing", () => {
    const navigate = vi.fn();
    const focus = vi
      .spyOn(globalThis, "focus")
      .mockImplementation(() => undefined);
    const { system } = browserDeliveries(navigate);
    system(NOTICE, 1);
    made[0]?.onclick?.();
    expect(focus).toHaveBeenCalled();
    expect(made[0]?.close).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledExactlyOnceWith(NOTICE_ROUTE);
  });

  it("does not follow data that is not the contract, whatever it names", () => {
    const navigate = vi.fn();
    vi.spyOn(globalThis, "focus").mockImplementation(() => undefined);
    const { system } = browserDeliveries(navigate);
    system(NOTICE, 1);
    const [shown] = made;
    if (!shown) throw new Error("no notification");
    shown.data = { kind: "local-access", action: "approve", ref: REF };
    shown.onclick?.();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("withdraws what is showing, and does nothing when nothing is", () => {
    const { system, closeSystem } = browserDeliveries(() => undefined);
    closeSystem();
    system(NOTICE, 1);
    closeSystem();
    closeSystem();
    expect(made[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("survives a browser that will not construct one from a page", () => {
    vi.stubGlobal(
      "Notification",
      Object.assign(
        () => {
          throw new TypeError("Illegal constructor");
        },
        { permission: "granted" },
      ),
    );
    const { system } = browserDeliveries(() => undefined);
    expect(() => system(NOTICE, 1)).not.toThrow();
  });
});

describe("what makes the inbox be read again", () => {
  function signals() {
    const heard: WatchTrigger[] = [];
    const ports = browserPorts(() => undefined, {
      list: async () => [],
      preference: async () => ({ version: 1, destinations: ["in_app"] }),
    });
    const off = ports.subscribe((why) => heard.push(why));
    return { heard, off, ports };
  }

  it("hears a change made here, in another tab, in the preference, and a return to the page", async () => {
    const { heard, off } = signals();
    notifyLocalIamChange();
    new BroadcastChannel(LOCAL_IAM_CHANNEL).postMessage({ type: "changed" });
    await vi.waitFor(() => expect(heard).toContain("other-tab"));
    document.dispatchEvent(new Event("visibilitychange"));
    globalThis.dispatchEvent(new Event("focus"));
    expect(heard).toContain("change");
    expect(heard.filter((why) => why === "visible")).toHaveLength(2);
    off();
  });

  it("hears the person change the preference", async () => {
    const tomb = `delivery-${crypto.randomUUID()}`;
    unlockTomb(tomb, (await mintVaultKey()).vaultKey);
    const { heard, off } = signals();
    await writePreference(tomb, { version: 1, destinations: ["in_app"] });
    expect(heard).toEqual(["preference"]);
    off();
    lockAllTombs();
  });

  it("stops hearing once it is told to", async () => {
    const { heard, off } = signals();
    off();
    notifyLocalIamChange();
    globalThis.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(heard).toEqual([]);
  });

  it("reports hidden from the document, and runs a later action once, cancellably", async () => {
    const { ports } = signals();
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    expect(ports.hidden()).toBe(true);
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    expect(ports.hidden()).toBe(false);
    const action = vi.fn();
    const cancel = ports.later(action, 10);
    cancel();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(action).not.toHaveBeenCalled();
    ports.later(action, 5);
    await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());
    expect(ports.now()).toBeGreaterThan(0);
  });
});
