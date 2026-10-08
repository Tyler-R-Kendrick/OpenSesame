// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { pfFill, pfPresence, pfWaitFor } from "./page-fns";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it.each(["input", "textarea"])(
  "fills a %s with a real instance value tracker through the native prototype",
  (tag) => {
    const field = document.createElement(tag);
    if (
      !(
        field instanceof HTMLInputElement ||
        field instanceof HTMLTextAreaElement
      )
    )
      throw new Error("Expected real editable control");
    field.id = "tracked";
    document.body.append(field);
    const prototype =
      tag === "input"
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (!descriptor?.get || !descriptor.set)
      throw new Error("Expected native descriptor");
    const nativeGet = descriptor.get;
    const nativeSet = descriptor.set;
    const instanceWrites: string[] = [];
    Object.defineProperty(field, "value", {
      configurable: true,
      get() {
        return nativeGet.call(field);
      },
      set(value: string) {
        instanceWrites.push(value);
        nativeSet.call(field, value);
      },
    });
    const observed: string[] = [];
    field.addEventListener("input", () =>
      observed.push(`input:${field.value}`),
    );
    field.addEventListener("change", () =>
      observed.push(`change:${field.value}`),
    );
    expect(pfFill("#tracked", "public-framework-fixture")).toBe("ok");
    expect(instanceWrites).toEqual([]);
    expect(observed).toEqual([
      "input:public-framework-fixture",
      "change:public-framework-fixture",
    ]);
    expect(pfPresence("#tracked", "public-framework-fixture")).toBe("present");
    expect(document.activeElement).toBe(field);
  },
);

it.each(["match", "timeout"])(
  "disconnects the real mutation observer after %s before later page mutations",
  async (kind) => {
    // The spy delegates to the actual browser-DOM implementation.
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const pending = pfWaitFor("#eventual", kind === "match" ? 100 : 1);
    if (kind === "match") {
      const match = document.createElement("div");
      match.id = "eventual";
      document.body.append(match);
    }
    expect(await pending).toBe(kind === "match" ? "ok" : "timeout");
    expect(disconnect).toHaveBeenCalledTimes(1);
    const later = document.createElement(
      kind === "timeout" ? "div" : "section",
    );
    if (kind === "timeout") later.id = "eventual";
    document.body.append(later);
    await Promise.resolve();
    expect(disconnect).toHaveBeenCalledTimes(1);
  },
);
