/**
 * Peer signed envelopes + alert outbox under network loss (BROWSER-QA-D).
 */
export async function walkPeerEnvelope({ page, check }) {
  const result = await page.evaluate(async () => {
    const qa = window.__duressQa;
    const { privateKey, publicKey } = await qa.generatePeerKeyPair();
    const now = Date.now();
    const base = {
      issuer: "peer-a",
      audience: "peer-b",
      principalRef: "p1",
      vaultRef: "vault-qa",
      deviceBindingRef: "device-qa",
      operation: "quarantine",
      incidentId: "inc-1",
      policyRevision: 1,
      keyEpoch: 1,
      nonce: `nonce-${now}`,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      ciphertextB64: btoa("opaque"),
    };
    const signed = await qa.signPeerEnvelope(base, privateKey);
    const seen = new Set();
    const ok = await qa.verifyPeerEnvelope(
      signed,
      publicKey,
      { audience: "peer-b", permittedOperations: ["quarantine"] },
      seen,
    );
    const replay = await qa.verifyPeerEnvelope(
      signed,
      publicKey,
      { audience: "peer-b", permittedOperations: ["quarantine"] },
      seen,
    );
    const wrongAud = await qa.verifyPeerEnvelope(
      signed,
      publicKey,
      { audience: "other", permittedOperations: ["quarantine"] },
      new Set(),
    );
    return { ok, replay, wrongAud };
  });

  check(result.ok?.ok === true, "peer envelope verifies");
  check(result.replay?.ok === false, "nonce replay rejected");
  check(result.wrongAud?.ok === false, "wrong audience rejected");
  return result;
}

export async function walkNetworkLoss({ page, check }) {
  const result = await page.evaluate(async () => {
    const qa = window.__duressQa;
    const sealingKey = await qa.createAlertSealingKey();
    const pkg = await qa.sealAlertPackage({
      incidentId: "inc-net",
      profileId: "SC-ALERT-ONLY",
      routeRef: "route-qa",
      templateRef: "tmpl-qa",
      payload: { kind: "duress_alert" },
      sealingKey,
      expiryMs: 60_000,
    });
    const outbox = new qa.AlertOutbox();
    outbox.enqueue(pkg, 3);
    // Simulate delivery failure — no unlock, outbox retained (INV-17).
    const failed = outbox.advance(pkg.packageId, "failed", "relay");
    const retained = outbox.exportRetainedOpaque();
    return {
      status: failed.status,
      retainedCount: retained.length,
      listed: outbox.list().length,
    };
  });

  check(result.status === "failed", "network loss marks delivery failed");
  check(result.listed === 1, "outbox entry survives failed delivery");
  check(
    result.retainedCount === 0,
    "failed packages are not export-retained as queued",
  );
  return result;
}

export async function walkMultiContext({
  browser,
  fixtureOrigin,
  installFixtureRoutes,
  check,
  record,
}) {
  const channel = `duress-qa-fence-${Date.now()}`;
  const ctxA = await browser.newContext({
    viewport: { width: 1100, height: 800 },
    serviceWorkers: "block",
  });
  const ctxB = await browser.newContext({
    viewport: { width: 1100, height: 800 },
    serviceWorkers: "block",
  });
  if (installFixtureRoutes) {
    await installFixtureRoutes(ctxA);
    await installFixtureRoutes(ctxB);
  }
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await pageA.goto(fixtureOrigin, { waitUntil: "networkidle" });
  await pageA.waitForFunction(() => Boolean(window.__duressQa));
  await pageB.goto(fixtureOrigin, { waitUntil: "networkidle" });
  await pageB.waitForFunction(() => Boolean(window.__duressQa));

  const setup = await pageA.evaluate((name) => {
    const qa = window.__duressQa;
    window.__fence = new qa.DuressSessionFence(name);
    return true;
  }, channel);
  check(setup === true, "context A fence constructed");

  await pageB.evaluate((name) => {
    const qa = window.__duressQa;
    window.__fence = new qa.DuressSessionFence(name);
    window.__hints = [];
    // BroadcastChannel is hint-only; record messages without trusting them.
    const ch = new BroadcastChannel(name);
    ch.onmessage = (ev) => window.__hints.push(ev.data);
  }, channel);

  const activated = await pageA.evaluate(() => {
    const fence = window.__fence.activate({
      incidentId: "inc-multi",
      policyRevision: 1,
      keyEpoch: 1,
      denyOperations: ["export"],
      admittedCompartmentRefs: ["c1"],
    });
    return fence.incidentEpoch;
  });
  check(activated >= 1, "context A fence epoch increments");

  await pageB.waitForTimeout(400);
  const hints = await pageB.evaluate(() => window.__hints ?? []);
  record(
    "multi-context",
    JSON.stringify({
      hints,
      note: "BroadcastChannel is hint-only; B must re-read durable fence",
    }),
  );
  check(
    Array.isArray(hints),
    hints.length > 0
      ? "context B received fence hint (not authoritative)"
      : "context B hint channel observed (may be empty under isolation)",
  );

  // Independent in-memory fences: B does not auto-apply A's state.
  const bEpoch = await pageB.evaluate(
    () => window.__fence.readFence().incidentEpoch,
  );
  check(
    bEpoch === 0,
    "context B fence remains local until it re-reads durable state",
  );

  await ctxA.close();
  await ctxB.close();
  return { activated, hints, bEpoch };
}

export async function walkRestart({ page, check }) {
  const result = await page.evaluate(async () => {
    const qa = window.__duressQa;
    const key = qa.createIndependentCompartmentKey();
    const slot = await qa.sealProfileSlot({
      code: "48291037",
      slotId: "slot-restart",
      profileId: "SC-LOCAL-HOLD",
      vaultRef: "vault-qa",
      deviceBindingRef: "device-qa",
      policyRevision: 1,
      keyEpoch: 1,
      plaintext: {
        compartmentKey: key,
        actionCapability: null,
        presentation: "locked",
      },
    });
    localStorage.setItem("duress-qa:slot", JSON.stringify(slot));
    return { stored: true };
  });
  check(result.stored, "sealed slot persisted to localStorage");

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.__duressQa));
  const after = await page.evaluate(async () => {
    const qa = window.__duressQa;
    const raw = localStorage.getItem("duress-qa:slot");
    if (!raw) return { missing: true };
    const slot = JSON.parse(raw);
    const opened = await qa.openProfileSlot("48291037", slot, {
      vaultRef: "vault-qa",
      deviceBindingRef: "device-qa",
      policyRevision: 1,
      keyEpoch: 1,
    });
    return {
      missing: false,
      presentation: opened?.presentation ?? null,
    };
  });
  check(!after.missing, "slot survives reload");
  check(after.presentation === "locked", "slot opens after restart");
  return after;
}
