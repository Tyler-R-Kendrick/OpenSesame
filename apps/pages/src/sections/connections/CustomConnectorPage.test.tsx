/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createCustomProvider = vi.hoisted(() => vi.fn());

import { connectionSeams } from "../../lib/connections.js";
import { identitySeams } from "../../lib/identity.js";
import { useOnlineSeams } from "../../lib/use-online.js";
import { CustomConnectorPage, slugify } from "./CustomConnectorPage.js";

const originalConnectionSeams = { ...connectionSeams };
const originalIdentitySeams = { ...identitySeams };
const originalUseOnlineSeams = { ...useOnlineSeams };

beforeEach(() => {
  Object.assign(connectionSeams, { createCustomProvider });
  Object.assign(identitySeams, { hostBase: () => "http://127.0.0.1:8787" });
  Object.assign(useOnlineSeams, { useOnline: () => true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  Object.assign(connectionSeams, originalConnectionSeams);
  Object.assign(identitySeams, originalIdentitySeams);
  Object.assign(useOnlineSeams, originalUseOnlineSeams);
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/connections/new"]}>
      <Routes>
        <Route path="/connections/new" element={<CustomConnectorPage />} />
        <Route
          path="/connections/:providerId"
          element={<p>connector page</p>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("slugify", () => {
  it("derives a custom- id from the display name", () => {
    expect(slugify("Acme MCP")).toBe("custom-acme-mcp");
    expect(slugify("  ")).toBe("");
    expect(slugify("Ünïcode! Server")).toBe("custom-n-code-server");
  });
});

describe("CustomConnectorPage", () => {
  it("creates an OAuth custom connector and opens its page", async () => {
    createCustomProvider.mockResolvedValue({ id: "custom-acme-mcp" });
    renderPage();
    await userEvent.type(screen.getByLabelText("Name"), "Acme MCP");
    await userEvent.type(
      screen.getByLabelText("Base URL"),
      "https://mcp.acme.dev",
    );
    await userEvent.type(
      screen.getByLabelText("Authorization URL"),
      "https://mcp.acme.dev/oauth/authorize",
    );
    await userEvent.type(
      screen.getByLabelText("Token URL"),
      "https://mcp.acme.dev/oauth/token",
    );
    await userEvent.type(
      screen.getByLabelText("Scopes"),
      "tools:read tools:invoke",
    );
    // The provider's app registration needs this exact redirect URL.
    expect(screen.getByText(/oauth\/callback\/custom-acme-mcp/)).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Create connector/i }),
    );
    await waitFor(() =>
      expect(createCustomProvider).toHaveBeenCalledWith({
        id: "custom-acme-mcp",
        displayName: "Acme MCP",
        baseUrl: "https://mcp.acme.dev",
        auth: {
          kind: "oauth2_authorization_code",
          authorizeUrl: "https://mcp.acme.dev/oauth/authorize",
          tokenUrl: "https://mcp.acme.dev/oauth/token",
          supportsRefresh: true,
          scopes: ["tools:read", "tools:invoke"],
        },
      }),
    );
    expect(await screen.findByText("connector page")).toBeTruthy();
  });

  it("creates an API-key custom connector", async () => {
    createCustomProvider.mockResolvedValue({ id: "custom-internal-api" });
    renderPage();
    await userEvent.type(screen.getByLabelText("Name"), "Internal API");
    await userEvent.type(
      screen.getByLabelText("Base URL"),
      "https://api.internal.dev",
    );
    await userEvent.click(screen.getByRole("radio", { name: /API key/i }));
    await userEvent.click(
      screen.getByRole("button", { name: /Create connector/i }),
    );
    await waitFor(() =>
      expect(createCustomProvider).toHaveBeenCalledWith({
        id: "custom-internal-api",
        displayName: "Internal API",
        baseUrl: "https://api.internal.dev",
        auth: {
          kind: "api_key",
          header: "Authorization",
          valuePrefix: "Bearer ",
        },
      }),
    );
  });

  it("surfaces a create failure without navigating", async () => {
    createCustomProvider.mockRejectedValue(new Error("id collides"));
    renderPage();
    await userEvent.type(screen.getByLabelText("Name"), "Internal API");
    await userEvent.type(
      screen.getByLabelText("Base URL"),
      "https://api.internal.dev",
    );
    await userEvent.click(screen.getByRole("radio", { name: /API key/i }));
    await userEvent.click(
      screen.getByRole("button", { name: /Create connector/i }),
    );
    expect(await screen.findByText(/id collides/)).toBeTruthy();
    expect(screen.queryByText("connector page")).toBeNull();
  });
});
