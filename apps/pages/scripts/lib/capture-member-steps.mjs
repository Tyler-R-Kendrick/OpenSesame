/**
 * Capture verbs for a person's own records in Identity: a passkey device to
 * sign in with, and the disclosures and keys on one named record's row. A
 * verb ending in `Optional` skips what this build does not draw — a base
 * build without the control is a legitimate difference, not a miss.
 */

/** The directory row whose heading, or member name, is exactly `name`. */
function recordRow(page, name) {
  return page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name, exact: true }) })
    .first();
}

export function memberSteps({ press }) {
  return {
    /**
     * Plug in a passkey device: Chromium's virtual authenticator, verifying
     * the user and answering by itself, the way a platform authenticator
     * does after a touch.
     */
    async authenticator(page) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
    },
    /** Open a disclosure on a named record's row: `{ record, summary }`. */
    async disclose(page, { record, summary }) {
      const target = recordRow(page, record)
        .locator("summary", { hasText: summary })
        .first();
      if (!(await target.count()))
        throw new Error(
          `capture-evidence disclose("${record}", "${summary}"): no disclosure matched — refusing a silent miss`,
        );
      await press(target);
      await page.waitForTimeout(900);
    },
    /** `disclose`, anywhere in main, when this build draws it. */
    async discloseOptional(page, summary) {
      const target = page.locator("main summary", { hasText: summary }).first();
      if (await target.count()) {
        await target.scrollIntoViewIfNeeded();
        await press(target);
        await page.waitForTimeout(900);
      }
    },
    /** Press a key on a named record's row: `{ record, key }`. */
    async pressOn(page, { record, key }) {
      const target = recordRow(page, record)
        .getByRole("button", { name: key, exact: true })
        .first();
      if (!(await target.count()))
        throw new Error(
          `capture-evidence pressOn("${record}", "${key}"): no key matched — refusing a silent miss`,
        );
      await press(target);
      await page.waitForTimeout(1200);
    },
    /**
     * Choose an option in a labelled select on a named record's row:
     * `{ record, label, option }`. Another record's closed disclosure may
     * hold a select with the same label.
     */
    async selectOn(page, { record, label, option }) {
      const field = recordRow(page, record)
        .getByLabel(label, { exact: true })
        .first();
      if (!(await field.count()))
        throw new Error(
          `capture-evidence selectOn("${record}", "${label}"): no field matched — refusing a silent miss`,
        );
      await field.selectOption({ label: option });
      await page.waitForTimeout(400);
    },
    /** Press a key by its exact name when this build draws it enabled. */
    async pressExactOptional(page, name) {
      const target = page.getByRole("button", { name, exact: true }).first();
      if ((await target.count()) && (await target.isEnabled())) {
        await press(target);
        await page.waitForTimeout(1200);
      }
    },
    /** Print every status mark's sentence in main, so a sheet quotes them. */
    async marks(page) {
      const labels = await page
        .locator("main .status-mark")
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("aria-label")),
        );
      console.log(`  marks: ${labels.join(" | ") || "none"}`);
    },
    /** Bring the first match to the middle of the viewport. */
    async centreOn(page, selector) {
      const target = page.locator(selector).first();
      if (!(await target.count())) return;
      await target.evaluate((node) =>
        node.scrollIntoView({ block: "center", behavior: "instant" }),
      );
      await page.waitForTimeout(500);
    },
  };
}
