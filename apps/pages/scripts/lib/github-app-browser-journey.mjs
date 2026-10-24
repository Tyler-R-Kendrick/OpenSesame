/** Measured browser lifecycle; an existing remote is never written to make recovery look successful. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { expect } from "@playwright/test";
import {
  SOURCE_PIN,
  TARGET_PIN,
  addCanary,
  bindRepository,
  captureGithub,
  contains,
  editCanary,
  explicitWrite,
  exportedBody,
  githubPage,
  newVault,
  providerIdle,
  registerGithubApp,
  unlockAt,
} from "./github-app-browser-setup.mjs";
import { lockVault } from "./pages-journey.mjs";
import { openBrowserBackup } from "./secret-backend-backup-oracle.mjs";

const fingerprint = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const putRequests = (fixture) =>
  fixture.rows.filter((row) => row.method === "PUT").length;
async function fixtureDeadline(promise, label) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}: original20s request bound`)),
          20000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function unchangedRemote(fixture, repo, original, stage) {
  const now = fixture.snapshot(repo);
  assert.ok(
    now.head === original.head &&
      now.sha256 === original.sha256 &&
      now.putCount === original.putCount &&
      putRequests(fixture) === original.putRequestCount,
    `Recovery must not replace source ciphertext at ${stage}`,
  );
}
async function openRestore(page) {
  await page
    .getByRole("button", { name: "Read encrypted vault backup", exact: true })
    .click();
  const form = page.getByRole("form", {
    name: "Restore vault backup",
    exact: true,
  });
  await form.waitFor();
  await expect(
    form.getByLabel("Backup name or ID", { exact: true }),
  ).toHaveValue("opensesame-vault.backup.json");
  await expect(
    form.getByLabel("Backup name or ID", { exact: true }),
  ).toHaveAttribute("readonly", "");
  await expect(
    page.getByRole("form", { name: "Back up vault", exact: true }),
  ).toHaveCount(0);
  return form;
}
async function restoreAt(page, pin, { failure = false } = {}) {
  const form = await openRestore(page);
  const credential = form.getByLabel("Backup password or PIN", { exact: true });
  await credential.fill(pin);
  await form
    .getByRole("button", {
      name: "Restore encrypted vault backup",
      exact: true,
    })
    .click();
  await expect(credential).toHaveValue("");
  if (failure) {
    await form.locator(".status-mark--err").waitFor();
    await expect(form.locator(".status-mark--ok")).toHaveCount(0);
  } else
    await form
      .getByRole("img", {
        name: /^[1-9][0-9]* items restored from encrypted backup$/,
      })
      .waitFor();
}

export async function sourceJourney(owner, options) {
  const { phase, repo, width, fixture, base, record } = options;
  let page = owner.page;
  await newVault(page, { ...options, pin: SOURCE_PIN });
  const canary = {
    name: `GitHub source ${width}`,
    value: `github-browser-encrypted-source-${width}`,
  };
  const canaryURL = await addCanary(page, { base, ...canary });
  await githubPage(page, base);
  await captureGithub(page, `${phase}-${width}-setup`, options);
  page = await registerGithubApp(page, { ...options, pin: SOURCE_PIN });
  owner.page = page;
  await bindRepository(page, repo, { ...options, create: true });
  await explicitWrite(page, repo, { fixture, first: phase === "after" });
  fixture.assertCiphertextExcludes(repo, [
    SOURCE_PIN,
    canary.name,
    canary.value,
  ]);
  const remote = {
    ...fixture.snapshot(repo),
    putRequestCount: putRequests(fixture),
  };
  const body = await openBrowserBackup(
    fixture.ciphertext(repo, remote.head),
    SOURCE_PIN,
  );
  assert.ok(
    contains(body, canary),
    "Actual uploaded ciphertext opens with source PIN and contains source item",
  );
  assert.ok(
    body.deviceIdentityKey,
    "Source backup carries a genuine sealed device identity",
  );
  await captureGithub(page, `${phase}-${width}-repository`, options);
  const restore = page.getByRole("button", {
    name: "Read encrypted vault backup",
    exact: true,
  });
  const available = await restore.count();
  if (phase === "before") {
    assert.equal(
      available,
      0,
      "Before artifact honestly lacks mounted restore control",
    );
    await captureGithub(page, `${phase}-${width}-restore`, options);
  } else {
    await expect(restore).toBeVisible();
    await openRestore(page);
    await captureGithub(page, `${phase}-${width}-restore`, options);
    await page
      .getByRole("button", { name: "Close encrypted backup", exact: true })
      .click();
  }
  record(
    "source",
    "Real registration, RSA grants, list/create, one explicit PUT and immutable ciphertext verified",
  );
  return {
    remote,
    body,
    canary,
    canaryRoute: canaryURL.split(base)[1],
    restoreAvailable: available === 1,
  };
}

async function coldDestination(page, options) {
  const { base, fixture, record } = options;
  const previous = fixture.summary().validAppJwtChecks;
  await page.reload({ waitUntil: "networkidle" });
  await page.getByLabel("PIN", { exact: true }).fill(SOURCE_PIN);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  // The wrong source PIN must not open the independently enrolled destination.
  await page.getByRole("button", { name: "Unlock", exact: true }).waitFor();
  await expect(
    page
      .getByRole("button", { name: "Lock vault", exact: true })
      .filter({ visible: true }),
  ).toHaveCount(0);
  await unlockAt(page, TARGET_PIN);
  await githubPage(page, base);
  await expect
    .poll(() => fixture.summary().validAppJwtChecks)
    .toBeGreaterThan(previous);
  record(
    "cold",
    "Different destination PIN retained; real App JWT revalidated after cold reload",
  );
}
async function cancelHeldRead(page, options) {
  const { fixture, repo, base, record } = options;
  await githubPage(page, base);
  await providerIdle(fixture);
  const before = {
    ...fixture.snapshot(repo),
    putRequestCount: putRequests(fixture),
  };
  const gate = fixture.holdNextRead();
  try {
    await page
      .getByRole("button", { name: "Read encrypted vault backup", exact: true })
      .click();
    await fixtureDeadline(gate.seen, "Held provider read reached");
    await page
      .getByRole("button", { name: "Close encrypted backup", exact: true })
      .click();
    await fixtureDeadline(gate.closed, "Cancelled provider socket closed");
    await expect(
      page.getByRole("form", { name: "Restore vault backup", exact: true }),
    ).toHaveCount(0);
    unchangedRemote(fixture, repo, before, "cancelled held provider read");
    record(
      "withdrawal",
      "Actual caller cancellation closed bridge/provider HTTP and never opened stale restore",
    );
  } finally {
    gate.release();
  }
}
async function withdrawApp(page, options) {
  const { fixture, base, record } = options;
  await githubPage(page, base);
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", {
      name: "Remove GitHub App from this device",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Create GitHub App", exact: true })
    .waitFor();
  const before = fixture.rows.length;
  await page.reload({ waitUntil: "networkidle" });
  await unlockAt(page, TARGET_PIN);
  await githubPage(page, base);
  await page
    .getByRole("button", { name: "Create GitHub App", exact: true })
    .waitFor();
  assert.equal(
    fixture.rows.length,
    before,
    "Removed App cannot revalidate or spend its key on cold reload",
  );
  await lockVault(page);
  record(
    "withdrawal",
    "App key removal persists cold and vault lock removes access; no identity sign-in session was fabricated",
  );
}

async function admitDestinationWrites(
  page,
  source,
  retained,
  original,
  options,
) {
  const { fixture, repo, base } = options;
  await githubPage(page, base);
  await explicitWrite(page, repo, { fixture, first: true });
  const saved = await openBrowserBackup(fixture.ciphertext(repo), TARGET_PIN);
  assert.ok(
    contains(saved, source.canary) && contains(saved, retained),
    "Deliberate first write uploads merged destination-encrypted snapshot",
  );
  assert.ok(
    fingerprint(saved.deviceIdentityKey) ===
      fingerprint(original.deviceIdentityKey),
    "Confirmed backup retains destination identity",
  );
  const beforeAuto = fixture.snapshot(repo);
  const requests = putRequests(fixture);
  const auto = { ...source.canary, value: `${source.canary.value}-updated` };
  await editCanary(page, { base, route: source.canaryRoute, ...auto });
  await expect
    .poll(() => fixture.snapshot(repo).putCount)
    .toBe(beforeAuto.putCount + 1);
  assert.equal(
    putRequests(fixture) - requests,
    1,
    "One real mutation emits one automatic PUT after explicit admission",
  );
  const automatic = await openBrowserBackup(
    fixture.ciphertext(repo),
    TARGET_PIN,
  );
  assert.ok(
    contains(automatic, auto) &&
      automatic.items.length === saved.items.length &&
      automatic.folders.length === saved.folders.length,
    "Actual automatic ciphertext updates an existing secret without changing item/folder counts",
  );
  fixture.assertCiphertextExcludes(repo, [
    SOURCE_PIN,
    TARGET_PIN,
    source.canary.value,
    retained.value,
    auto.value,
  ]);
}

export async function destinationJourney(owner, source, options) {
  const { fixture, repo, base, width, record } = options;
  let page = owner.page;
  await newVault(page, { ...options, pin: TARGET_PIN });
  const retained = {
    name: `GitHub destination ${width}`,
    value: `destination-kept-${width}`,
  };
  await addCanary(page, { base, ...retained });
  page = await registerGithubApp(page, { ...options, pin: TARGET_PIN });
  owner.page = page;
  const original = await exportedBody(page, `${width}-destination-before`, {
    ...options,
    pin: TARGET_PIN,
  });
  assert.ok(
    original.deviceIdentityKey,
    "Destination has its independently sealed identity",
  );
  assert.ok(
    fingerprint(original.deviceIdentityKey) !==
      fingerprint(source.body.deviceIdentityKey),
    "Two real vaults have different device identities",
  );
  await bindRepository(page, repo, { ...options, create: false });
  unchangedRemote(
    fixture,
    repo,
    source.remote,
    "binding existing recovery repository",
  );
  await restoreAt(page, "82946731", { failure: true });
  unchangedRemote(fixture, repo, source.remote, "wrong backup PIN");
  const failed = await exportedBody(
    page,
    `${width}-destination-after-refusal`,
    { ...options, pin: TARGET_PIN },
  );
  assert.ok(
    fingerprint(failed.items) === fingerprint(original.items),
    "Wrong PIN changes no destination items",
  );
  assert.ok(
    fingerprint(failed.deviceIdentityKey) ===
      fingerprint(original.deviceIdentityKey),
    "Wrong PIN changes no destination identity",
  );
  await githubPage(page, base);
  await restoreAt(page, SOURCE_PIN);
  unchangedRemote(
    fixture,
    repo,
    source.remote,
    "successful merge before explicit write",
  );
  await captureGithub(page, `after-${width}-restored`, options);
  const merged = await exportedBody(page, `${width}-destination-merged`, {
    ...options,
    pin: TARGET_PIN,
  });
  assert.ok(
    contains(merged, source.canary) && contains(merged, retained),
    "Actual restore merges source and retained destination items",
  );
  assert.ok(
    fingerprint(merged.deviceIdentityKey) ===
      fingerprint(original.deviceIdentityKey),
    "Shared restore does not adopt the source identity",
  );
  unchangedRemote(fixture, repo, source.remote, "exporting merged vault");
  await admitDestinationWrites(page, source, retained, original, options);
  await githubPage(page, base);
  await coldDestination(page, options);
  await cancelHeldRead(page, options);
  await withdrawApp(page, options);
  record(
    "recovery",
    "Different PIN/identity, wrong-PIN refusal, read-only merge, explicit write and genuine autosync verified",
  );
  return {
    independentDestination: true,
    sourcePreservedUntilExplicitWrite: true,
    wrongPinRefused: true,
    mergedOwnIdentity: true,
    coldRevalidated: true,
    appWithdrawal: true,
    callerCancellation: true,
    automaticWrite: true,
    humanIdpSignOut:
      "not-created: local-only App-key authority; lock and key withdrawal actually exercised",
  };
}
