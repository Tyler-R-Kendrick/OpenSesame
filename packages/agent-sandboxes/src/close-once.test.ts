import { expect, it, vi } from "vitest";
import { closeOnce } from "./close-once.js";

it("shares an in-flight close and does not repeat it after success", async () => {
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = vi.fn(() => pending);
  const close = closeOnce(original);
  const first = close();
  const second = close();
  expect(original).toHaveBeenCalledOnce();
  release();
  await Promise.all([first, second]);
  await close();
  expect(original).toHaveBeenCalledOnce();
});

it("propagates a failed close and retries it", async () => {
  const original = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("close failed"))
    .mockResolvedValueOnce(undefined);
  const close = closeOnce(original);
  await expect(close()).rejects.toThrow("close failed");
  await expect(close()).resolves.toBeUndefined();
  await close();
  expect(original).toHaveBeenCalledTimes(2);
});
