/** @vitest-environment jsdom */
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { mergeVercelCatalog } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
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

function bundled(id: string): Provider {
  const found = providers.find((row) => row.id === id);
  if (!found) throw new Error(`${id} is not bundled`);
  return found;
}

/** The page a family tile opens: the route names the tile, the row is bundled. */
function draw(route: string, row: string) {
  render(
    <MemoryRouter initialEntries={[`/connections/${route}`]}>
      <ConnectorSettingsPage
        provider={bundled(row)}
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

function familySelect() {
  return screen.getByRole("combobox", { name: "API family" });
}

describe("a family tile's provider page", () => {
  it("offers AWS's other APIs when the bundled row keeps the catalog's alias", () => {
    draw("aws", "aws-secrets-manager");
    const select = familySelect();
    expect(select).toHaveProperty("value", "aws-secrets-manager");
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => [option.getAttribute("value"), option.textContent]),
    ).toEqual([
      ["aws-secrets-manager", "AWS Secrets Manager"],
      ["aws-kms", "AWS KMS"],
      ["aws-parameter-store", "AWS Parameter Store"],
      ["aws-sts", "AWS STS"],
      ["aws-bedrock", "Amazon Bedrock"],
      ["amazon-nova", "Amazon Nova"],
    ]);
  });

  it("offers GCP's other APIs from Google Cloud Secret Manager", () => {
    draw("gcp", "gcp-secret-manager");
    expect(
      within(familySelect())
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "Google Cloud Secret Manager",
      "Google Cloud KMS",
      "Google Cloud IAM credentials",
    ]);
  });

  it("keeps the select a row named by its catalog id already had", () => {
    draw("google", "google");
    expect(familySelect()).toHaveProperty("value", "google");
  });
});
