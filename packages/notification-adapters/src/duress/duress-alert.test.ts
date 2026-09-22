import { describe, expect, it } from "vitest";
import {
  clearLocalDeliveryQueue,
  createLocalDeliveryDouble,
  mapTransportToRelayAccept,
  toSecretFreeDiagnostic,
} from "./index.js";

describe("duress alert adapter helpers", () => {
  const pkg = {
    packageId: "alert-1",
    incidentId: "inc-1",
    routeRef: "route-1",
    templateRef: "tmpl",
    ciphertextB64: "CIPHERTEXT_SECRET",
    evidenceMacB64: "MAC_SECRET",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    nonce: "n1",
  };

  it("maps transport statuses without promoting to human ack", () => {
    expect(mapTransportToRelayAccept({ status: "delivered" })).toBe("accepted");
    expect(mapTransportToRelayAccept({ status: "retryable" })).toBe(
      "retryable",
    );
    expect(mapTransportToRelayAccept({ status: "permanent", error: "x" })).toBe(
      "rejected",
    );
    expect(mapTransportToRelayAccept({ status: "unconfigured" })).toBe(
      "rejected",
    );
  });

  it("keeps diagnostics secret-free", () => {
    const diag = toSecretFreeDiagnostic(pkg, { status: "delivered" });
    const raw = JSON.stringify(diag);
    expect(raw).not.toContain("CIPHERTEXT_SECRET");
    expect(raw).not.toContain("MAC_SECRET");
    expect(diag.packageId).toBe("alert-1");
  });

  it("local double never invents success when configured to reject; queue clear is local-only", async () => {
    const reject = createLocalDeliveryDouble({ mode: "reject" });
    const outcome = await reject.deliver(pkg);
    expect(outcome.status).toBe("permanent");
    expect(reject.attempts).toHaveLength(1);
    const cleared = clearLocalDeliveryQueue(reject);
    expect(cleared.cleared).toBe(1);
    expect(cleared.remoteRetracted).toBe(false);
    expect(reject.attempts).toHaveLength(0);
  });
});
