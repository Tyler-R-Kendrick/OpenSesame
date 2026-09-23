import { defined } from "@opensesame/contracts";
import { describe, expect, it } from "vitest";
import {
  mintDisposableAgePair,
  openAgeActivation,
  sealAgeActivation,
} from "./age-activation.js";
import { createIndependentCompartmentKey } from "./slots.js";

describe("KEYS-B age activation packages", () => {
  it("round-trips without protected-root bootstrap", async () => {
    const pair = await mintDisposableAgePair();
    const key = createIndependentCompartmentKey();
    const pkg = await sealAgeActivation({
      compartmentKey: key,
      recipients: [pair.recipient],
      profileId: "p1",
      vaultRef: "v1",
      policyRevision: 3,
      keyEpoch: 2,
    });
    const opened = await openAgeActivation({
      identity: pair.identity,
      package: pkg,
      expect: { vaultRef: "v1", policyRevision: 3, keyEpoch: 2 },
    });
    expect(opened).not.toBeNull();
    expect([...defined(opened, "opened")]).toEqual([...key]);
  });

  it("rejects wrong identity and context", async () => {
    const a = await mintDisposableAgePair();
    const b = await mintDisposableAgePair();
    const key = createIndependentCompartmentKey();
    const pkg = await sealAgeActivation({
      compartmentKey: key,
      recipients: [a.recipient],
      profileId: "p1",
      vaultRef: "v1",
      policyRevision: 1,
      keyEpoch: 1,
    });
    expect(
      await openAgeActivation({
        identity: b.identity,
        package: pkg,
        expect: { vaultRef: "v1", policyRevision: 1, keyEpoch: 1 },
      }),
    ).toBeNull();
    expect(
      await openAgeActivation({
        identity: a.identity,
        package: pkg,
        expect: { vaultRef: "other", policyRevision: 1, keyEpoch: 1 },
      }),
    ).toBeNull();
  });
});
