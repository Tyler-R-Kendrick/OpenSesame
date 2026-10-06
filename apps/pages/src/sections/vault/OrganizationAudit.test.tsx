/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { createItem } from "@opensesame/vault-core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import {
  OrganizationAudit,
  organizationAuditSeams,
} from "./OrganizationAudit.js";
afterEach(() => {
  cleanup();
  clearNotices();
  vi.restoreAllMocks();
});
it("reports an unavailable review in the tray without exposing provider failures", async () => {
  vi.spyOn(organizationAuditSeams, "review").mockRejectedValue(
    new Error("PRIVATE_AUDIT_SENTINEL"),
  );
  vi.spyOn(vaultHooksSeams, "useVault").mockReturnValue({
    ...vaultStore.getSnapshot(),
    status: "unlocked",
    awaitingSecondStep: false,
    items: [createItem("account", "Account")],
  });
  render(<OrganizationAudit />);
  await waitFor(() => {
    expect(
      listNotices().find((notice) => notice.id === "vault:organization-audit")
        ?.body,
    ).toBe("Organization review unavailable.");
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    listNotices()
      .map((notice) => notice.body)
      .join(" "),
  ).not.toContain("PRIVATE_AUDIT_SENTINEL");
});
