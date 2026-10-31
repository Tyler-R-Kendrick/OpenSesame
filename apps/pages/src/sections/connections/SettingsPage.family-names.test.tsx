/** @vitest-environment jsdom */
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { mergeVercelCatalog } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { connectionRouteProvider } from "@opensesame/app-core/sections/connections/provider-route.js";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorSettingsPage } from "./SettingsPage.js";
import { installConnectorIntegration } from "./connect/native-connector-integration.test-support.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

afterEach(cleanup);
declareConnectionsTutorial();
installConnectorIntegration();

/** The rows Connections draws (ConnectionsSection's catalog). */
const providers = mergeVercelCatalog(getBundledProviders());

/** The page a route opens, drawn the way ConnectionsSection draws it. */
function draw(route: string) {
  const row = connectionRouteProvider(providers, route);
  if (!row) throw new Error(`${route} opens no page`);
  render(
    <MemoryRouter initialEntries={[`/connections/${route}`]}>
      <ConnectorSettingsPage
        provider={row}
        providers={providers}
        providerId={route}
        connection={null}
        connections={[]}
        loading={false}
        online
        canConfigure
        configureHint=""
        flash={null}
        rememberOffer={null}
        onFlash={vi.fn()}
        onRememberOffer={vi.fn()}
        onChanged={vi.fn()}
      />
    </MemoryRouter>,
  );
}

function optionLabels(name: string) {
  return within(screen.getByRole("combobox", { name }))
    .getAllByRole("option")
    .map((option) => option.textContent);
}

describe("a provider family's API select", () => {
  it("names Google Drive as the catalog does, on the Google page", () => {
    draw("google");
    expect(optionLabels("Google API")).toEqual([
      "Google",
      "Google Drive",
      "Google Gemini",
      "Google Vertex AI",
      "Google Wallet",
    ]);
  });

  it("names Microsoft 365 as the catalog does, on the Microsoft page", () => {
    draw("microsoft");
    expect(optionLabels("Microsoft API")).toEqual([
      "Microsoft",
      "Microsoft 365",
      "Microsoft Teams",
    ]);
  });

  it("is one control a screen reader can tell apart from a model form's on the same page", () => {
    // Vercel AI Gateway is a model provider in the Vercel family: its page
    // draws the family's select and the model connection form together.
    draw("vercel-ai-gateway");
    const labels = new Map(
      [...document.querySelectorAll("label")].map((label) => [
        label.htmlFor,
        label.textContent,
      ]),
    );
    const names = screen
      .getAllByRole("combobox")
      .map((box) => box.getAttribute("aria-label") ?? labels.get(box.id));
    expect(names).toContain("Vercel API");
    expect(new Set(names).size).toBe(names.length);
  });
});
