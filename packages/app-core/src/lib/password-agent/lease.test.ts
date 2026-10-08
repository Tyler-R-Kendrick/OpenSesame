import { describe, expect, it } from "vitest";
import {
  type LeaseResolverPorts,
  type LeaseStorePort,
  authorizeLease,
  claimLease,
  createLease,
  durationSeconds,
  inspectReference,
  resolverWith,
  sameBinding,
  validateLeaseBinding,
} from "./lease.js";
import { type Binding, prepareRequest } from "./request.js";
import type { PasswordAgentPort } from "./transport.js";

const resource = { id: "a".repeat(26), version: 3 };
const binding = prepareRequest({
  url: "https://example.com/fixture",
  reference: `op://fixture/${resource.id}/password`,
}).binding;
const now = 10_000;
function grant(patch = {}) {
  return createLease({
    id: "fixture lease",
    principal: "fixture owner",
    binding,
    resource,
    now,
    ...patch,
  });
}
function fixture(lease = grant()) {
  let current = lease;
  let currentResource = resource;
  let readFailure = false;
  let reads = 0;
  let inspections = 0;
  let queue = Promise.resolve();
  const store: LeaseStorePort = {
    async principal() {
      return "fixture owner";
    },
    async insert(value) {
      current = value;
    },
    async get() {
      return current;
    },
    claim(_id, requested, version, principal, time) {
      const next = queue.then(() => {
        current = claimLease(current, requested, version, principal, time);
        return current;
      });
      queue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    async revoke() {
      current = { ...current, revoked: true };
      return current;
    },
  };
  const ports: LeaseResolverPorts = {
    store,
    now: () => now,
    async inspect() {
      inspections++;
      return currentResource;
    },
    async read() {
      reads++;
      if (readFailure) throw new Error("private fixture read failure");
      return "fixture credential";
    },
  };
  return {
    ports,
    current: () => current,
    reads: () => reads,
    inspections: () => inspections,
    change: () => {
      currentResource = { ...resource, version: 4 };
    },
    failRead: () => {
      readFailure = true;
    },
  };
}

describe("password-agent exact bound leases", () => {
  it.each([
    ["1s", 1],
    ["10m", 600],
    ["1h", 3600],
  ])("accepts bounded duration %s", (input, seconds) => {
    expect(durationSeconds(input)).toBe(seconds);
  });
  it.each(["0s", "-1m", "1.5m", "61m", "2h", "9007199254740992s", "1d"])(
    "refuses invalid duration %s",
    (value) => {
      expect(() => durationSeconds(value)).toThrow();
    },
  );
  it("creates, authorizes and immutably consumes exactly the configured budget", () => {
    const lease = grant({ uses: 2 });
    expect(lease.expiresAt).toBe(now + 600_000);
    expect(authorizeLease(lease, binding, "fixture owner", now)).toBe(lease);
    const once = claimLease(lease, binding, resource, "fixture owner", now);
    const twice = claimLease(once, binding, resource, "fixture owner", now);
    expect(lease.usesRemaining).toBe(2);
    expect(twice.usesRemaining).toBe(0);
    expect(() =>
      claimLease(twice, binding, resource, "fixture owner", now),
    ).toThrow("exhausted");
  });
  it.each<Partial<Binding>>([
    { reference: "op://other/item/password" },
    { destination: "https://other.example" },
    { destinationFingerprint: "f".repeat(64) },
    { header: "X-API-Key" },
    { prefix: "Basic " },
  ])("rejects every changed bound request component", (patch) => {
    const changed: Binding = { ...binding, ...patch };
    expect(sameBinding(binding, changed)).toBe(false);
    expect(() =>
      authorizeLease(grant(), changed, "fixture owner", now),
    ).toThrow();
  });
  it.each([
    { id: "" },
    { principal: "" },
    { now: Number.NaN },
    { resource: { id: "invalid", version: 1 } },
    { resource: { ...resource, version: 0 } },
    { uses: 0 },
    { uses: 11 },
    { uses: 1.5 },
  ])("rejects invalid grants", (patch) => {
    expect(() => grant(patch)).toThrow();
  });
  it.each([
    { revoked: true },
    { usesRemaining: 0 },
    { usesRemaining: 2 },
    { createdAt: now + 1 },
    { expiresAt: now },
    { expiresAt: now + 3_600_001 },
  ])("rejects revoked, expired or inconsistent records", (patch) => {
    expect(() =>
      authorizeLease({ ...grant(), ...patch }, binding, "fixture owner", now),
    ).toThrow();
  });
  it("rejects principal, clock, resource identity and resource version changes", () => {
    const lease = grant();
    expect(() => authorizeLease(lease, binding, "successor", now)).toThrow();
    expect(() =>
      authorizeLease(lease, binding, "fixture owner", Number.NaN),
    ).toThrow();
    expect(() =>
      claimLease(
        lease,
        binding,
        { ...resource, version: 4 },
        "fixture owner",
        now,
      ),
    ).toThrow();
    expect(() =>
      claimLease(
        lease,
        binding,
        { ...resource, id: "b".repeat(26) },
        "fixture owner",
        now,
      ),
    ).toThrow();
    expect(() =>
      validateLeaseBinding({ ...binding, destination: "http://example.com" }),
    ).toThrow();
    expect(() =>
      validateLeaseBinding({
        ...binding,
        destination: "https://example.com/path",
      }),
    ).toThrow();
  });
  it("resolves once and denies concurrent replay before a second credential read", async () => {
    const test = fixture();
    const resolve = resolverWith("fixture lease", binding, test.ports);
    const results = await Promise.allSettled([
      resolve(binding.reference),
      resolve(binding.reference),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toEqual([
      { status: "fulfilled", value: "fixture credential" },
    ]);
    expect(test.reads()).toBe(1);
    expect(test.current().usesRemaining).toBe(0);
    await expect(resolve(binding.reference)).rejects.toThrow("claim denied");
    expect(test.reads()).toBe(1);
  });
  it("denies mismatched reference and revocation before secret reads", async () => {
    const test = fixture();
    const resolve = resolverWith("fixture lease", binding, test.ports);
    await expect(resolve("op://other/item/password")).rejects.toThrow(
      "does not match",
    );
    expect(test.inspections()).toBe(0);
    await test.ports.store.revoke("fixture lease", "fixture owner", now);
    await expect(resolve(binding.reference)).rejects.toThrow("claim denied");
    expect(test.reads()).toBe(0);
  });
  it.each([
    { ...resource, version: 0 },
    { ...resource, id: "invalid" },
  ])(
    "refuses unavailable resource versions before consuming the lease or reading",
    async (version) => {
      const test = fixture();
      test.ports.inspect = async () => version;
      await expect(
        resolverWith("fixture lease", binding, test.ports)(binding.reference),
      ).rejects.toThrow("claim denied");
      expect(test.current().usesRemaining).toBe(1);
      expect(test.reads()).toBe(0);
    },
  );
  it.each(["changed", "failed"])(
    "consumes a use but withholds a %s read",
    async (mode) => {
      const test = fixture();
      const original = test.ports.read;
      test.ports.read = async (reference) => {
        if (mode === "failed") test.failRead();
        const value = await original(reference);
        test.change();
        return value;
      };
      await expect(
        resolverWith("fixture lease", binding, test.ports)(binding.reference),
      ).rejects.toThrow("use was consumed");
      expect(test.current().usesRemaining).toBe(0);
    },
  );
  it("inspects exactly one actual provider item version and suppresses ambiguous data", async () => {
    const commands: string[][] = [];
    const port: PasswordAgentPort = {
      async invoke(args) {
        commands.push([...args]);
        return JSON.stringify([{ ...resource, title: "fixture" }]);
      },
    };
    expect(await inspectReference(port, binding.reference)).toEqual(resource);
    expect(commands[0]).toEqual([
      "item",
      "list",
      "--vault",
      "fixture",
      "--format",
      "json",
    ]);
    const ambiguous: PasswordAgentPort = {
      async invoke() {
        return JSON.stringify([
          { ...resource, title: "fixture" },
          { ...resource, title: "duplicate" },
        ]);
      },
    };
    await expect(
      inspectReference(ambiguous, binding.reference),
    ).rejects.toThrow("exactly one");
    const unavailable: PasswordAgentPort = {
      async invoke() {
        throw new Error("private diagnostic");
      },
    };
    await expect(
      inspectReference(unavailable, binding.reference),
    ).rejects.toThrow("details suppressed");
  });
});
