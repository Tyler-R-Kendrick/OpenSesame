import { describe, expect, it, vi } from "vitest";
import { installPwaRefresh, pwaRefreshSeams } from "./pwa-refresh.js";

describe("installPwaRefresh", () => {
  it("reloads once when a controlled window changes worker", () => {
    const listeners = new Map<string, EventListener>();
    const reload = vi.fn();
    pwaRefreshSeams.host = () => ({
      serviceWorker: {
        // SAFETY: installPwaRefresh only checks that a controller is present, so an empty object matches the part of ServiceWorker it reads.
        controller: {} as ServiceWorker,
        addEventListener: (type: string, listener: EventListener) =>
          listeners.set(type, listener),
        removeEventListener: (type: string) => listeners.delete(type),
      },
      visibilityState: "hidden",
      addEventListener: (type: string, listener: EventListener) =>
        listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
      reload,
    });
    const check = vi.fn(async () => true);
    installPwaRefresh(check);
    listeners.get("controllerchange")?.(new Event("controllerchange"));
    listeners.get("controllerchange")?.(new Event("controllerchange"));
    expect(reload).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledOnce();
  });

  it("checks again when the page becomes visible", () => {
    const listeners = new Map<string, EventListener>();
    let visibility: DocumentVisibilityState = "hidden";
    pwaRefreshSeams.host = () => ({
      serviceWorker: {
        controller: null,
        addEventListener: (type: string, listener: EventListener) =>
          listeners.set(type, listener),
        removeEventListener: () => undefined,
      },
      get visibilityState() {
        return visibility;
      },
      addEventListener: (type: string, listener: EventListener) =>
        listeners.set(type, listener),
      removeEventListener: () => undefined,
      reload: vi.fn(),
    });
    const check = vi.fn(async () => true);
    installPwaRefresh(check);
    visibility = "visible";
    listeners.get("visibilitychange")?.(new Event("visibilitychange"));
    expect(check).toHaveBeenCalledTimes(2);
  });
});
