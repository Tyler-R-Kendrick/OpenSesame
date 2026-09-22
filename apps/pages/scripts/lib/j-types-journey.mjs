/**
 * J-TYPES: paste an inert VaultItemType, install without reload, remove it
 * without rewriting the item values it shaped (ADR 0087 §7).
 */
import { openSettingsCategory, sealWithPassword } from "./pages-journey.mjs";

const TICKET = JSON.stringify({
  apiVersion: "opensesame.dev/v1alpha1",
  kind: "VaultItemType",
  metadata: {
    id: "event-ticket",
    version: "1.0.0",
    publisher: "https://community.test",
  },
  spec: {
    title: "Event ticket",
    plural: "Event tickets",
    extension: ".ticket",
    summary: "A booking reference and the seat it holds.",
    categories: ["documents"],
    sections: [
      {
        id: "booking",
        title: "Booking",
        fields: [
          { id: "event", type: "string", label: "Event", required: true },
          { id: "seat", type: "string", label: "Seat" },
          { id: "reference", type: "concealed", label: "Booking reference" },
        ],
      },
    ],
    native: {
      secret: "reference",
      trailer: [
        { key: "event", field: "event" },
        { key: "seat", field: "seat" },
      ],
    },
    cxf: { credential: "custom-fields" },
    subtitle: ["event", "seat"],
    search: ["event"],
  },
});

export async function walkJTypes({ page, origin, base, check, snap }) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPassword(page);
  await openSettingsCategory(page, "Vaults");
  await page.getByRole("heading", { name: "Item types" }).waitFor({
    timeout: 15000,
  });
  const list = page.getByRole("list", { name: "Installed types" });
  await list.waitFor({ timeout: 8000 });
  check(
    (await list.locator("li").count()) > 0,
    "built-in types are listed before anything is installed",
  );
  await page.getByLabel("Add a type").fill(TICKET);
  await page.getByRole("button", { name: "Install type" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /no reload/i })
    .waitFor({ timeout: 10000 });
  check(true, "install reports no reload needed");
  await page
    .getByRole("list", { name: "Installed types" })
    .getByText("Event ticket")
    .waitFor({ timeout: 8000 });
  await snap(page, "J-TYPES-installed");
  await page.getByRole("button", { name: "Remove Event ticket" }).click();
  await page.getByRole("button", { name: "Confirm removal" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /kept/i })
    .waitFor({ timeout: 10000 });
  check(true, "remove keeps item values");
  await snap(page, "J-TYPES-removed");
}
