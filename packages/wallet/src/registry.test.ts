import { describe, expect, it } from "vitest";
import {
  InMemoryWalletRegistrationStore,
  WalletRegistrationConflictError,
} from "./registry.js";

const NOW = new Date("2026-08-31T12:00:00.000Z");
const INPUT = {
  registrationId: "dev-laptop",
  ownerPrincipalId: "prn_alice",
  passId: "3388000000022125777.l_abc",
};

function store(): InMemoryWalletRegistrationStore {
  return new InMemoryWalletRegistrationStore(() => NOW);
}

describe("InMemoryWalletRegistrationStore", () => {
  it("records a registration as active", async () => {
    const s = store();
    const row = await s.create(INPUT);
    expect(row.state).toBe("active");
    expect(row.createdAt).toEqual(NOW);
    expect(row).not.toHaveProperty("disabledAt");
    expect(await s.get("dev-laptop")).toMatchObject({ state: "active" });
  });

  it("refuses a duplicate registration id", async () => {
    const s = store();
    await s.create(INPUT);
    await expect(s.create(INPUT)).rejects.toBeInstanceOf(
      WalletRegistrationConflictError,
    );
  });

  it("scopes list to the owner", async () => {
    const s = store();
    await s.create(INPUT);
    await s.create({
      registrationId: "work-phone",
      ownerPrincipalId: "prn_bob",
      passId: "3388000000022125777.l_def",
    });
    const alice = await s.list("prn_alice");
    expect(alice).toHaveLength(1);
    expect(alice[0]?.registrationId).toBe("dev-laptop");
  });

  it("disables locally, and disablement stands on its own (T-29)", async () => {
    const s = store();
    await s.create(INPUT);
    const disabled = await s.disable("dev-laptop");
    // The store is the source of truth: no Google call is involved in turning
    // a launcher off, so this succeeds regardless of vendor reachability.
    expect(disabled?.state).toBe("disabled");
    expect(disabled?.disabledAt).toEqual(NOW);
    expect(await s.get("dev-laptop")).toMatchObject({ state: "disabled" });
  });

  it("is idempotent on disable and truthful on an unknown id", async () => {
    const s = store();
    await s.create(INPUT);
    await s.disable("dev-laptop");
    expect(await s.disable("dev-laptop")).toMatchObject({ state: "disabled" });
    // A launcher nobody registered cannot be reported as turned off.
    expect(await s.disable("never-existed")).toBeNull();
  });
});
