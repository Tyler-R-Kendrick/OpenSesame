import { describe, expect, it, vi } from "vitest";
import { installPwaRefresh, pwaRefreshSeams } from "./pwa-refresh.js";

describe("installPwaRefresh", () => {
  it("reloads once when a controlled window changes worker", () => {
    const listeners = new Map<string, () => void>();
    const reload = vi.fn();
    pwaRefreshSeams.host = () => ({
      serviceWorker: {
        controller: {} as ServiceWorker,
        addEventListener: (type: string, listener: EventListener) =>
          listeners.set(type, listener as () => void),
        removeEventListener: (type: string) => listeners.delete(type),
      },
      visibilityState: "hidden",
      addEventListener: (type: string, listener: EventListener) =>
        listeners.set(type, listener as () => void),
      removeEventListener: (type: string) => listeners.delete(type),
      reload,
    });
    const check = vi.fn(async () => true);
    installPwaRefresh(check);
    listeners.get("controllerchange")?.();
    listeners.get("controllerchange")?.();
    expect(reload).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledOnce();
  });

  it("checks again when the page becomes visible", () => {
    const listeners = new Map<string, () => void>();
    let visibility: DocumentVisibilityState = "hidden";
    pwaRefreshSeams.host = () => ({
      serviceWorker: {
        controller: null,
        addEventListener: (type: string, listener: EventListener) =>
          listeners.set(type, listener as () => void),
        removeEventListener: () => undefined,
      },
      get visibilityState() {
        return visibility;
      },
      addEventListener: (type: string, listener: EventListener) =>
        listeners.set(type, listener as () => void),
      removeEventListener: () => undefined,
      reload: vi.fn(),
    });
    const check = vi.fn(async () => true);
    installPwaRefresh(check);
    visibility = "visible";
    listeners.get("visibilitychange")?.();
    expect(check).toHaveBeenCalledTimes(2);
  });
});
