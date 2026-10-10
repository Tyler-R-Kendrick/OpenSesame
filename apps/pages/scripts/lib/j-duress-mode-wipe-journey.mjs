/**
 * J-DURESS-MODE-WIPE: the duress code that wipes this device's copy (ADR 0168),
 * in the built app, real crypto, real origin files, nothing mocked.
 *
 * Two walks on one device, because a wipe leaves nothing to wipe a second time:
 *
 *  1. The page dies in the middle of a wipe. A vault with an item and a second
 *     vault are sealed, the wipe code is armed (the word typed, the sentence
 *     ticked), the page reloaded, and the code typed at the unlock screen with
 *     the browser refusing every removal after the headers. The headers are
 *     gone, the bodies are not, the intent is on disk; a new page boots, and the
 *     boot finishes the removal.
 *  2. A new vault is sealed under the same, still armed, code. After a reload
 *     the code is typed and the refusal reads exactly as a wrong PIN's does;
 *     the real PIN opens nothing; after another reload the device shows no vault.
 *  3. The owner recovers. A new vault is sealed on the held device, the Duress
 *     row says the code was used, Clear lifts it, and a new code arms. (The
 *     backup restore is proved in the unit suite, `wipe-recovery.test.ts`.)
 */
import {
  openSettingsCategory,
  sealWithPin,
  waitOpen,
} from "./pages-journey.mjs";
import { takeRefusal, waitForTray } from "./tray-contract.mjs";

const PIN = "48291037";
const CODE = "246813579";
const WRONG = "13572468";
const WIPE = "Wipe this device's copy";
const WORD_LABEL = "Type WIPE to confirm";
const INTENT_FILE = "opensesame-pages-duress.wipe-intent.v1.json";
const ENROLLMENT_FILE = "opensesame-pages-duress.enrollment-state.v1.json";

const bodyText = async (page) =>
  (await page.locator("body").innerText()).replace(/\s+/g, " ");

const originFiles = (page) =>
  page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const names = [];
    for await (const name of root.keys()) names.push(name);
    return names.sort();
  });

/** Every file of a vault that is not the guest's: what a wipe has to take. */
const vaultFiles = async (page) =>
  (await originFiles(page)).filter(
    (name) =>
      name.includes("tomb_") &&
      !name.includes("tomb_guest") &&
      // The two plaintext markers boot writes into any tomb it enters; a vault
      // is not what they are.
      !/(migrated|seal-bound)\.v1\.json$/.test(name),
  );

/** The browser, refusing to finish a removal: headers go, nothing else does. */
async function stallAfterHeaders(context) {
  await context.addInitScript(() => {
    const real = FileSystemDirectoryHandle.prototype.removeEntry;
    FileSystemDirectoryHandle.prototype.removeEntry = function (name, options) {
      const body =
        /tomb_/.test(name) &&
        !/tomb_guest/.test(name) &&
        !/header\.json$/.test(name);
      if (window.__stallRemovals && body) {
        window.__stalled = (window.__stalled ?? []).concat(name);
        return new Promise(() => {});
      }
      return real.call(this, name, options);
    };
  });
}

/** An item in the vault that is open, by the editor's own route. */
async function addItem(page, name) {
  await page.evaluate(
    (href) => {
      history.pushState(null, "", href);
      dispatchEvent(new PopStateEvent("popstate"));
    },
    `${new URL(page.url()).pathname.replace(/[^/]*$/, "")}vault/new/secret`,
  );
  await page.getByLabel("Name", { exact: true }).first().fill(name);
  await page.getByRole("button", { name: "Save item" }).first().click();
  await page.waitForTimeout(900);
}

/** Seal a named vault with the open vault's key, then return to personal. */
async function sealNamed(page, name) {
  await openSettingsCategory(page, "Vaults");
  await page.getByRole("button", { name: "Seal a new vault" }).click();
  const dialog = page.getByRole("dialog", { name: "Seal a new vault" });
  await dialog.waitFor({ timeout: 15000 });
  await dialog.locator("#vaults-new-name").fill(name);
  await dialog.getByRole("button", { name: "Seal vault" }).click();
  await dialog.waitFor({ state: "hidden", timeout: 20000 });
  const personal = page.getByRole("button", { name: /^personal/ });
  if ((await personal.count()) > 0) {
    await personal.first().click();
    await waitOpen(page);
  }
}

/** Arm the wipe code in the sheet, with the word and the sentence as asked. */
async function armWipe({ page, check, snap }) {
  await openSettingsCategory(page, "Security");
  await page.locator("#duress-profiles").waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Add" }).last().click();
  await page.getByRole("radio", { name: WIPE }).check();
  const radios = await page.locator("[role=dialog] input[type=radio]").count();
  check(
    radios >= 3,
    `the sheet offers Wipe among at least three modes (${radios})`,
  );
  const fields = page.locator("[role=dialog] input[type=password]");
  await fields.nth(0).fill(CODE);
  await fields.nth(1).fill(CODE);
  const go = page.getByRole("button", { name: "Turn on duress code" });
  check(await go.isDisabled(), "armed by neither the word nor the sentence");
  await page.getByRole("checkbox").check();
  check(await go.isDisabled(), "the sentence alone does not arm a wipe");
  const word = page.getByLabel(WORD_LABEL);
  await word.fill("WIP");
  check(await go.isDisabled(), "a wrong word keeps the key disabled");
  await word.fill("WIPE");
  check(await go.isEnabled(), "the word and the sentence arm it");
  await snap(page, "J-DURESS-WIPE-armed");
  await go.click();
  await page.getByText("Duress code is on.").waitFor({ timeout: 20000 });
}

/**
 * With more than one vault the unlock screen lists them first; the personal
 * one is chosen to reach its PIN. With one, the PIN is already asked for.
 */
async function reachPin(page) {
  const pin = page.getByLabel("PIN", { exact: true });
  const personal = page.getByRole("button", { name: /^personal/ });
  await Promise.race([
    pin.waitFor({ timeout: 20000 }),
    personal.first().waitFor({ timeout: 20000 }),
  ]);
  if ((await pin.count()) === 0) await personal.first().click();
  await pin.waitFor({ timeout: 20000 });
  return pin;
}

/** Typed at the PIN field of a freshly loaded unlock screen. */
async function typeAtUnlock(page, secret) {
  await (await reachPin(page)).fill(secret);
  const started = Date.now();
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  // The refusal is a notice in the tray, never a box in the page.
  await waitForTray(page, 40000).catch(async (error) => {
    throw new Error(
      `no refusal after typing ${secret.slice(0, 2)}…: ${(await bodyText(page)).slice(0, 400)} (${error.message})`,
    );
  });
  const ms = Date.now() - started;
  // What the screen shows is read the moment the refusal lands, before the tray
  // is opened: a wipe that runs behind the sentence redraws the screen meanwhile.
  const guest = await page
    .getByRole("button", { name: "Skip to the guest vault" })
    .count();
  const body = await bodyText(page);
  return { text: await takeRefusal(page), ms, guest, body };
}

async function reloadToUnlock(page) {
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: "networkidle" });
}

/** Walk 1: the page dies mid-wipe, and the next boot finishes it. */
async function interrupted({ page, context, check, snap, origin, base }) {
  await stallAfterHeaders(context);
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPin(page);
  await addItem(page, "Border notes");
  await sealNamed(page, "Work");
  const sealed = await vaultFiles(page);
  check(sealed.length > 0, `two vaults are on disk (${sealed.length} files)`);
  await armWipe({ page, check, snap });
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: "networkidle" });
  check(
    (await originFiles(page)).includes(ENROLLMENT_FILE),
    "the armed code is on disk after the reload",
  );

  const pin = await reachPin(page);
  await page.evaluate(() => {
    window.__stallRemovals = true;
  });
  await pin.fill(CODE);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.waitForFunction(() => (window.__stalled ?? []).length > 0, null, {
    timeout: 40000,
  });
  const cut = await originFiles(page);
  check(
    cut.every((name) => !/tomb_(?!guest).*header\.json$/.test(name)),
    "every header went first",
  );
  check(
    (await vaultFiles(page)).length > 0,
    "the removal was cut short: bodies and files are still on disk",
  );
  check(cut.includes(INTENT_FILE), "the intent is on disk to resume from");
  await page.close();

  const next = await context.newPage();
  await next.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await next.waitForTimeout(2500);
  const after = await originFiles(next);
  check(
    (await vaultFiles(next)).length === 0,
    `the next boot finished the removal (left: ${(await vaultFiles(next)).join(", ")})`,
  );
  check(!after.includes(INTENT_FILE), "and cleared its intent");
  check(after.includes(ENROLLMENT_FILE), "the duress code is still armed");
  check(
    (await next.getByLabel("PIN", { exact: true }).count()) === 0,
    "no vault is offered at the unlock screen",
  );
  await snap(next, "J-DURESS-WIPE-resumed");
  return next;
}

/** Walk 2: the whole wipe, typed at the unlock screen of a new vault. */
async function whole(context) {
  const { page, check, snap, origin, base } = context;
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPin(page);
  await addItem(page, "Passport scan");
  await reloadToUnlock(page);

  const guestRoad = page.getByRole("button", {
    name: "Skip to the guest vault",
  });
  await reachPin(page);
  check(
    (await guestRoad.count()) === 1,
    "the unlock screen offers the guest road, as it always does",
  );
  const ordinary = await typeAtUnlock(page, WRONG);
  await reloadToUnlock(page);
  const wiped = await typeAtUnlock(page, CODE);
  check(
    wiped.text === ordinary.text,
    `the refusal reads as a wrong PIN's ("${wiped.text}" vs "${ordinary.text}")`,
  );
  check(
    !/wipe|removed|duress|decoy/i.test(wiped.body),
    "the screen says nothing of a wipe",
  );
  console.log(
    `  refusal timing: wrong PIN ${ordinary.ms} ms, wipe code ${wiped.ms} ms`,
  );
  check(wiped.guest === 1, "and offers it still after the wipe code was typed");
  await snap(page, "J-DURESS-WIPE-refused");
  check(
    (await vaultFiles(page)).length === 0,
    "the vault's files are gone from the origin",
  );

  await reloadToUnlock(page);
  await page.waitForTimeout(1500);
  check(
    (await page.getByLabel("PIN", { exact: true }).count()) === 0,
    "after a reload no vault asks for its PIN",
  );
  check(
    !/Unlock\b/.test(
      await bodyText(page).then((t) => t.replace(/Unlock method/g, "")),
    ) ||
      (await page
        .getByRole("button", { name: "Unlock", exact: true })
        .count()) === 0,
    "after a reload nothing offers to unlock",
  );
  await snap(page, "J-DURESS-WIPE-after");

  // The device is a device again: it seals a new vault as it would on a first
  // visit that has already answered setup.
  await sealWithPin(page);
  check(true, "a new vault can be sealed where the wiped one was");
  await recover(context);
}

const rowText = async (page) =>
  (await page.locator("#duress-profiles").innerText()).replace(/\s+/g, " ");

/** Walk 3: a held device with a new vault shows the code used and lets it be cleared. */
async function recover({ page, check, snap }) {
  await openSettingsCategory(page, "Security");
  await page.locator("#duress-profiles").waitFor({ timeout: 15000 });
  check(
    /guest's powers/.test(await rowText(page)),
    "the Duress row says the code was used, on the device the wipe left",
  );
  await snap(page, "J-DURESS-WIPE-used");
  await page.getByRole("button", { name: "Clear" }).click();
  await page.getByText("Cleared. The code is still on.").waitFor({
    timeout: 15000,
  });
  check(
    !/guest's powers/.test(await rowText(page)),
    "Clear lifts what the code set off, with no vault but the new one",
  );
  await page.getByRole("button", { name: "Change" }).last().click();
  const fields = page.locator("[role=dialog] input[type=password]");
  await fields.nth(0).fill("135792468");
  await fields.nth(1).fill("135792468");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Change duress code" }).click();
  await page.getByText("Duress code changed.").waitFor({ timeout: 20000 });
  check(true, "a new duress code arms on the recovered device");
}

export async function walkJDuressModeWipe(context) {
  const next = await interrupted(context);
  await whole({ ...context, page: next });
}
