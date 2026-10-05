import { describe, expect, it } from "vitest";
import { SealedKv } from "./store";
import { MemoryStore, useTestDeviceKey } from "./test-support/memory";
import { CURRENT_PASSWORD, RunnerVault } from "./vault";

const CUSTOMER_A = {
  origin: "https://customer-a.example",
  runId: "run:shared",
};
const CUSTOMER_B = {
  origin: "https://customer-b.example",
  runId: "run:shared",
};

async function localVault() {
  useTestDeviceKey();
  const raw = new MemoryStore();
  const kv = new SealedKv(raw);
  return { raw, kv, vault: new RunnerVault(kv) };
}

function onlyAddedKey(raw: MemoryStore, before: Set<string>): string {
  const added = [...raw.rows.keys()].filter((key) => !before.has(key));
  expect(added).toHaveLength(1);
  const [key] = added;
  if (!key) throw new Error("missing fixture record");
  return key;
}

describe("local runner credential boundaries", () => {
  it("refuses ciphertext transplanted between customer origins on the same device", async () => {
    const { raw, vault } = await localVault();
    await vault.putEntry({
      ...CUSTOMER_A,
      username: "alice",
      password: "customer-a fixture",
    });
    const keyA = onlyAddedKey(raw, new Set());
    const beforeB = new Set(raw.rows.keys());
    await vault.putEntry({
      ...CUSTOMER_B,
      username: "bob",
      password: "customer-b fixture",
    });
    const keyB = onlyAddedKey(raw, beforeB);
    expect(await vault.resolve(CURRENT_PASSWORD, CUSTOMER_A)).toBe(
      "customer-a fixture",
    );
    expect(await vault.resolve(CURRENT_PASSWORD, CUSTOMER_B)).toBe(
      "customer-b fixture",
    );
    const ciphertext = raw.rows.get(keyA);
    if (!ciphertext) throw new Error("missing fixture ciphertext");
    raw.rows.set(keyB, ciphertext);
    expect(await vault.resolve(CURRENT_PASSWORD, CUSTOMER_B)).toBeNull();
    expect(await vault.resolve(CURRENT_PASSWORD, CUSTOMER_A)).toBe(
      "customer-a fixture",
    );
  });

  it("refuses candidate replay across runs, origins and ciphertext storage names", async () => {
    const { raw, vault } = await localVault();
    const handleA = `candidate:${crypto.randomUUID()}`;
    const handleB = `candidate:${crypto.randomUUID()}`;
    await vault.generate(CUSTOMER_A, handleA);
    const keyA = onlyAddedKey(raw, new Set());
    const beforeB = new Set(raw.rows.keys());
    await vault.generate(CUSTOMER_B, handleB);
    const keyB = onlyAddedKey(raw, beforeB);
    expect(await vault.resolve(handleA, CUSTOMER_A)).not.toBeNull();
    expect(await vault.resolve(handleA, CUSTOMER_B)).toBeNull();
    expect(
      await vault.resolve(handleA, { ...CUSTOMER_A, runId: "run:other" }),
    ).toBeNull();
    const ciphertext = raw.rows.get(keyA);
    if (!ciphertext) throw new Error("missing fixture ciphertext");
    raw.rows.set(keyB, ciphertext);
    expect(await vault.resolve(handleB, CUSTOMER_B)).toBeNull();
    expect(await vault.resolve(handleA, CUSTOMER_A)).not.toBeNull();
  });
});
