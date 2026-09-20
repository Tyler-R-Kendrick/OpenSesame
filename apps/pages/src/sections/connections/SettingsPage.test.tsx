/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "../../lib/connections.js";
import { ConnectorSettingsPage } from "./SettingsPage.js";

afterEach(() => {
  cleanup();
});

function gitProvider(): Provider {
  return {
    id: "git",
    displayName: "Git (any remote)",
    category: "backup_recovery",
    docsUrl: "https://git-scm.com/docs/gitcredentials",
    authKind: "configuration",
    supportsRefresh: false,
    configured: false,
    autoConfigurable: false,
    missingConfig: [],
    callbackUrl: null,
    scopes: [],
    egress: { scheme: "https", authorities: [], pathPrefixes: [] },
    operations: ["git.fetch", "git.push"],
    configurationFields: [],
  };
}

describe("ConnectorSettingsPage git", () => {
  it("shows the git connect ceremony when the provider is unconfigured", () => {
    render(
      <MemoryRouter initialEntries={["/settings/connections/git"]}>
        <ConnectorSettingsPage
          provider={gitProvider()}
          providerId="git"
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

    expect(screen.getByRole("heading", { name: "Connect" })).toBeTruthy();
    expect(screen.getByLabelText(/Remote URL/i)).toBeTruthy();
    expect(screen.getByText(/HTTPS token/i)).toBeTruthy();
    expect(
      screen.queryByText(/connects over OAuth/i),
    ).toBeNull();
  });
});
