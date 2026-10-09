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

it("allows a verified name edit with blank primary and secondary credentials, without loading them", async () => {
  const view = nativeUiView();
  const descriptor = nativeUiDescriptor();
  descriptor.methods = [
    {
      ...descriptor.methods[0],
      fields: [
        ...descriptor.methods[0].fields,
        {
          id: "secondary",
          label: "Secondary credential",
          kind: "text",
          secret: true,
          required: true,
        },
      ],
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
  expect(
    screen.getByLabelText("Algolia API key", {
      selector: 'input[type="password"]',
    }),
  ).toHaveProperty("value", "");
  expect(screen.getByLabelText("Secondary credential")).toHaveProperty(
    "value",
    "",
  );
  expect(
    screen.getAllByRole("img", {
      name: "Leave blank to keep the saved credential.",
    }),
  ).toHaveLength(2);
  await userEvent.clear(screen.getByLabelText("Connector name"));
  await userEvent.type(
    screen.getByLabelText("Connector name"),
    "Renamed verified connector",
  );
  const submit = screen.getByRole("button", {
    name: "Verify and connect Algolia",
  });
  expect(submit).toHaveProperty("disabled", false);
  await userEvent.click(submit);
  await waitFor(() => expect(controller.configure).toHaveBeenCalledOnce());
  expect(controller.configure.mock.calls[0]?.[0].credentials).toEqual({
    key: "",
    secondary: "",
  });
  expect(controller.configure.mock.calls[0]?.[0].displayName).toBe(
    "Renamed verified connector",
  );
});

it("requires a new private credential after a public application binding changes", async () => {
  const view = nativeUiView();
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
  await userEvent.clear(screen.getByLabelText("Algolia application ID"));
  await userEvent.type(
    screen.getByLabelText("Algolia application ID"),
    "different-application",
  );
  const submit = screen.getByRole("button", {
    name: "Verify and connect Algolia",
  });
  expect(submit).toHaveProperty("disabled", true);
  expect(
    screen.queryByRole("img", {
      name: "Leave blank to keep the saved credential.",
    }),
  ).toBeNull();
  await userEvent.click(submit);
  expect(controller.configure).not.toHaveBeenCalled();
  await userEvent.type(
    screen.getByLabelText("Algolia API key", {
      selector: 'input[type="password"]',
    }),
    "fresh-private-key",
  );
  await userEvent.click(submit);
  await waitFor(() => expect(controller.configure).toHaveBeenCalledOnce());
  expect(controller.configure.mock.calls[0]?.[0].credentials).toEqual({
    key: "fresh-private-key",
  });
});

it.each(["configuration", "reauthorize", "cleanup"] as const)(
  "does not offer credential retention for an unverified %s record",
  (status) => {
    const view = nativeUiView();
    view.status = status;
    view.verifiedAt = null;
    render(
      <NativeConnectorForm
        descriptor={nativeUiDescriptor()}
        view={view}
        controller={nativeUiController(view)}
        onChanged={vi.fn()}
        onFlash={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("img", {
        name: "Leave blank to keep the saved credential.",
      }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Verify and connect Algolia" }),
    ).toHaveProperty("disabled", true);
  },
);
