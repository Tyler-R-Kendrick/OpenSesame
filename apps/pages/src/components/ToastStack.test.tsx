import {
  setDesktopRinging,
  showToast,
} from "@opensesame/app-core/lib/notice-toast.js";
import { clearNotices, pushNotice } from "@opensesame/app-core/lib/notices.js";
/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOAST_LIMIT, TOAST_MS, ToastStack } from "./ToastStack.js";

type Made = { title: string; options: NotificationOptions; closed: boolean };
const made: Made[] = [];

class FakeNotification {
  static permission: NotificationPermission = "granted";
  closed = false;
  onclick: (() => void) | null = null;
  constructor(
    public title: string,
    public options: NotificationOptions,
  ) {
    made.push({ title, options, closed: false });
  }
  close() {
    this.closed = true;
  }
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
}

function renderStack() {
  return render(
    <MemoryRouter>
      <ToastStack />
    </MemoryRouter>,
  );
}

function arrive(title: string, body = "Something happened.") {
  act(() => {
    pushNotice({ kind: "status", tone: "info", title, body });
  });
}

describe("ToastStack", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    made.length = 0;
    vi.stubGlobal("Notification", FakeNotification);
    FakeNotification.permission = "granted";
    setHidden(false);
    setDesktopRinging(false);
  });

  afterEach(() => {
    cleanup();
    clearNotices();
    setDesktopRinging(false);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("is one polite live region, drawn before anything arrives", () => {
    renderStack();
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
  });

  it("says an arrival in front of the person, in the notice's own words", () => {
    renderStack();
    arrive("Guest session", "Sign in to claim it.");
    const toast = screen.getByRole("status");
    expect(toast.textContent).toContain("Guest session");
    expect(toast.textContent).toContain("Sign in to claim it.");
    expect(made).toHaveLength(0);
  });

  it("goes after its time unless the person is still reading it", () => {
    renderStack();
    arrive("Saved");
    act(() => vi.advanceTimersByTime(TOAST_MS - 1));
    expect(screen.getByText("Saved")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("holds while a pointer rests on it, then gives back the time it had left", () => {
    renderStack();
    arrive("Held");
    const card = screen.getByText("Held").closest("article");
    if (!card) throw new Error("no toast card");
    act(() => vi.advanceTimersByTime(TOAST_MS / 2));
    fireEvent.pointerEnter(card);
    act(() => vi.advanceTimersByTime(TOAST_MS * 3));
    expect(screen.getByText("Held")).toBeTruthy();
    fireEvent.pointerLeave(card);
    act(() => vi.advanceTimersByTime(TOAST_MS / 2 - 1));
    expect(screen.getByText("Held")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Held")).toBeNull();
  });

  it("dismisses on its key; the tray keeps the notice", () => {
    renderStack();
    arrive("Gone");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Gone")).toBeNull();
  });

  it("shows at most the limit at once, the newest", () => {
    renderStack();
    for (let index = 1; index <= TOAST_LIMIT + 1; index += 1)
      arrive(`Notice ${index}`);
    expect(screen.queryByText("Notice 1")).toBeNull();
    expect(screen.getByText(`Notice ${TOAST_LIMIT + 1}`)).toBeTruthy();
  });

  it("shows a toast another part of the page sent through the bus", () => {
    renderStack();
    act(() => {
      showToast({
        id: "req",
        tone: "warn",
        title: "Request waiting",
        body: "A request is waiting for you.",
      });
    });
    expect(screen.getByText("Request waiting")).toBeTruthy();
  });

  it("rings the desktop once, and no toast, when away with desktop on", () => {
    setHidden(true);
    setDesktopRinging(true);
    renderStack();
    arrive("Guest session");
    expect(screen.queryByText("Guest session")).toBeNull();
    expect(made).toHaveLength(1);
    expect(made[0]?.title).toBe("Notice waiting");
    expect(made[0]?.options.tag).toMatch(/^opensesame-notice-/);
    expect(made[0]?.options.body).not.toContain("Guest");
  });

  it("neither rings nor toasts when away with desktop off", () => {
    setHidden(true);
    setDesktopRinging(false);
    renderStack();
    arrive("Quiet");
    expect(screen.queryByText("Quiet")).toBeNull();
    expect(made).toHaveLength(0);
  });

  it("does not ring the desktop when the browser has not granted it", () => {
    setHidden(true);
    setDesktopRinging(true);
    FakeNotification.permission = "denied";
    renderStack();
    arrive("Denied");
    expect(made).toHaveLength(0);
  });
});
