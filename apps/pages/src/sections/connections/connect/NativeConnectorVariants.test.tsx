/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { NativeConnectorForm } from "./NativeConnectorForm.js";
import {
  nativeUiController,
  nativeUiDescriptor,
} from "./native-connector-ui.test-support.js";

afterEach(cleanup);

it("switches credential variants with one visible field contract and clears all prior credentials", async () => {
  const descriptor = nativeUiDescriptor();
  const method = descriptor.methods[0];
  method.fields = [
    {
      id: "variant",
      label: "Credential type",
      kind: "choice",
      secret: false,
      required: true,
      defaultValue: "admin",
      choices: [
        { id: "admin", label: "Admin key" },
        { id: "search", label: "Search key" },
      ],
    },
    {
      id: "key",
      label: "Algolia API key",
      kind: "text",
      required: true,
      secret: true,
    },
    {
      id: "application_id",
      label: "Admin application ID",
      kind: "text",
      required: true,
      secret: false,
      defaultValue: "admin-default",
      when: { fieldId: "variant", value: "admin" },
    },
    {
      id: "application_id",
      label: "Search application ID",
      kind: "text",
      required: true,
      secret: false,
      defaultValue: "search-default",
      when: { fieldId: "variant", value: "search" },
    },
    {
      id: "admin_secret",
      label: "Admin secondary secret",
      kind: "text",
      required: true,
      secret: true,
      when: { fieldId: "variant", value: "admin" },
    },
    {
      id: "search_region",
      label: "Search region",
      kind: "text",
      required: true,
      secret: false,
      when: { fieldId: "variant", value: "search" },
    },
  ];
  const controller = nativeUiController();
  render(
    <NativeConnectorForm
      descriptor={descriptor}
      controller={controller}
      onChanged={vi.fn()}
      onFlash={vi.fn()}
    />,
  );
  expect(screen.getByLabelText("Admin application ID")).toHaveProperty(
    "value",
    "admin-default",
  );
  await userEvent.type(
    screen.getByLabelText("Algolia API key", {
      selector: 'input[type="password"]',
    }),
    "private-admin-key",
  );
  await userEvent.type(
    screen.getByLabelText("Admin secondary secret"),
    "private-admin-secondary",
  );
  await userEvent.selectOptions(
    screen.getByLabelText("Credential type"),
    "search",
  );
  expect(screen.queryByLabelText("Admin secondary secret")).toBeNull();
  expect(
    screen.getByLabelText("Algolia API key", {
      selector: 'input[type="password"]',
    }),
  ).toHaveProperty("value", "");
  expect(
    screen.getByRole("button", { name: "Verify and connect Algolia" }),
  ).toHaveProperty("disabled", true);
  await userEvent.type(
    screen.getByLabelText("Algolia API key", {
      selector: 'input[type="password"]',
    }),
    "private-search-key",
  );
  await userEvent.type(screen.getByLabelText("Search region"), "eu");
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Algolia" }),
  );
  await waitFor(() => expect(controller.configure).toHaveBeenCalledOnce());
  const sent = controller.configure.mock.calls[0]?.[0];
  expect(sent?.credentials).toEqual({ key: "private-search-key" });
  expect(sent?.parameters).toEqual({
    variant: "search",
    application_id: "search-default",
    search_region: "eu",
  });
  expect(JSON.stringify(sent)).not.toContain("private-admin");
});

it("clears prior credentials on a variant switch and sends only visible required slots", async () => {
  const descriptor = nativeUiDescriptor();
  descriptor.methods = [
    {
      ...descriptor.methods[0],
      fields: [
        {
          id: "credentialVariant",
          label: "Algolia credential type",
          kind: "choice",
          secret: false,
          required: true,
          defaultValue: "key",
          choices: [
            { id: "key", label: "API key" },
            { id: "basic", label: "Basic credentials" },
          ],
        },
        {
          id: "key",
          label: "Algolia API key",
          kind: "text",
          secret: true,
          required: true,
          when: { fieldId: "credentialVariant", value: "key" },
        },
        {
          id: "username",
          label: "Provider username",
          kind: "text",
          secret: false,
          required: true,
          when: { fieldId: "credentialVariant", value: "basic" },
        },
        {
          id: "password",
          label: "Provider password",
          kind: "text",
          secret: true,
          required: true,
          when: { fieldId: "credentialVariant", value: "basic" },
        },
      ],
    },
  ];
  const controller = nativeUiController();
  render(
    <NativeConnectorForm
      descriptor={descriptor}
      controller={controller}
      onChanged={vi.fn()}
      onFlash={vi.fn()}
    />,
  );
  await userEvent.type(
    screen.getByLabelText("Algolia API key", {
      selector: 'input[type="password"]',
    }),
    "old-private-key",
  );
  await userEvent.selectOptions(
    screen.getByLabelText("Algolia credential type"),
    "basic",
  );
  expect(
    screen.queryByLabelText("Algolia API key", {
      selector: 'input[type="password"]',
    }),
  ).toBeNull();
  expect(screen.getByLabelText("Provider password")).toHaveProperty(
    "value",
    "",
  );
  expect(
    screen.getByRole("button", { name: "Verify and connect Algolia" }),
  ).toHaveProperty("disabled", true);
  await userEvent.type(screen.getByLabelText("Provider username"), "person");
  await userEvent.type(
    screen.getByLabelText("Provider password"),
    "new-private-password",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Algolia" }),
  );
  await waitFor(() => expect(controller.configure).toHaveBeenCalledOnce());
  expect(controller.configure).toHaveBeenCalledWith(
    expect.objectContaining({
      parameters: { credentialVariant: "basic", username: "person" },
      credentials: { password: "new-private-password" },
    }),
  );
  await userEvent.selectOptions(
    screen.getByLabelText("Algolia credential type"),
    "key",
  );
  expect(
    screen.getByLabelText("Algolia API key", {
      selector: 'input[type="password"]',
    }),
  ).toHaveProperty("value", "");
});
