/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import {
  nativeConfigurationOwner,
  useNativeSignInUiLifetime,
} from "./NativeCancelSignIn.js";
import {
  nativeUiController,
  nativeUiDescriptor,
  nativeUiView,
} from "./native-connector-ui.test-support.js";

it("physically withdraws the original mounted configuration caller when its controller/revision scope changes", () => {
  const view = nativeUiView();
  const controller = nativeUiController(view);
  const descriptor = nativeUiDescriptor();
  const hook = renderHook((scope) => useNativeSignInUiLifetime(scope), {
    initialProps: { descriptor, controller, view },
  });
  let attempt!: ReturnType<typeof hook.result.current.begin>;
  act(() => {
    attempt = hook.result.current.begin();
  });
  expect(attempt.current()).toBe(true);
  expect(attempt.signal.aborted).toBe(false);
  const owner = nativeConfigurationOwner(attempt);
  expect(owner.signal).toBe(attempt.signal);
  expect(() => owner.assertCurrent()).not.toThrow();
  hook.rerender({
    descriptor,
    controller,
    view: { ...view, revision: view.revision + 1 },
  });
  expect(attempt.signal.aborted).toBe(true);
  expect(attempt.current()).toBe(false);
  expect(() => owner.assertCurrent()).toThrow("This configuration ended.");
  hook.unmount();
});
it("retires completed configuration without converting successful cleanup into an HTTP abort", () => {
  const view = nativeUiView();
  const hook = renderHook(() =>
    useNativeSignInUiLifetime({
      descriptor: nativeUiDescriptor(),
      controller: nativeUiController(view),
      view,
    }),
  );
  let attempt!: ReturnType<typeof hook.result.current.begin>;
  act(() => {
    attempt = hook.result.current.begin();
  });
  act(() => attempt.finish());
  expect(attempt.current()).toBe(false);
  expect(attempt.signal.aborted).toBe(false);
  hook.unmount();
  expect(attempt.signal.aborted).toBe(false);
});
it("unmount aborts only a still-owned pending caller and never revives it", () => {
  const view = nativeUiView();
  const scope = {
    descriptor: nativeUiDescriptor(),
    controller: nativeUiController(view),
    view,
  };
  const hook = renderHook(() => useNativeSignInUiLifetime(scope));
  let attempt!: ReturnType<typeof hook.result.current.begin>;
  act(() => {
    attempt = hook.result.current.begin();
  });
  hook.unmount();
  expect(attempt.signal.aborted).toBe(true);
  expect(attempt.current()).toBe(false);
});
