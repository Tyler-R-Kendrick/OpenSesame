import fc from "fast-check";
import { afterEach, beforeEach, expect, it } from "vitest";
import { kvGet, kvSet } from "../kv.js";
import {
  probeRetiredCredential,
  recordRetiredDecoyInteraction,
  retiredCredentialStatus,
} from "./index.js";
import { parseRetiredCredentialRecords } from "./records.js";
import { TRAPS_KEY, createRetiredCredentialFixture } from "./test-support.js";

let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
});
afterEach(() => fixture.restore());

it("rejects generated malformed records before credential classification", async () => {
  await fixture.enroll();
  const original = parseRetiredCredentialRecords(
    kvGet(TRAPS_KEY) ?? "",
    "personal",
  );
  const trap = original.traps[0];
  if (!trap) throw new Error("Missing selected trap");
  const mutations = [
    { ...original, tomb: "other-vault" },
    { ...original, traps: [trap, trap] },
    {
      ...original,
      traps: Array.from({ length: 4 }, (_, i) => ({
        ...trap,
        id: `trap-${i}`,
      })),
    },
    { ...original, traps: [{ ...trap, response: "wipe" }] },
    { ...original, traps: [{ ...trap, verifier: "attacker-selected" }] },
    { ...original, traps: [{ ...trap, salt: "attacker-selected" }] },
    { ...original, productionPrincipal: "real-owner" },
  ];
  const current = fixture.store.getSnapshot();
  await fc.assert(
    fc.asyncProperty(fc.constantFrom(...mutations), async (mutation) => {
      kvSet(TRAPS_KEY, JSON.stringify(mutation));
      await expect(
        probeRetiredCredential("retired-secret", "personal"),
      ).rejects.toThrow(/unavailable/);
      expect(fixture.store.getSnapshot()).toEqual(current);
    }),
    { seed: 1730105, numRuns: 28 },
  );
});

it("refuses ambiguous matches instead of choosing an attacker-controlled response", async () => {
  await fixture.enroll();
  const records = parseRetiredCredentialRecords(
    kvGet(TRAPS_KEY) ?? "",
    "personal",
  );
  const trap = records.traps[0];
  if (!trap) throw new Error("Missing selected trap");
  records.traps.push({
    ...trap,
    id: "different-id",
    response: "synthetic_decoy",
  });
  kvSet(TRAPS_KEY, JSON.stringify(records));
  await expect(
    probeRetiredCredential("retired-secret", "personal"),
  ).rejects.toThrow(/Ambiguous/);
  expect(retiredCredentialStatus("personal").events).toEqual([]);
});

it("bounds the evidence log according to an independent mixed-operation model", async () => {
  await fixture.enroll("selected-synthetic", "synthetic_decoy");
  await fixture.enroll("selected-reject", "reject");
  const initial = kvGet(TRAPS_KEY);
  if (!initial) throw new Error("Missing selected traps");
  const traps = retiredCredentialStatus("personal").traps;
  const synthetic = traps.find((trap) => trap.response === "synthetic_decoy");
  const rejected = traps.find((trap) => trap.response === "reject");
  if (!synthetic || !rejected) throw new Error("Missing response cases");
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom("write", "deny", "unknown", "reject"), {
        minLength: 33,
        maxLength: 80,
      }),
      async (operations) => {
        kvSet(TRAPS_KEY, initial);
        const expected: string[] = [];
        for (const operation of operations) {
          const id =
            operation === "unknown"
              ? "unknown"
              : operation === "reject"
                ? rejected.id
                : synthetic.id;
          const action =
            operation === "write" ? "vault_write" : "authority_denied";
          await recordRetiredDecoyInteraction("personal", id, action);
          if (operation === "write" || operation === "deny")
            expected.push(action);
          const actual = retiredCredentialStatus("personal").events.map(
            (event) =>
              event.type === "synthetic_decoy_interaction"
                ? event.action
                : event.type,
          );
          expect(actual).toEqual(expected.slice(-32));
          expect(actual.length).toBeLessThanOrEqual(32);
        }
      },
    ),
    { seed: 1730106, numRuns: 12 },
  );
});

it("rejects oversized UTF-8 and unsupported hostile event content", async () => {
  await fixture.enroll();
  const original = parseRetiredCredentialRecords(
    kvGet(TRAPS_KEY) ?? "",
    "personal",
  );
  const raw = JSON.stringify({ ...original, tomb: "💣".repeat(9000) });
  expect(raw.length).toBeLessThan(32768);
  expect(new TextEncoder().encode(raw).length).toBeGreaterThan(32768);
  kvSet(TRAPS_KEY, raw);
  await expect(
    probeRetiredCredential("retired-secret", "personal"),
  ).rejects.toThrow(/unavailable/);
  kvSet(
    TRAPS_KEY,
    JSON.stringify({
      ...original,
      events: [
        {
          type: "attacker_confirmed",
          trapId: "x",
          at: new Date().toISOString(),
          response: "wipe",
        },
      ],
    }),
  );
  await expect(
    probeRetiredCredential("retired-secret", "personal"),
  ).rejects.toThrow(/unavailable/);
});
