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

  it("tries a failed read again, later each time, and a few times only", async () => {
    vi.useFakeTimers();
    listInbox.mockRejectedValue(new Error("busy"));
    renderHook(() => useInboxCount("tomb-a", listInbox));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(listInbox).toHaveBeenCalledTimes(1);
    for (const [at, delay] of [1000, 2000, 4000, 8000].entries()) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay - 1);
      });
      expect(listInbox, `before retry ${at + 1}`).toHaveBeenCalledTimes(1 + at);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(listInbox, `retry ${at + 1}`).toHaveBeenCalledTimes(2 + at);
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(listInbox).toHaveBeenCalledTimes(5);
  });

  it("shows the count again when a retry works", async () => {
    vi.useFakeTimers();
    listInbox.mockRejectedValueOnce(new Error("busy"));
    listInbox.mockResolvedValue([row("a", Date.now() + 600_000)]);
    const { result } = renderHook(() => useInboxCount("tomb-a", listInbox));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current).toBe(1);
  });

  it("leaves no timer behind for a read that another one overtook", async () => {
    vi.useFakeTimers();
    let release: (rows: ReturnType<typeof row>[]) => void = () => undefined;
    listInbox.mockReturnValueOnce(
      new Promise<ReturnType<typeof row>[]>((resolve) => {
        release = resolve;
      }),
    );
    renderHook(() => useInboxCount("tomb-a", listInbox));
    // A second read starts and finishes while the first is still out.
    listInbox.mockResolvedValue([]);
    await act(async () => notifyLocalIamChange());
    expect(listInbox).toHaveBeenCalledTimes(2);
    // The first comes back late, with a request about to lapse: it is not the
    // newest read, so it sets no count and starts no timer.
    release([row("late", Date.now() + 500)]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(listInbox).toHaveBeenCalledTimes(2);
  });
});
