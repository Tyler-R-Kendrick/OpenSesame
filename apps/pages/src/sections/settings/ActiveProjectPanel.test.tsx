import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { overlapCast, type BoundaryValue } from "@opensesame/os-domain";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const online = vi.hoisted(() => ({ value: true }));
const plane = vi.hoisted(() => ({
  value: { host: "live", identity: "connected" },
}));
const session = vi.hoisted(() => ({
  current: { principalId: "prn_op" },
}));
const connect = vi.hoisted(() => vi.fn());
const connecting = vi.hoisted(() => ({ value: false }));
const identityFetch = vi.hoisted(() => vi.fn());

import { useOnlineSeams } from "../../lib/use-online.js";
const originalUseOnlineSeams = { ...useOnlineSeams };
Object.assign(useOnlineSeams, {useOnline: () => online.value});
import { planeSeams } from "../../lib/planes.js";
const originalPlaneSeams = { ...planeSeams };
Object.assign(planeSeams, {usePlaneStatus: () => plane.value});
import { identitySeams } from "../../lib/identity.js";
const originalIdentitySeams = { ...identitySeams };
Object.assign(identitySeams, {useIdentitySession: () => session.current,
  useConnect: () => ({ connect, connecting: connecting.value }),
  identityFetch});
const loadSettings = vi.hoisted(() => vi.fn());
const saveSettings = vi.hoisted(() => vi.fn());
const shouldAutoConnect = vi.hoisted(() => vi.fn(() => true));

import { settingsSeams } from "../../lib/settings.js";
const originalSettingsSeams = { ...settingsSeams };
Object.assign(settingsSeams, {loadSettings,
  saveSettings,
  shouldAutoConnect});
import { ActiveProjectPanel } from "./ActiveProjectPanel.js";

const personalProject = {
  id: "proj_personal",
  slug: "personal",
  displayName: "Personal",
  state: "active",
  sealedStoreTombName: null,
  pagesVaultFolderId: null,
  created: false,
};

function jsonResponse(body: BoundaryValue, ok = true, status = 200) {
  return overlapCast({
    ok,
    status,
    json: () => Promise.resolve(body),
  });
}

function mockSuccessfulRefresh(personal = personalProject) {
  identityFetch.mockImplementation((path: string) => {
    if (path === "/v1/projects/personal/ensure") {
      return Promise.resolve(jsonResponse(personal));
    }
    if (path === "/v1/projects") {
      return Promise.resolve(
        jsonResponse({
          projects: [
            personalProject,
            {
              id: "proj_team",
              slug: "team",
              displayName: "Team",
              state: "active",
            },
          ],
        }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch ${path}`));
  });
}

describe("ActiveProjectPanel", () => {
  beforeEach(() => {
    online.value = true;
    plane.value = { host: "live", identity: "connected" };
    session.current = { principalId: "prn_op" };
    connecting.value = false;
    shouldAutoConnect.mockReturnValue(true);
    loadSettings.mockReturnValue({ activeProjectId: "" });
    mockSuccessfulRefresh();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("offers identity connect when signed out", () => {
    session.current = null;
    render(<ActiveProjectPanel />);
    const button = overlapCast(screen.getByRole("button", {
      name: /Connect Identity/i,
    }));
    expect(button.disabled).toBe(false);
    expect(identityFetch).not.toHaveBeenCalled();
  });

  it("disables connect while a connection is in flight", () => {
    session.current = null;
    connecting.value = true;
    render(<ActiveProjectPanel />);
    const button = overlapCast(screen.getByRole("button", {
      name: /Connecting…/i,
    }));
    expect(button.disabled).toBe(true);
  });

  it("disables connect when auto-connect is not allowed", () => {
    session.current = null;
    shouldAutoConnect.mockReturnValue(false);
    render(<ActiveProjectPanel />);
    const button = overlapCast(screen.getByRole("button", {
      name: /Connect Identity/i,
    }));
    expect(button.disabled).toBe(true);
  });

  it("starts the identity flow when Connect is clicked", async () => {
    session.current = null;
    connect.mockResolvedValue(undefined);
    render(<ActiveProjectPanel />);
    await userEvent.click(
      screen.getByRole("button", { name: /Connect Identity/i }),
    );
    expect(connect).toHaveBeenCalled();
  });

  it("ensures the personal project and lists projects", async () => {
    render(<ActiveProjectPanel />);
    expect(await screen.findByText(/Using your personal project/)).toBeTruthy();
    expect(identityFetch).toHaveBeenCalledWith(
      "/v1/projects/personal/ensure",
      expect.objectContaining({ method: "POST" }),
    );
    // Personal project is auto-selected and persisted.
    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ activeProjectId: "proj_personal" }),
      ),
    );
    expect(screen.getByText(/Personal \(personal\) — personal/)).toBeTruthy();
    expect(screen.getByText(/Team — team/)).toBeTruthy();
  });

  it("announces a freshly created personal project", async () => {
    mockSuccessfulRefresh({ ...personalProject, created: true });
    render(<ActiveProjectPanel />);
    expect(await screen.findByText(/Personal project ready/)).toBeTruthy();
  });

  it("keeps a stored selection that still exists", async () => {
    loadSettings.mockReturnValue({ activeProjectId: "proj_team" });
    render(<ActiveProjectPanel />);
    await screen.findByText(/Using your personal project/);
    const select = overlapCast(screen.getByLabelText(/Project/i));
    await waitFor(() => expect(select.value).toBe("proj_team"));
  });

  it("persists a manual project selection", async () => {
    render(<ActiveProjectPanel />);
    await screen.findByText(/Using your personal project/);
    await userEvent.selectOptions(
      screen.getByLabelText(/Project/i),
      "proj_team",
    );
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ activeProjectId: "proj_team" }),
    );
    expect(await screen.findByText(/Active project saved/)).toBeTruthy();
  });

  it("shows tomb binding details for the active project", async () => {
    loadSettings.mockReturnValue({ activeProjectId: "proj_team" });
    identityFetch.mockImplementation((path: string) => {
      if (path === "/v1/projects/personal/ensure") {
        return Promise.resolve(jsonResponse(personalProject));
      }
      return Promise.resolve(
        jsonResponse({
          projects: [
            {
              id: "proj_team",
              slug: "team",
              displayName: "Team",
              state: "active",
              sealedStoreTombName: "team-tomb",
              pagesVaultFolderId: "fld_9",
            },
          ],
        }),
      );
    });
    render(<ActiveProjectPanel />);
    await screen.findByText(/Using your personal project/);
    expect(await screen.findByText(/team-tomb/)).toBeTruthy();
    expect(screen.getByText(/Vault folder: fld_9/)).toBeTruthy();
  });

  it("surfaces ensure failures with the server message", async () => {
    identityFetch.mockImplementation((path: string) => {
      if (path === "/v1/projects/personal/ensure") {
        return Promise.resolve(
          jsonResponse({ message: "quota exceeded" }, false, 403),
        );
      }
      return Promise.resolve(jsonResponse({ projects: [] }));
    });
    render(<ActiveProjectPanel />);
    expect(await screen.findByText(/quota exceeded/)).toBeTruthy();
  });

  it("falls back to the status code when ensure has no message", async () => {
    identityFetch.mockImplementation((path: string) => {
      if (path === "/v1/projects/personal/ensure") {
        return Promise.resolve(jsonResponse(null, false, 500));
      }
      return Promise.resolve(jsonResponse({ projects: [] }));
    });
    render(<ActiveProjectPanel />);
    expect(await screen.findByText(/Ensure failed \(500\)/)).toBeTruthy();
  });

  it("surfaces project list failures", async () => {
    identityFetch.mockImplementation((path: string) => {
      if (path === "/v1/projects/personal/ensure") {
        return Promise.resolve(jsonResponse(personalProject));
      }
      return Promise.resolve(jsonResponse({}, false, 502));
    });
    render(<ActiveProjectPanel />);
    expect(
      await screen.findByText(/List projects failed \(502\)/),
    ).toBeTruthy();
  });

  it("reports thrown refresh errors", async () => {
    identityFetch.mockRejectedValue(new Error("dns failure"));
    render(<ActiveProjectPanel />);
    expect(await screen.findByText(/dns failure/)).toBeTruthy();
  });

  it("does not refresh while the identity plane is down", () => {
    plane.value = { host: "live", identity: "degraded" };
    render(<ActiveProjectPanel />);
    expect(identityFetch).not.toHaveBeenCalled();
  });

  it("shows an offline note when disconnected", () => {
    online.value = false;
    render(<ActiveProjectPanel />);
    expect(
      screen.getByText(/Offline — project list needs Identity/i),
    ).toBeTruthy();
    expect(identityFetch).not.toHaveBeenCalled();
  });

  it("reloads when Refresh is clicked", async () => {
    render(<ActiveProjectPanel />);
    await screen.findByText(/Using your personal project/);
    await userEvent.click(
      screen.getByRole("button", { name: /Refresh \/ ensure personal/i }),
    );
    await waitFor(() =>
      expect(
        identityFetch.mock.calls.filter(
          ([path]) => path === "/v1/projects/personal/ensure",
        ),
      ).toHaveLength(2),
    );
  });
});
