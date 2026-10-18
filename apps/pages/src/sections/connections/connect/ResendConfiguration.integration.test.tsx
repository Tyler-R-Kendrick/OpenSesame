/** @vitest-environment jsdom */
import { setVercelConnectAuth } from "@opensesame/app-core/lib/vercel-connect.js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { ConnectPanels } from "./ConnectPanels.js";
import {
  connectorIntegration,
  installConnectorIntegration,
  integrationProvider,
} from "./native-connector-integration.test-support.js";

installConnectorIntegration();

it("starts from the Resend preset and requires a key before API verification", async () => {
  setVercelConnectAuth(null);
  const runtime = connectorIntegration();
  render(
    <MemoryRouter>
      <ConnectPanels
        provider={integrationProvider("resend")}
        connection={null}
        online
        onFlash={vi.fn()}
        onChanged={vi.fn()}
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole("region", { name: "Connector" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Sign in to Resend" }),
  ).toBeTruthy();
  expect(screen.queryByLabelText("Connector name")).toBeNull();
  const apiKey = screen.getByRole("radio", { name: "API Key" });
  expect(apiKey).toHaveProperty("checked", false);
  expect(
    screen.getByText("Other sign-in methods", { selector: "summary" }),
  ).toBeTruthy();
  expect(screen.queryByLabelText("Resend API key")).toBeNull();
  await userEvent.click(apiKey);
  const credential = screen.getByLabelText("Resend API key");
  expect(credential).toHaveProperty("type", "password");
  expect(credential).toHaveProperty("value", "");
  const verify = screen.getByRole("button", {
    name: "Verify and connect Resend",
  });
  expect(verify).toHaveProperty("disabled", true);
  await userEvent.type(credential, "entered-only");
  expect(verify).toHaveProperty("disabled", false);
  expect(runtime.requests).toEqual([]);
  expect(screen.queryByLabelText("Relay management key")).toBeNull();
});
