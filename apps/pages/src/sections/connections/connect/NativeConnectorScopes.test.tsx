/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigSelections } from "./ConfigSelections.js";
import { NativeConnectorForm } from "./NativeConnectorForm.js";
import {
  nativeUiController,
  nativeUiDescriptor,
  nativeUiView,
} from "./native-connector-ui.test-support.js";

afterEach(cleanup);

it("keeps mandatory account-verification permissions selected while allowing optional scopes to change", async () => {
  const descriptor = nativeUiDescriptor();
  descriptor.methods = [
    {
      id: "oauth",
      label: "Public browser application",
      available: true,
      fields: [
        {
          id: "client_id",
          label: "Public client ID",
          kind: "text",
          required: true,
          secret: false,
        },
      ],
      scopeGroups: [
        {
          actor: "user",
          label: "User permissions",
          requiredScopes: ["account.read"],
          choices: [
            {
              name: "account.read",
              description: "Verify the account",
              default: false,
            },
            {
              name: "items.read",
              description: "Optional item access",
              default: true,
            },
          ],
        },
      ],
    },
  ];
  const view = nativeUiView();
  view.configuration.method = "oauth";
  view.configuration.clientId = "public-client";
  view.configuration.requestedScopes = {
    user: ["items.read"],
    unrelated: ["unlisted"],
  };
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
  await userEvent.click(
    screen.getByLabelText("User permissions", { selector: "summary" }),
  );
  const required = screen.getByRole("checkbox", {
    name: "account.read (required)",
  });
  expect(required).toHaveProperty("checked", true);
  expect(required).toHaveProperty("disabled", true);
  await userEvent.click(required);
  await userEvent.click(screen.getByRole("checkbox", { name: "items.read" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Algolia" }),
  );
  await waitFor(() => expect(controller.configure).toHaveBeenCalledOnce());
  expect(controller.configure.mock.calls[0]?.[0].requestedScopes).toEqual({
    user: ["account.read"],
  });
});

it("does not change existing configurable selection controls when required choices are absent", async () => {
  const onChange = vi.fn();
  render(
    <ConfigSelections
      label="App Scopes"
      selected={["read"]}
      choices={[{ name: "read", description: "Read workspace", default: true }]}
      onChange={onChange}
    />,
  );
  await userEvent.click(
    screen.getByLabelText("App Scopes", { selector: "summary" }),
  );
  const choice = screen.getByRole("checkbox", { name: "read" });
  expect(choice).toHaveProperty("disabled", false);
  await userEvent.click(choice);
  expect(onChange).toHaveBeenCalledWith([]);
});

it("shows callback registration metadata without sending it as a provider parameter", async () => {
  const descriptor = nativeUiDescriptor();
  descriptor.methods = [
    {
      id: "oauth",
      label: "Public OAuth",
      available: true,
      fields: [
        {
          id: "client_id",
          label: "Public client ID",
          kind: "text",
          secret: false,
          required: true,
        },
        {
          id: "redirect_uri",
          label: "OAuth callback URL",
          kind: "url",
          secret: false,
          required: false,
          readOnly: true,
          displayOnly: true,
          defaultValue: "https://app.example/connect/callback",
        },
        {
          id: "instance_url",
          label: "Pinned provider origin",
          kind: "url",
          secret: false,
          required: false,
          readOnly: true,
          defaultValue: "https://gitlab.com",
        },
      ],
      scopeGroups: [],
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
  expect(screen.getByLabelText("OAuth callback URL")).toHaveProperty(
    "readOnly",
    true,
  );
  await userEvent.type(
    screen.getByLabelText("Public client ID"),
    "browser-app",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Sign in to Algolia" }),
  );
  await waitFor(() => expect(controller.configure).toHaveBeenCalledOnce());
  expect(controller.configure.mock.calls[0]?.[0].parameters).toEqual({
    client_id: "browser-app",
    instance_url: "https://gitlab.com",
  });
  expect(controller.configure.mock.calls[0]?.[0].credentials).toEqual({});
});
