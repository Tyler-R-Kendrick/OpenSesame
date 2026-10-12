/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { NativeConnectorSummary } from "./NativeConnectorSummary.js";
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
  expect(controller.invoke).toHaveBeenCalledWith("provider.secret.read", {
    mount: "secret",
    path: "application/database",
    proof: "private-once",
  });
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
  expect(controller.invoke).toHaveBeenLastCalledWith("provider.secret.read", {
    mount: "secret",
    path: "application/database",
    proof: "",
  });
  expect(rendered.container.textContent).not.toContain(
    "ephemeral-secret-value",
  );
  expect(screen.getByRole("button", { name: "Reveal Password" })).toBeTruthy();
});
