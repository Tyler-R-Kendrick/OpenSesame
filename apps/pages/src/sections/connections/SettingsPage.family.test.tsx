/** @vitest-environment jsdom */
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { mergeVercelCatalog } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { connectionRouteProvider } from "@opensesame/app-core/sections/connections/provider-route.js";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorSettingsPage } from "./SettingsPage.js";
import { API_FAMILIES, apiFamilyFor } from "./catalog-families.js";
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

/**
 * Each option of the page's provider-family select as [the page it opens, its
 * label]; null where none opens. A model provider's form has a select of its
 * own named "API family" (the protocol), so the page's is found by its id.
 */
function familyOptions() {
  const select = document.getElementById("connector-api-family");
  if (!select) throw new Error("the page draws no API family select");
  expect(screen.getAllByRole("combobox", { name: "API family" })).toContain(
    select,
  );
  return within(select)
    .getAllByRole("option")
    .map((option) => [
      connectionRouteProvider(providers, option.getAttribute("value") ?? "")
        ?.displayName ?? null,
      option.textContent,
    ]);
}

describe("a family tile's provider page", () => {
  it("offers AWS's other APIs on the page the AWS tile opens", () => {
    draw("aws");
    expect(familyOptions()).toEqual(
      [
        "AWS Secrets Manager",
        "AWS KMS",
        "AWS Parameter Store",
        "AWS STS",
        "Amazon Bedrock",
        "Amazon Nova",
      ].map((name) => [name, name]),
    );
  });

  it("offers GCP's other APIs on the page the GCP tile opens", () => {
    draw("gcp");
    expect(familyOptions()).toEqual(
      [
        "Google Cloud Secret Manager",
        "Google Cloud KMS",
        "Google Cloud IAM credentials",
      ].map((name) => [name, name]),
    );
  });

  it("offers only members that open a page, named for that page", () => {
    for (const family of API_FAMILIES) {
      for (const member of family.members) {
        if (!connectionRouteProvider(providers, member)) continue;
        draw(member);
        for (const [page, label] of familyOptions())
          expect(page, `${family.id} page ${member}: ${label}`).toBe(label);
        cleanup();
      }
    }
  });

  it("names a family for every member page it offers", () => {
    for (const family of API_FAMILIES)
      for (const member of family.members) {
        const row = connectionRouteProvider(providers, member);
        if (row) expect(apiFamilyFor(row.id)?.id, member).toBe(family.id);
      }
  });
});
