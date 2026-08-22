import { overlapCast } from "@opensesame/os-domain";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session: { current: { principalId: string } | null } = vi.hoisted(() => ({
  current: null,
}));

import { identitySeams } from "../../lib/identity.js";
const originalIdentitySeams = { ...identitySeams };
Object.assign(identitySeams, { useIdentitySession: () => session.current });
const loadSettings = vi.hoisted(() => vi.fn());

import { settingsSeams } from "../../lib/settings.js";
const originalSettingsSeams = { ...settingsSeams };
Object.assign(settingsSeams, { loadSettings });
const listChangelog = vi.hoisted(() => vi.fn());

import { changelogSeams } from "../../lib/changelog.js";
const originalChangelogSeams = { ...changelogSeams };
Object.assign(changelogSeams, {
  listChangelog,
  formatChangelogSummary: (event: { eventType: string; keyNames?: string[] }) =>
    `${event.eventType}${event.keyNames ? ` keys: ${event.keyNames.join(", ")}` : ""}`,
});

import { ChangelogPanel } from "./ChangelogPanel.js";

describe("ChangelogPanel", () => {
  beforeEach(() => {
    session.current = { principalId: "prn_operator" };
    loadSettings.mockReturnValue({ activeProjectId: "proj_personal" });
    listChangelog.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("asks for an identity session when signed out", () => {
    session.current = null;
    render(<ChangelogPanel />);
    expect(
      screen.getByText(/Connect an identity session to load changelog events/i),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Refresh/i })).toBeNull();
  });

  it("loads events for the active project and lists them", async () => {
    listChangelog.mockResolvedValue([
      {
        id: "evt_1",
        eventType: "secret.updated",
        occurredAt: "2026-08-01T00:00:00Z",
        actorId: "prn_operator",
        metadata: {},
        keyNames: ["API_KEY"],
      },
      {
        id: "evt_2",
        eventType: "config.synced",
        occurredAt: "2026-08-02T00:00:00Z",
        metadata: {},
      },
    ]);
    render(<ChangelogPanel />);
    expect(screen.getByDisplayValue("proj_personal")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Refresh/i }));
    expect(await screen.findByText(/Loaded 2 metadata events/)).toBeTruthy();
    expect(listChangelog).toHaveBeenCalledWith({
      projectId: "proj_personal",
      limit: 50,
    });
    expect(screen.getByText(/secret\.updated keys: API_KEY/)).toBeTruthy();
    expect(screen.getByText(/prn_operator/)).toBeTruthy();
    // Second event has no actor — renders timestamp only.
    expect(screen.getByText("2026-08-02T00:00:00Z")).toBeTruthy();
  });

  it("omits the project filter when no project is active", async () => {
    // The effect re-adopts the configured project whenever the field is
    // empty, so an empty filter is only possible with no configured project.
    loadSettings.mockReturnValue({ activeProjectId: "" });
    render(<ChangelogPanel />);
    await userEvent.click(screen.getByRole("button", { name: /Refresh/i }));
    expect(await screen.findByText(/No changelog events yet/)).toBeTruthy();
    expect(listChangelog).toHaveBeenCalledWith({ limit: 50 });
  });

  it("adopts the active project from settings when the field starts empty", async () => {
    let stored = "";
    loadSettings.mockImplementation(() => ({ activeProjectId: stored }));
    render(<ChangelogPanel />);
    expect(screen.getByPlaceholderText("project_…")).toBeTruthy();
    stored = "proj_adopted";
    // Trigger a re-render so the effect re-reads settings.
    await userEvent.type(
      screen.getByPlaceholderText("project_…"),
      "x{backspace}",
    );
    expect(loadSettings).toHaveBeenCalled();
  });

  it("surfaces load failures as an alert", async () => {
    listChangelog.mockRejectedValue(new Error("host offline"));
    render(<ChangelogPanel />);
    await userEvent.click(screen.getByRole("button", { name: /Refresh/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/host offline/);
  });

  it("falls back to a generic message for non-Error rejections", async () => {
    listChangelog.mockRejectedValue("boom");
    render(<ChangelogPanel />);
    await userEvent.click(screen.getByRole("button", { name: /Refresh/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Could not load changelog/);
  });

  it("uses singular wording for exactly one event", async () => {
    listChangelog.mockResolvedValue([
      {
        id: "evt_1",
        eventType: "secret.created",
        occurredAt: "2026-08-01T00:00:00Z",
        metadata: {},
      },
    ]);
    render(<ChangelogPanel />);
    await userEvent.click(screen.getByRole("button", { name: /Refresh/i }));
    expect(await screen.findByText(/Loaded 1 metadata event\./)).toBeTruthy();
  });
});
