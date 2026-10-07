import { createItem, manualPassword } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { storeManifestFile } from "../../sections/vault/import/store-manifest.js";
import { createRetiredCredentialFixture } from "../retired-credentials/test-support.js";
import { planDigest, planFromRecipients } from "../sops/plan.js";
import { SopsSession } from "../sops/session.js";
import { newIdentity } from "../sops/test-support.js";
import { exportVaultSecrets } from "../sops/vault-secrets.js";
let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
});
afterEach(() => fixture.restore());
it.each(["manifest", "sops"])(
  "preserves the actual owner's raw bound credential in %s just as its resolved view",
  async (format) => {
    const account = createItem("account", "Raw bound account");
    account.methods = [
      manualPassword(
        `${account.id}:password`,
        "RAW_BOUND_EXPORT_SENTINEL",
        account.createdAt,
      ),
    ];
    await fixture.store.saveItem(account);
    const state = fixture.store.getSnapshot();
    const raw = state.rawItems ?? [];
    const rawAccount = raw.find((item) => item.id === account.id);
    expect(rawAccount?.kind === "account" && rawAccount.methods).toEqual([]);
    if (format === "manifest") {
      const exported = storeManifestFile(raw, state.folders);
      const resolved = storeManifestFile(state.items, state.folders);
      expect(exported.text).toContain("RAW_BOUND_EXPORT_SENTINEL");
      expect(exported.text).toBe(resolved.text);
      expect(exported.count).toBe(1);
      return;
    }
    const session = new SopsSession();
    const identity = await newIdentity();
    const plan = planFromRecipients({
      format: "json",
      groups: [[identity.recipient]],
    });
    const permit = session.permit({
      vaultScope: state.tomb,
      documentGeneration: 1,
      approvedPlanDigest: await planDigest(plan),
    });
    try {
      const document = await exportVaultSecrets({
        runner: session.runner,
        items: raw,
        plan,
        permit,
      });
      expect(document).not.toContain("RAW_BOUND_EXPORT_SENTINEL");
      const opened = await session.runner.open(
        document,
        "json",
        [identity.identity],
        permit,
      );
      expect(opened.plaintext).toContain("RAW_BOUND_EXPORT_SENTINEL");
      const resolved = await exportVaultSecrets({
        runner: session.runner,
        items: state.items,
        plan,
        permit,
      });
      const resolvedOpen = await session.runner.open(
        resolved,
        "json",
        [identity.identity],
        permit,
      );
      expect(JSON.parse(opened.plaintext)).toEqual(
        JSON.parse(resolvedOpen.plaintext),
      );
    } finally {
      session.bump();
    }
  },
);
