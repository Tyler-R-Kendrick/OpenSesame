/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { createItem } from "@opensesame/vault-core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
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

function unlockedWith(items: ReturnType<typeof createItem>[]) {
  vi.spyOn(vaultHooksSeams, "useVault").mockReturnValue({
    ...vaultStore.getSnapshot(),
    status: "unlocked",
    awaitingSecondStep: false,
    tomb: "personal",
    items,
  });
  vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
    ...vaultStore.getSnapshot(),
    status: "unlocked",
    awaitingSecondStep: false,
    tomb: "personal",
    items,
  });
}

it("draws one finding per item, with each reason as a mark and a link to the item", async () => {
  const item = createItem("account", "Example");
  item.uris = [
    {
      id: "uri_1",
      uri: "https://user:pass@example.test/reset/PATH_SENTINEL?token=QUERY_SENTINEL",
      match: "domain",
    },
  ];
  const twin = createItem("account", "example");
  unlockedWith([item, twin]);
  vi.spyOn(organizationAuditSeams, "review").mockResolvedValue({
    summary: { items: 2, tagged: 0, untagged: 2 },
    duplicateTitles: [
      {
        title: "Example",
        items: [
          { id: item.id, title: "Example" },
          { id: twin.id, title: "example" },
        ],
      },
    ],
    untaggedMachineCredentials: [],
    oldLogins: [],
    urlsToReview: [
      {
        id: item.id,
        title: "Example",
        urls: ["https://example.test"],
        reason: "transient-url",
      },
    ],
  });
  render(
    <MemoryRouter>
      <OrganizationAudit />
    </MemoryRouter>,
  );
  await screen.findByText("2 items to file or rename");
  const link = screen.getByRole("link", { name: "Example" });
  expect(link.getAttribute("href")).toBe(`/vault/${item.id}`);
  expect(screen.getAllByRole("img", { name: "Duplicate title" })).toHaveLength(
    2,
  );
  expect(
    screen.getAllByRole("img", { name: "Address to review" }),
  ).toHaveLength(1);
  for (const sentinel of ["PATH_SENTINEL", "QUERY_SENTINEL", "user:pass"])
    expect(document.body.textContent).not.toContain(sentinel);
});

it("draws nothing for a vault with nothing to file", async () => {
  unlockedWith([]);
  const review = vi.spyOn(organizationAuditSeams, "review");
  const { container } = render(
    <MemoryRouter>
      <OrganizationAudit />
    </MemoryRouter>,
  );
  await waitFor(() => expect(review).toHaveBeenCalled());
  expect(container.querySelector("section")).toBeNull();
});
