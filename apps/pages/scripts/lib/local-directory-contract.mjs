import { expect } from "@playwright/test";
import { localAgentContract } from "./local-agent-contract.mjs";
import { localApplicationContract } from "./local-application-contract.mjs";
import { localMembershipContract } from "./local-membership-contract.mjs";
import { localPasskeyContract } from "./local-passkey-contract.mjs";

export async function localDirectoryContract(page, tabTo) {
  await directoryRecordsContract(page, tabTo);
  await localMembershipContract(page, tabTo);
  await localApplicationContract(page, tabTo);
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
    await expect(panel.getByRole("alert")).toHaveText(
      /without control characters/,
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
  for (const [tab, kind, heading] of [
    ["People", "person", "people"],
    ["Agents", "agent", "agents"],
    ["Applications", "application", "applications"],
    ["Organization", "organization", "organizations"],
  ]) {
    await tabTo(page, page.getByRole("tab", { name: tab, exact: true }));
    await page.keyboard.press("Enter");
    const panel = page.getByRole("region", {
      name: `Local ${heading}`,
      exact: true,
    });
    await createDirectoryRecord(page, panel, tabTo, kind);
    let label = `Keyboard ${kind}`;
    const row = () => panel.getByRole("listitem").filter({ hasText: label });
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
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type(`Renamed ${kind}`);
    await expect(
      row().getByRole("button", { name: "Disable", exact: true }),
    ).toBeDisabled();
    await expect(
      row().getByRole("button", { name: "Delete", exact: true }),
    ).toBeDisabled();
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
    await expect(row().getByText("Disabled", { exact: true })).toBeVisible();
    await tabTo(
      page,
      panel.getByRole("button", { name: "Reload directory", exact: true }),
    );
    await page.keyboard.press("Enter");
    await expect(row().getByText("Disabled", { exact: true })).toBeVisible();
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
  }
}
