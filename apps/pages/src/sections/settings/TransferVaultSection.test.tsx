/** @vitest-environment jsdom */
import { changeLocalDirectory } from "@opensesame/app-core/lib/local-directory-admin.js";
import { readLocalDirectory } from "@opensesame/app-core/lib/local-directory.js";
import { lockAllTombs, unlockTomb } from "@opensesame/app-core/lib/vfs.js";
import { mintVaultKey } from "@opensesame/vault-core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { testLockManager } from "../../test-support/lock-manager.js";
import { TransferVaultSection } from "./TransferVaultSection.js";

let tomb: string;
const realUseVault = vaultHooksSeams.useVault;

type Change = Parameters<typeof changeLocalDirectory>[2];

async function seed(extra: Change[] = []) {
  let dir = await changeLocalDirectory(tomb, 0, {
    action: "create",
    kind: "organization",
    name: "Home",
  });
  const apply = async (change: Change) => {
    dir = await changeLocalDirectory(tomb, dir.revision, change);
  };
  const id = (name: string) => {
    const found = dir.entries.find((entry) => entry.name === name);
    if (!found) throw new Error(`${name} missing`);
    return found.id;
  };
  await apply({ action: "create", kind: "person", name: "Ada" });
  await apply({ action: "create", kind: "person", name: "Grace" });
  await apply({
    action: "membership",
    organizationId: id("Home"),
    principalId: id("Ada"),
    role: "owner",
  });
  for (const change of extra) await apply(change);
  return { org: id("Home"), ada: id("Ada"), grace: id("Grace") };
}

beforeEach(async () => {
  tomb = `transfer-section-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  vi.stubGlobal("navigator", { ...navigator, locks: testLockManager });
  vaultHooksSeams.useVault = () => ({ ...realUseVault(), tomb, guest: false });
});
afterEach(() => {
  cleanup();
  lockAllTombs();
  vi.unstubAllGlobals();
  vaultHooksSeams.useVault = realUseVault;
});

describe("Danger zone › Transfer ownership", () => {
  it("is not drawn when no other registered user could receive the vault", async () => {
    await changeLocalDirectory(tomb, 0, {
      action: "create",
      kind: "person",
      name: "Ada",
    });
    const { container } = render(<TransferVaultSection />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.textContent).toBe("");
  });

  it("transfers to the chosen user once their name is typed back", async () => {
    const ids = await seed();
    render(<TransferVaultSection />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Transfer ownership" }),
    );
    const sheet = await screen.findByRole("dialog", {
      name: "Transfer ownership",
    });
    const send = within(sheet).getByRole<HTMLButtonElement>("button", {
      name: "Transfer ownership",
    });
    expect(send.disabled).toBe(true);

    fireEvent.click(within(sheet).getByRole("button", { name: "Grace" }));
    expect(send.disabled).toBe(true);
    fireEvent.change(within(sheet).getByLabelText("Type Grace to confirm"), {
      target: { value: "Grace" },
    });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);

    await waitFor(async () => {
      const dir = await readLocalDirectory(tomb);
      const role = (id: string) =>
        dir.memberships.find(
          (row) => row.organizationId === ids.org && row.principalId === id,
        )?.role;
      expect(role(ids.grace)).toBe("owner");
      expect(role(ids.ada)).toBe("admin");
    });
  });

  it("offers neither a guest nor a disabled person", async () => {
    const ids = await seed();
    await changeLocalDirectory(
      tomb,
      (await readLocalDirectory(tomb)).revision,
      { action: "create", kind: "person", name: "Guest 1" },
    );
    await changeLocalDirectory(
      tomb,
      (await readLocalDirectory(tomb)).revision,
      { action: "update", id: ids.grace, name: "Grace", enabled: false },
    );
    const { container } = render(<TransferVaultSection />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.textContent).toBe("");
  });
});
