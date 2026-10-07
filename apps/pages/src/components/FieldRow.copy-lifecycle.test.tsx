/** @vitest-environment jsdom */
import { deferred } from "@opensesame/app-core/browser/security/management.fixture.js";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CopyResult } from "../lib/vault/hooks.js";
import { useCopyFeedbackWith } from "./FieldRow.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("does not arm a feedback timer after a held copy control unmounts", async () => {
  vi.useFakeTimers();
  const held = deferred<CopyResult>();
  const hook = renderHook(() => useCopyFeedbackWith(() => held.promise));
  const original = hook.result.current.copy;
  const work = original("controlled", "controlled-value");
  hook.unmount();
  held.finish("copied");
  await work;
  expect(vi.getTimerCount()).toBe(0);
  expect(hook.result.current.copied).toBeNull();
  expect(hook.result.current.failed).toBeNull();
});

it("keeps newer copied feedback when an older unavailable result arrives", async () => {
  vi.useFakeTimers();
  const first = deferred<CopyResult>();
  const hook = renderHook(() =>
    useCopyFeedbackWith(async (value) =>
      value === "older" ? first.promise : "copied",
    ),
  );
  const old = hook.result.current.copy("older-key", "older");
  await act(async () => hook.result.current.copy("newer-key", "newer"));
  first.finish("unavailable");
  await act(async () => {
    await old;
  });
  expect(hook.result.current.copied).toBe("newer-key");
  expect(hook.result.current.failed).toBeNull();
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => {
    vi.advanceTimersByTime(1800);
  });
  expect(hook.result.current.copied).toBeNull();
});

it("preserves the original 4000 ms unavailable feedback duration", async () => {
  vi.useFakeTimers();
  const hook = renderHook(() => useCopyFeedbackWith(async () => "unavailable"));
  await act(async () =>
    hook.result.current.copy("controlled", "controlled-value"),
  );
  await act(async () => {
    vi.advanceTimersByTime(3999);
  });
  expect(hook.result.current.failed).toBe("controlled");
  await act(async () => {
    vi.advanceTimersByTime(1);
  });
  expect(hook.result.current.failed).toBeNull();
});
