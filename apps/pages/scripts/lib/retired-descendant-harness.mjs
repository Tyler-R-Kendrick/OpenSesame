/** Genuine pointer events and independent application-document admission. */
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { nativeWebMcp } from "./native-webmcp.mjs";

export async function observeNativeContextMenu(page) {
  // Native dispatch may checkpoint microtasks between listeners. Sample only
  // after dispatch completes; never change event trust or cancellation flags.
  await page.addInitScript(() => {
    window.retiredContextEvents = [];
    window.addEventListener(
      "contextmenu",
      (event) => {
        setTimeout(() => {
          window.retiredContextEvents.push({
            trusted: event.isTrusted,
            prevented: event.defaultPrevented,
            shift: event.shiftKey,
          });
        }, 0);
      },
      true,
    );
  });
}

/** A real pointer target, including clipping and overlays, rather than :visible. */
export function actionableInternalAnchor(element) {
  if (element.matches(".skip-link")) return false;
  if (new URL(element.href).origin !== location.origin) return false;
  if (element.target === "_blank") return false;
  const rect = element.getBoundingClientRect();
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(innerWidth, rect.right);
  const bottom = Math.min(innerHeight, rect.bottom);
  if (right <= left || bottom <= top) return false;
  const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
  return hit !== null && element.contains(hit);
}

async function internalLink(page) {
  for (const link of await page.locator("a[href]:visible").all()) {
    if (await link.evaluate(actionableInternalAnchor)) return link;
  }
  throw new Error("No rendered internal application link");
}

export async function assertTrustedShiftMenu(page, context, synthetic) {
  const link = await internalLink(page);
  const href = await link.evaluate((element) => element.href);
  await page.evaluate(() => {
    window.retiredContextEvents = [];
  });
  const count = context.pages().length;
  await link.click({ button: "right", modifiers: ["Shift"] });
  await expect
    .poll(() => page.evaluate(() => window.retiredContextEvents.length))
    .toBeGreaterThan(0);
  assert.deepEqual(
    await page.evaluate(() => window.retiredContextEvents.at(-1)),
    { trusted: true, prevented: synthetic, shift: true },
  );
  assert.equal(context.pages().length, count);
  await page.keyboard.press("Escape");
  return href;
}

/** A fresh document can legitimately start at the authored multi-vault chooser. */
async function chooseSealedPersonalIfOffered(
  page,
  native,
  realName,
  realItemId,
  restricted,
) {
  const chooser = page.getByRole("heading", { name: "Vaults", exact: true });
  const password = page.getByLabel("Password", { exact: true });
  await chooser.or(password).first().waitFor();
  if (!(await chooser.isVisible())) return;
  await native.expectReady(["opensesame_status", "opensesame_navigate"]);
  if (restricted) await native.refuse("opensesame_status", {});
  else assert.equal((await native.invoke("opensesame_status")).vault, "locked");
  assert.equal(
    (await page.locator("body").innerText()).includes(realName),
    false,
  );
  await assertUnregisteredVaultToolRefused(page, realItemId);
  const personal = page.locator("button.vault-row__body").filter({
    has: page.locator(".vault-row__name").filter({ hasText: /^personal$/u }),
  });
  assert.equal(await personal.count(), 1);
  await personal.click();
}

export async function assertFreshDocumentSealed(
  context,
  href,
  realName,
  realItemId,
) {
  const child = await context.newPage();
  try {
    const native = await nativeWebMcp(child);
    await child.goto(href, { waitUntil: "domcontentloaded" });
    await chooseSealedPersonalIfOffered(
      child,
      native,
      realName,
      realItemId,
      false,
    );
    await child.getByLabel("Password", { exact: true }).waitFor();
    await native.expectReady(["opensesame_status", "opensesame_navigate"]);
    assert.notEqual(
      (await native.invoke("opensesame_status")).vault,
      "unlocked",
    );
    assert.equal(
      (await child.locator("body").innerText()).includes(realName),
      false,
    );
    await assertUnregisteredVaultToolRefused(child, realItemId);
    assert.equal(
      await child
        .getByText("real-secret-do-not-disclose", { exact: true })
        .count(),
      0,
    );
    assert.equal(
      native
        .names()
        .some((name) =>
          /^(opensesame_vault_|opensesame_open_reveal|opensesame_wallet_lease_|opensesame_wallet_payment_)/u.test(
            name,
          ),
        ),
      false,
    );
  } finally {
    await child.close();
  }
}

/** Deliberate browser presentation bypass: cloned metadata grants no keys. */
export async function assertOpenerDocumentSealed(
  parent,
  href,
  realName,
  realItemId,
) {
  const contextKey = "opensesame.decoy-fresh-owner-auth.v1";
  assert.equal(
    await parent.evaluate(
      (key) => sessionStorage.getItem(key)?.startsWith("osr2.") === true,
      contextKey,
    ),
    true,
  );
  const popup = parent.waitForEvent("popup");
  await parent.evaluate(() => window.open("about:blank", "_blank"));
  const child = await popup;
  const pageErrors = [];
  child.on("pageerror", (error) => pageErrors.push(String(error)));
  try {
    // The copied witness is genuine existing sealed metadata, never fabricated.
    assert.equal(
      await child.evaluate(
        (key) =>
          window.opener !== null &&
          sessionStorage.getItem(key)?.startsWith("osr2.") === true &&
          sessionStorage.getItem(key) ===
            window.opener.sessionStorage.getItem(key),
        contextKey,
      ),
      true,
    );
    const native = await nativeWebMcp(child);
    await child.goto(href, { waitUntil: "domcontentloaded" });
    await chooseSealedPersonalIfOffered(
      child,
      native,
      realName,
      realItemId,
      true,
    );
    await child.getByLabel("Password", { exact: true }).waitFor();
    assert.equal(await child.evaluate(() => window.opener !== null), true);
    await native.expectReady(["opensesame_status", "opensesame_navigate"]);
    // A copied pending-owner restriction denies even a registered boot call.
    await native.refuse("opensesame_status", {});
    assert.equal(
      (await child.locator("body").innerText()).includes(realName),
      false,
    );
    assert.equal(
      await child
        .getByText("real-secret-do-not-disclose", { exact: true })
        .count(),
      0,
    );
    assert.equal(
      native
        .names()
        .some((name) =>
          /^(opensesame_vault_|opensesame_open_reveal|opensesame_wallet_lease_|opensesame_wallet_payment_)/u.test(
            name,
          ),
        ),
      false,
    );
    await assertUnregisteredVaultToolRefused(child, realItemId);
    assert.deepEqual(pageErrors, []);
  } finally {
    await child.close();
  }
  await parent
    .getByText("Example account.account", { exact: true })
    .first()
    .waitFor();
  assert.equal(
    (await parent.locator("body").innerText()).includes(realName),
    false,
  );
}

/** Real item decryption remains available to an independently authenticated tab. */
export async function assertOwnerWitnessReadable(owner, realName) {
  const native = await nativeWebMcp(owner);
  await native.expectReady([
    "opensesame_vault_search",
    "opensesame_vault_item_read",
  ]);
  const search = await native.invoke("opensesame_vault_search", {
    query: realName,
  });
  assert.equal(search.items.length, 1);
  const item = search.items[0];
  assert.equal(item.name, realName);
  assert.equal(item.kind, "secret");
  const metadata = await native.invoke("opensesame_vault_item_read", {
    itemId: item.id,
  });
  assert.equal(metadata.id, item.id);
  assert.equal(metadata.name, realName);
  assert.equal(metadata.kind, "secret");
  await owner.getByText(`${realName}.secret`, { exact: true }).first().click();
  await owner
    .getByRole("button", { name: "Reveal secret value", exact: true })
    .click();
  await owner
    .getByText("real-secret-do-not-disclose", { exact: true })
    .waitFor();
  return item.id;
}

/** Invoke through Chrome even though the locked surface did not register it. */
async function assertUnregisteredVaultToolRefused(page, realItemId) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("WebMCP.enable");
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const responses = [];
    cdp.on("WebMCP.toolResponded", (response) => responses.push(response));
    let invocation;
    try {
      invocation = await cdp.send("WebMCP.invokeTool", {
        frameId: frameTree.frame.id,
        toolName: "opensesame_vault_item_read",
        input: { itemId: realItemId },
      });
    } catch (error) {
      assert.match(String(error), /tool|registered|found/iu);
      return;
    }
    await expect
      .poll(() =>
        responses.some((r) => r.invocationId === invocation.invocationId),
      )
      .toBe(true);
    const response = responses.find(
      (r) => r.invocationId === invocation.invocationId,
    );
    assert.ok(
      response.status !== "Completed" || response.output?.isError === true,
    );
  } finally {
    await cdp.detach();
  }
}
