import { expect } from "@playwright/test";
import { localAgentContract } from "./local-agent-contract.mjs";
import { localApplicationContract } from "./local-application-contract.mjs";
import { localDeviceContract } from "./local-device-contract.mjs";
import {
  expectIdentityRefusal,
  openIdentityRecord,
  openIdentityView,
} from "./local-directory-navigation.mjs";
import { localMemberOrganizationsContract } from "./local-member-organizations-contract.mjs";
import {
  localMembershipContract,
  localMembershipSetup,
} from "./local-membership-contract.mjs";
import { localPasskeyContract } from "./local-passkey-contract.mjs";

// The journey is a guest's. A guest administers Access only until a claimed
// (non-guest) owner or admin exists (`resolveCurrentAccessRole`), so the
// organization and the application are set up first and the owner is
// assigned last; the membership contract then proves the guest is refused.
export async function localDirectoryContract(page, tabTo) {
  await directoryRecordsContract(page, tabTo);
  await localDeviceContract(page, tabTo);
  await localMembershipSetup(page, tabTo);
  await localApplicationContract(page, tabTo);
  await localMembershipContract(page, tabTo);
  await localMemberOrganizationsContract(page, tabTo);
}

async function createDirectoryRecord(page, panel, tabTo, kind) {
  const create = panel.getByRole("button", {
    name: `New ${kind}`,
    exact: true,
  });
  await expect(create).toBeEnabled();
  await tabTo(page, create);
  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("textbox", { name: "Name", exact: true }),
  ).toBeFocused();
  if (kind === "person") {
    await page.keyboard.insertText("invalid\u202ename");
    await page.keyboard.press("Enter");
    await expectIdentityRefusal(page, tabTo, /without control characters/);
    await tabTo(
      page,
      panel.getByRole("textbox", { name: "Name", exact: true }),
    );
    await expect(
      panel.getByRole("textbox", { name: "Name", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("ControlOrMeta+A");
  }
  await page.keyboard.type(`Keyboard ${kind}`);
  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("heading", { name: `Keyboard ${kind}`, exact: true }),
  ).toBeVisible();
}

async function directoryRecordsContract(page, tabTo) {
  for (const [tab, kind] of [
    ["People", "person"],
    ["Agents", "agent"],
    ["Applications", "application"],
    ["Organizations", "organization"],
  ]) {
    await openIdentityView(page, tabTo, tab);
    const panel = page.locator('.record-workspace[data-section="Identity"]');
    await createDirectoryRecord(page, panel, tabTo, kind);
    let label = `Keyboard ${kind}`;
    const row = () => panel.locator(".vault__detail");
    if (kind === "person") {
      await localPasskeyContract(page, row(), tabTo);
    }
    if (kind === "agent") {
      await localAgentContract(page, row(), tabTo);
    }
    await tabTo(
      page,
      row().getByRole("button", { name: `Edit ${label}`, exact: true }),
    );
    await page.keyboard.press("Enter");
    const name = row().getByRole("textbox", { name: "Name", exact: true });
    await expect(name).toBeFocused();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type(`Renamed ${kind}`);
    await expect(name).toHaveValue(`Renamed ${kind}`);
    await expect(
      row().getByRole("button", { name: "Disable", exact: true }),
    ).toHaveCount(0);
    await expect(
      row().getByRole("button", { name: "Delete", exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press("Enter");
    label = `Renamed ${kind}`;
    await expect(
      row().getByRole("heading", { name: label, exact: true }),
    ).toBeVisible();
    await tabTo(
      page,
      row().getByRole("button", { name: "Disable", exact: true }),
    );
    await page.keyboard.press("Enter");
    await expect(row().locator(".detail__meta")).toContainText("Disabled");
    if (page.viewportSize().width <= 900) {
      await openIdentityView(
        page,
        tabTo,
        tab === "Agents" ? "People" : "Agents",
      );
      await openIdentityView(page, tabTo, tab);
      await openIdentityRecord(page, tabTo, label);
    } else {
      await tabTo(
        page,
        panel.getByRole("button", { name: "Reload directory", exact: true }),
      );
      await page.keyboard.press("Enter");
    }
    await expect(row().locator(".detail__meta")).toContainText("Disabled");
    await tabTo(
      page,
      row().getByRole("button", { name: "Delete", exact: true }),
    );
    await page.keyboard.press("Enter");
    await tabTo(
      page,
      row().getByRole("button", { name: "Confirm deletion", exact: true }),
    );
    await page.keyboard.press("Enter");
    await expect(
      panel.getByRole("heading", { name: label, exact: true }),
    ).toHaveCount(0);
    const nextFocus =
      page.viewportSize().width <= 900
        ? panel.getByRole("tree", { name: `${tab} items` })
        : panel.getByRole("button", { name: `New ${kind}`, exact: true });
    await expect(nextFocus).toBeFocused();
  }
}
