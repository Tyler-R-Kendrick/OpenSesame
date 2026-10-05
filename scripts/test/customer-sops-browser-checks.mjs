// Browser callback: the real SOPS engine binds document handles to customer scope.
export async function verifySopsCustomerIsolation() {
  const passed = [];
  function check(condition, label) {
    if (!condition) throw new Error(label);
    passed.push(label);
  }
  async function refuses(operation, label) {
    let refused = false;
    try {
      await operation();
    } catch {
      refused = true;
    }
    check(refused, label);
  }
  let generation = 0;
  const engine = new globalThis.SopsEngine(
    new globalThis.HandleRegistry(() => generation),
  );
  const signal = new AbortController().signal;
  const permit = (customer, digest = "") => ({
    scope: {
      operationId: "browser-regression",
      documentGeneration: 1,
      sessionGeneration: generation,
      vaultScope: customer,
    },
    approvedPlanDigest: digest,
    network: "forbidden",
  });
  const ageA = await globalThis.age.generateX25519Identity();
  const ageB = await globalThis.age.generateX25519Identity();
  const reopenedSops = await verifyOpenAndEdit({
    engine,
    signal,
    permit,
    ageA,
    ageB,
    check,
    refuses,
  });
  await verifyRecipientRotation({
    engine,
    signal,
    permit,
    ageA,
    ageB,
    check,
    refuses,
    reopenedSops,
  });
  generation += 1;
  engine.disposeAll();
  await refuses(
    () =>
      engine.saveEdited(
        reopenedSops.handle,
        '{"token":"late write"}',
        permit("customer-a"),
        signal,
      ),
    "vault switch invalidates SOPS document handles",
  );
  return passed;
}

async function verifyOpenAndEdit({
  engine,
  signal,
  permit,
  ageA,
  ageB,
  check,
  refuses,
}) {
  const recipientA = await globalThis.age.identityToRecipient(ageA);
  const plan = globalThis.sopsPlans.planFromRecipients({
    format: "json",
    groups: [[recipientA]],
  });
  const encrypted = await engine.encryptNew(
    '{"token":"customer A SOPS secret"}',
    {
      plan,
      permit: permit("customer-a", await globalThis.sopsPlans.planDigest(plan)),
      signal,
    },
  );
  const second = await engine.encryptNew('{"token":"customer A SOPS secret"}', {
    plan,
    permit: permit("customer-a", await globalThis.sopsPlans.planDigest(plan)),
    signal,
  });
  check(
    encrypted !== second && !encrypted.includes("customer A SOPS secret"),
    "browser SOPS uses fresh data keys and seals secret values",
  );
  await refuses(
    () =>
      engine.open(encrypted, "json", {
        identities: [ageB],
        permit: permit("customer-b"),
        signal,
      }),
    "other customer age identity cannot open SOPS envelope",
  );
  const sopsOpened = await engine.open(encrypted, "json", {
    identities: [ageA],
    permit: permit("customer-a"),
    signal,
  });
  check(
    JSON.parse(sopsOpened.plaintext).token === "customer A SOPS secret",
    "customer age identity opens browser SOPS envelope",
  );
  await refuses(
    () =>
      engine.saveEdited(
        sopsOpened.handle,
        '{"token":"cross customer write"}',
        permit("customer-b"),
        signal,
      ),
    "SOPS document handle cannot cross customer vault scope",
  );
  const edited = await engine.saveEdited(
    sopsOpened.handle,
    '{"token":"updated customer A secret"}',
    permit("customer-a"),
    signal,
  );
  const reopenedSops = await engine.open(edited, "json", {
    identities: [ageA],
    permit: permit("customer-a"),
    signal,
  });
  check(
    JSON.parse(reopenedSops.plaintext).token === "updated customer A secret",
    "browser SOPS edit preserves authenticated envelope",
  );
  return reopenedSops;
}

async function verifyRecipientRotation({
  engine,
  signal,
  permit,
  ageA,
  ageB,
  check,
  refuses,
  reopenedSops,
}) {
  const rotatedPlan = globalThis.sopsPlans.planFromRecipients({
    format: "json",
    groups: [[await globalThis.age.identityToRecipient(ageB)]],
  });
  const rotatedSops = await engine.rotate(reopenedSops.handle, null, {
    plan: rotatedPlan,
    permit: permit(
      "customer-a",
      await globalThis.sopsPlans.planDigest(rotatedPlan),
    ),
    signal,
  });
  await refuses(
    () =>
      engine.open(rotatedSops, "json", {
        identities: [ageA],
        permit: permit("customer-a"),
        signal,
      }),
    "SOPS recipient rotation refuses the former customer key",
  );
  const nextSops = await engine.open(rotatedSops, "json", {
    identities: [ageB],
    permit: permit("customer-a"),
    signal,
  });
  check(
    JSON.parse(nextSops.plaintext).token === "updated customer A secret",
    "browser SOPS recipient rotation preserves secret values",
  );
}
