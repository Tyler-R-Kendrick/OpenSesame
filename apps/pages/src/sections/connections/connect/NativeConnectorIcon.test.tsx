/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { NativeConnectorForm } from "./NativeConnectorForm.js";
import {
  nativeUiController,
  nativeUiDescriptor,
  nativeUiView,
} from "./native-connector-ui.test-support.js";
import { nativeDeviceProviderDescriptor } from "./native-device-provider-descriptor.js";

afterEach(cleanup);

it("retains the local icon as metadata and sends an explicit removal on the next verified save", async () => {
  const view = nativeUiView();
  view.configuration.icon = "data:image/png;base64,aWNvbg==";
  const controller = nativeUiController(view);
  render(
    <NativeConnectorForm
      descriptor={nativeUiDescriptor()}
      controller={controller}
      view={view}
      onChanged={vi.fn()}
      onFlash={vi.fn()}
    />,
  );
  expect(
    screen.getByRole("img", { name: "Connector icon" }).getAttribute("src"),
  ).toBe(view.configuration.icon);
  await userEvent.type(
    screen.getByLabelText("Algolia API key", {
      selector: 'input[type="password"]',
    }),
    "private-entered-key",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Algolia" }),
  );
  await waitFor(() => expect(controller.configure).toHaveBeenCalledOnce());
  expect(controller.configure.mock.calls[0]?.[0].icon).toBe(
    view.configuration.icon,
  );
  await userEvent.click(screen.getByRole("button", { name: "Remove icon" }));
  expect(screen.queryByRole("img", { name: "Connector icon" })).toBeNull();
  await userEvent.type(
    screen.getByLabelText("Algolia API key", {
      selector: 'input[type="password"]',
    }),
    "private-entered-key",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Algolia" }),
  );
  await waitFor(() => expect(controller.configure).toHaveBeenCalledTimes(2));
  expect(controller.configure.mock.calls[1]?.[0].icon).toBe("");
});

it("uses shared image validation without saving an oversized file or exposing credentials", async () => {
  const controller = nativeUiController();
  render(
    <NativeConnectorForm
      descriptor={nativeUiDescriptor()}
      controller={controller}
      view={nativeUiView()}
      onChanged={vi.fn()}
      onFlash={vi.fn()}
    />,
  );
  await userEvent.click(
    screen.getByText("Appearance", { selector: "summary" }),
  );
  await userEvent.upload(
    screen.getByLabelText("Icon"),
    new File([new Uint8Array(2 * 1024 * 1024 + 1)], "too-large.png", {
      type: "image/png",
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("img", { name: "The icon must be at most 2 MB." }),
    ).toBeTruthy(),
  );
  expect(screen.queryByRole("img", { name: "Connector icon" })).toBeNull();
  expect(controller.configure).not.toHaveBeenCalled();
});

it("offers the real vault import destination for a companion without a false Connect action", () => {
  const descriptor = nativeDeviceProviderDescriptor("keepass", {
    has: () => false,
  });
  expect(descriptor).not.toBeNull();
  if (!descriptor) throw new Error("KeePass catalog descriptor missing");
  render(
    <MemoryRouter>
      <NativeConnectorForm
        descriptor={descriptor}
        controller={nativeUiController()}
        onChanged={vi.fn()}
        onFlash={vi.fn()}
      />
    </MemoryRouter>,
  );
  expect(
    screen
      .getByRole("link", { name: "Open Vault to import a supported export" })
      .getAttribute("href"),
  ).toBe("/vault?f=all");
  expect(
    screen.queryByRole("button", { name: /Verify and connect/ }),
  ).toBeNull();
  expect(screen.getByText(/Imported items are a local snapshot/)).toBeTruthy();
  expect(screen.queryByLabelText("Icon")).toBeNull();
});
