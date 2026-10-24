import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

async function visit(page, base, route) {
  await page.evaluate((target) => {
    history.pushState(null, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}${route}`);
}

/**
 * The file a press hands the person. Where the browser has the File System
 * Access save picker the app opens it (`src/lib/file-system.ts`), and headless
 * Chromium, with no dialog to draw, answers AbortError and nothing is written.
 * So the walk stands in for the dialog alone: the person chose a file, and the
 * bytes the app wrote and closed are read back. The stand-in refuses a call
 * with no user activation, as the browser does. A browser without the picker
 * takes the anchor download, which is awaited instead.
 */
async function download(page, press) {
  const picker = await page.evaluate(() => {
    if (!window.showSaveFilePicker) return false;
    window.__walkSavedFile = null;
    window.showSaveFilePicker = async (options = {}) => {
      if (!navigator.userActivation.isActive)
        throw new DOMException(
          "Must be handling a user gesture to show a file picker.",
          "SecurityError",
        );
      const parts = [];
      return {
        createWritable: async () => ({
          write: async (data) => {
            parts.push(data);
          },
          close: async () => {
            window.__walkSavedFile = {
              name: options.suggestedName ?? "",
              text: await new Blob(parts).text(),
            };
          },
          abort: async () => undefined,
        }),
      };
    };
    return true;
  });
  if (picker) {
    await press();
    const saved = await page.waitForFunction(() => window.__walkSavedFile);
    return saved.jsonValue();
  }
  const event = page.waitForEvent("download");
  await press();
  const file = await event;
  return {
    name: file.suggestedFilename(),
    text: fs.readFileSync(await file.path(), "utf8"),
  };
}

/** An environment file's lines, as name → value. */
function envValues(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1).replace(/^"|"$/g, "")];
    });
}

/**
 * A standalone secret: created in New item, read through the field's own copy,
 * written out by reference on the toolbar, and as a plaintext .env asked for twice.
 */
export async function verifySecretItem(page, base, width, out, sentinel) {
  await visit(page, base, "vault/new/secret");
  await page.getByLabel("Name", { exact: true }).first().fill("Gauntlet API");
  const input = page.locator("#secret-value");
  assert.equal(await input.getAttribute("type"), "password");
  await input.fill(sentinel);
  await page.getByRole("button", { name: "Save item" }).first().click();
  await page.waitForURL((url) => /\/vault\/[^/]+$/.test(url.pathname));
  const id = new URL(page.url()).pathname.split("/").pop();
  const tools = page.locator(".detail__tools");
  await tools.waitFor();
  const reference = `os://guest/${id}/value`;
  assert.ok(!(await page.locator("body").textContent()).includes(sentinel));
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });

  // Reading the value is the field's own copy, pressed by the person.
  await page
    .getByRole("button", { name: "Copy secret", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Copied secret", exact: true })
    .first()
    .waitFor();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    sentinel,
  );

  const template = await download(page, () =>
    tools
      .getByRole("button", { name: "Download reference template", exact: true })
      .click(),
  );
  assert.equal(template.name, "references.env.tpl");
  assert.equal(template.text, `GAUNTLET_API_VALUE=${reference}\n`);

  // A plaintext file asks twice: the first press writes nothing.
  const plaintext = tools.getByRole("button", {
    name: "Download plaintext .env",
    exact: true,
  });
  await plaintext.click();
  const confirm = tools.getByRole("button", {
    name: "Really download a plaintext .env? Press again to confirm",
  });
  await confirm.waitFor();
  const env = await download(page, () => confirm.click());
  assert.equal(env.name, "plaintext.env");
  assert.equal(env.text, `GAUNTLET_API_VALUE="${sentinel}"\n`);
  assert.ok(!(await page.locator("body").textContent()).includes(sentinel));

  const measurements = await measure(page, tools);
  assert.ok(measurements.scrollWidth <= measurements.clientWidth);
  if (width < 600)
    assert.ok(
      measurements.controls.every(
        (control) => control.height >= 44 && control.width >= 44,
      ),
    );
  fs.writeFileSync(
    path.join(out, `${width}-item-references-measurements.json`),
    JSON.stringify(measurements, null, 2),
  );
  await page.screenshot({
    path: path.join(out, `${width}-item-references.png`),
    fullPage: true,
  });
  return id;
}

function measure(page, region) {
  return region.evaluate((node) => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
    controls: [...node.querySelectorAll("button")].map((button) => ({
      height: button.getBoundingClientRect().height,
      width: button.getBoundingClientRect().width,
    })),
  }));
}

/**
 * An account's password row: compare a typed password by a mark, replace it
 * through the verified write, and keep every sibling method.
 */
export async function verifyAccountPassword(
  page,
  base,
  accountId,
  methodIds,
  width,
  out,
) {
  await visit(page, base, `vault/${accountId}`);
  const row = page.locator(".frow", {
    has: page.locator(".frow__label", { hasText: /^Password$/ }),
  });
  await row.getByRole("button", { name: "Update password" }).click();
  await row.getByRole("button", { name: "Enter", exact: true }).click();
  const field = row.getByLabel("New password");
  const compare = row.getByRole("button", {
    name: "Compare with the saved password",
  });
  await field.fill("new-private-password");
  await compare.click();
  await row
    .getByRole("img", { name: "Differs from the saved password" })
    .waitFor();
  await field.fill("old-private-password");
  assert.equal(
    await row.getByRole("img", { name: /saved password/ }).count(),
    0,
  );
  await compare.click();
  await row.getByRole("img", { name: "Same as the saved password" }).waitFor();
  await field.fill("new-private-password");
  await row.getByRole("button", { name: "Save new value" }).click();
  await row.getByLabel("New password").waitFor({ state: "detached" });

  // The write read back: the same candidate now matches, and nothing else moved.
  await row.getByRole("button", { name: "Update password" }).click();
  await row.getByRole("button", { name: "Enter", exact: true }).click();
  await row.getByLabel("New password").fill("new-private-password");
  await row
    .getByRole("button", { name: "Compare with the saved password" })
    .click();
  await row.getByRole("img", { name: "Same as the saved password" }).waitFor();
  await row.getByRole("button", { name: "Cancel" }).click();
  assert.ok(
    !(await page.locator("body").textContent()).includes(
      "new-private-password",
    ),
  );

  const tools = page.locator(".detail__tools");
  const template = await download(page, () =>
    tools
      .getByRole("button", { name: "Download reference template", exact: true })
      .click(),
  );
  const refs = envValues(template.text).map(([, value]) => value);
  for (const [label, suffix] of [
    ["Password", "secret"],
    ["API key", "key"],
    ["Token", "token"],
  ])
    assert.ok(
      refs.includes(
        `os://guest/${accountId}/${encodeURIComponent(`method:${methodIds[label]}:${suffix}`)}`,
      ),
      `the template names the ${label}`,
    );
  await tools.getByRole("button", { name: "Download plaintext .env" }).click();
  const env = await download(page, () =>
    tools
      .getByRole("button", {
        name: "Really download a plaintext .env? Press again to confirm",
      })
      .click(),
  );
  assert.deepEqual(
    envValues(env.text)
      .map(([, value]) => value)
      .sort(),
    [
      "context-private-api-key",
      "context-private-token",
      "new-private-password",
    ],
  );
  await page.screenshot({
    path: path.join(out, `${width}-account-password.png`),
    fullPage: true,
  });
}

/** Password health lists items to file or rename, each a link to its item. */
export async function verifyHealthFindings(page, base, secretId) {
  await visit(page, base, "vault/health");
  const organization = page.getByRole("region", { name: "Organization" });
  await organization.waitFor();
  const link = organization.getByRole("link", {
    name: "Gauntlet API",
    exact: true,
  });
  await link.waitFor();
  assert.ok(
    (await organization.getByRole("img", { name: "Unfiled" }).count()) >= 1,
  );
  assert.ok(
    !(await organization.textContent()).includes("PRIVATE_BROWSER_SENTINEL"),
  );
  await link.click();
  await page.waitForURL((url) => url.pathname === `${base}vault/${secretId}`);
}
