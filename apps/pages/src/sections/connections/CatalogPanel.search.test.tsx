/** @vitest-environment jsdom */
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitToConsumer } from "../../lib/command-bar/search.js";
import { standInPrompt } from "../../lib/command-bar/search.test-support.js";
import { CatalogPanel } from "./CatalogPanel.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

// The panel registers guide targets; a deployment that approved connections declares them.
declareConnectionsTutorial();

function provider(id: string, displayName: string): Provider {
  return {
    id,
    displayName,
    category: "developer",
    docsUrl: "https://example.invalid/docs",
    authKind: "oauth2_authorization_code",
    supportsRefresh: true,
    configured: true,
    autoConfigurable: false,
    missingConfig: [],
    callbackUrl: null,
    scopes: [],
    egress: { scheme: "https", authorities: [], pathPrefixes: [] },
    operations: [],
  };
}

let prompt = standInPrompt();
beforeEach(() => {
  prompt = standInPrompt();
});
afterEach(() => {
  cleanup();
  prompt.stop();
});

describe("the connector catalog searched in the prompt", () => {
  it("Enter lands the keyboard on the first matching tile, and stays in the field when none match", () => {
    render(
      <MemoryRouter>
        <CatalogPanel
          providers={[
            provider("github", "GitHub"),
            provider("linear", "Linear"),
          ]}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByLabelText("Search connectors")).toBeNull();
    act(() => prompt.type("/? linear"));
    expect(commitToConsumer()).toBe("took");
    expect(
      document.activeElement?.closest(".conn-tile")?.textContent,
    ).toContain("Linear");
    act(() => prompt.type("/? zzzz"));
    expect(commitToConsumer()).toBe("seen");
  });
});
