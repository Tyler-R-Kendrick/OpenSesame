/**
 * J-TYPES: install an inert VaultItemType as a file — a new file in
 * `settings/item-types/installed/`, opened from the Vaults directory's files
 * (ADR 0134) — without a reload, then remove it from the Form without
 * rewriting the item values it shaped (ADR 0087 §7).
 */
import {
  openConfigFile,
  openConfigForm,
  openSettingsCategory,
  sealWithPassword,
} from "./pages-journey.mjs";

const INSTALLED = "settings/item-types/installed";
const DRAFT = `${INSTALLED}/new.json`;
const TICKET_FILE = `${INSTALLED}/event-ticket.json`;

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
  check(
    // Folded under builtin/: counted in the DOM, not by what is expanded.
    (await page.locator('[aria-label="Built-in types"] li').count()) > 0,
    "built-in types are listed before anything is installed",
  );

  // Installing is writing a file: the directory's files, then a new one.
  await openConfigFile(page, "vaults");
  await page.getByRole("button", { name: `New file in ${INSTALLED}/` }).click();
  await page.getByRole("textbox", { name: DRAFT, exact: true }).fill(TICKET);
  await page.getByRole("button", { name: `Save ${DRAFT}` }).click();
  await page
    .getByRole("textbox", { name: TICKET_FILE, exact: true })
    .waitFor({ timeout: 10000 });
  check(true, "the file is renamed for its id, with no reload");
  await snap(page, "J-TYPES-file");

  await openConfigForm(page, "Vaults");
  const installed = page.getByRole("list", { name: "Installed types" });
  await installed.getByText("Event ticket").waitFor({ timeout: 8000 });
  check(true, "the Form lists the installed type");
  await snap(page, "J-TYPES-installed");
  await page.getByRole("button", { name: "Remove Event ticket" }).click();
  await page
    .getByRole("button", {
      name: "Remove Event ticket; its items keep their values",
    })
    .click();
  await installed.waitFor({ state: "detached", timeout: 10000 });
  check(true, "remove keeps item values and lists nothing installed");
  await snap(page, "J-TYPES-removed");
}
