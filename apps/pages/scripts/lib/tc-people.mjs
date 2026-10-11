/**
 * The five people of `verify-trusted-contacts.mjs`: one browser context each,
 * at the production origin served from `dist/`, every one with its own
 * virtual authenticator that does the WebAuthn PRF extension, clipboard
 * access, and a clock the gate moves forward for all of them together.
 *
 * A person here does what a person does on the screens: presses the keys by
 * their accessible names, types into a field with the keyboard, copies a
 * packet with its Copy key and pastes it into somebody else's page. Nothing
 * reaches into the app; every claim is about what the page shows.
 */

import fs from "node:fs";
import { EXPECT_TIMEOUT_MS } from "./expect-timeout.mjs";
import {
  addCapabilities,
  openSettingsCategory,
  sealWithPin,
  unlockWithPin,
} from "./pages-journey.mjs";
import { AUTHENTICATOR, BASE, ORIGIN } from "./quorum-browser-rig.mjs";
import { expect } from "./tc-expect.mjs";
import { settleTray } from "./tc-refusals.mjs";

export { BASE, ORIGIN };

const PANELS = ["circles", "guarding", "recovery"];

export class Person {
  constructor({ name, page, context, cdp, authenticatorId, harness, shot }) {
    this.name = name;
    this.shot = shot;
    this.page = page;
    this.context = context;
    this.cdp = cdp;
    this.authenticatorId = authenticatorId;
    this.harness = harness;
    /** Sentences the page showed as marks that the tray must hold once its sheet is closed. */
    this.owed = [];
  }

  // --- the key (a CDP virtual authenticator) --------------------------------

  /** The key stops (or starts again) proving a PIN or biometric. */
  async userVerified(isUserVerified) {
    await this.cdp.send("WebAuthn.setUserVerified", {
      authenticatorId: this.authenticatorId,
      isUserVerified,
    });
  }

  /** Lose the key and carry a new one: the credentials the old one held are gone. */
  async replaceKey({ prf = true } = {}) {
    await this.cdp.send("WebAuthn.removeVirtualAuthenticator", {
      authenticatorId: this.authenticatorId,
    });
    const { authenticatorId } = await this.cdp.send(
      "WebAuthn.addVirtualAuthenticator",
      { options: { ...AUTHENTICATOR, hasPrf: prf } },
    );
    this.authenticatorId = authenticatorId;
  }

  /**
   * The key is carried on after the browser stopped trusting it. A Chromium
   * virtual authenticator that failed a user-verification check does not
   * recover when `setUserVerified(true)` is sent (every later request is
   * refused too), so the person takes their credentials to a new one. An
   * approval (a signature) works again; the PRF secret does not travel, so a
   * share the old key sealed cannot be opened with it.
   */
  async restoreKey({ prf = true } = {}) {
    const { credentials } = await this.cdp.send("WebAuthn.getCredentials", {
      authenticatorId: this.authenticatorId,
    });
    await this.replaceKey({ prf });
    for (const credential of credentials) {
      await this.cdp.send("WebAuthn.addCredential", {
        authenticatorId: this.authenticatorId,
        credential,
      });
    }
  }

  // --- the clock -------------------------------------------------------------

  /** Move this person's clock to `ms` since the epoch; no timer fires. */
  async setClock(ms) {
    await this.page.clock.setSystemTime(new Date(ms));
  }

  // --- the app -----------------------------------------------------------------

  /**
   * A sealed vault of one's own with the capability on, on Settings › Trusted
   * contacts. Nothing is reloaded before the first ceremony: the first unlock
   * after a vault is sealed used to drop every file written in that first
   * session from the VFS index (`rebindTombSeals` read the index before it was
   * in memory), so a ceremony kept then was not listed after a reload. Walking
   * a ceremony and then reloading, on a vault that has never been reopened, is
   * how this gate holds that fixed.
   */
  async enter() {
    await sealWithPin(this.page);
    await addCapabilities(this.page, ["Trusted contacts"]);
    await this.openTab();
  }

  async openTab() {
    await openSettingsCategory(this.page, "Trusted contacts");
    for (const id of PANELS) {
      await expect(this.page.locator(`section#${id}`)).toBeVisible();
    }
  }

  /** The app opened again at its front address, and the vault unlocked with its PIN. */
  async reopen() {
    await this.page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
    await unlockWithPin(this.page);
  }

  /** The app opened again, the vault unlocked, and the tab drawn: a person who closed the page and came back. */
  async reopenAtTab() {
    await this.reopen();
    await this.openTab();
  }

  /** The page reloaded where it stands (a deep link, answered by the 404 page), and unlocked. */
  async reload() {
    await this.page.reload({ waitUntil: "networkidle" });
    await unlockWithPin(this.page);
    await this.openTab();
  }

  panel(id) {
    return this.page.locator(`section#${id}`);
  }

  sheet(name) {
    return this.page.getByRole("dialog", { name, exact: true });
  }

  // --- controls, by their accessible names ----------------------------------

  key(name, scope = this.page) {
    return scope.getByRole("button", { name, exact: true });
  }

  mark(label, scope = this.page) {
    return scope.getByRole("img", { name: label, exact: true });
  }

  async press(name, scope = this.page) {
    await this.key(name, scope).click();
  }

  /** A field, entered with the keyboard: the field has the keyboard, its text is replaced. */
  async type(label, text, scope = this.page) {
    const field = scope.getByLabel(label, { exact: true });
    await field.click();
    await this.page.keyboard.press("ControlOrMeta+A");
    await this.page.keyboard.insertText(text);
    return field;
  }

  /** Close an open sheet by its own close key, and see it go. */
  async closeSheet(name) {
    const sheet = this.sheet(name);
    await this.key("Close", sheet).click();
    await expect(sheet).toHaveCount(0);
    await settleTray(this);
  }

  // --- packets travel by the clipboard ---------------------------------------

  async readClipboard() {
    return this.page.evaluate(() => navigator.clipboard.readText());
  }

  /** Press `Copy <what>` and take what is on the clipboard: a person's own copy. */
  async copy(what, scope = this.page) {
    await this.key(`Copy ${what}`, scope).click();
    await expect(this.key(`Copied ${what}`, scope)).toBeVisible();
    const text = await this.readClipboard();
    expect(text.length, `${what} reached the clipboard`).toBeGreaterThan(20);
    return text;
  }

  /** Paste a packet into a field the way a person does, and press its key. */
  async paste(label, text, scope = this.page) {
    return this.type(label, text, scope);
  }

  /** Press a key that hands the person a file, and read the file. */
  async download(name, scope = this.page) {
    const [download] = await Promise.all([
      this.page.waitForEvent("download"),
      this.press(name, scope),
    ]);
    const text = fs.readFileSync(await download.path(), "utf8");
    return { name: download.suggestedFilename(), text };
  }

  // --- evidence ---------------------------------------------------------------

  async snap(moment) {
    this.harness.setStep(`${this.name}: ${moment}`);
    await this.harness.snap(this.page, `${this.shot()}-${this.name}-${moment}`);
  }

  async close() {
    await this.context.close();
  }
}

/** One person: a context with a PRF key, clipboard and a clock that starts at `clock`. */
export async function createPerson(harness, browser, name, options) {
  const { width, clock, shot, prf = true } = options;
  const { page, context } = await harness.newPage(browser, {
    // A reload at the tab is a deep link: the 404 page answers it, once.
    expectedFallbackUrl: `${ORIGIN}${BASE}settings/trusted-contacts`,
    device: {
      viewport: { width, height: 900 },
      permissions: ["clipboard-read", "clipboard-write"],
      acceptDownloads: true,
    },
  });
  page.setDefaultTimeout(EXPECT_TIMEOUT_MS);
  // Before the first navigation, so every page shares one controlled Date.
  await page.clock.install({ time: clock });
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    { options: { ...AUTHENTICATOR, hasPrf: prf } },
  );
  return new Person({
    name,
    page,
    context,
    cdp,
    authenticatorId,
    harness,
    shot,
  });
}
