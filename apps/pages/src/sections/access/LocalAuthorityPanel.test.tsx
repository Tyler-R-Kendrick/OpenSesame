import * as directory from "@opensesame/app-core/lib/local-directory.js";
import * as grants from "@opensesame/app-core/lib/local-grant-admin.js";
import {
  listRecordedLocalGrants,
  revokeRecordedLocalGrant,
} from "@opensesame/app-core/lib/local-grant-admin.js";
import { notifyLocalIamChange } from "@opensesame/app-core/lib/local-iam-events.js";
import * as sessions from "@opensesame/app-core/lib/local-sessions.js";
import {
  listLocalIdentitySessions,
  revokeLocalIdentitySession,
} from "@opensesame/app-core/lib/local-sessions.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalAuthorityPanel } from "./LocalAuthorityPanel.js";
import { renderAccess as render } from "./workspace-test-support.js";

beforeEach(() => {
  vi.spyOn(directory, "readLocalDirectory").mockResolvedValue({
    version: 2,
    revision: 1,
    memberships: [],
    entries: [
      { id: "person", kind: "person", name: "Test person", enabled: true },
      {
        id: "app",
        kind: "application",
        name: "Test application",
        enabled: true,
      },
      {
        id: "org",
        kind: "organization",
        name: "Test organization",
        enabled: true,
      },
    ],
  });
  vi.spyOn(sessions, "listLocalIdentitySessions").mockResolvedValue([
    {
      id: "session-record",
      principalId: "person",
      authentication: "passkey",
      authTime: Date.now(),
      expiresAt: Date.now() + 60000,
    },
  ]);
  vi.spyOn(grants, "listRecordedLocalGrants").mockResolvedValue([
    {
      id: "grant-record",
      principalId: "person",
      applicationId: "app",
      organizationId: "org",
      scopes: ["records:read"],
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60000,
      approvingPrincipalId: null,
    },
  ]);
  vi.spyOn(sessions, "revokeLocalIdentitySession").mockImplementation(
    async () => {
      vi.mocked(listLocalIdentitySessions).mockResolvedValue([]);
      notifyLocalIamChange();
    },
  );
  vi.spyOn(grants, "revokeRecordedLocalGrant").mockImplementation(async () => {
    vi.mocked(listRecordedLocalGrants).mockResolvedValue([]);
    notifyLocalIamChange();
  });
});
function trayFailures() {
  return listNotices().filter(
    (notice) => notice.kind === "status" && notice.tone === "err",
  );
}

afterEach(() => {
  cleanup();
  clearNotices();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("lists local records without a backend and cancels with keyboard focus restored", async () => {
  render(<LocalAuthorityPanel tomb="vault-a" records="grant" />);
  await screen.findByRole("heading", {
    name: "Test person → Test application",
  });
  const button = screen.getByRole("button", { name: "Revoke grant" });
  button.focus();
  await userEvent.keyboard("{Enter}");
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Cancel revocation" }),
  );
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(document.activeElement).toBe(button));
  expect(revokeRecordedLocalGrant).not.toHaveBeenCalled();
  expect(listRecordedLocalGrants).toHaveBeenCalledWith("vault-a");
});

it("restores focus even when a frame fires before the confirmation's removal commits", async () => {
  // Under load a frame can run before React commits the render that closes
  // the confirmation, while the row's key is still disabled beside it.
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  render(<LocalAuthorityPanel tomb="vault-a" records="grant" />);
  await screen.findByRole("heading", {
    name: "Test person → Test application",
  });
  const button = screen.getByRole("button", { name: "Revoke grant" });
  button.focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(document.activeElement).toBe(button));
});

it("shows only application grants and revokes through the same encrypted-store operation", async () => {
  render(<LocalAuthorityPanel tomb="vault-a" records="grant" />);
  await screen.findByRole("heading", {
    name: "Test person → Test application",
  });
  expect(
    screen.getByRole("tree", { name: "Local application grants items" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Revoke session" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Revoke grant" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm revocation" }),
  );
  await screen.findByText("No grants.");
  expect(revokeRecordedLocalGrant).toHaveBeenCalledExactlyOnceWith(
    "vault-a",
    "grant-record",
  );
  expect(revokeLocalIdentitySession).not.toHaveBeenCalled();
});

it.each(["session", "grant"] as const)(
  "confirms only the selected %s and recovers focus",
  async (kind) => {
    render(
      <LocalAuthorityPanel tomb="vault-a" records={kind} />,
      `/access?view=${kind === "grant" ? "grants" : "sessions"}#${kind === "grant" ? "local-grants/grant-record" : "local-sessions/session-record"}`,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: `Revoke ${kind}` }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm revocation" }),
    );
    await screen.findByText(
      kind === "session"
        ? "Local session revoked."
        : "Application grant revoked.",
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Reload local access records" }),
      ),
    );
    const selected =
      kind === "session"
        ? revokeLocalIdentitySession
        : revokeRecordedLocalGrant;
    const other =
      kind === "session"
        ? revokeRecordedLocalGrant
        : revokeLocalIdentitySession;
    expect(selected).toHaveBeenCalledExactlyOnceWith(
      "vault-a",
      `${kind}-record`,
    );
    expect(other).not.toHaveBeenCalled();
  },
);

it("does not turn a failed read into an empty list", async () => {
  vi.mocked(listRecordedLocalGrants).mockRejectedValueOnce(
    new Error("private diagnostic"),
  );
  render(<LocalAuthorityPanel tomb="vault-a" records="grant" />);
  await waitFor(() => expect(trayFailures()).toHaveLength(1));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("No grants.")).toBeNull();
  expect(document.body.textContent).not.toContain("private diagnostic");
  expect(JSON.stringify(listNotices())).not.toContain("private diagnostic");
  await userEvent.click(
    screen.getByRole("button", { name: "Reload local access records" }),
  );
  await screen.findByRole("heading", {
    name: "Test person → Test application",
  });
  await waitFor(() => expect(trayFailures()).toHaveLength(0));
});

it("retains confirmation on failed writes and never claims revocation succeeded", async () => {
  vi.mocked(revokeRecordedLocalGrant).mockRejectedValueOnce(
    new Error("private storage error"),
  );
  render(<LocalAuthorityPanel tomb="vault-a" records="grant" />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Revoke grant" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm revocation" }),
  );
  await waitFor(() =>
    expect(
      trayFailures().some((notice) =>
        notice.body.includes("Revocation was not confirmed. Reload and retry."),
      ),
    ).toBe(true),
  );
  expect(
    screen.queryByText("Revocation was not confirmed. Reload and retry."),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "Confirm revocation" }),
  ).toBeTruthy();
  expect(screen.queryByText("Application grant revoked.")).toBeNull();
});

it("refreshes external changes to one empty line, never a dash counter", async () => {
  render(
    <LocalAuthorityPanel tomb="vault-a" records="session" />,
    "/access?view=sessions#local-sessions/session-record",
  );
  await screen.findByRole("button", { name: "Revoke session" });
  vi.mocked(listLocalIdentitySessions).mockResolvedValue([]);
  act(() => notifyLocalIamChange());
  await screen.findByText("No sessions.");
  expect(screen.queryByText(/: -/)).toBeNull();
  // Sessions never lists the Grants tab's records.
  expect(screen.queryByText("Test person → Test application")).toBeNull();
});

it("does not steal focus moved away during a pending revocation", async () => {
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(revokeRecordedLocalGrant).mockImplementationOnce(async () => {
    await pending;
    vi.mocked(listRecordedLocalGrants).mockResolvedValue([]);
    notifyLocalIamChange();
  });
  render(
    <>
      <LocalAuthorityPanel tomb="vault-a" records="grant" />
      <button type="button">Another control</button>
    </>,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Revoke grant" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm revocation" }),
  );
  const other = screen.getByRole("button", { name: "Another control" });
  await userEvent.click(other);
  if (!release) throw new Error("Missing write completion");
  const finish = release;
  await act(async () => finish());
  await screen.findByText("Application grant revoked.");
  expect(document.activeElement).toBe(other);
  expect(revokeRecordedLocalGrant).toHaveBeenCalledTimes(1);
});
