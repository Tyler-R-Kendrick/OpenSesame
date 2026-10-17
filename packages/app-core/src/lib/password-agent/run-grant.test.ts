import { describe, expect, it } from "vitest";
import { grantRunGrant } from "./run-grant-grant.js";
import {
  type RunGrantBinding,
  type RunGrantRecord,
  type RunGrantStorePort,
  authorizeRunGrant,
  claimRunGrant,
  createRunGrant,
  describeRunGrant,
} from "./run-grant.js";

const now = 1_700_000_000_000;

function binding(): RunGrantBinding {
  return describeRunGrant({
    assignments: [
      { name: "B_TOKEN", reference: "os://personal/item-2/apiKey" },
      { name: "A_KEY", reference: "op://Vault/Item/token" },
    ],
  });
}

function grant(overrides: Partial<RunGrantRecord> = {}): RunGrantRecord {
  return {
    ...createRunGrant({
      id: "grant-1",
      principal: "principal-1",
      binding: binding(),
      now,
      expiresIn: "10m",
      uses: 2,
    }),
    ...overrides,
  };
}

describe("run grant binding", () => {
  it("canonicalizes assignment order so the same set matches", () => {
    const reversed = describeRunGrant({
      assignments: [
        { name: "A_KEY", reference: "op://Vault/Item/token" },
        { name: "B_TOKEN", reference: "os://personal/item-2/apiKey" },
      ],
    });
    expect(reversed).toEqual(binding());
    expect(
      authorizeRunGrant(grant(), reversed, "principal-1", now),
    ).toBeTruthy();
  });

  it("refuses duplicate names, empty sets, and mount/broker conflicts", () => {
    expect(() =>
      describeRunGrant({
        assignments: [
          { name: "A", reference: "op://v/i/f" },
          { name: "A", reference: "op://v/i/g" },
        ],
      }),
    ).toThrow(/unique/);
    expect(() => describeRunGrant({ assignments: [] })).toThrow(/at least one/);
    expect(() =>
      describeRunGrant({
        assignments: [{ name: "A", reference: "os://v/i/f" }],
        mounts: [{ name: "A", reference: "os://v/i/g" }],
      }),
    ).toThrow(/both an env value and a mount/);
    expect(() =>
      describeRunGrant({
        assignments: [{ name: "A", reference: "os://v/i/f" }],
        agentProxy: true,
        mounts: [{ name: "B", reference: "os://v/i/g" }],
      }),
    ).toThrow(/agent-proxy/);
    expect(() =>
      describeRunGrant({
        assignments: [{ name: "A", reference: "os://v/i/f" }],
        paths: ["A=/repos"],
      }),
    ).toThrow(/require --agent-proxy/);
  });

  it("binds broker paths and methods exactly, case-normalized", () => {
    const brokered = describeRunGrant({
      assignments: [{ name: "GH", reference: "os://personal/connections/gh" }],
      agentProxy: true,
      paths: ["GH=/repos/acme,/user"],
      methods: ["GH=get,post"],
    });
    expect(brokered.paths).toEqual(["GH=/repos/acme,/user"]);
    expect(brokered.methods).toEqual(["GH=GET,POST"]);
    const widened = describeRunGrant({
      assignments: [{ name: "GH", reference: "os://personal/connections/gh" }],
      agentProxy: true,
      paths: ["GH=/repos"],
      methods: ["GH=GET,POST"],
    });
    const issued = createRunGrant({
      id: "g",
      principal: "p",
      binding: brokered,
      now,
    });
    expect(() => authorizeRunGrant(issued, widened, "p", now)).toThrow(
      /mismatched/,
    );
  });
});

describe("run grant authority", () => {
  it("claims decrement the use budget and exhaustion refuses", () => {
    const first = claimRunGrant(grant(), binding(), "principal-1", now);
    expect(first.usesRemaining).toBe(1);
    const second = claimRunGrant(first, binding(), "principal-1", now);
    expect(second.usesRemaining).toBe(0);
    expect(() => claimRunGrant(second, binding(), "principal-1", now)).toThrow(
      /invalid, expired, revoked, exhausted, or mismatched/,
    );
  });

  it("refuses expired, revoked, foreign, and over-ceiling grants", () => {
    expect(() =>
      authorizeRunGrant(grant(), binding(), "principal-1", now + 600_001),
    ).toThrow(/mismatched/);
    expect(() =>
      authorizeRunGrant(
        grant({ revoked: true }),
        binding(),
        "principal-1",
        now,
      ),
    ).toThrow(/mismatched/);
    expect(() =>
      authorizeRunGrant(grant(), binding(), "someone-else", now),
    ).toThrow(/mismatched/);
    expect(() =>
      createRunGrant({
        id: "g",
        principal: "p",
        binding: binding(),
        now,
        expiresIn: "2h",
      }),
    ).toThrow(/60 minutes/);
    expect(() =>
      createRunGrant({
        id: "g",
        principal: "p",
        binding: binding(),
        now,
        uses: 11,
      }),
    ).toThrow(/between 1 and 10/);
  });

  it("refuses a run that changes any bound reference", () => {
    const changed = describeRunGrant({
      assignments: [
        { name: "A_KEY", reference: "op://Vault/Item/token" },
        { name: "B_TOKEN", reference: "os://personal/item-2/other" },
      ],
    });
    expect(() =>
      authorizeRunGrant(grant(), changed, "principal-1", now),
    ).toThrow(/mismatched/);
  });
});

describe("run grant ceremony", () => {
  function memoryStore(): RunGrantStorePort & {
    records: Map<string, RunGrantRecord>;
  } {
    const records = new Map<string, RunGrantRecord>();
    return {
      records,
      async principal() {
        return "principal-1";
      },
      async insert(record) {
        records.set(record.id, record);
      },
      async get(id) {
        const record = records.get(id);
        if (!record) throw new Error("missing");
        return record;
      },
      async claim(id, claimBinding, principal, at) {
        const record = records.get(id);
        if (!record) throw new Error("missing");
        const claimed = claimRunGrant(record, claimBinding, principal, at);
        records.set(id, claimed);
        return claimed;
      },
      async revoke(id) {
        const record = records.get(id);
        if (!record) throw new Error("missing");
        const revoked = { ...record, revoked: true };
        records.set(id, revoked);
        return revoked;
      },
    };
  }

  it("grants nothing when the human declines", async () => {
    const store = memoryStore();
    await expect(
      grantRunGrant(
        binding(),
        {},
        {
          approve: async () => false,
          store,
          now: () => now,
          newId: () => "grant-1",
        },
      ),
    ).rejects.toThrow(/nothing was granted/);
    expect(store.records.size).toBe(0);
  });

  it("issues a verifiable grant on approval that the store can claim", async () => {
    const store = memoryStore();
    const issued = await grantRunGrant(
      binding(),
      { uses: 1 },
      {
        approve: async () => true,
        store,
        now: () => now,
        newId: () => "grant-1",
      },
    );
    expect(issued.usesRemaining).toBe(1);
    const claimed = await store.claim("grant-1", binding(), "principal-1", now);
    expect(claimed.usesRemaining).toBe(0);
  });
});
