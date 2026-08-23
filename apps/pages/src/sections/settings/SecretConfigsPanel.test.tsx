import { overlapCast } from "@opensesame/os-domain";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const online = vi.hoisted(() => ({ value: true }));
const session = vi.hoisted(() => ({
  current: { principalId: "prn_op" },
}));
const ensureHostSession = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const hostLocalSessionEligible = vi.hoisted(() => vi.fn(() => true));

import { useOnlineSeams } from "../../lib/use-online.js";
Object.assign(useOnlineSeams, { useOnline: () => online.value });
import { identitySeams } from "../../lib/identity.js";
Object.assign(identitySeams, {
  useIdentitySession: () => session.current,
  ensureHostSession,
  hostLocalSessionEligible,
});

const activeProjectId = vi.hoisted(() => ({ value: "project_1" }));
import { settingsSeams } from "../../lib/settings.js";
const originalLoadSettings = settingsSeams.loadSettings;
Object.assign(settingsSeams, {
  loadSettings: () => ({
    ...originalLoadSettings(),
    activeProjectId: activeProjectId.value,
  }),
});

const listSecretConfigs = vi.hoisted(() => vi.fn());
const listConfigKeys = vi.hoisted(() => vi.fn());
const putConfigSecrets = vi.hoisted(() => vi.fn());
const deleteConfigSecret = vi.hoisted(() => vi.fn());
const listConfigSecretVersions = vi.hoisted(() => vi.fn());
const rollbackConfigSecret = vi.hoisted(() => vi.fn());
const compareConfigs = vi.hoisted(() => vi.fn());
const branchConfig = vi.hoisted(() => vi.fn());

import { secretConfigSeams } from "../../lib/secret-configs.js";
Object.assign(secretConfigSeams, {
  listSecretConfigs,
  listConfigKeys,
  putConfigSecrets,
  deleteConfigSecret,
  listConfigSecretVersions,
  rollbackConfigSecret,
  compareConfigs,
  branchConfig,
  formatConfigSummary: (config: { slug: string; environment: string }) =>
    `${config.slug} (${config.environment})`,
});

const listHostChangelogPage = vi.hoisted(() => vi.fn());
import { changelogSeams } from "../../lib/changelog.js";
Object.assign(changelogSeams, {
  listHostChangelogPage,
  formatChangelogSummary: (event: { eventType: string }) => event.eventType,
});

import type { SecretConfig } from "../../lib/secret-configs.js";
import { SecretConfigsPanel } from "./SecretConfigsPanel.js";

function makeConfig(overrides: Partial<SecretConfig> = {}): SecretConfig {
  return {
    id: "cfg_prod",
    organizationId: "org_1",
    projectId: "project_1",
    slug: "production",
    displayName: "Production",
    environment: "production",
    parentConfigId: null,
    createdAt: "2026-08-20T00:00:00Z",
    updatedAt: "2026-08-20T00:00:00Z",
    ...overrides,
  };
}

describe("SecretConfigsPanel", () => {
  beforeEach(() => {
    online.value = true;
    activeProjectId.value = "project_1";
    session.current = { principalId: "prn_op" };
    listSecretConfigs.mockResolvedValue([]);
    listConfigKeys.mockResolvedValue([]);
    listHostChangelogPage.mockResolvedValue({
      events: [],
      nextBeforeSeq: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("warns when offline and skips loading", () => {
    online.value = false;
    render(<SecretConfigsPanel />);
    expect(screen.getByText(/Offline — configs require Host/i)).toBeTruthy();
    expect(listSecretConfigs).not.toHaveBeenCalled();
  });

  it("hints when there is no active project", () => {
    activeProjectId.value = "";
    render(<SecretConfigsPanel />);
    expect(screen.getByText(/Set an active project/i)).toBeTruthy();
    expect(listSecretConfigs).not.toHaveBeenCalled();
  });

  it("shows the empty-state hint when the project has no configs", async () => {
    render(<SecretConfigsPanel />);
    expect(await screen.findByText(/No configs yet/i)).toBeTruthy();
    expect(listSecretConfigs).toHaveBeenCalledWith("project_1");
    expect(ensureHostSession).toHaveBeenCalled();
  });

  it("lists configs and key metadata for the selected config", async () => {
    listSecretConfigs.mockResolvedValue([makeConfig()]);
    listConfigKeys.mockResolvedValue([
      {
        keyName: "DATABASE_URL",
        version: 3,
        updatedAt: "2026-08-20T01:00:00Z",
      },
    ]);
    render(<SecretConfigsPanel />);
    expect(await screen.findByText(/DATABASE_URL/)).toBeTruthy();
    expect(screen.getByText(/v3/)).toBeTruthy();
    expect(listConfigKeys).toHaveBeenCalledWith("cfg_prod");
  });

  it("sets a secret through the masked write-only input and clears it", async () => {
    listSecretConfigs.mockResolvedValue([makeConfig()]);
    putConfigSecrets.mockResolvedValue([
      { keyName: "API_KEY", version: 1, updatedAt: "2026-08-20T01:00:00Z" },
    ]);
    render(<SecretConfigsPanel />);
    await screen.findByLabelText(/Key name/i);

    const valueInput = overlapCast(
      screen.getByLabelText(/Value \(write-only\)/i),
    );
    expect(valueInput.type).toBe("password");

    await userEvent.type(screen.getByLabelText(/Key name/i), "API_KEY");
    await userEvent.type(
      screen.getByLabelText(/Value \(write-only\)/i),
      "hunter2-secret",
    );
    await userEvent.click(screen.getByRole("button", { name: /Set secret/i }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/Set API_KEY/);
    expect(putConfigSecrets).toHaveBeenCalledWith("cfg_prod", {
      API_KEY: "hunter2-secret",
    });
    expect(overlapCast(screen.getByLabelText(/Key name/i)).value).toBe("");
    expect(
      overlapCast(screen.getByLabelText(/Value \(write-only\)/i)).value,
    ).toBe("");
  });

  it("clears the masked value even when the set fails", async () => {
    listSecretConfigs.mockResolvedValue([makeConfig()]);
    putConfigSecrets.mockRejectedValue(new Error("forbidden"));
    render(<SecretConfigsPanel />);
    await screen.findByLabelText(/Key name/i);

    await userEvent.type(screen.getByLabelText(/Key name/i), "API_KEY");
    await userEvent.type(
      screen.getByLabelText(/Value \(write-only\)/i),
      "hunter2-secret",
    );
    await userEvent.click(screen.getByRole("button", { name: /Set secret/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/forbidden/);
    expect(
      overlapCast(screen.getByLabelText(/Value \(write-only\)/i)).value,
    ).toBe("");
  });

  it("unsets a key", async () => {
    listSecretConfigs.mockResolvedValue([makeConfig()]);
    listConfigKeys.mockResolvedValue([
      { keyName: "DB_URL", version: 1, updatedAt: "2026-08-20T01:00:00Z" },
    ]);
    deleteConfigSecret.mockResolvedValue(undefined);
    render(<SecretConfigsPanel />);
    await screen.findByText(/DB_URL/);
    await userEvent.click(screen.getByRole("button", { name: /Unset/i }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/Unset DB_URL/);
    expect(deleteConfigSecret).toHaveBeenCalledWith("cfg_prod", "DB_URL");
  });

  it("shows version history and rolls back only after confirm", async () => {
    listSecretConfigs.mockResolvedValue([makeConfig()]);
    listConfigKeys.mockResolvedValue([
      { keyName: "DB_URL", version: 2, updatedAt: "2026-08-20T01:00:00Z" },
    ]);
    listConfigSecretVersions.mockResolvedValue([
      {
        version: 1,
        deleted: false,
        actorId: "prn_op",
        createdAt: "2026-08-20T00:00:00Z",
      },
    ]);
    rollbackConfigSecret.mockResolvedValue({ keyName: "DB_URL", version: 3 });
    render(<SecretConfigsPanel />);
    await screen.findByText(/DB_URL/);

    await userEvent.click(screen.getByRole("button", { name: /Versions/i }));
    await screen.findByRole("button", { name: /Rollback to v1/i });
    expect(rollbackConfigSecret).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole("button", { name: /Rollback to v1/i }),
    );
    expect(rollbackConfigSecret).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole("button", { name: /Confirm rollback/i }),
    );
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/Rolled DB_URL back to v1 as new v3/);
    expect(rollbackConfigSecret).toHaveBeenCalledWith("cfg_prod", "DB_URL", 1);
  });

  it("branches the selected config", async () => {
    listSecretConfigs.mockResolvedValue([makeConfig()]);
    branchConfig.mockResolvedValue(
      makeConfig({
        id: "cfg_child",
        slug: "dev-tyler",
        parentConfigId: "cfg_prod",
      }),
    );
    render(<SecretConfigsPanel />);
    await screen.findByLabelText(/Branch into child config/i);

    await userEvent.type(
      screen.getByLabelText(/Branch into child config/i),
      "dev-tyler",
    );
    await userEvent.click(screen.getByRole("button", { name: /^Branch$/i }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/Branched into dev-tyler/);
    expect(branchConfig).toHaveBeenCalledWith("cfg_prod", {
      slug: "dev-tyler",
    });
  });

  it("compares the selected config with another and renders versions only", async () => {
    listSecretConfigs.mockResolvedValue([
      makeConfig(),
      makeConfig({
        id: "cfg_dev",
        slug: "development",
        environment: "development",
      }),
    ]);
    compareConfigs.mockResolvedValue({
      onlyInA: ["ONLY_A"],
      onlyInB: [],
      inBoth: [{ keyName: "SHARED", aVersion: 1, bVersion: 4 }],
    });
    render(<SecretConfigsPanel />);
    await screen.findByLabelText(/Compare with/i);

    await userEvent.selectOptions(
      screen.getByLabelText(/Compare with/i),
      "cfg_dev",
    );
    await userEvent.click(screen.getByRole("button", { name: /^Compare$/i }));

    expect(await screen.findByText(/ONLY_A/)).toBeTruthy();
    expect(screen.getByText(/SHARED/)).toBeTruthy();
    expect(screen.getByText(/v1 vs v4/)).toBeTruthy();
    expect(compareConfigs).toHaveBeenCalledWith("cfg_prod", "cfg_dev");
  });

  it("pages the changelog with the durable cursor", async () => {
    listSecretConfigs.mockResolvedValue([makeConfig()]);
    listHostChangelogPage
      .mockResolvedValueOnce({
        events: [
          {
            id: "chg_1",
            seq: 9,
            eventType: "secret.value.changed",
            occurredAt: "2026-08-20T02:00:00Z",
            metadata: {},
          },
        ],
        nextBeforeSeq: 9,
      })
      .mockResolvedValueOnce({
        events: [
          {
            id: "chg_0",
            seq: 8,
            eventType: "secret.config.created",
            occurredAt: "2026-08-20T01:00:00Z",
            metadata: {},
          },
        ],
        nextBeforeSeq: null,
      });
    render(<SecretConfigsPanel />);

    await userEvent.click(
      await screen.findByRole("button", { name: /Load change log/i }),
    );
    expect(await screen.findByText(/secret.value.changed/)).toBeTruthy();
    expect(listHostChangelogPage).toHaveBeenCalledWith("project_1", {
      limit: 20,
    });

    await userEvent.click(screen.getByRole("button", { name: /Load older/i }));
    expect(await screen.findByText(/secret.config.created/)).toBeTruthy();
    expect(listHostChangelogPage).toHaveBeenLastCalledWith("project_1", {
      limit: 20,
      beforeSeq: 9,
    });
    await waitFor(() =>
      expect(screen.getByText(/No older events/i)).toBeTruthy(),
    );
  });

  it("surfaces load failures from listSecretConfigs", async () => {
    listSecretConfigs.mockRejectedValue(new Error("host unreachable"));
    render(<SecretConfigsPanel />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/host unreachable/);
  });
});
