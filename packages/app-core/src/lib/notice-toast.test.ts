import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ToastMessage,
  arrivalSurface,
  desktopRinging,
  setDesktopRinging,
  showToast,
  subscribeToasts,
  toastOf,
} from "./notice-toast.js";
import type { Notice } from "./notices.js";

afterEach(() => setDesktopRinging(false));

describe("arrivalSurface: one surface per arrival", () => {
  it("toasts in front of the person, whatever the desktop setting", () => {
    expect(arrivalSurface({ away: false, desktop: false })).toBe("toast");
    expect(arrivalSurface({ away: false, desktop: true })).toBe("toast");
  });

  it("rings the desktop, and no toast, when away with desktop on", () => {
    expect(arrivalSurface({ away: true, desktop: true })).toBe("desktop");
  });

  it("leaves a notice to the tray alone when away with desktop off", () => {
    expect(arrivalSurface({ away: true, desktop: false })).toBeNull();
  });
});

describe("toastOf", () => {
  it("carries the notice's words, tone and route, and defaults the tone to info", () => {
    const notice: Notice = {
      id: "n1",
      kind: "status",
      title: "Host unreachable",
      body: "Retry when it is back.",
      createdAt: new Date(0).toISOString(),
      open: { to: "/connections", label: "Open connections" },
    };
    expect(toastOf(notice)).toEqual({
      id: "n1",
      tone: "info",
      title: "Host unreachable",
      body: "Retry when it is back.",
      open: { to: "/connections", label: "Open connections" },
    });
    expect(toastOf({ ...notice, tone: "err" }).tone).toBe("err");
  });
});

describe("the toast bus", () => {
  it("delivers a shown toast to every listener until it unsubscribes", () => {
    const first = vi.fn<(toast: ToastMessage) => void>();
    const second = vi.fn<(toast: ToastMessage) => void>();
    const offFirst = subscribeToasts(first);
    const offSecond = subscribeToasts(second);
    const toast: ToastMessage = {
      id: "t",
      tone: "warn",
      title: "Waiting",
      body: "One.",
    };
    showToast(toast);
    expect(first).toHaveBeenCalledWith(toast);
    expect(second).toHaveBeenCalledWith(toast);
    offFirst();
    showToast(toast);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
    offSecond();
  });

  it("drops a toast nobody is listening for without failing", () => {
    const toast: ToastMessage = {
      id: "x",
      tone: "info",
      title: "t",
      body: "b",
    };
    expect(() => showToast(toast)).not.toThrow();
  });
});

describe("the desktop flag", () => {
  it("is off until a capability that owns desktop rings says otherwise", () => {
    expect(desktopRinging()).toBe(false);
    setDesktopRinging(true);
    expect(desktopRinging()).toBe(true);
    setDesktopRinging(false);
    expect(desktopRinging()).toBe(false);
  });
});
