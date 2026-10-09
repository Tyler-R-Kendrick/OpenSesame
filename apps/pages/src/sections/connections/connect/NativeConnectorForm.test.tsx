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

async function enterCredentials() {
  await userEvent.type(
    screen.getByLabelText("Algolia application ID"),
    "app-human",
  );
  await userEvent.type(
    screen.getByLabelText("Algolia API key", {
      selector: 'input[type="password"]',
    }),
    "private-human-key",
  );
}

it("keeps provider fields and credentials separate and waits for verified durable completion", async () => {
  const controller = nativeUiController();
  let finish: ((view: ReturnType<typeof nativeUiView>) => void) | undefined;
  controller.configure.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const onChanged = vi.fn();
  const onFlash = vi.fn();
  render(
    <NativeConnectorForm
      descriptor={nativeUiDescriptor()}
      controller={controller}
      onChanged={onChanged}
      onFlash={onFlash}
    />,
  );
  expect(
    screen.getByLabelText("Algolia API key", {
      selector: 'input[type="password"]',
    }),
  ).toHaveProperty("value", "");
  expect(screen.getByRole("radio", { name: "Operator OAuth" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.queryByText("App Scopes")).toBeNull();
  await enterCredentials();
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Algolia" }),
  );
  expect(controller.configure).toHaveBeenCalledWith({
    method: "api-key",
    displayName: "Algolia",
    icon: "",
    parameters: { application_id: "app-human" },
    credentials: { key: "private-human-key" },
    requestedScopes: {},
    targetIds: {},
  });
  expect(onChanged).not.toHaveBeenCalled();
  expect(onFlash).not.toHaveBeenCalled();
  expect(
    screen.getByLabelText("Algolia API key", {
      selector: 'input[type="password"]',
    }),
  ).toHaveProperty("value", "private-human-key");
  finish?.(nativeUiView());
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  expect(
    screen.getByLabelText("Algolia API key", {
      selector: 'input[type="password"]',
    }),
  ).toHaveProperty("value", "");
  expect(onFlash).toHaveBeenCalledWith({
    tone: "ok",
    text: "Algolia access verified and saved on this device.",
  });
});

it("retains entered credentials and refreshes recovery state after refusal without echoing secrets", async () => {
  const controller = nativeUiController();
  controller.configure.mockRejectedValue(
    new Error("Provider refused private-human-key"),
  );
  const onChanged = vi.fn();
  const onFlash = vi.fn();
  const rendered = render(
    <NativeConnectorForm
      descriptor={nativeUiDescriptor()}
      controller={controller}
      onChanged={onChanged}
      onFlash={onFlash}
    />,
  );
  await enterCredentials();
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Algolia" }),
  );
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  expect(
    screen.getByLabelText("Algolia API key", {
      selector: 'input[type="password"]',
    }),
  ).toHaveProperty("value", "private-human-key");
  expect(rendered.container.textContent).not.toContain("private-human-key");
  expect(onFlash).toHaveBeenCalledWith({
    tone: "err",
    text: "Provider refused [credential removed]",
  });
});

it("does not turn a stored configuration into successful authorization", async () => {
  const view = nativeUiView();
  view.status = "configuration";
  view.verifiedAt = null;
  const controller = nativeUiController(view);
  const onFlash = vi.fn();
  render(
    <NativeConnectorForm
      descriptor={nativeUiDescriptor()}
      controller={controller}
      onChanged={vi.fn()}
      onFlash={onFlash}
    />,
  );
  await enterCredentials();
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Algolia" }),
  );
  await waitFor(() =>
    expect(onFlash).toHaveBeenCalledWith({
      tone: "warn",
      text: "Algolia authorization is incomplete.",
    }),
  );
  expect(
    screen.getByLabelText("Algolia API key", {
      selector: 'input[type="password"]',
    }),
  ).toHaveProperty("value", "private-human-key");
});

it("keeps unavailable native routes disabled instead of offering invented OAuth fields", () => {
  const descriptor = nativeUiDescriptor();
  descriptor.methods = descriptor.methods.map((method) => ({
    ...method,
    available: false,
    unavailableReason: "No configured runtime for this method.",
  }));
  const controller = nativeUiController();
  render(
    <NativeConnectorForm
      descriptor={descriptor}
      controller={controller}
      onChanged={vi.fn()}
      onFlash={vi.fn()}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Verify and connect Algolia" }),
  ).toBeNull();
  expect(
    screen.getByRole("img", {
      name: "Algolia has no supported browser connection method.",
    }),
  ).toBeTruthy();
  expect(
    screen.queryByLabelText("Algolia API key", {
      selector: 'input[type="password"]',
    }),
  ).toBeNull();
  expect(controller.configure).not.toHaveBeenCalled();
});

it("does not load a saved secret into an editable field", () => {
  const view = nativeUiView();
  view.configuration.parameters.key = "malformed-public-secret";
  render(
    <NativeConnectorForm
      descriptor={nativeUiDescriptor()}
      controller={nativeUiController()}
      view={view}
      onChanged={vi.fn()}
      onFlash={vi.fn()}
    />,
  );
  expect(
    screen.getByLabelText("Algolia API key", {
      selector: 'input[type="password"]',
    }),
  ).toHaveProperty("value", "");
  expect(screen.getByLabelText("Algolia application ID")).toHaveProperty(
    "value",
    "app-1",
  );
});
