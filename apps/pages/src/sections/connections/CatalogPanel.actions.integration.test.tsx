/** @vitest-environment jsdom */
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { mergeVercelCatalog } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { connectionRouteProvider } from "@opensesame/app-core/sections/connections/provider-route.js";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { CatalogPanel } from "./CatalogPanel.js";
import { API_FAMILIES, apiFamilyFor } from "./catalog-families.js";
import {
  connectorIntegration,
  installConnectorIntegration,
  integrationProvider,
} from "./connect/native-connector-integration.test-support.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

declareConnectionsTutorial();
installConnectorIntegration();

it("offers actual configuration routes for compiled API protocols despite hosted CORS history", () => {
  connectorIntegration();
  render(
    <MemoryRouter>
      <CatalogPanel
        providers={[
          integrationProvider("linear"),
          integrationProvider("openai"),
        ]}
      />
    </MemoryRouter>,
  );
  expect(
    screen.getByRole("link", { name: "Connect Linear" }).getAttribute("href"),
  ).toBe("/connections/linear");
  expect(
    screen.getByRole("link", { name: "Connect OpenAI" }).getAttribute("href"),
  ).toBe("/connections/openai");
  expect(
    screen.queryByRole("img", { name: "Provider blocks browsers" }),
  ).toBeNull();
  expect(
    screen.queryByRole("img", { name: "Desktop app required" }),
  ).toBeNull();
});

/**
 * A family tile links to the page of a row its family holds, whose "API
 * family" select reaches the rest (SettingsPage.family.test.tsx).
 */
it("opens each family's tile on a page its route draws, in that family", () => {
  connectorIntegration();
  const providers = mergeVercelCatalog(getBundledProviders());
  render(
    <MemoryRouter>
      <CatalogPanel providers={providers} />
    </MemoryRouter>,
  );
  for (const family of API_FAMILIES) {
    const href = document
      .getElementById(`catalog-${encodeURIComponent(family.id)}`)
      ?.querySelector("a")
      ?.getAttribute("href");
    expect(href, family.id).toBeTruthy();
    const route = decodeURIComponent(href?.split("/").pop() ?? "");
    const page = connectionRouteProvider(providers, route);
    expect(page, `${family.id} opens ${route}`).not.toBeNull();
    expect(apiFamilyFor(page?.id ?? "")?.id, route).toBe(family.id);
  }
});
