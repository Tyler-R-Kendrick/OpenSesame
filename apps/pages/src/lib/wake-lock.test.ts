import { describe, expect, it, vi } from "vitest";
import { holdWakeLock, withWakeLock } from "./wake-lock.js";

function host() {
  const release = vi.fn(async () => undefined);
  const sentinel = { release, released: false };
  return {
    sentinel,
    host: { wakeLock: { request: vi.fn(async () => sentinel) } },
  };
}

describe("wake lock", () => {
  it("releases on hide and is idempotent", async () => {
    const { host: platform, sentinel } = host();
    let hide: (() => void) | undefined;
    const visibility = {
      // SAFETY: "visible" matches DocumentVisibilityState; the assertion only widens it so the test can set "hidden" below.
      visibilityState: "visible" as DocumentVisibilityState,
      addEventListener: (_type: string, listener: () => void) => {
        hide = listener;
      },
      removeEventListener: vi.fn(),
    };
    const release = await holdWakeLock(platform, visibility);
    visibility.visibilityState = "hidden";
    hide?.();
    await Promise.resolve();
    await release();
    expect(sentinel.release).toHaveBeenCalledOnce();
  });

  it("runs the task when the platform has no Wake Lock", async () => {
    await expect(withWakeLock(async () => 7)).resolves.toBe(7);
  });
});
