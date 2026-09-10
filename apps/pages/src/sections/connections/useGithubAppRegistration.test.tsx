/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectionSeams } from "../../lib/connections.js";
import { useGithubAppRegistration } from "./useGithubAppRegistration.js";

const registration = {
  action: "https://github.com/settings/apps/new",
  state: "test-state",
  manifest: {},
  redirectUrl: "https://host.example.test/callback",
};
const provider = { id: "github", displayName: "GitHub" };
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(connectionSeams, "startGithubAppRegistration").mockResolvedValue(
    registration,
  );
  vi.spyOn(connectionSeams, "submitGithubAppManifest").mockImplementation(
    () => undefined,
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("cancels the navigation fallback when its panel unmounts", async () => {
  const flash = vi.fn();
  const busy = vi.fn();
  const { result, unmount } = renderHook(() =>
    useGithubAppRegistration(provider, flash, busy),
  );
  await act(() => result.current());
  expect(connectionSeams.submitGithubAppManifest).toHaveBeenCalledOnce();
  unmount();
  flash.mockClear();
  busy.mockClear();
  await act(() => vi.advanceTimersByTimeAsync(2500));
  expect(flash).not.toHaveBeenCalled();
  expect(busy).not.toHaveBeenCalled();
});

it("does not navigate or schedule work when registration completes after unmount", async () => {
  let complete: ((value: typeof registration) => void) | undefined;
  vi.mocked(connectionSeams.startGithubAppRegistration).mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const flash = vi.fn();
  const { result, unmount } = renderHook(() =>
    useGithubAppRegistration(provider, flash, vi.fn()),
  );
  const pending = result.current();
  unmount();
  if (!complete) throw new Error("Missing pending registration");
  complete(registration);
  await pending;
  expect(connectionSeams.submitGithubAppManifest).not.toHaveBeenCalled();
  expect(flash).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("still reports a failed navigation while the panel is present", async () => {
  const flash = vi.fn();
  const busy = vi.fn();
  const { result } = renderHook(() =>
    useGithubAppRegistration(provider, flash, busy),
  );
  await act(() => result.current());
  await act(() => vi.advanceTimersByTimeAsync(2500));
  expect(flash).toHaveBeenLastCalledWith({
    tone: "err",
    text: expect.stringContaining("GitHub did not open"),
  });
  expect(busy).toHaveBeenLastCalledWith(null);
});
