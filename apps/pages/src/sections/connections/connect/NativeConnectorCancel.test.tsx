/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { NativeConnectorForm } from "./NativeConnectorForm.js";
import { NativeConnectorSummary } from "./NativeConnectorSummary.js";
import {
  nativeUiController,
  nativeUiDescriptor,
  nativeUiView,
} from "./native-connector-ui.test-support.js";

afterEach(cleanup);

function signInDescriptor() {
  const descriptor = nativeUiDescriptor();
  descriptor.methods = [
    {
      id: "oauth",
      label: "Sign in",
      authorizeFirst: true,
      available: true,
      fields: [],
      scopeGroups: [],
    },
  ];
  return descriptor;
}

it("cancels the pending provider sign-in from its originating form and allows another attempt", async () => {
  const controller = nativeUiController();
  let reject: ((error: Error) => void) | undefined;
  controller.connect.mockImplementation(
    () =>
      new Promise((_resolve, refused) => {
        reject = refused;
      }),
  );
  controller.cancelAuthorization.mockImplementation(() =>
    reject?.(new Error("Sign-in cancelled")),
  );
  const onFlash = vi.fn();
  const onChanged = vi.fn();
  render(
    <NativeConnectorForm
      descriptor={signInDescriptor()}
      controller={controller}
      onFlash={onFlash}
      onChanged={onChanged}
    />,
  );
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Sign in to Algolia" }),
  );
  expect(
    screen.getByRole("button", { name: "Sign in to Algolia" }),
  ).toHaveProperty("disabled", true);
  await userEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  expect(controller.cancelAuthorization).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull(),
  );
  expect(
    screen.getByRole("button", { name: "Sign in to Algolia" }),
  ).toHaveProperty("disabled", false);
  expect(onChanged).toHaveBeenCalledOnce();
  expect(onFlash).not.toHaveBeenCalledWith(
    expect.objectContaining({ tone: "ok" }),
  );
});

it("cancels consent renewal without offering cancellation for a separate access check", async () => {
  const view = nativeUiView();
  view.status = "reauthorize";
  view.verifiedAt = null;
  view.configuration.method = "oauth";
  const controller = nativeUiController(view);
  let reject: ((error: Error) => void) | undefined;
  controller.authorize.mockImplementation(
    () =>
      new Promise((_resolve, refused) => {
        reject = refused;
      }),
  );
  controller.cancelAuthorization.mockImplementation(() =>
    reject?.(new Error("Sign-in cancelled")),
  );
  render(
    <NativeConnectorSummary
      descriptor={signInDescriptor()}
      controller={controller}
      view={view}
      onFlash={vi.fn()}
      onChanged={vi.fn()}
      onRemoved={vi.fn()}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Authorize Algolia" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull(),
  );
  expect(controller.cancelAuthorization).toHaveBeenCalledOnce();
  let finish: ((value: ReturnType<typeof nativeUiView>) => void) | undefined;
  controller.verify.mockImplementation(
    () =>
      new Promise((done) => {
        finish = done;
      }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Verify Algolia access" }),
  );
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
  expect(controller.remove).not.toHaveBeenCalled();
  finish?.(view);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Verify Algolia access" }),
    ).toHaveProperty("disabled", false),
  );
});
