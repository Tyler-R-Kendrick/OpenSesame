/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type InstallState,
  armInstall,
  ensurePersistence,
  installOfferable,
  installSeams,
  installState,
  installWorthShowing,
  promptInstall,
  requestPersistence,
  resetInstallForTest,
  storagePersisted,
  subscribeInstall,
} from "./install.js";

const originalSeams = { ...installSeams };

/** Chromium's event, as far as this module is concerned. */
function firePrompt(outcome: "accepted" | "dismissed" | "throw" = "accepted") {
  const event = new Event("beforeinstallprompt", { cancelable: true });
  Object.assign(event, {
    prompt: () =>
      outcome === "throw"
        ? Promise.reject(new Error("already used"))
        : Promise.resolve({ outcome }),
  });
  window.dispatchEvent(event);
  return { prevented: event.defaultPrevented };
}

beforeEach(() => {
  resetInstallForTest();
  Object.assign(installSeams, originalSeams, {
    runningStandalone: () => false,
    appleTouchDevice: () => false,
  });
  armInstall();
});

afterEach(() => {
  resetInstallForTest();
  Object.assign(installSeams, originalSeams);
  vi.unstubAllGlobals();
});

describe("installState", () => {
  it("is unavailable on a browser that offers nothing", () => {
    // Firefox on the desktop, an in-app webview, or a Chromium that has not
    // decided yet. There is no install to offer and no instruction to give.
    expect(installState()).toBe("unavailable");
  });

  it("becomes prompt once Chromium hands over its event", () => {
    firePrompt();
    expect(installState()).toBe("prompt");
  });

  it("suppresses Chromium's own mini-infobar", () => {
    // The whole point of this surface is that the offer is ours, in the app,
    // beside the reason for it — not a browser strip over the top of it.
    expect(firePrompt().prevented).toBe(true);
  });

  it("is manual on an Apple touch device, where no API exists", () => {
    Object.assign(installSeams, { appleTouchDevice: () => true });
    expect(installState()).toBe("manual");
  });

  it("is installed when the page is already running standalone", () => {
    Object.assign(installSeams, { runningStandalone: () => true });
    expect(installState()).toBe("installed");
  });

  it("prefers installed over a prompt the browser still had in flight", () => {
    firePrompt();
    Object.assign(installSeams, { runningStandalone: () => true });
    expect(installState()).toBe("installed");
  });

  it("prefers a real prompt over the iOS instructions", () => {
    Object.assign(installSeams, { appleTouchDevice: () => true });
    firePrompt();
    expect(installState()).toBe("prompt");
  });

  it("goes installed on appinstalled, and drops the spent event", () => {
    firePrompt();
    window.dispatchEvent(new Event("appinstalled"));
    expect(installState()).toBe("installed");
    // Nothing left to offer: a second prompt would throw on the spent event.
    expect(installOfferable(installState())).toBe(false);
  });
});

describe("promptInstall", () => {
  it("does not spend the one persistence attempt before the install lands", async () => {
    // At accept time the origin is still a plain tab — `appinstalled` has not
    // fired — so Chromium refuses. Asking here would latch the module's
    // once-per-load flag on that refusal and the retry that *would* have been
    // granted, moments later, never happens.
    const persist = vi.fn().mockResolvedValue(true);
    const persisted = vi.fn().mockResolvedValue(false);
    vi.stubGlobal("navigator", {
      ...navigator,
      storage: { persist, persisted },
    });
    firePrompt("accepted");

    expect(await promptInstall()).toBe("accepted");
    expect(persist).not.toHaveBeenCalled();
  });

  it("does not spend the attempt on our own optimistic accept", async () => {
    // The regression that hid behind the first fix: `promptInstall` flips the
    // state to `installed` before Chromium has installed anything, so anything
    // gating on `installState()` asks while the origin is still a plain tab —
    // spends the one attempt on a guaranteed refusal, and the real chance a
    // moment later finds it gone. The gate is the browser's own confirmation.
    const persist = vi.fn().mockResolvedValue(true);
    const persisted = vi.fn().mockResolvedValue(false);
    vi.stubGlobal("navigator", {
      ...navigator,
      storage: { persist, persisted },
    });
    firePrompt("accepted");
    await promptInstall();

    // What the card's effect does the moment the state says "installed".
    expect(await ensurePersistence()).toBe(false);
    expect(persist).not.toHaveBeenCalled();

    // Then the browser confirms, and the attempt is still there to spend.
    window.dispatchEvent(new Event("appinstalled"));
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
  });

  it("shares one request, so a second caller gets the real answer", async () => {
    // Latching a boolean would have the second caller read "somebody else
    // asked" as "not persisted", and render "not kept" over a live grant.
    const persist = vi.fn().mockResolvedValue(true);
    const persisted = vi.fn().mockResolvedValue(false);
    vi.stubGlobal("navigator", {
      ...navigator,
      storage: { persist, persisted },
    });
    Object.assign(installSeams, { runningStandalone: () => true });

    const [a, b] = await Promise.all([
      ensurePersistence(),
      ensurePersistence(),
    ]);
    expect([a, b]).toEqual([true, true]);
    expect(persist).toHaveBeenCalledOnce();
  });

  it("asks the moment the browser says the app is installed", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const persisted = vi.fn().mockResolvedValue(false);
    vi.stubGlobal("navigator", {
      ...navigator,
      storage: { persist, persisted },
    });

    window.dispatchEvent(new Event("appinstalled"));
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
  });

  it("keeps a rejected gesture retryable rather than calling it a refusal", async () => {
    // Chromium rejects with NotAllowedError when it cannot trace the call to a
    // transient user activation — and does NOT consume the event. Throwing it
    // away would send the reader to the browser's own menu when a second press
    // would have worked.
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, {
      prompt: () =>
        Promise.reject(new DOMException("no activation", "NotAllowedError")),
    });
    window.dispatchEvent(event);

    expect(await promptInstall()).toBe("retry");
    expect(installState()).toBe("prompt");
  });

  it("reads the error's shape, not its constructor", async () => {
    // A cross-realm rejection, a wrapped one, or an engine that rejects with a
    // plain Error means the same thing — and misreading it retires an offer
    // the browser never spent.
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, {
      prompt: () =>
        Promise.reject(
          Object.assign(new Error("no"), { name: "NotAllowedError" }),
        ),
    });
    window.dispatchEvent(event);

    expect(await promptInstall()).toBe("retry");
    expect(installState()).toBe("prompt");
  });

  it("keeps the surface visible while the dialog is open", async () => {
    // Consuming the event empties `pending`; without a separate "dialog is up"
    // fact the state falls to `unavailable`, which renders nothing at all.
    let settle: (choice: { outcome: string }) => void = () => {};
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, {
      prompt: () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    });
    window.dispatchEvent(event);

    const pending = promptInstall();
    expect(installState()).toBe("prompt");
    expect(installWorthShowing(installState())).toBe(true);
    settle({ outcome: "dismissed" });
    await pending;
  });

  it("records the install itself rather than waiting for appinstalled", async () => {
    // `appinstalled` normally follows and is what flips the state — but it is
    // not guaranteed. Without recording it here the surface collapses to
    // `unavailable` at the exact moment the install succeeded.
    firePrompt("accepted");
    await promptInstall();
    expect(installState()).toBe("installed");
    expect(installWorthShowing(installState())).toBe(true);
  });

  it("lands on dismissed rather than vanishing when the reader says no", async () => {
    firePrompt("dismissed");
    expect(await promptInstall()).toBe("dismissed");
    // The offer is spent, but the surface stays: an offer that disappears the
    // moment it is refused reads as the app having taken it badly.
    expect(installState()).toBe("dismissed");
    expect(installWorthShowing("dismissed")).toBe(true);
    expect(installOfferable("dismissed")).toBe(false);
  });

  it("treats a fresh event as a fresh offer, not a lingering refusal", async () => {
    firePrompt("dismissed");
    await promptInstall();
    firePrompt("accepted");
    expect(installState()).toBe("prompt");
  });

  it("consumes the event before awaiting, so overlapping presses cannot double-prompt", async () => {
    // Chromium's event is single-use. Two calls that overlap — a double press
    // dispatched before React paints the disabled button — would otherwise
    // both reach `prompt()`, and the second rejection would report a refusal
    // for an install that succeeded.
    const prompt = vi.fn().mockResolvedValue({ outcome: "accepted" });
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, { prompt });
    window.dispatchEvent(event);

    await Promise.all([promptInstall(), promptInstall()]);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("consumes the event exactly once", async () => {
    firePrompt("accepted");
    expect(await promptInstall()).toBe("accepted");
    // Chromium's event is single-use and a second `prompt()` throws, so the
    // module must not keep a button alive that would.
    expect(await promptInstall()).toBe("unknown");
  });

  it("is unknown with no captured event at all", async () => {
    expect(await promptInstall()).toBe("unknown");
  });

  it("swallows a rejected prompt without deleting the surface", async () => {
    // Chromium rejects a `prompt()` it cannot trace to a transient user
    // activation. The event is gone, but the reader is still looking at the
    // card they just pressed — it must not vanish under their finger.
    firePrompt("throw");
    expect(await promptInstall()).toBe("unknown");
    expect(installState()).toBe("dismissed");
    expect(installWorthShowing(installState())).toBe(true);
  });

  it("does not call an unreadable answer a refusal", async () => {
    // Older Chromium resolved `prompt()` with nothing and had no
    // `userChoice`. That is genuinely unknown, and reporting it as "you
    // declined" would tell someone who just installed the app otherwise.
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, { prompt: () => Promise.resolve(undefined) });
    window.dispatchEvent(event);

    expect(await promptInstall()).toBe("unknown");
    // Still on screen, because the offer is spent either way.
    expect(installWorthShowing(installState())).toBe(true);
  });
});

describe("subscribeInstall", () => {
  it("announces a captured prompt and stops on unsubscribe", () => {
    const seen = vi.fn();
    const stop = subscribeInstall(seen);
    firePrompt();
    expect(seen).toHaveBeenCalledOnce();
    stop();
    window.dispatchEvent(new Event("appinstalled"));
    expect(seen).toHaveBeenCalledOnce();
  });
});

describe("what the surfaces ask", () => {
  const cases: [InstallState, boolean, boolean][] = [
    ["prompt", true, true],
    ["manual", true, true],
    ["installed", false, true],
    ["dismissed", false, true],
    ["unavailable", false, false],
  ];

  it.each(cases)(
    "%s: offerable=%s worthShowing=%s",
    (state, offerable, showing) => {
      expect(installOfferable(state)).toBe(offerable);
      expect(installWorthShowing(state)).toBe(showing);
    },
  );

  it("withholds the surface entirely where nothing can be installed", () => {
    // ADR 0077's rule, applied again: a screen that exists only to say what
    // your browser will not do is a report nobody can act on.
    expect(installWorthShowing("unavailable")).toBe(false);
  });
});

describe("storage persistence", () => {
  it("is best-effort — a browser without the API is not an error", async () => {
    vi.stubGlobal("navigator", { ...navigator, storage: undefined });
    expect(await requestPersistence()).toBe(false);
    expect(await storagePersisted()).toBe(false);
  });

  it("reports what the browser actually answered", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      storage: {
        persist: () => Promise.resolve(false),
        persisted: () => Promise.resolve(true),
      },
    });
    expect(await requestPersistence()).toBe(false);
    expect(await storagePersisted()).toBe(true);
  });

  it("survives a browser that throws from the storage manager", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      storage: {
        persist: () => {
          throw new Error("denied");
        },
        persisted: () => {
          throw new Error("denied");
        },
      },
    });
    expect(await requestPersistence()).toBe(false);
    expect(await storagePersisted()).toBe(false);
  });
});
