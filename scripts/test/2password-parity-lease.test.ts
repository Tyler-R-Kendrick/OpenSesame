import { describe, expect, it } from "vitest";
import { grantLease } from "../../packages/app-core/src/lib/password-agent/lease-grant.js";
import {
  type LeaseRecord,
  type LeaseStorePort,
  type ResourceVersion,
  authorizeLease,
  claimLease,
  createLease,
  inspectReference,
  resolverWith,
} from "../../packages/app-core/src/lib/password-agent/lease.js";
import { leasedRequest } from "../../packages/app-core/src/lib/password-agent/request-leased.js";
import {
  type RequestOptions,
  type RequestPorts,
  describeRequest,
} from "../../packages/app-core/src/lib/password-agent/request.js";
const secret = "LEASE_PRIVATE_SENTINEL";
const options: RequestOptions = {
  url: "https://example.test/use/PATH_PRIVATE?token=QUERY_PRIVATE",
  reference: "op://Personal/Example/credential",
};
const binding = describeRequest(options);
const resource = { id: "a".repeat(26), version: 7 };
const now = 1_000_000;
function fixture() {
  const calls: string[] = [];
  let row = createLease({
    id: "lease-one",
    principal: "human-device",
    binding,
    resource,
    now,
  });
  const store: LeaseStorePort = {
    async principal() {
      return "human-device";
    },
    async insert(value) {
      row = value;
    },
    async get(id) {
      if (id !== row.id) throw new Error(secret);
      calls.push("get");
      return { ...row };
    },
    async claim(id, bound, version, principal, at) {
      calls.push("claim");
      if (id !== row.id) throw new Error(secret);
      row = claimLease(row, bound, version, principal, at);
      return { ...row };
    },
    async revoke(id, principal) {
      if (id !== row.id || principal !== row.principal) throw new Error(secret);
      row = { ...row, revoked: true };
      return { ...row };
    },
  };
  const request: RequestPorts = {
    async addresses() {
      calls.push("dns");
      return [{ address: "1.1.1.1", family: 4 }];
    },
    async resolve() {
      calls.push("read");
      expect(row.usesRemaining).toBe(0);
      return secret;
    },
    async send() {
      calls.push("send");
      return { status: 200, body: secret, bytes: secret.length };
    },
  };
  const ports = {
    store,
    request,
    async inspect(): Promise<ResourceVersion> {
      calls.push("inspect");
      return resource;
    },
    now: () => now,
  };
  return { calls, ports, current: () => row };
}
describe("2password parity core", () => {
  it("lease.binding", async () => {
    const f = fixture();
    for (const changes of [
      { reference: "op://Personal/Other/credential" },
      { url: `${options.url}&different=1` },
      { header: "X-API-Key" },
      { prefix: "" },
    ]) {
      await expect(
        leasedRequest("lease-one", { ...options, ...changes }, f.ports),
      ).rejects.toThrow("authorization denied");
    }
    expect(f.calls).toEqual(["get", "get", "get", "get"]);
    expect(f.current().usesRemaining).toBe(1);
    expect(() =>
      authorizeLease(f.current(), binding, "other-device", now),
    ).toThrow("mismatched");
    await expect(
      resolverWith("lease-one", binding, {
        ...f.ports,
        read: f.ports.request.resolve,
      })("op://Personal/Other/credential"),
    ).rejects.toThrow("does not match");
  });
  it("lease.atomic-budget", async () => {
    const f = fixture();
    const claims = await Promise.allSettled([
      f.ports.store.claim("lease-one", binding, resource, "human-device", now),
      f.ports.store.claim("lease-one", binding, resource, "human-device", now),
    ]);
    expect(claims.map((x) => x.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(f.current().usesRemaining).toBe(0);
    await expect(
      f.ports.store.claim("lease-one", binding, resource, "human-device", now),
    ).rejects.toThrow();
  });
  it("lease.lifecycle", async () => {
    const f = fixture();
    expect(() =>
      authorizeLease(
        f.current(),
        binding,
        "human-device",
        f.current().expiresAt,
      ),
    ).toThrow("expired");
    expect(f.current().usesRemaining).toBe(1);
    const revoked = await f.ports.store.revoke(
      "lease-one",
      "human-device",
      now,
    );
    expect(revoked.revoked).toBe(true);
    await expect(leasedRequest("lease-one", options, f.ports)).rejects.toThrow(
      "authorization denied",
    );
    expect(f.calls).toEqual(["get"]);
    expect(f.current().usesRemaining).toBe(1);
    expect(JSON.stringify(revoked)).not.toMatch(/PRIVATE|QUERY|PATH/);
  });
  it("lease.versioning", async () => {
    const good = fixture();
    const receipt = await leasedRequest("lease-one", options, good.ports);
    expect(good.calls).toEqual([
      "get",
      "dns",
      "inspect",
      "claim",
      "read",
      "inspect",
      "send",
      "get",
    ]);
    expect(receipt.lease.usesRemaining).toBe(0);
    expect(JSON.stringify(receipt)).not.toContain(secret);
    const stale = fixture();
    stale.ports.inspect = async () => {
      stale.calls.push("inspect");
      return { ...resource, version: 8 };
    };
    await expect(
      leasedRequest("lease-one", options, stale.ports),
    ).rejects.toThrow("details suppressed");
    expect(stale.current().usesRemaining).toBe(1);
    expect(stale.calls).toEqual(["get", "dns", "inspect", "claim"]);
    let count = 0;
    const rotated = fixture();
    rotated.ports.inspect = async () => {
      rotated.calls.push("inspect");
      return { ...resource, version: ++count === 1 ? 7 : 8 };
    };
    await expect(
      leasedRequest("lease-one", options, rotated.ports),
    ).rejects.toThrow("details suppressed");
    expect(rotated.current().usesRemaining).toBe(0);
    expect(rotated.calls).not.toContain("send");
    const calls: string[][] = [];
    const summary = await inspectReference(
      {
        async invoke(args) {
          calls.push([...args]);
          return JSON.stringify([{ ...resource, title: "Example" }]);
        },
      },
      options.reference,
    );
    expect(summary).toEqual(resource);
    expect(calls).toEqual([
      ["item", "list", "--vault", "Personal", "--format", "json"],
    ]);
  });
  it("lease.failure-spend", async () => {
    for (const stage of ["read", "send"]) {
      const f = fixture();
      if (stage === "read")
        f.ports.request.resolve = async () => {
          f.calls.push("read");
          throw new Error(secret);
        };
      else
        f.ports.request.send = async () => {
          f.calls.push("send");
          throw new Error(secret);
        };
      await expect(
        leasedRequest("lease-one", options, f.ports),
      ).rejects.toThrow("details suppressed");
      expect(f.current().usesRemaining).toBe(0);
      expect(f.calls.filter((x) => x === stage)).toHaveLength(1);
      await expect(
        leasedRequest("lease-one", options, f.ports),
      ).rejects.toThrow("authorization denied");
      expect(f.calls.filter((x) => x === stage)).toHaveLength(1);
    }
  });
  it("lease.human-approval", async () => {
    for (const approved of [false, "throws"]) {
      const f = fixture();
      const order: string[] = [];
      await expect(
        grantLease(
          binding,
          {},
          {
            ...f.ports,
            async approve(received, policy) {
              order.push("approve");
              expect(received).toEqual(binding);
              expect(policy).toEqual({ expiresIn: "10m", uses: 1 });
              if (approved === "throws") throw new Error(secret);
              return false;
            },
            async inspect() {
              order.push("desktop-inspect");
              return resource;
            },
            newId: () => "human-approved",
          },
        ),
      ).rejects.toThrow(/Human lease approval/);
      expect(order).toEqual(["approve"]);
      expect(f.calls).toEqual([]);
    }
    const f = fixture();
    const order: string[] = [];
    const created = await grantLease(
      binding,
      { expiresIn: "1h", uses: 10 },
      {
        ...f.ports,
        async approve(_received, policy) {
          order.push("approve");
          expect(policy).toEqual({ expiresIn: "1h", uses: 10 });
          return true;
        },
        async inspect() {
          order.push("desktop-inspect");
          return resource;
        },
        newId: () => "human-approved",
      },
    );
    expect(order).toEqual(["approve", "desktop-inspect"]);
    expect(created.itemVersion).toBe(7);
    expect(created.useBudget).toBe(10);
    expect(f.current()).toEqual(created);
  });
  it("lease.persistence", async () => {
    const f = fixture();
    const row: LeaseRecord = await f.ports.store.get("lease-one");
    expect(row.principal).toBe(await f.ports.store.principal());
    expect(row.expiresAt - row.createdAt).toBe(600000);
    expect(row.useBudget).toBe(1);
    expect(JSON.stringify(row)).not.toMatch(/PRIVATE|QUERY|PATH/);
    for (const changes of [
      { uses: 0 },
      { uses: 11 },
      { uses: 1.5 },
      { expiresIn: "2h" },
      { expiresIn: "0m" },
      { expiresIn: "tomorrow" },
      { resource: { ...resource, version: 0 } },
    ]) {
      expect(() =>
        createLease({
          id: "bad",
          principal: "human-device",
          binding,
          resource,
          now,
          ...changes,
        }),
      ).toThrow();
    }
    expect(f.current()).toEqual(row);
    const maximum = createLease({
      id: "maximum",
      principal: "human-device",
      binding,
      resource,
      now,
      uses: 10,
      expiresIn: "1h",
    });
    expect(maximum.useBudget).toBe(10);
    expect(maximum.expiresAt - now).toBe(3600000);
    for (const corrupt of [false, true]) {
      const failed = fixture();
      let inserts = 0;
      const insert = failed.ports.store.insert;
      failed.ports.store.insert = async (value) => {
        inserts++;
        await insert(
          corrupt ? { ...value, itemVersion: value.itemVersion + 1 } : value,
        );
        if (!corrupt) throw new Error(secret);
      };
      await expect(
        grantLease(
          binding,
          {},
          {
            ...failed.ports,
            approve: async () => true,
            newId: () => "human-approved",
          },
        ),
      ).rejects.toThrow("Lease grant is unverified");
      expect(inserts).toBe(1);
    }
  });
});
