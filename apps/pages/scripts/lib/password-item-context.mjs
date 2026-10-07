import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { addCapabilities } from "./pages-journey.mjs";

export async function verifyItemContext(
  page,
  base,
  loginId,
  methodIds,
  width,
  out,
) {
  await page.evaluate((route) => {
    history.pushState(null, "", route);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}vault?f=all`);
  const command = page.getByRole("combobox", { name: "Command", exact: true });
  await command.fill("/search Gauntlet Account");
  // The account's credentials are entries beside it ("Gauntlet Account ·
  // Password", ADR 0179); the account is the one without a middle dot.
  const loginRow = page.getByRole("treeitem", {
    name: /^Gauntlet Account(?! ·)/,
  });
  await loginRow.waitFor();
  await loginRow.click();
  await page.waitForURL((url) => url.pathname === `${base}vault/${loginId}`);
  await command.fill("");
  const section = page.getByRole("region", { name: "Credential references" });
  await verifyReferenceDownloads(page, section, loginId, methodIds.Password);
  await section
    .getByLabel("Candidate password")
    .fill("context-private-password");
  await section.getByRole("button", { name: "Compare this password" }).click();
  await section.getByText("Password differs.", { exact: true }).waitFor();
  assert.equal(await section.getByLabel("Candidate password").inputValue(), "");
  await section
    .getByLabel("Candidate password")
    .fill("context-private-password");
  await section
    .getByRole("button", { name: "Apply and verify this password" })
    .click();
  await section
    .getByText("Password updated and verified.", { exact: true })
    .waitFor();
  await section
    .getByLabel("Candidate password")
    .fill("context-private-password");
  await section.getByRole("button", { name: "Compare this password" }).click();
  await section.getByText("Password matches.", { exact: true }).waitFor();
  assert.ok(
    !(await section.textContent()).includes("context-private-password"),
  );
  await verifyPreservedMethods(page, section, loginId, methodIds);
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(out, `${width}-item-credentials.png`),
    fullPage: true,
  });
  await page.evaluate((route) => {
    history.pushState(null, "", route);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}vault/health`);
  const organization = page.getByRole("region", {
    name: "Credential organization",
  });
  await organization.getByText("2 active items reviewed").waitFor();
  const credentialLink = organization.getByRole("link", {
    name: "Gauntlet API",
    exact: true,
  });
  await credentialLink.waitFor();
  assert.ok(
    !(await organization.textContent()).includes("PRIVATE_BROWSER_SENTINEL"),
  );
  await credentialLink.click();
  await page.waitForURL((url) => url.pathname !== `${base}vault/health`);
  await page.getByRole("region", { name: "Credential references" }).waitFor();
}

async function verifyPreservedMethods(page, section, accountId, methodIds) {
  for (const [label, suffix, value] of [
    ["API key", "key", "context-private-api-key"],
    ["Token", "token", "context-private-token"],
  ]) {
    const field = section.getByRole("group", { name: label, exact: true });
    const reference = `os://personal/${accountId}/${encodeURIComponent(`method:${methodIds[label]}:${suffix}`)}`;
    assert.equal(await field.locator("code").textContent(), reference);
    assert.ok(!(await section.textContent()).includes(value));
    await field
      .getByLabel("Download this credential as plaintext on this device")
      .check();
    const event = page.waitForEvent("download");
    await field
      .getByRole("button", {
        name: `Download ${label} plaintext credential`,
        exact: true,
      })
      .click();
    const file = await event;
    assert.equal(fs.readFileSync(await file.path(), "utf8"), value);
  }
}

async function verifyReferenceDownloads(
  page,
  section,
  loginId,
  passwordMethodId,
) {
  const field = section.getByRole("group", { name: "Password", exact: true });
  const templateButton = field.getByRole("button", {
    name: /^Download Password reference template$/,
  });
  await templateButton.waitFor();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  await field
    .getByRole("button", { name: "Copy Password reference", exact: true })
    .click();
  await field
    .getByRole("button", { name: "Copied Password reference", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    `os://personal/${loginId}/${encodeURIComponent(`method:${passwordMethodId}:secret`)}`,
  );
  assert.ok(!(await section.textContent()).includes("new-private-password"));
  const event = page.waitForEvent("download");
  await templateButton.click();
  const file = await event;
  assert.equal(
    fs.readFileSync(await file.path(), "utf8"),
    `CREDENTIAL=os://personal/${loginId}/${encodeURIComponent(`method:${passwordMethodId}:secret`)}\n`,
  );
  await field
    .getByLabel("Download this credential as plaintext on this device")
    .check();
  const secretEvent = page.waitForEvent("download");
  await field
    .getByRole("button", { name: "Download Password plaintext credential" })
    .click();
  const secret = await secretEvent;
  assert.equal(
    fs.readFileSync(await secret.path(), "utf8"),
    "new-private-password",
  );
  assert.ok(!(await section.textContent()).includes("new-private-password"));
}

export async function verifyNativeRequestHandoff(page, base, width, out) {
  // Install the owner's real optional Access module through
  // the same Settings switch a person uses before visiting its requests.
  await addCapabilities(page, ["Access authority"]);
  await page.evaluate((route) => {
    history.pushState(null, "", route);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}access/requests`);
  const panel = page.getByRole("region", {
    name: "Private credential requests",
  });
  await panel.getByText("Prepare a native request", { exact: true }).click();
  await panel
    .getByLabel("Exact HTTPS destination")
    .fill("https://api.example.test/v1/me");
  await panel
    .getByLabel("Credential reference", { exact: true })
    .fill("op://Automation/Example/credential");
  await panel
    .getByLabel("Existing lease ID (optional)")
    .fill("reviewable_lease");
  await panel
    .getByRole("button", { name: "Prepare commands", exact: true })
    .click();
  const commands = panel.getByLabel("Native request commands");
  await commands.waitFor();
  assert.equal(
    await commands.locator("pre").nth(0).textContent(),
    "'opensesame' 'password-agent' 'lease' 'approve' 'https://api.example.test/v1/me' '--secret' 'op://Automation/Example/credential' '--header' 'Authorization' '--prefix' 'Bearer ' '--desktop' '--expires-in' '10m' '--uses' '1'",
  );
  assert.equal(
    await commands.locator("pre").nth(1).textContent(),
    "'opensesame' 'password-agent' 'request' 'https://api.example.test/v1/me' '--secret' 'op://Automation/Example/credential' '--header' 'Authorization' '--prefix' 'Bearer ' '--lease' 'reviewable_lease'",
  );
  assert.equal(
    await commands.locator("pre").nth(2).textContent(),
    "'opensesame' 'password-agent' 'lease' 'status' 'reviewable_lease'\n'opensesame' 'password-agent' 'lease' 'revoke' 'reviewable_lease'",
  );
  assert.ok((await panel.textContent()).includes("interactive terminal"));
  assert.ok(
    (await panel.textContent()).includes(
      "native CLI stores and enforces the lease",
    ),
  );
  await commands.scrollIntoViewIfNeeded();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Native request commands must fit the viewport without horizontal page scrolling",
  );
  await page.screenshot({
    path: path.join(out, `${width}-native-request-handoff.png`),
    fullPage: true,
  });
}
