// Native Chrome only. No modelContext polyfill or injected application state.
import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "@playwright/test";
import { nativeWebMcp } from "./lib/native-webmcp.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const origin = "https://tyler-r-kendrick.github.io";
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const harness = createHarness({
  dist: path.resolve(import.meta.dirname, "../dist"),
  origin,
  base,
  out: process.env.PAGES_VERIFY_OUT ?? "/tmp/opensesame-webmcp",
});
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  channel: process.env.PLAYWRIGHT_CHROME_CHANNEL || undefined,
  args: ["--enable-experimental-web-platform-features"],
});
try {
  const { page, context } = await harness.newPage(browser);
  const native = await nativeWebMcp(page);
  await page.goto(`${origin}${base}`);
  await page
    .getByRole("button", { name: "Continue as guest", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(() =>
      document.modelContext?.registerTool.toString().includes("[native code]"),
    ),
    true,
    "Chrome must expose native WebMCP; absence is a failure, never a skipped test",
  );
  await native.expectCount(3);
  const boot = native.names();
  assert.deepEqual(boot, [
    "opensesame_health",
    "opensesame_navigate",
    "opensesame_status",
  ]);
  const initial = await native.invoke("opensesame_status");
  assert.equal(initial.vault, "empty");
  await page
    .getByRole("button", { name: "Continue as guest", exact: true })
    .click();
  await native.expectCount(20);
  const all = native.names();
  assert.equal((await native.invoke("opensesame_status")).vault, "unlocked");

  // Every authored navigation destination is exercised through the same CDP
  // domain that backs Application > WebMCP, not execute() imported from source.
  const destinations = (await native.invoke("opensesame_status")).destinations;
  assert.ok(destinations.length >= 23, "nested navigation must stay exposed");
  for (const destination of destinations) {
    await native.invoke("opensesame_navigate", { section: destination });
    await page.waitForURL(`${origin}${base.slice(0, -1)}${destination}`);
    const url = new URL(page.url());
    const view = url.searchParams.get("view");
    if (url.pathname.endsWith("/access") && view) {
      await page
        .getByRole("tab", { selected: true })
        .filter({ hasText: new RegExp(view, "i") })
        .waitFor();
    }
    if (url.pathname.endsWith("/identity") && view) {
      const later = page.getByRole("button", { name: /set up later/i });
      if (await later.isVisible()) await later.click();
      const label = view === "service-accounts" ? "Service accounts" : view;
      await page
        .getByRole("tab", { selected: true })
        .filter({ hasText: new RegExp(label, "i") })
        .waitFor();
    }
    assert.deepEqual(native.names(), all, `tools lost at ${destination}`);
    console.log(
      `PASS CDP navigation ${destination}: ${all.length} native tools`,
    );
  }
  for (const kind of [
    "login",
    "secret",
    "note",
    "card",
    "certificate",
    "passkey",
    "drop",
  ]) {
    await native.invoke("opensesame_navigate", {
      section: "/vault/new",
      itemType: kind,
    });
    await page.waitForURL(`${origin}${base}vault/new/${kind}`);
    assert.equal(
      await page.getByRole("combobox", { name: /type/i }).count(),
      0,
    );
    assert.ok(await page.getByLabel("Name", { exact: true }).inputValue());
    if (kind === "login") {
      const password = page.getByLabel("Password", { exact: true });
      assert.equal((await password.inputValue()).length, 20);
      assert.equal(await password.getAttribute("type"), "password");
      assert.match(
        await page.getByLabel("Username", { exact: true }).inputValue(),
        /^user_/,
      );
    }
  }
  const labels = await native.invoke("opensesame_vault_item_write", {
    action: "suggest",
    kind: "login",
    source: "random",
  });
  assert.deepEqual(Object.keys(labels).sort(), [
    "name",
    "source",
    "status",
    "username",
  ]);
  await native.invoke("opensesame_navigate", {
    section: "/vault/new",
    itemType: "login",
    prefill: {
      name: "Link fixture",
      username: "public_alias",
      uri: "https://example.com/login",
    },
  });
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Name"]')?.value === "Link fixture",
  );
  assert.equal(
    await page.getByLabel("Username", { exact: true }).inputValue(),
    "public_alias",
  );
  await native.refuse("opensesame_navigate", {
    section: "/vault/new",
    prefill: { password: "sentinel-never-prefill" },
  });
  await native.refuse("opensesame_vault_item_write", {
    action: "suggest",
    kind: "login",
    password: "sentinel-never-prompt",
  });
  await native.refuse("opensesame_navigate", {
    section: "https://attacker.invalid",
  });
  await native.refuse("opensesame_navigate", {
    section: "/vault/new",
    itemType: "not-installed",
  });
  await native.invoke("opensesame_navigate", { section: "/vault" });
  const item = await native.invoke("opensesame_vault_item_write", {
    kind: "login",
    name: "Browser control fixture",
  });
  await native.invoke("opensesame_vault_item_write", {
    itemId: item.id,
    name: "Renamed by Chrome",
    favorite: true,
  });
  const metadata = await native.invoke("opensesame_vault_item_read", {
    itemId: item.id,
  });
  assert.equal(metadata.name, "Renamed by Chrome");
  assert.equal(metadata.favorite, true);
  await native.invoke("opensesame_navigate", {
    section: "/vault",
    itemId: item.id,
    edit: true,
  });
  await page.waitForURL(`${origin}${base}vault/${item.id}/edit`);
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .filter({ visible: true })
    .waitFor();
  await native.refuse("opensesame_vault_item_write", {
    itemId: item.id,
    password: "sentinel-not-a-real-credential",
  });
  await native.invoke("opensesame_open_reveal", { itemId: item.id });
  await page.waitForURL(`${origin}${base}vault/${item.id}`);
  await page.getByRole("heading", { name: "Renamed by Chrome" }).waitFor();
  await native.invoke("opensesame_help", {});
  await page
    .getByLabel("WebMCP status")
    .filter({ hasText: "20 tools exposed" })
    .waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).last().click();
  await page
    .getByRole("button", { name: /^lock( vault)?$/i })
    .first()
    .click();
  await native.expectCount(3);
  assert.deepEqual(native.names(), boot);
  await native.refuse("opensesame_vault_item_read", { itemId: item.id });
  await page.reload();
  await native.expectCount(3);
  assert.deepEqual(native.names(), boot);
  assert.notEqual((await native.invoke("opensesame_status")).vault, "unlocked");
  const errors = harness.log.filter((entry) =>
    ["PAGE-ERROR", "MISSING-ASSET"].includes(entry.kind),
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      browser: browser.version(),
      source: "native WebMCP CDP",
      boot,
      unlocked: all,
      destinations: destinations.length,
      invocations: native.invocations(),
    }),
  );
  await context.close();
} finally {
  await browser.close();
}
