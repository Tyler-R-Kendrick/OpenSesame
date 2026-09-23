import { backupSeams } from "@opensesame/app-core/lib/backup.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { isHistorySelected } from "@opensesame/app-core/lib/history-backups.js";
import {
  loadSettings,
  saveSettings,
} from "@opensesame/app-core/lib/settings.js";
/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorSettingsPage } from "./SettingsPage.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

const originalBackup = { ...backupSeams };

// The connector settings page mounts guide targets `connectors.external`
// contributes; these cases describe a deployment that approved it.
declareConnectionsTutorial();

afterEach(() => {
  cleanup();
  Object.assign(backupSeams, originalBackup);
  const settings = loadSettings();
  saveSettings({
    ...settings,
    capabilityConnectors: {
      ...settings.capabilityConnectors,
      history: { providerId: "github", selections: [] },
    },
  });
});

beforeEach(() => {
  Object.assign(backupSeams, {
    getBackupStatus: vi.fn(async () => ({ target: null, pendingEvents: 0 })),
    setBackupTargetEnabled: vi.fn(async (enabled: boolean) => ({
      kind: "github_app",
      providerId: null,
      connectionId: null,
      integrationId: "int_1",
      installationId: "99",
      owner: "acme",
      repo: "vault",
      branch: "main",
      enabled,
      status: "ok",
      lastCommitSha: null,
      lastSyncedAt: null,
      lastError: null,
      config: null,
    })),
  });
  const settings = loadSettings();
  saveSettings({
    ...settings,
    capabilityConnectors: {
      ...settings.capabilityConnectors,
      history: {
        providerId: "github",
        selections: [{ providerId: "github", group: "git" }],
      },
    },
  });
});

function githubProvider(): Provider {
  return {
    id: "github",
    displayName: "GitHub",
    category: "backup_recovery",
    docsUrl: "https://docs.github.com",
    authKind: "oauth2_authorization_code",
    supportsRefresh: false,
    configured: true,
    autoConfigurable: false,
    missingConfig: [],
    callbackUrl: null,
    scopes: [],
    egress: {
      scheme: "https",
      authorities: ["api.github.com"],
      pathPrefixes: [],
    },
    operations: [],
    configurationFields: [],
  };
}

describe("ConnectorSettingsPage backup switch", () => {
  it("shows the enable switch beside the connector title", async () => {
    render(
      <MemoryRouter initialEntries={["/settings/connections/github"]}>
        <ConnectorSettingsPage
          provider={githubProvider()}
          providerId="github"
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
    const toggle = await waitFor(() =>
      screen.getByRole("switch", { name: "GitHub vault history" }),
    );
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(isHistorySelected("github")).toBe(false));
  });
});
