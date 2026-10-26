/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
  expect(screen.queryByRole("radio", { name: "Operator OAuth" })).toBeNull();
  expect(screen.queryByLabelText("Icon")).toBeNull();
  expect(screen.queryByLabelText("Connector name")).toBeNull();
  expect(screen.queryByText("App Scopes")).toBeNull();
  await enterCredentials();
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Algolia" }),
  );
  const owner = controller.configure.mock.calls[0]?.[0].owner;
  expect(owner?.signal).toBeInstanceOf(AbortSignal);
  expect(owner?.signal.aborted).toBe(false);
  expect(() => owner?.assertCurrent()).not.toThrow();
  expect(controller.configure).toHaveBeenCalledWith({
    owner,
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
  expect(owner?.signal.aborted).toBe(false);
  expect(() => owner?.assertCurrent()).toThrow("This configuration ended.");
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
      text: "Complete Algolia sign-in to connect.",
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

function configurableDescriptor(policy = false) {
  const descriptor = nativeUiDescriptor();
  descriptor.methods = descriptor.methods
    .filter((method) => method.id === "api-key")
    .map((method) => ({
      ...method,
      available: false,
      configurable: true,
      unavailableKind: policy ? ("policy" as const) : undefined,
    }));
  return descriptor;
}
it.each([false, true])(
  "opens only the compiled editor without admitting connection for saved=%s",
  async (saved) => {
    const controller = nativeUiController();
    const onChanged = vi.fn();
    const onFlash = vi.fn();
    const rendered = render(
      <NativeConnectorForm
        descriptor={configurableDescriptor()}
        controller={controller}
        view={saved ? nativeUiView() : undefined}
        onChanged={onChanged}
        onFlash={onFlash}
      />,
    );
    await enterCredentials();
    const connect = screen.getByRole("button", {
      name: "Verify and connect Algolia",
    });
    expect(connect).toHaveProperty("disabled", true);
    await userEvent.click(connect);
    const form = rendered.container.querySelector("form");
    if (!form) throw new Error("Actual compiled form missing");
    fireEvent.submit(form);
    expect(controller.configure).not.toHaveBeenCalled();
    expect(controller.connect).not.toHaveBeenCalled();
    expect(controller.authorize).not.toHaveBeenCalled();
    expect(controller.verify).not.toHaveBeenCalled();
    expect(controller.invoke).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(onFlash).not.toHaveBeenCalled();
  },
);
it("does not open a product-policy-refused editor even when configurable is present", () => {
  const controller = nativeUiController();
  render(
    <NativeConnectorForm
      descriptor={configurableDescriptor(true)}
      controller={controller}
      onChanged={vi.fn()}
      onFlash={vi.fn()}
    />,
  );
  expect(screen.queryByLabelText("Algolia application ID")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Verify and connect Algolia" }),
  ).toBeNull();
  expect(controller.configure).not.toHaveBeenCalled();
  expect(controller.connect).not.toHaveBeenCalled();
  expect(controller.invoke).not.toHaveBeenCalled();
});
it("switches configurable editors while both actual authorization routes remain unavailable", async () => {
  const descriptor = nativeUiDescriptor();
  for (const method of descriptor.methods) {
    method.available = false;
    method.configurable = true;
    if (method.id === "oauth")
      method.fields = [
        {
          id: "client_id",
          label: "Operator OAuth client ID",
          kind: "text",
          secret: false,
          required: true,
        },
      ];
  }
  const controller = nativeUiController();
  render(
    <NativeConnectorForm
      descriptor={descriptor}
      controller={controller}
      onChanged={vi.fn()}
      onFlash={vi.fn()}
    />,
  );
  expect(screen.getByLabelText("Operator OAuth client ID")).toBeTruthy();
  await userEvent.click(screen.getByRole("radio", { name: "Algolia API key" }));
  expect(screen.getByLabelText("Algolia application ID")).toBeTruthy();
  expect(screen.queryByLabelText("Operator OAuth client ID")).toBeNull();
  await enterCredentials();
  expect(
    screen.getByRole("button", { name: "Verify and connect Algolia" }),
  ).toHaveProperty("disabled", true);
  expect(controller.configure).not.toHaveBeenCalled();
  expect(controller.connect).not.toHaveBeenCalled();
  expect(controller.invoke).not.toHaveBeenCalled();
});
