/** @vitest-environment jsdom */
import { renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useOnce } from "./use-once.js";

it("runs its body once for two calls made before either has finished", async () => {
  let runs = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { result } = renderHook(() =>
    useOnce(async () => {
      runs += 1;
      await gate;
    }),
  );
  const both = Promise.all([result.current(), result.current()]);
  release();
  await both;
  expect(runs).toBe(1);
  await result.current();
  expect(runs).toBe(1);
});

it("runs the latest body it was given, not the one from the first render", async () => {
  const seen: string[] = [];
  const { result, rerender } = renderHook(
    ({ word }) => useOnce(async () => void seen.push(word)),
    { initialProps: { word: "first" } },
  );
  rerender({ word: "second" });
  await result.current();
  expect(seen).toEqual(["second"]);
});
