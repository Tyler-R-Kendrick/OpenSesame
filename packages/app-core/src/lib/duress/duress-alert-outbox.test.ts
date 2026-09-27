import { describe, expect, it } from "vitest";
import { AlertOutbox } from "./alert/outbox.js";
import { importAlertSealingKey, sealAlertPackage } from "./alert/seal.js";

async function alertKeys() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return importAlertSealingKey(raw);
}

describe("alert outbox", () => {
  it("does not treat relay accept as human ack (AT-050/051)", async () => {
    const { encryptKey, macKey } = await alertKeys();
    const pkg = await sealAlertPackage({
      incidentId: "i1",
      profileId: "p1",
      routeRef: "r1",
      templateRef: "t1",
      payload: { kind: "duress_alert" },
      encryptKey,
      macKey,
      policyRevision: 1,
      keyEpoch: 1,
      expiryMs: 60_000,
    });
    const box = new AlertOutbox();
    box.enqueue(pkg, 3);
    box.advance(pkg.packageId, "delivered", "relay");
    expect(() =>
      box.advance(pkg.packageId, "human_acknowledged", "relay"),
    ).toThrow(/authority_mismatch|invalid_transition/);
  });
});
