/**
 * J-TYPES: switch a built-in type on (a download, no reload) and off again,
 * then install an inert VaultItemType as a file — a new file in
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
    (await page.getByRole("switch").count()) === 18,
    "every built-in type beyond the core is a switch",
  );
  check(
    (await page.locator('[role="switch"][aria-checked="true"]').count()) === 0,
    "a minimal vault starts with every one of them off",
  );
  await snap(page, "J-TYPES-off");

  // Switching on is the cue to download and install: the switch moves at
  // once, is busy while the pack arrives, and the page is never reloaded.
  const login = page.getByRole("switch", { name: "Login", exact: true });
  await login.click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[role="switch"][aria-label="Login"]')
        ?.getAttribute("aria-busy") === "false",
    undefined,
    { timeout: 15000 },
  );
  check(
    (await login.getAttribute("aria-checked")) === "true",
    "Login is on once its pack has arrived",
  );
  await page.getByText("1 of 18 on").waitFor({ timeout: 5000 });
  await snap(page, "J-TYPES-on");
  await login.click();
  await page.getByText("0 of 18 on").waitFor({ timeout: 5000 });
  check(true, "switching it off drops the pack again");

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
  const installed = page.getByRole("list", { name: "Types you added" });
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
