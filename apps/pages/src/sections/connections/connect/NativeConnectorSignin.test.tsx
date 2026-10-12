/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { NativeConnectorForm } from "./NativeConnectorForm.js";
import {
  nativeUiController,
  nativeUiDescriptor,
  nativeUiView,
} from "./native-connector-ui.test-support.js";

afterEach(cleanup);

it("uses the provider sign-in controller on the first action without requiring cosmetic metadata", async () => {
  const descriptor = nativeUiDescriptor();
  descriptor.methods = [
    ...descriptor.methods.filter((method) => method.id === "api-key"),
    {
      id: "oauth",
      label: "Sign in",
      authorizeFirst: true,
      available: true,
      fields: [],
      scopeGroups: [],
    },
  ];
  const controller = nativeUiController();
  let resolve: ((view: ReturnType<typeof nativeUiView>) => void) | undefined;
  controller.connect.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const onChanged = vi.fn();
  const onFlash = vi.fn();
  render(
    <NativeConnectorForm
      descriptor={descriptor}
      controller={controller}
      onChanged={onChanged}
      onFlash={onFlash}
    />,
  );
  expect(screen.queryByLabelText("Icon")).toBeNull();
  expect(screen.queryByLabelText("Connector name")).toBeNull();
  expect(screen.getByRole("radio", { name: "Sign in" })).toHaveProperty(
    "checked",
    true,
  );
  expect(
    screen.queryByLabelText("Algolia API key", {
      selector: 'input[type="password"]',
    }),
  ).toBeNull();
  const signIn = screen.getByRole("button", { name: "Sign in to Algolia" });
  await userEvent.click(signIn);
  expect(controller.connect).toHaveBeenCalledOnce();
  expect(controller.configure).not.toHaveBeenCalled();
  expect(controller.authorize).not.toHaveBeenCalled();
  expect(onChanged).not.toHaveBeenCalled();
  expect(onFlash).not.toHaveBeenCalled();
  expect(signIn).toHaveProperty("disabled", true);
  resolve?.(nativeUiView());
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  expect(onFlash).toHaveBeenCalledWith({
    tone: "ok",
    text: "Algolia access verified and saved on this device.",
  });
});
