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
import { backupSeams } from "../../lib/backup.js";
import {
  isHistorySelected,
  loadHistorySelections,
} from "../../lib/history-backups.js";
import { loadSettings, saveSettings } from "../../lib/settings.js";
import { declareTutorialForTest } from "../../modules/tutorial-test-realm.js";
import { CONNECTIONS_TARGETS } from "../../tutorial/registry/connections-catalog.js";
import { FeatureBindingsPanel } from "./FeatureBindingsPanel.js";

const originalBackup = { ...backupSeams };

// The panel mounts guide targets `connectors.external` contributes
// (`settings.connectivity`, `settings.model-provider`); declare them the way
// the loader would.
let undeclare: (() => void) | null = null;
beforeEach(async () => {
  undeclare = await declareTutorialForTest("connectors.external", {
    targets: CONNECTIONS_TARGETS,
  });
});

afterEach(() => {
  cleanup();
  undeclare?.();
  undeclare = null;
  Object.assign(backupSeams, originalBackup);
  const settings = loadSettings();
  saveSettings({
    ...settings,
    capabilityConnectors: {
      ...settings.capabilityConnectors,
      history: { providerId: "github" },
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
        providerId: "gitlab",
        selections: [
          {
            providerId: "gitlab",
            group: "git",
            connectionId: "conn_gl",
            remote: "https://gitlab.com/acme/vault.git",
          },
        ],
      },
    },
  });
});

describe("FeatureBindingsPanel backup toggles", () => {
  it("puts a history switch on unbound backup connectors", async () => {
    render(
      <MemoryRouter>
        <FeatureBindingsPanel />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "GitLab vault history" }),
      ).toBeTruthy(),
    );
    expect(
      screen
        .getByRole("switch", { name: "GitLab vault history" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByText("https://gitlab.com/acme/vault.git")).toBeTruthy();
  });

  it("toggles vault history when no Host backup target is bound", async () => {
    render(
      <MemoryRouter>
        <FeatureBindingsPanel />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "GitLab vault history" }),
      ).toBeTruthy(),
    );
    fireEvent.click(
      screen.getByRole("switch", { name: "GitLab vault history" }),
    );
    expect(isHistorySelected("gitlab")).toBe(false);
    fireEvent.click(
      screen.getByRole("switch", { name: "Bitbucket vault history" }),
    );
    expect(
      loadHistorySelections().some((row) => row.providerId === "bitbucket"),
    ).toBe(true);
  });

  it("can turn GitHub vault history off (empty selection sticks)", async () => {
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
    render(
      <MemoryRouter>
        <FeatureBindingsPanel />
      </MemoryRouter>,
    );
    const github = await waitFor(() =>
      screen.getByRole("switch", { name: "GitHub vault history" }),
    );
    expect(github.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(github);
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "GitHub vault history" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
    expect(isHistorySelected("github")).toBe(false);
    expect(loadHistorySelections()).toEqual([]);
  });

  it("drives the Host backup actor enable flag for a configured GitHub App", async () => {
    Object.assign(backupSeams, {
      getBackupStatus: vi.fn(async () => ({
        target: {
          kind: "github_app",
          providerId: null,
          connectionId: "conn_gh",
          integrationId: "int_1",
          installationId: "99",
          owner: "acme",
          repo: "vault",
          branch: "main",
          enabled: true,
          status: "ok",
          lastCommitSha: null,
          lastSyncedAt: null,
          lastError: null,
          config: null,
        },
        pendingEvents: 0,
      })),
    });
    render(
      <MemoryRouter>
        <FeatureBindingsPanel />
      </MemoryRouter>,
    );
    const github = await waitFor(() =>
      screen.getByRole("switch", { name: "GitHub backup" }),
    );
    expect(github.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("acme/vault")).toBeTruthy();
    fireEvent.click(github);
    await waitFor(() =>
      expect(backupSeams.setBackupTargetEnabled).toHaveBeenCalledWith(
        false,
        "github",
      ),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "GitHub backup" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
  });
});
