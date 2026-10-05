/** @vitest-environment jsdom */
import { enablePepper } from "@opensesame/app-core/lib/vault/generators/index.js";
import { type VaultItem, passwordMethod } from "@opensesame/vault-core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../lib/vault/hooks.js";
import { makeAccount } from "../sections/vault/account.test-support.js";
import { CommandBar } from "./CommandBar.js";

const copy = vi.hoisted(() => vi.fn());
type VaultFixture = { current: { items: VaultItem[]; status: string } };
const vault = vi.hoisted(
  (): VaultFixture => ({ current: { items: [], status: "unlocked" } }),
);
const original = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useCopySecret: () => copy,
});
afterAll(() => Object.assign(vaultHooksSeams, original));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CommandBar with a peppered password", () => {
  it("asks for the pepper in the one prompt, copies on the right one, and returns focus", async () => {
    copy.mockResolvedValue({ ok: true as const, clearsInMs: 0 });
    const plain = makeAccount({ name: "Bank", password: "bank-password-1" });
    const method = passwordMethod(plain);
    if (!method) throw new Error("fixture");
    const sealed = await enablePepper(
      plain.id,
      method,
      "bank-password-1",
      "right",
    );
    vault.current = {
      items: [{ ...plain, methods: [sealed] }],
      status: "unlocked",
    };
    render(
      <MemoryRouter>
        <CommandBar />
      </MemoryRouter>,
    );
    const field = screen.getByLabelText("Command");
    await userEvent.type(field, "copy password for Bank{Enter}");
    expect(
      await screen.findByRole("dialog", { name: "Use pepper" }),
    ).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Pepper"), "right{Enter}");
    await waitFor(() => expect(copy).toHaveBeenCalledWith("bank-password-1"));
    await waitFor(() => expect(document.activeElement).toBe(field));
  }, 20_000);

  it("copies nothing when the prompt is closed", async () => {
    const plain = makeAccount({ name: "Bank", password: "bank-password-1" });
    const method = passwordMethod(plain);
    if (!method) throw new Error("fixture");
    const sealed = await enablePepper(
      plain.id,
      method,
      "bank-password-1",
      "right",
    );
    vault.current = {
      items: [{ ...plain, methods: [sealed] }],
      status: "unlocked",
    };
    render(
      <MemoryRouter>
        <CommandBar />
      </MemoryRouter>,
    );
    await userEvent.type(
      screen.getByLabelText("Command"),
      "copy password for Bank{Enter}",
    );
    await screen.findByRole("dialog", { name: "Use pepper" });
    await userEvent.keyboard("{Escape}{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(copy).not.toHaveBeenCalled();
  }, 20_000);
});
