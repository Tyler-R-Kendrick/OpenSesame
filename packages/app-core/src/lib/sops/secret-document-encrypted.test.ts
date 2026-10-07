import { expect, it } from "vitest";
import { pepperedAccount, plainAccount } from "../account.test-support.js";
import { inlineRunner } from "./runner.js";
import { NEVER, TestSession, newIdentities } from "./test-support.js";
import { exportVaultSecrets, importVaultSecrets } from "./vault-secrets.js";

it("encrypted account export preserves its base password without granting missing recipients or silently relaxing threshold consent", async () => {
  const identity = await newIdentities(3);
  const session = new TestSession();
  const runner = inlineRunner(session.engine, () => NEVER);
  const { plan, permit } = await session.plan(
    "json",
    [[identity(0).recipient], [identity(1).recipient]],
    { shamirThreshold: 2 },
  );
  const account = plainAccount(
    "Controlled integration account",
    "integration-only-password",
  );
  const peppered = pepperedAccount("Separate pepper slot", "stored-base", "-3");
  const ciphertext = await exportVaultSecrets({
    runner,
    items: [account, peppered],
    plan,
    permit,
  });
  expect(ciphertext).not.toContain("integration-only-password");
  expect(ciphertext).not.toContain("stored-base");
  const open = (identities: string[], consentToVaultCopy: boolean) =>
    importVaultSecrets({
      runner,
      ciphertext,
      identities,
      consentToVaultCopy,
      permit: session.permit(),
    });
  try {
    await expect(
      open([identity(0).identity, identity(1).identity], false),
    ).rejects.toMatchObject({ code: "unauthorized_policy" });
    await expect(open([identity(0).identity], true)).rejects.toMatchObject({
      code: "insufficient_groups",
    });
    await expect(open([identity(2).identity], true)).rejects.toMatchObject({
      code: "missing_identity",
    });
    const imported = await open(
      [identity(0).identity, identity(1).identity],
      true,
    );
    expect(imported.thresholdRelaxed).toBe(true);
    expect(imported.items).toEqual([account, peppered]);
  } finally {
    runner.invalidate(session.generation + 1);
  }
});
