import { withLocalDirectoryLock } from "@opensesame/app-core/lib/local-directory.js";
import {
  localRequestDigest,
  writeLocalRequestRecords,
} from "@opensesame/app-core/lib/local-request-store.js";
import { lockAllTombs, unlockTomb } from "@opensesame/app-core/lib/vfs.js";
/** @vitest-environment jsdom */
import type { LocalAccessRequestRecord } from "@opensesame/contracts";
import { mintVaultKey } from "@opensesame/vault-core";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalRequestsPanel } from "./LocalRequestsPanel.js";
import { renderAccess as render } from "./workspace-test-support.js";

let tomb: string;
const now = 1788998400000;
beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(now + 2);
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  tomb = `requests-ui-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  let queue = Promise.resolve();
  vi.stubGlobal("navigator", {
    locks: {
      request: <T,>(_name: string, action: () => Promise<T>) => {
        const next = queue.then(action);
        queue = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
    },
  });
});
afterEach(() => {
  cleanup();
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Overrides = Partial<
  Pick<LocalAccessRequestRecord, "authorizationDigest" | "reason">
>;

async function request(
  extra: Overrides = {},
): Promise<LocalAccessRequestRecord> {
  const base = {
    id: crypto.randomUUID(),
    version: 0,
    requesterId: `local_${crypto.randomUUID()}`,
    requesterSessionId: crypto.randomUUID(),
    applicationId: `local_${crypto.randomUUID()}`,
    organizationId: `local_${crypto.randomUUID()}`,
    applicationRevision: 1,
    directoryRevision: 0,
    redirectUri: "https://rp.example.test/callback",
    scopes: ["openid"],
    reason: "Review this request",
    createdAt: now,
    expiresAt: now + 300_000,
    status: "pending" as const,
    ...extra,
  };
  return { ...base, requestDigest: await localRequestDigest(base) };
}

async function refresh(requests: LocalAccessRequestRecord[]) {
  await withLocalDirectoryLock(tomb, () =>
    writeLocalRequestRecords(tomb, requests),
  );
}

it("does not offer a sign-in that is being consented to in its own window", async () => {
  const asked = await request();
  const signIn = await request({
    reason: "Application sign-in",
    authorizationDigest: "A".repeat(43),
  });
  await refresh([asked, signIn]);
  render(
    <LocalRequestsPanel tomb={tomb} />,
    "/access?view=requests#local-requests",
  );
  await screen.findByRole("treeitem");
  // Two requests are stored and one is shown: the other is decided where it was
  // raised, and a decision made here would only make that one fail.
  expect(screen.getAllByRole("treeitem")).toHaveLength(1);
});

it.each(["expired", "revoked", "denied", "approved"] as const)(
  "updates an open pending review to refreshed %s without retaining approval controls",
  async (status) => {
    const pending = await request();
    await refresh([pending]);
    render(
      <LocalRequestsPanel tomb={tomb} />,
      "/access?view=requests#local-requests",
    );
    await userEvent.click(await screen.findByRole("treeitem"));
    expect(
      screen.getByRole("button", { name: "Approve with passkey" }),
    ).toBeTruthy();
    const close = screen.getByRole("button", { name: "Close request" });
    close.focus();
    if (status === "expired")
      vi.spyOn(Date, "now").mockReturnValue(pending.expiresAt);
    const updated: LocalAccessRequestRecord = {
      ...pending,
      status: status === "expired" ? "pending" : status,
      version: 1,
    };
    if (status === "approved" || status === "denied") {
      // Display-only public metadata; cryptographic decisions are tested in the core suite.
      updated.decidedAt = now + 1;
      updated.approval = {
        principalId: pending.requesterId,
        credentialId: "display-fixture-public-credential",
        credentialCreatedAt: now,
        publicKeyB64: "display-fixture-public-key",
        authTime: now + 1,
        decisionDigest: pending.requestDigest,
      };
    }
    await refresh([updated]);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Approve with passkey" }),
      ).toBeNull(),
    );
    expect(
      screen.queryByRole("button", { name: "Deny with passkey" }),
    ).toBeNull();
    expect(document.activeElement).toBe(close);
  },
);

it("closes a removed review and restores its reload fallback", async () => {
  await refresh([await request()]);
  render(
    <LocalRequestsPanel tomb={tomb} />,
    "/access?view=requests#local-requests",
  );
  await userEvent.click(await screen.findByRole("treeitem"));
  await refresh([]);
  await waitFor(() =>
    expect(
      screen.queryByRole("group", { name: "Review local request" }),
    ).toBeNull(),
  );
  expect(
    screen.getByRole("button", { name: "New local request" }),
  ).toHaveProperty("disabled", false);
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Reload local requests" }),
  );
});
