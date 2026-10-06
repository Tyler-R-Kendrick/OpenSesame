/** @vitest-environment jsdom */
import { shareReachSeams } from "@opensesame/app-core/lib/local-share-reach.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import type { VaultState } from "@opensesame/app-core/lib/vault/store-state.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { createItem, manualPassword } from "@opensesame/vault-core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { downloadSeams } from "../../screens/capabilities/download.js";
import { PasswordWorkflowsPanel } from "./PasswordWorkflows.js";
import { persistPasswordTestItem } from "./account-password-test-context.js";

afterEach(() => {
  cleanup();
  clearNotices();
  vi.restoreAllMocks();
});
describe("PWA password workflows", () => {
  it("selects an account password method explicitly and keeps sibling methods intact", async () => {
    const account = createItem("account", "Multiple methods");
    account.methods = [
      manualPassword("first", "PRIVATE_FIRST", account.createdAt),
      manualPassword("second", "PRIVATE_SECOND", account.createdAt),
      {
        ...manualPassword(
          "protected",
          "PRIVATE_SLOTTED_SENTINEL",
          account.createdAt,
        ),
        pepper: true,
      },
    ];
    const state: VaultState = {
      ...vaultStore.getSnapshot(),
      status: "unlocked",
      awaitingSecondStep: false,
      tomb: "personal",
      items: [account],
    };
    vi.spyOn(vaultStore, "getSnapshot").mockImplementation(() => state);
    vi.spyOn(vaultHooksSeams, "useVault").mockImplementation(() => state);
    vi.spyOn(shareReachSeams, "resolveCurrentAccessRole").mockResolvedValue(
      "operator",
    );
    vi.spyOn(shareReachSeams, "canAccess").mockReturnValue(true);
    const save = vi
      .spyOn(vaultStore, "saveItem")
      .mockImplementation(async (next) => {
        state.items = persistPasswordTestItem(state.items, next);
      });
    const user = userEvent.setup();
    render(<PasswordWorkflowsPanel />);
    await user.selectOptions(
      screen.getByLabelText("Account", { exact: true }),
      account.id,
    );
    expect(
      screen
        .getByRole("option", { name: "Password 3 (private input required)" })
        .getAttribute("disabled"),
    ).not.toBeNull();
    await user.selectOptions(
      screen.getByLabelText("Password method", { exact: true }),
      "second",
    );
    await user.type(
      screen.getByLabelText("Private password"),
      "PRIVATE_REPLACEMENT",
    );
    await user.click(screen.getByRole("button", { name: "Update and verify" }));
    await screen.findByText(/"verified": true/);
    const saved = state.items[0];
    if (saved?.kind !== "account")
      throw new Error("Expected the updated account.");
    expect(saved.methods[0]).toEqual(account.methods[0]);
    expect(saved.methods[1]).toMatchObject({
      id: "second",
      secret: "PRIVATE_REPLACEMENT",
    });
    expect(saved.methods[2]).toEqual(account.methods[2]);
    expect(save).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("PRIVATE_REPLACEMENT");
  });
  it("runs discovery, inventory, audit, template creation and private verified writes through shared core", async () => {
    const credential = createItem("secret", "OpenAI");
    credential.value = "SECRET_SENTINEL";
    const login = createItem("account", "Example");
    login.methods = [
      manualPassword("password-primary", "old", login.createdAt),
    ];
    const state: VaultState = {
      ...vaultStore.getSnapshot(),
      status: "unlocked",
      awaitingSecondStep: false,
      tomb: "personal",
      items: [credential, login],
    };
    vi.spyOn(vaultStore, "getSnapshot").mockImplementation(() => state);
    vi.spyOn(vaultHooksSeams, "useVault").mockImplementation(() => state);
    vi.spyOn(shareReachSeams, "resolveCurrentAccessRole").mockResolvedValue(
      "operator",
    );
    vi.spyOn(shareReachSeams, "canAccess").mockReturnValue(true);
    vi.spyOn(vaultStore, "saveItem").mockImplementation(async (item) => {
      state.items = persistPasswordTestItem(state.items, item);
    });
    const save = vi.spyOn(downloadSeams, "save").mockImplementation(() => {});
    const user = userEvent.setup();
    render(<PasswordWorkflowsPanel />);
    await user.type(
      screen.getByLabelText("Title queries, one per line"),
      "openai\nexample",
    );
    await user.click(screen.getByRole("button", { name: /^Find$/ }));
    expect(
      (await screen.findByLabelText("Workflow result")).textContent,
    ).toContain("os://personal/");
    expect(screen.getByLabelText("Workflow result").textContent).not.toContain(
      "SECRET_SENTINEL",
    );
    await user.click(screen.getByRole("button", { name: /^Inventory$/ }));
    expect(
      (await screen.findByLabelText("Workflow result")).textContent,
    ).toContain('"fields"');
    await user.click(
      screen.getByRole("button", { name: "Audit organization" }),
    );
    expect(
      (await screen.findByLabelText("Workflow result")).textContent,
    ).toContain('"items": 2');
    await user.type(
      screen.getByLabelText("Assignments, one NAME=reference per line"),
      "KEY=os://personal/item/value",
    );
    await user.click(
      screen.getByRole("button", { name: "Save reference template" }),
    );
    expect(save).toHaveBeenCalledWith(
      ".env.tpl",
      "KEY=os://personal/item/value\n",
      "text/plain",
    );
    const localRef = `os://personal/${credential.id}/value`;
    await user.clear(
      screen.getByLabelText("Assignments, one NAME=reference per line"),
    );
    await user.type(
      screen.getByLabelText("Assignments, one NAME=reference per line"),
      `KEY=${localRef}`,
    );
    await user.click(
      screen.getByLabelText(
        "I want a plaintext credential file on this device.",
      ),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Resolve and download plaintext env",
      }),
    );
    expect(save).toHaveBeenCalledWith(
      ".env",
      'KEY="SECRET_SENTINEL"',
      "text/plain",
    );
    expect(screen.getByLabelText("Workflow result").textContent).not.toContain(
      "SECRET_SENTINEL",
    );
    await user.type(screen.getByLabelText("Local secret reference"), localRef);
    await user.click(
      screen.getByLabelText("I want this credential in a plaintext file."),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Read and download plaintext credential",
      }),
    );
    expect(save).toHaveBeenCalledWith(
      "credential.txt",
      "SECRET_SENTINEL",
      "text/plain",
    );
    await user.type(screen.getByLabelText("Title", { exact: true }), "New API");
    await user.type(
      screen.getByLabelText("Private credential"),
      "PRIVATE_INPUT_SENTINEL",
    );
    await user.click(screen.getByRole("button", { name: "Create and verify" }));
    expect(
      (await screen.findByLabelText("Workflow result")).textContent,
    ).toContain('"verified": true');
    expect(screen.getByLabelText("Workflow result").textContent).not.toContain(
      "PRIVATE_INPUT_SENTINEL",
    );
    expect(screen.getByLabelText("Private credential")).toHaveProperty(
      "value",
      "",
    );
    await user.selectOptions(screen.getByLabelText("Account"), login.id);
    await user.type(screen.getByLabelText("Private password"), "new");
    await user.click(screen.getByRole("button", { name: /^Compare$/ }));
    expect(
      (await screen.findByLabelText("Workflow result")).textContent,
    ).toContain('"matches": false');
    await user.type(screen.getByLabelText("Private password"), "new");
    await user.click(screen.getByRole("button", { name: "Update and verify" }));
    expect(
      (await screen.findByLabelText("Workflow result")).textContent,
    ).toContain('"verified": true');
    expect(state.items.find((item) => item.id === login.id)).toMatchObject({
      methods: [
        expect.objectContaining({ id: "password-primary", secret: "new" }),
      ],
    });
  });
  it("shows the unlock gate rather than private inputs when locked", () => {
    vi.spyOn(vaultHooksSeams, "useVault").mockReturnValue({
      ...vaultStore.getSnapshot(),
      status: "locked",
    });
    render(<PasswordWorkflowsPanel />);
    expect(
      screen.getByText("Unlock the vault to use password workflows."),
    ).toBeDefined();
    expect(screen.queryByLabelText("Private credential")).toBeNull();
  });
  it("suppresses uncertain credential and password write failures in the human tray without retry", async () => {
    const login = createItem("account", "Example");
    login.methods = [
      manualPassword("password-primary", "old", login.createdAt),
    ];
    const state: VaultState = {
      ...vaultStore.getSnapshot(),
      status: "unlocked",
      awaitingSecondStep: false,
      tomb: "personal",
      items: [login],
    };
    vi.spyOn(vaultStore, "getSnapshot").mockReturnValue(state);
    vi.spyOn(vaultHooksSeams, "useVault").mockReturnValue(state);
    vi.spyOn(shareReachSeams, "resolveCurrentAccessRole").mockResolvedValue(
      "operator",
    );
    vi.spyOn(shareReachSeams, "canAccess").mockReturnValue(true);
    const save = vi
      .spyOn(vaultStore, "saveItem")
      .mockRejectedValue(new Error("PRIVATE_FAILURE_SENTINEL"));
    const user = userEvent.setup();
    render(<PasswordWorkflowsPanel />);
    await user.type(screen.getByLabelText("Title", { exact: true }), "New");
    await user.type(
      screen.getByLabelText("Private credential"),
      "PRIVATE_FAILURE_SENTINEL",
    );
    await user.click(screen.getByRole("button", { name: "Create and verify" }));
    expect(
      listNotices()
        .map((notice) => notice.body)
        .join(" "),
    ).toContain("unverified");
    expect(
      listNotices()
        .map((notice) => notice.body)
        .join(" "),
    ).not.toContain("PRIVATE_FAILURE_SENTINEL");
    expect(save).toHaveBeenCalledTimes(1);
    await user.selectOptions(screen.getByLabelText("Account"), login.id);
    await user.type(
      screen.getByLabelText("Private password"),
      "PRIVATE_FAILURE_SENTINEL",
    );
    await user.click(screen.getByRole("button", { name: "Update and verify" }));
    expect(
      listNotices()
        .map((notice) => notice.body)
        .join(" "),
    ).toContain("unverified");
    expect(
      listNotices()
        .map((notice) => notice.body)
        .join(" "),
    ).not.toContain("PRIVATE_FAILURE_SENTINEL");
    expect(save).toHaveBeenCalledTimes(2);
    expect(login.methods[0]).toMatchObject({ secret: "old" });
  });
});
