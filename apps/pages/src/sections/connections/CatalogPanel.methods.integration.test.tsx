/** @vitest-environment jsdom */
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { mergeVercelCatalog } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it } from "vitest";
import {
  CatalogPanel,
  authKindLabel,
  catalogMethodLabel,
} from "./CatalogPanel.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";
declareConnectionsTutorial();
afterEach(cleanup);
it("shows Adobe's MCP contract on the actual catalog tile instead of its legacy OAuth type", () => {
  const providers = mergeVercelCatalog(getBundledProviders());
  render(
    <MemoryRouter>
      <CatalogPanel providers={providers} />
    </MemoryRouter>,
  );
  const adobe = document.getElementById("catalog-adobe");
  expect(adobe?.querySelector(".conn-tile__kind")?.textContent).toBe("MCP");
  expect(
    document
      .getElementById("catalog-datadog")
      ?.querySelector(".conn-tile__kind")?.textContent,
  ).toBe("API key (browser unavailable)");
  expect(connectPlan("adobe")?.methods.map((method) => method.kind)).toEqual([
    "mcp",
  ]);
});
it("uses compiled provider protocols across the full public catalog and keeps legacy feature labels", () => {
  for (const provider of mergeVercelCatalog(getBundledProviders())) {
    const plan = connectPlan(provider.id);
    if (!plan) {
      expect(catalogMethodLabel(provider)).toBe(authKindLabel(provider));
      continue;
    }
    const label = catalogMethodLabel(provider);
    expect(label).not.toBe("Managed");
    for (const method of plan.methods) {
      if (method.kind === "mcp") expect(label).toContain("MCP");
      if (method.kind === "oauth" && method.preset)
        expect(label).toContain("OAuth");
      if (method.kind === "api-key" && method.preset)
        expect(label).toContain("API key");
    }
  }
  const provider = catalogProvider("better-auth");
  if (!provider) throw new Error("Missing legacy catalog provider");
  expect(catalogMethodLabel(provider)).toBe("Configuration");
});

it("keeps admitted Notion and MCP alternatives distinct from blocked browser API/OAuth badges", () => {
  const providers = mergeVercelCatalog(getBundledProviders());
  const labels = Object.fromEntries(
    providers.map((provider) => [provider.id, catalogMethodLabel(provider)]),
  );
  expect(labels.notion).toContain("API key");
  expect(labels.notion).not.toContain("API key (browser unavailable)");
  expect(labels.resend).toContain("API key (browser unavailable)");
  expect(labels.resend).toContain("OAuth (browser unavailable)");
  expect(labels.resend).toContain("MCP");
  expect(labels.adobe).toBe("MCP");
});
