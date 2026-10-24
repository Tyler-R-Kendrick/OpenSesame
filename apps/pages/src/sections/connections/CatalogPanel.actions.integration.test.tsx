/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { CatalogPanel } from "./CatalogPanel.js";
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
