import { describe, expect, it } from "vitest";
import {
  authorizeTransaction,
  consumeOwnedDevice,
  createMemoryCeremonySubjectStore,
  newOwnedDevice,
  newPairingSession,
  newTransactionRecord,
  pairSession,
} from "./ceremony-subjects.js";

const NOW = new Date("2026-09-17T12:00:00.000Z");

describe("ceremony subject records", () => {
  it("consumes a pending device session through approve then consume", () => {
    const owned = newOwnedDevice("das_1", "prn_owner", NOW);
    const spent = consumeOwnedDevice(owned, "prn_approver", NOW);
    expect(spent.session.state).toBe("consumed");
    expect(spent.session.approvedByPrincipalId).toBe("prn_approver");
    expect(spent.session.consumedAt).toEqual(NOW);
    expect(consumeOwnedDevice(spent, "prn_other", NOW).session.state).toBe(
      "consumed",
    );
  });

  it("pairs and authorizes without mixing ids", () => {
    const store = createMemoryCeremonySubjectStore();
    store.putPairing(
      pairSession(newPairingSession("p1", "prn_a", NOW), "prn_b", NOW),
    );
    store.putTransaction(
      authorizeTransaction(
        newTransactionRecord("t1", "prn_a", NOW),
        "prn_b",
        NOW,
        "res_1",
      ),
    );
    const paired = store.getPairing("p1");
    expect(paired?.state).toBe("paired");
    if (paired) {
      expect(pairSession(paired, "prn_c", NOW).state).toBe("paired");
    }
    const txn = store.getTransaction("t1");
    expect(txn?.state).toBe("authorized");
    expect(txn?.resourceRef).toBe("res_1");
    if (txn) {
      expect(authorizeTransaction(txn, "prn_c", NOW).state).toBe("authorized");
    }
    expect(store.getDevice("das_1")).toBeUndefined();
  });
});
