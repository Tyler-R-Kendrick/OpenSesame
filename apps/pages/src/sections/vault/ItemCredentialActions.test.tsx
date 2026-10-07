/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { createItem, manualPassword } from "@opensesame/vault-core";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { downloadSeams } from "../../screens/capabilities/download.js";
import {
  admitConnectorOwner,
  releaseConnectorOwner,
} from "../settings/connector-owner.test-support.js";
import { ItemCredentialActions } from "./ItemCredentialActions.js";
import { OrganizationAudit } from "./OrganizationAudit.js";

beforeEach(admitConnectorOwner);
afterEach(async () => {
  cleanup();
  clearNotices();
  await releaseConnectorOwner();
  vi.restoreAllMocks();
});
function fixture() {
  const item = createItem("account", "Example");
  item.methods = [
    manualPassword(
      "password-primary",
      "PRIVATE_CONTEXT_SENTINEL",
      "2020-01-01T00:00:00Z",
    ),
  ];
  item.username = "unchanged";
  item.fields = [
    {
      id: "extra",
      name: "Extra",
      hidden: true,
      value: "CUSTOM_PRIVATE_SENTINEL",
    },
  ];
  item.updatedAt = "2020-01-01T00:00:00Z";
  item.uris = [
    {
      id: "uri_fixture",
      uri: "https://user:pass@example.test/reset/PATH_SENTINEL?token=QUERY_SENTINEL",
      match: "domain",
    },
  ];
  const save = vi.spyOn(vaultStore, "saveItem");
  return { item, save };
}
it("runs contextual reference template/read and password compare/apply through shared core", async () => {
  const { item, save } = fixture();
  const download = vi.spyOn(downloadSeams, "save").mockImplementation(() => {});
  const user = userEvent.setup();
  await vaultStore.replaceAll([item], []);
  render(<ItemCredentialActions item={item} />);
  await screen.findByRole("button", {
    name: "Download Password reference template",
  });
  expect(document.body.textContent).not.toContain("PRIVATE_CONTEXT_SENTINEL");
  expect(document.body.textContent).not.toContain("CUSTOM_PRIVATE_SENTINEL");
  await user.click(
    screen.getByRole("button", {
      name: "Download Password reference template",
    }),
  );
  expect(download).toHaveBeenCalledWith(
    ".env.tpl",
    `CREDENTIAL=os://personal/${item.id}/method%3Apassword-primary%3Asecret\n`,
    "text/plain",
  );
  const confirmations = screen.getAllByLabelText(
    "Download this credential as plaintext on this device",
  );
  await user.click(confirmations[0]);
  await user.click(
    screen.getByRole("button", {
      name: "Download Password plaintext credential",
    }),
  );
  expect(download).toHaveBeenCalledWith(
    "credential.txt",
    "PRIVATE_CONTEXT_SENTINEL",
    "text/plain",
  );
  expect(document.body.textContent).not.toContain("PRIVATE_CONTEXT_SENTINEL");
  await user.type(
    screen.getByLabelText("Candidate password"),
    "new-private-password",
  );
  await user.click(
    screen.getByRole("button", { name: "Compare this password" }),
  );
  await screen.findByText("Password differs.");
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Candidate password")).toHaveProperty(
    "value",
    "",
  );
  await user.type(
    screen.getByLabelText("Candidate password"),
    "new-private-password",
  );
  await user.click(
    screen.getByRole("button", { name: "Apply and verify this password" }),
  );
  await screen.findByText("Password updated and verified.");
  expect(vaultStore.getSnapshot().items[0]).toMatchObject({
    username: "unchanged",
    methods: [
      expect.objectContaining({
        id: "password-primary",
        secret: "new-private-password",
      }),
    ],
    fields: item.fields,
  });
});
it("shows safe organization findings in password health with item navigation", async () => {
  const { item } = fixture();
  await vaultStore.replaceAll([item], []);
  const rendered = render(
    <MemoryRouter>
      <OrganizationAudit />
    </MemoryRouter>,
  );
  await screen.findByText("1 active items reviewed");
  const links = screen.getAllByRole("link", { name: "Example" });
  expect(links).toHaveLength(2);
  expect(links[0]?.getAttribute("href")).toBe(`/vault/${item.id}`);
  for (const sentinel of [
    "PRIVATE_CONTEXT_SENTINEL",
    "PATH_SENTINEL",
    "QUERY_SENTINEL",
    "user:pass",
  ])
    expect(document.body.textContent).not.toContain(sentinel);
  await act(async () => {
    await vaultStore.replaceAll([], []);
  });
  rendered.rerender(
    <MemoryRouter>
      <OrganizationAudit />
    </MemoryRouter>,
  );
  expect(screen.queryByRole("link", { name: "Example" })).toBeNull();
  await screen.findByText("0 active items reviewed");
});
it("suppresses uncertain private write details and refuses locked contextual operations", async () => {
  const { item, save } = fixture();
  save.mockRejectedValue(new Error("PRIVATE_CONTEXT_SENTINEL"));
  const user = userEvent.setup();
  await vaultStore.replaceAll([item], []);
  const rendered = render(<ItemCredentialActions item={item} />);
  await user.type(
    screen.getByLabelText("Candidate password"),
    "PRIVATE_CONTEXT_SENTINEL-new",
  );
  await user.click(
    screen.getByRole("button", { name: "Apply and verify this password" }),
  );
  await waitFor(() =>
    expect(
      listNotices().some((notice) => notice.body.includes("unverified")),
    ).toBe(true),
  );
  expect(JSON.stringify(listNotices())).not.toContain(
    "PRIVATE_CONTEXT_SENTINEL",
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.body.textContent).not.toContain("PRIVATE_CONTEXT_SENTINEL");
  expect(save).toHaveBeenCalledTimes(1);
  act(() => vaultStore.lock());
  rendered.rerender(<ItemCredentialActions item={item} />);
  expect(screen.queryByLabelText("Candidate password")).toBeNull();
});
it("updates the selected account password method and preserves protected and sibling methods", async () => {
  const { item, save } = fixture();
  const secondary = manualPassword(
    "password-secondary",
    "SECONDARY_PRIVATE_SENTINEL",
    item.createdAt,
  );
  const protectedMethod = {
    ...manualPassword(
      "password-protected",
      "PRIVATE_SLOTTED_SENTINEL",
      item.createdAt,
    ),
    pepper: true,
  };
  item.methods.push(secondary, protectedMethod);
  const user = userEvent.setup();
  await vaultStore.replaceAll([item], []);
  render(<ItemCredentialActions item={item} />);
  const selected = within(
    screen.getByRole("group", { name: "Compare password 2" }),
  );
  await user.type(
    selected.getByLabelText("Candidate password"),
    "replacement-private-password",
  );
  await user.click(
    selected.getByRole("button", { name: "Apply and verify this password" }),
  );
  await selected.findByText("Password updated and verified.");
  expect(
    selected.getByLabelText("Candidate password").getAttribute("value"),
  ).toBe("");
  const saved = vaultStore.getSnapshot().items[0];
  if (saved?.kind !== "account")
    throw new Error("Expected the updated account.");
  expect(saved.methods[0]).toEqual(item.methods[0]);
  expect(saved.methods[1]).toMatchObject({
    id: secondary.id,
    secret: "replacement-private-password",
  });
  expect(saved.methods[2]).toEqual(protectedMethod);
  expect(saved.fields).toEqual(item.fields);
  expect(save).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByRole("group", { name: "Compare password 3" }),
  ).toBeNull();
  expect(screen.getByText(/Password 3 needs private input/)).toBeTruthy();
  expect(document.body.textContent).not.toContain("SECONDARY_PRIVATE_SENTINEL");
  expect(document.body.textContent).not.toContain(
    "replacement-private-password",
  );
});
it("keeps references and the comparison guide on the first usable password when a protected method comes first", async () => {
  const { item } = fixture();
  item.methods.unshift({
    ...manualPassword(
      "protected-first",
      "PRIVATE_SLOTTED_SENTINEL",
      item.createdAt,
    ),
    pepper: true,
  });
  await vaultStore.replaceAll([item], []);
  render(<ItemCredentialActions item={item} />);
  await screen.findByRole("button", {
    name: "Download Password 2 reference template",
  });
  expect(
    screen.queryByRole("button", {
      name: "Download Password 1 reference template",
    }),
  ).toBeNull();
  expect(
    screen
      .getByRole("group", { name: "Compare password 2" })
      .getAttribute("data-guide-targets"),
  ).toContain("item.credentials.compare");
  expect(
    screen.queryByRole("group", { name: "Compare password 1" }),
  ).toBeNull();
});
