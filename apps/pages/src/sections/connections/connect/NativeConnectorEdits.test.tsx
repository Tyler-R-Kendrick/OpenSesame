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

it("locks the method of a saved connection until its existing removal finishes", async () => {
  const view = nativeUiView();
  const descriptor = nativeUiDescriptor();
  descriptor.methods = descriptor.methods.map((method) => ({
    ...method,
    available: true,
  }));
  const controller = nativeUiController(view);
  render(
    <NativeConnectorForm
      descriptor={descriptor}
      view={view}
      controller={controller}
      onChanged={vi.fn()}
      onFlash={vi.fn()}
    />,
  );
  const selected = screen.getByRole("radio", {
    name: "Algolia API key",
  });
  const alternate = screen.getByRole("radio", {
    name: "Operator OAuth",
  });
  expect(selected).toHaveProperty("checked", true);
  expect(selected).toHaveProperty("disabled", true);
  expect(alternate).toHaveProperty("disabled", true);
  await userEvent.click(alternate);
  expect(selected).toHaveProperty("checked", true);
  expect(
    screen.getByRole("img", {
      name: /This connection stays saved until removal completes/,
    }),
  ).toBeTruthy();
  await userEvent.type(
    screen.getByLabelText("Algolia API key", {
      selector: 'input[type="password"]',
    }),
    "new-private-key",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Algolia" }),
  );
  await waitFor(() => expect(controller.configure).toHaveBeenCalledOnce());
  expect(controller.configure.mock.calls[0]?.[0].method).toBe("api-key");
  expect(controller.remove).not.toHaveBeenCalled();
});

it("does not switch a saved unavailable method into a different available driver", () => {
  const view = nativeUiView();
  view.configuration.method = "mcp";
  const controller = nativeUiController(view);
  render(
    <NativeConnectorForm
      descriptor={nativeUiDescriptor()}
      view={view}
      controller={controller}
      onChanged={vi.fn()}
      onFlash={vi.fn()}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Verify and connect Algolia" }),
  ).toBeNull();
  expect(screen.getByRole("radio", { name: "Algolia API key" })).toHaveProperty(
    "checked",
    false,
  );
  expect(screen.getByRole("radio", { name: "Algolia API key" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(controller.configure).not.toHaveBeenCalled();
});

it("initializes the saved public OAuth client ID from its dedicated configuration field", async () => {
  const view = nativeUiView();
  view.configuration.method = "oauth";
  view.configuration.clientId = "saved-public-client";
  view.configuration.parameters = { client_id: "outdated-parameter" };
  const descriptor = nativeUiDescriptor();
  descriptor.methods = [
    {
      id: "oauth",
      label: "Public browser OAuth",
      available: true,
      fields: [
        {
          id: "client_id",
          label: "Public client ID",
          kind: "text",
          secret: false,
          required: true,
        },
      ],
      scopeGroups: [],
    },
  ];
  const controller = nativeUiController(view);
  render(
    <NativeConnectorForm
      descriptor={descriptor}
      view={view}
      controller={controller}
      onChanged={vi.fn()}
      onFlash={vi.fn()}
    />,
  );
  expect(screen.getByLabelText("Public client ID")).toHaveProperty(
    "value",
    "saved-public-client",
  );
  await userEvent.clear(screen.getByLabelText("Connector name"));
  await userEvent.type(
    screen.getByLabelText("Connector name"),
    "Renamed connection",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Algolia" }),
  );
  await waitFor(() => expect(controller.configure).toHaveBeenCalledOnce());
  expect(controller.configure.mock.calls[0]?.[0].parameters).toEqual({
    client_id: "saved-public-client",
  });
  expect(controller.configure.mock.calls[0]?.[0].displayName).toBe(
    "Renamed connection",
  );
});

it("renders an identity-only provider action result without inventing an empty resource count", async () => {
  const view = nativeUiView();
  const descriptor = nativeUiDescriptor();
  descriptor.actions = [
    {
      id: "provider.read",
      label: "Read verified access",
      available: true,
      fields: [],
      resultOrigins: [],
    },
  ];
  const controller = nativeUiController(view);
  controller.invoke.mockResolvedValue({
    label: "Restricted integration access verified",
    items: [],
  });
  const rendered = render(
    <NativeConnectorSummary
      descriptor={descriptor}
      view={view}
      controller={controller}
      onChanged={vi.fn()}
      onFlash={vi.fn()}
      onRemoved={vi.fn()}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Read verified access" }),
  );
  await waitFor(() =>
    expect(
      screen.getByText("Restricted integration access verified", {
        selector: "output",
      }),
    ).toBeTruthy(),
  );
  expect(rendered.container.textContent).not.toContain("none found");
  expect(controller.invoke).toHaveBeenCalledWith("provider.read", {});
});
