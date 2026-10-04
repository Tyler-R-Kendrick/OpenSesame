/** @vitest-environment jsdom */
import {
  LOCAL_IAM_CHANNEL,
  notifyLocalIamChange,
  resetLocalIamChannelForTest,
} from "@opensesame/app-core/lib/local-iam-events.js";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useInboxCount } from "./use-inbox.js";

const listInbox = vi.fn();

const row = (ref: string, expiresAt: number) => ({
  kind: "local-access",
  action: "review",
  ref,
  expiresAt: new Date(expiresAt).toISOString(),
});

beforeEach(() => {
  listInbox.mockReset();
  listInbox.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  resetLocalIamChannelForTest();
  vi.useRealTimers();
});

describe("useInboxCount", () => {
  it("is the number of requests waiting for this vault", async () => {
    listInbox.mockResolvedValue([
      row("a", Date.now() + 60_000),
      row("b", Date.now() + 60_000),
    ]);
    const { result } = renderHook(() => useInboxCount("tomb-a", listInbox));
    await waitFor(() => expect(result.current).toBe(2));
    expect(listInbox).toHaveBeenCalledWith("tomb-a");
  });

  it("is zero while the inbox cannot be read, never a number it cannot stand behind", async () => {
    listInbox.mockRejectedValue(new Error("locked"));
    const { result } = renderHook(() => useInboxCount("tomb-a", listInbox));
    await waitFor(() => expect(listInbox).toHaveBeenCalled());
    expect(result.current).toBe(0);
  });

  it("follows a request raised or decided in this tab", async () => {
    const { result } = renderHook(() => useInboxCount("tomb-a", listInbox));
    await waitFor(() => expect(listInbox).toHaveBeenCalledTimes(1));
    listInbox.mockResolvedValue([row("a", Date.now() + 60_000)]);
    await act(async () => notifyLocalIamChange());
    await waitFor(() => expect(result.current).toBe(1));
  });

  it("follows a request raised in another tab", async () => {
    const { result } = renderHook(() => useInboxCount("tomb-a", listInbox));
    await waitFor(() => expect(listInbox).toHaveBeenCalledTimes(1));
    listInbox.mockResolvedValue([row("a", Date.now() + 60_000)]);
    const tab = new BroadcastChannel(LOCAL_IAM_CHANNEL);
    tab.postMessage({ type: "changed" });
    await waitFor(() => expect(result.current).toBe(1));
    tab.close();
  });

  it("reads again when the soonest waiting request lapses", async () => {
    vi.useFakeTimers();
    listInbox.mockResolvedValue([row("a", Date.now() + 1000)]);
    const { result } = renderHook(() => useInboxCount("tomb-a", listInbox));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toBe(1);
    listInbox.mockResolvedValue([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(result.current).toBe(0);
  });

  it("stops listening when the page leaves", async () => {
    const { unmount } = renderHook(() => useInboxCount("tomb-a", listInbox));
    await waitFor(() => expect(listInbox).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => notifyLocalIamChange());
    expect(listInbox).toHaveBeenCalledTimes(1);
  });
});
