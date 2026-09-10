/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { connectionSeams } from "../../lib/connections.js";
import { identitySeams } from "../../lib/identity.js";
import { useGithubAppDeployment } from "./useGithubAppDeployment.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([false, true])(
  "navigation recovery follows the panel lifetime (unmounted=%s)",
  async (unmounted) => {
    vi.useFakeTimers();
    vi.spyOn(identitySeams, "ensureHostSession").mockResolvedValue({
      clientId: "fixture-client",
      hostApi: "https://host.example",
      expiresAt: Date.now() + 300000,
      capabilities: [],
    });
    vi.spyOn(connectionSeams, "startGithubAppRegistration").mockResolvedValue({
      action: "https://github.com/settings/apps/new",
      state: "fixture",
      manifest: {},
      redirectUrl: "https://host.example/callback",
    });
    const submit = vi
      .spyOn(connectionSeams, "submitGithubAppManifest")
      .mockImplementation(() => {});
    const busy = vi.fn();
    const flash = vi.fn();
    const { result, unmount } = renderHook(() =>
      useGithubAppDeployment(busy, flash),
    );
    await act(async () => {
      await result.current("history");
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    if (unmounted) unmount();
    expect(vi.getTimerCount()).toBe(unmounted ? 0 : 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(flash).toHaveBeenCalledTimes(unmounted ? 2 : 3);
    if (!unmounted)
      expect(flash).toHaveBeenLastCalledWith(
        expect.objectContaining({ tone: "err" }),
      );
  },
);
