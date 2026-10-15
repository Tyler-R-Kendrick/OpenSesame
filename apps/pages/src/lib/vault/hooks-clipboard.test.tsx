import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIPBOARD_READ_NOTICE,
  clearCopiedSecret,
  useCopySecret,
} from "./hooks.js";

type ClipboardStub = {
  readText: ReturnType<typeof vi.fn>;
  writeText: ReturnType<typeof vi.fn>;
};

function stubClipboard(overrides: Partial<ClipboardStub> = {}): ClipboardStub {
  const clipboard: ClipboardStub = {
    readText: vi.fn().mockResolvedValue(""),
    writeText: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  Object.defineProperty(navigator, "permissions", {
    value: {
      query: vi.fn().mockResolvedValue({ state: "granted" }),
    },
    configurable: true,
  });
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: clipboard,
    configurable: true,
  });
  return clipboard;
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useCopySecret", () => {
  it("reads the clipboard only after the tray says why", async () => {
    vi.useFakeTimers();
    let reasonDuringRead: string | undefined;
    const clipboard = stubClipboard({
      readText: vi.fn().mockImplementation(async () => {
        reasonDuringRead = listNotices().find(
          (notice) => notice.id === CLIPBOARD_READ_NOTICE.id,
        )?.body;
        return "hunter2";
      }),
    });
    act(() => {
      vaultStore.setPrefs({ clipboardClearSeconds: 30 });
    });

    const { result } = renderHook(() => useCopySecret());
    await result.current("hunter2");
    expect(clipboard.readText).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clipboard.readText).toHaveBeenCalledTimes(1);
    expect(reasonDuringRead).toBe(CLIPBOARD_READ_NOTICE.body);
    expect(
      listNotices().some((notice) => notice.id === CLIPBOARD_READ_NOTICE.id),
    ).toBe(false);
    clearNotices();
  });

  it("copies and schedules a clipboard clear", async () => {
    vi.useFakeTimers();
    const clipboard = stubClipboard();
    act(() => {
      vaultStore.setPrefs({ clipboardClearSeconds: 30 });
    });

    const { result } = renderHook(() => useCopySecret());
    await expect(result.current("hunter2")).resolves.toBe("copied");
    expect(clipboard.writeText).toHaveBeenCalledWith("hunter2");

    clipboard.readText.mockResolvedValue("hunter2");
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(clipboard.writeText).toHaveBeenLastCalledWith("");
  });

  it("leaves a clipboard someone else has since overwritten alone", async () => {
    vi.useFakeTimers();
    const clipboard = stubClipboard();
    act(() => {
      vaultStore.setPrefs({ clipboardClearSeconds: 10 });
    });

    const { result } = renderHook(() => useCopySecret());
    await result.current("ours");
    clipboard.readText.mockResolvedValue("theirs");
    clipboard.writeText.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("does not arm a timer when clearing is disabled", async () => {
    vi.useFakeTimers();
    const clipboard = stubClipboard();
    act(() => {
      vaultStore.setPrefs({ clipboardClearSeconds: 0 });
    });

    const { result } = renderHook(() => useCopySecret());
    await expect(result.current("kept")).resolves.toBe("copied");
    clipboard.writeText.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    expect(clipboard.writeText).not.toHaveBeenCalled();
    act(() => {
      vaultStore.setPrefs({ clipboardClearSeconds: 30 });
    });
  });

  it("reports unavailable when the write is rejected or the API is missing", async () => {
    const clipboard = stubClipboard({
      writeText: vi.fn().mockRejectedValue(new Error("denied")),
    });
    const { result } = renderHook(() => useCopySecret());
    await expect(result.current("x")).resolves.toBe("unavailable");
    void clipboard;

    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    const { result: missing } = renderHook(() => useCopySecret());
    await expect(missing.current("x")).resolves.toBe("unavailable");
  });

  it("skips a timed clear when clipboard-read is not already granted", async () => {
    vi.useFakeTimers();
    const clipboard = stubClipboard();
    Object.defineProperty(navigator, "permissions", {
      value: {
        query: vi.fn().mockResolvedValue({ state: "prompt" }),
      },
      configurable: true,
    });
    act(() => {
      vaultStore.setPrefs({ clipboardClearSeconds: 10 });
    });

    const { result } = renderHook(() => useCopySecret());
    await result.current("secret-value");
    clipboard.readText.mockClear();
    clipboard.writeText.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(clipboard.readText).not.toHaveBeenCalled();
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("clears on lock without a clipboard-read prompt when read is not granted", async () => {
    const clipboard = stubClipboard();
    Object.defineProperty(navigator, "permissions", {
      value: {
        query: vi.fn().mockResolvedValue({ state: "prompt" }),
      },
      configurable: true,
    });
    act(() => {
      vaultStore.setPrefs({ clipboardClearSeconds: 0 });
    });

    const { result } = renderHook(() => useCopySecret());
    await result.current("secret-value");
    clipboard.readText.mockClear();
    clipboard.writeText.mockClear();

    clearCopiedSecret();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clipboard.readText).not.toHaveBeenCalled();
    expect(clipboard.writeText).toHaveBeenLastCalledWith("");
  });

  it("a second copy replaces the pending clear of the first", async () => {
    vi.useFakeTimers();
    const clipboard = stubClipboard();
    act(() => {
      vaultStore.setPrefs({ clipboardClearSeconds: 10 });
    });

    const { result } = renderHook(() => useCopySecret());
    await result.current("first");
    await result.current("second");
    clipboard.readText.mockResolvedValue("second");
    clipboard.writeText.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText).toHaveBeenLastCalledWith("");
  });
});

describe("clearCopiedSecret", () => {
  it("is a no-op when nothing was copied", () => {
    const clipboard = stubClipboard();
    clearCopiedSecret();
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("clears the tracked secret immediately, cancelling any pending timer", async () => {
    vi.useFakeTimers();
    const clipboard = stubClipboard();
    act(() => {
      vaultStore.setPrefs({ clipboardClearSeconds: 60 });
    });

    const { result } = renderHook(() => useCopySecret());
    await result.current("secret-value");
    clipboard.readText.mockResolvedValue("secret-value");
    clipboard.writeText.mockClear();

    clearCopiedSecret();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clipboard.writeText).toHaveBeenLastCalledWith("");

    clipboard.writeText.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("falls back to an unconditional clear when reads are denied", async () => {
    const clipboard = stubClipboard({
      readText: vi.fn().mockRejectedValue(new Error("denied")),
    });
    act(() => {
      vaultStore.setPrefs({ clipboardClearSeconds: 0 });
    });

    const { result } = renderHook(() => useCopySecret());
    await result.current("secret-value");
    clipboard.writeText.mockClear();

    clearCopiedSecret();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clipboard.writeText).toHaveBeenLastCalledWith("");
  });

  it("swallows a clipboard that rejects every touch", async () => {
    stubClipboard({
      readText: vi.fn().mockRejectedValue(new Error("denied")),
      writeText: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(new Error("denied")),
    });
    act(() => {
      vaultStore.setPrefs({ clipboardClearSeconds: 0 });
    });

    const { result } = renderHook(() => useCopySecret());
    await result.current("secret-value");
    clearCopiedSecret();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  });
});
