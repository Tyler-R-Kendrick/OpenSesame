/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { NativeConnectorActions } from "./NativeConnectorActions.js";
import { NativeConnectorSummary } from "./NativeConnectorSummary.js";
import type { SafeActionResult } from "./native-connector-ui.js";
import {
  nativeUiController,
  nativeUiDescriptor,
  nativeUiView,
} from "./native-connector-ui.test-support.js";

afterEach(cleanup);
it("retains a selected resource for repeat reads, clears only secret inputs, and masks every fresh secret result", async () => {
  const view = nativeUiView();
  const controller = nativeUiController(view);
  controller.invoke.mockResolvedValue({
    label: "Secret returned",
    items: [
      {
        id: "password",
        label: "Password",
        secretValue: "ephemeral-secret-value",
      },
    ],
  });
  const descriptor = nativeUiDescriptor();
  descriptor.actions = [
    {
      id: "provider.secret.read",
      label: "Read secret",
      available: true,
      fields: [
        {
          id: "mount",
          label: "KV mount",
          kind: "text",
          secret: false,
          required: true,
          defaultValue: "secret",
        },
        {
          id: "path",
          label: "Secret path",
          kind: "text",
          secret: false,
          required: true,
        },
        {
          id: "proof",
          label: "One-use proof",
          kind: "text",
          secret: true,
          required: false,
        },
      ],
      resultOrigins: [],
    },
  ];
  const rendered = render(
    <NativeConnectorSummary
      descriptor={descriptor}
      controller={controller}
      view={view}
      onFlash={vi.fn()}
      onChanged={vi.fn()}
      onRemoved={vi.fn()}
    />,
  );
  await userEvent.click(
    screen.getByText("Read secret", { selector: "summary" }),
  );
  await userEvent.type(
    screen.getByLabelText("Secret path"),
    "application/database",
  );
  await userEvent.type(screen.getByLabelText("One-use proof"), "private-once");
  await userEvent.click(screen.getByRole("button", { name: "Read secret" }));
  await screen.findByRole("button", { name: "Reveal Password" });
  expect(controller.invoke).toHaveBeenCalledWith(
    "provider.secret.read",
    {
      mount: "secret",
      path: "application/database",
      proof: "private-once",
    },
    expect.any(AbortSignal),
  );
  expect(screen.getByLabelText("Secret path")).toHaveProperty(
    "value",
    "application/database",
  );
  expect(screen.getByLabelText("KV mount")).toHaveProperty("value", "secret");
  expect(screen.getByLabelText("One-use proof")).toHaveProperty("value", "");
  expect(rendered.container.textContent).not.toContain(
    "ephemeral-secret-value",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Reveal Password" }),
  );
  expect(rendered.container.textContent).toContain("ephemeral-secret-value");
  await userEvent.click(screen.getByRole("button", { name: "Read secret" }));
  await screen.findByRole("button", { name: "Reveal Password" });
  expect(controller.invoke).toHaveBeenLastCalledWith(
    "provider.secret.read",
    {
      mount: "secret",
      path: "application/database",
      proof: "",
    },
    expect.any(AbortSignal),
  );
  expect(rendered.container.textContent).not.toContain(
    "ephemeral-secret-value",
  );
  expect(screen.getByRole("button", { name: "Reveal Password" })).toBeTruthy();
});

it.each([
  "controller",
  "disabled",
  "connection",
  "revision",
  "provider",
  "unmount",
])(
  "ends the actual caller on %s and ignores an uncancellable late result",
  async (replacement) => {
    const view = nativeUiView();
    const descriptor = nativeUiDescriptor();
    const controller = nativeUiController(view);
    let finish: (value: SafeActionResult) => void = () => {};
    controller.invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const props = {
      descriptor,
      view,
      controller,
      disabled: false,
      onFlash: vi.fn(),
      onChanged: vi.fn(),
    };
    const ui = render(<NativeConnectorActions {...props} />);
    await userEvent.click(
      screen.getByText("Read Algolia indexes", { selector: "summary" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Read Algolia indexes" }),
    );
    const signal = controller.invoke.mock.calls[0]?.[2];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    if (replacement === "unmount") ui.unmount();
    else
      ui.rerender(
        <NativeConnectorActions
          {...props}
          controller={
            replacement === "controller" ? nativeUiController(view) : controller
          }
          disabled={replacement === "disabled"}
          descriptor={
            replacement === "provider"
              ? { ...descriptor, providerId: "other-provider" }
              : descriptor
          }
          view={{
            ...view,
            connectionId:
              replacement === "connection"
                ? "another-connection"
                : view.connectionId,
            revision:
              replacement === "revision" ? view.revision + 1 : view.revision,
            providerId:
              replacement === "provider" ? "other-provider" : view.providerId,
          }}
        />,
      );
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      finish({
        label: "Late private result",
        items: [{ id: "late", label: "Private", secretValue: "late-secret" }],
      });
    });
    expect(props.onFlash).not.toHaveBeenCalled();
    expect(props.onChanged).not.toHaveBeenCalled();
    expect(controller.load).not.toHaveBeenCalled();
    expect(ui.container.textContent).not.toContain("Late private result");
    expect(ui.container.textContent).not.toContain("late-secret");
  },
);

it("reports an active provider error named AbortError rather than hiding it as owner withdrawal", async () => {
  const view = nativeUiView();
  const controller = nativeUiController(view);
  const error = new Error("The provider request failed while still active.");
  error.name = "AbortError";
  controller.invoke.mockRejectedValue(error);
  const onFlash = vi.fn();
  const onChanged = vi.fn();
  render(
    <NativeConnectorActions
      descriptor={nativeUiDescriptor()}
      view={view}
      controller={controller}
      onFlash={onFlash}
      onChanged={onChanged}
    />,
  );
  await userEvent.click(
    screen.getByText("Read Algolia indexes", { selector: "summary" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Read Algolia indexes" }),
  );
  expect(onFlash).toHaveBeenCalledExactlyOnceWith({
    tone: "err",
    text: error.message,
  });
  expect(onChanged).toHaveBeenCalledExactlyOnceWith(view);
});
