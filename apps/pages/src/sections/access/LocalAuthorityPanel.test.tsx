/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as directory from "../../lib/local-directory.js";
import * as grants from "../../lib/local-grant-admin.js";
import {
  listRecordedLocalGrants,
  revokeRecordedLocalGrant,
} from "../../lib/local-grant-admin.js";
import { notifyLocalIamChange } from "../../lib/local-iam-events.js";
import * as sessions from "../../lib/local-sessions.js";
import {
  listLocalIdentitySessions,
  revokeLocalIdentitySession,
} from "../../lib/local-sessions.js";
import { LocalAuthorityPanel } from "./LocalAuthorityPanel.js";

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
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("lists local records without a backend and cancels with keyboard focus restored", async () => {
  render(<LocalAuthorityPanel tomb="vault-a" />);
  await screen.findByText("Test person → Test application");
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

it("shows only application grants and revokes through the same encrypted-store operation", async () => {
  render(<LocalAuthorityPanel tomb="vault-a" grantsOnly />);
  await screen.findByText("Test person → Test application");
  expect(
    screen.getByRole("heading", { name: "Local application grants" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Revoke session" })).toBeNull();
  expect(screen.queryByText(/Recorded sessions:/)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Revoke grant" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm revocation" }),
  );
  await screen.findByText("No unexpired local application grants.");
  expect(screen.getByText("Application grants: -")).toBeTruthy();
  expect(revokeRecordedLocalGrant).toHaveBeenCalledExactlyOnceWith(
    "vault-a",
    "grant-record",
  );
  expect(revokeLocalIdentitySession).not.toHaveBeenCalled();
});

it.each(["session", "grant"] as const)(
  "confirms only the selected %s and recovers focus",
  async (kind) => {
    render(<LocalAuthorityPanel tomb="vault-a" />);
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
  render(<LocalAuthorityPanel tomb="vault-a" />);
  await screen.findByRole("alert");
  expect(
    screen.queryByText("No unexpired local sessions or application grants."),
  ).toBeNull();
  expect(document.body.textContent).not.toContain("private diagnostic");
  await userEvent.click(
    screen.getByRole("button", { name: "Reload local access records" }),
  );
  await screen.findByText("Test person → Test application");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("retains confirmation on failed writes and never claims revocation succeeded", async () => {
  vi.mocked(revokeRecordedLocalGrant).mockRejectedValueOnce(
    new Error("private storage error"),
  );
  render(<LocalAuthorityPanel tomb="vault-a" />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Revoke grant" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm revocation" }),
  );
  await screen.findByText("Revocation was not confirmed. Reload and retry.");
  expect(
    screen.getByRole("button", { name: "Confirm revocation" }),
  ).toBeTruthy();
  expect(screen.queryByText("Application grant revoked.")).toBeNull();
});

it("refreshes external changes and shows a dash for no records", async () => {
  render(<LocalAuthorityPanel tomb="vault-a" />);
  await screen.findByText("Test person → Test application");
  vi.mocked(listLocalIdentitySessions).mockResolvedValue([]);
  vi.mocked(listRecordedLocalGrants).mockResolvedValue([]);
  act(() => notifyLocalIamChange());
  await screen.findByText("No unexpired local sessions or application grants.");
  expect(
    screen.getByText("Recorded sessions: - · Application grants: -"),
  ).toBeTruthy();
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
      <LocalAuthorityPanel tomb="vault-a" />
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
