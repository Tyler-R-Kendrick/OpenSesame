#!/usr/bin/env node
/**
 * Two browser contexts join one relay session (ADR 0181).
 *
 * A consents and publishes a sealed snapshot. B consents, is refused as a
 * member, and still reads the ciphertext with the slot key. The page shows
 * generation and ciphertext. It never shows an item name.
 * `verify:live-join` stays the live-session walk.
 *
 * The default is the in-process harness.
 * `VAULT_RELAY_LIVE=1` (set by `verify:relay-join-live`, the journeys-1
 * CI shard) spawns the gateway relay profile instead.
 */

import { chromium } from "@playwright/test";
import { findChromium } from "./duress/find-chromium.mjs";
import { startVaultRelay } from "./lib/vault-relay-http.mjs";

const ITEM_NAME = "Bank login";
const CIPHERTEXT = "Y2lwaGVydGV4dA";
const SLOT_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64url");

function fail(message) {
  console.error(`[relay-join] ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

async function expectStatus(response, status, label) {
  if (response.status !== status) {
    fail(`${label} answered ${response.status}, expected ${status}`);
  }
}

/** Protocol checks on a throwaway address, before either browser joins. */
async function probe(origin) {
  const live = await fetch(`${origin}/health/live`);
  await expectStatus(live, 200, "health");
  if ((await live.text()) !== "ok") fail("health body was not ok");

  const advertised = await fetch(`${origin}/health/relay`);
  await expectStatus(advertised, 200, "relay health");
  const health = await advertised.json();
  if (
    health.profile !== "relay" ||
    health.bindings !== "vault_relay" ||
    health.durable !== true
  ) {
    fail(`relay health ${JSON.stringify(health)}`);
  }

  const absent = await fetch(`${origin}/api/v1/sync/pull`, { method: "POST" });
  await expectStatus(absent, 404, "host sync route");

  const created = await fetch(`${origin}/v1/org-vaults`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opensesame-principal": "ada",
    },
    body: JSON.stringify({
      ownerKind: "organization",
      owner: "acme",
      slug: "probe",
    }),
  });
  await expectStatus(created, 201, "create probe");
  const listed = await fetch(`${origin}/v1/org-vaults?owner=acme`);
  await expectStatus(listed, 200, "list probe");
  const body = await listed.json();
  const slugs = (body.vaults ?? []).map((vault) => vault.slug);
  if (!slugs.includes("probe"))
    fail(`list missed probe: ${JSON.stringify(body)}`);

  const second = await fetch(`${origin}/v1/org-vaults`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opensesame-principal": "bee",
    },
    body: JSON.stringify({
      ownerKind: "organization",
      owner: "acme",
      slug: "probe",
    }),
  });
  await expectStatus(second, 409, "second principal");

  const blank = await fetch(`${origin}/v1/org-vaults`);
  const blankBody = await blank.json();
  if (!Array.isArray(blankBody.vaults) || blankBody.vaults.length !== 0) {
    fail("a blank directory filter dumped the directory");
  }
}

function joinUrl(pageOrigin, apiOrigin, role, principal) {
  const url = new URL("/join.html", pageOrigin);
  url.searchParams.set("role", role);
  url.searchParams.set("principal", principal);
  url.searchParams.set("owner", "acme");
  url.searchParams.set("slug", "ledger");
  url.searchParams.set("ownerKind", "organization");
  url.searchParams.set("slotKey", SLOT_KEY);
  if (apiOrigin !== pageOrigin) url.searchParams.set("relay", apiOrigin);
  return url.href;
}

async function joinedText(page, role) {
  const consent =
    role === "a"
      ? "I consent to publish this vault"
      : "I consent to join this vault";
  await page.getByRole("checkbox", { name: consent }).check();
  await page.getByRole("button", { name: "Join session" }).click();
  const joined = page.locator("#joined");
  await joined.waitFor({ state: "visible", timeout: 15_000 });
  return {
    status: (await page.locator("#create-status").textContent()) ?? "",
    generation: (await page.locator("#generation").textContent()) ?? "",
    ciphertext: (await page.locator("#ct").textContent()) ?? "",
    body: await page.locator("body").innerText(),
  };
}

async function main() {
  const discovery = findChromium();
  if (!discovery.path) {
    console.error("[relay-join] no Chromium binary");
    for (const probed of discovery.probed) console.error(`  ${probed}`);
    process.exit(2);
  }
  const relay = await startVaultRelay({
    live: process.env.VAULT_RELAY_LIVE === "1",
  });
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: discovery.path,
      headless: true,
    });
    await probe(relay.origin);
    const publisher = await browser.newContext();
    const receiver = await browser.newContext();
    const pageA = await publisher.newPage();
    const pageB = await receiver.newPage();
    const pageOrigin = relay.pageOrigin ?? relay.origin;
    await pageA.goto(joinUrl(pageOrigin, relay.origin, "a", "ada"));
    const first = await joinedText(pageA, "a");
    if (first.status !== "201") fail(`A create status ${first.status}`);
    if (first.generation !== "1") fail(`A generation ${first.generation}`);
    if (first.ciphertext !== CIPHERTEXT)
      fail(`A ciphertext ${first.ciphertext}`);
    if (first.body.includes(ITEM_NAME)) fail("A rendered an item name");

    await pageB.goto(joinUrl(pageOrigin, relay.origin, "b", "bee"));
    const second = await joinedText(pageB, "b");
    if (second.status !== "403") fail(`B create status ${second.status}`);
    if (second.generation !== "1") fail(`B generation ${second.generation}`);
    if (second.ciphertext !== CIPHERTEXT) {
      fail(`B ciphertext ${second.ciphertext}`);
    }
    if (second.body.includes(ITEM_NAME)) fail("B rendered an item name");
    console.log("[relay-join] A published generation 1; B read the ciphertext");
  } finally {
    await browser?.close();
    await relay.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(process.exitCode || 1);
});
