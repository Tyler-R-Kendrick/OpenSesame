import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLease } from "@opensesame/app-core/lib/password-agent/lease.js";
import { describeRequest } from "@opensesame/app-core/lib/password-agent/request.js";
import type { InvokeOptions } from "@opensesame/app-core/lib/password-agent/transport.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openLeaseStore } from "./parity-lease-node.js";
import { runCli } from "./run.js";
let directory = "";
const reference = "op://Automation/Database/password";
const url = "https://request.example/private?query=canary";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "request-dispatch-"));
  process.env.OPENSESAME_STATE_DIR = directory;
});
afterEach(async () => {
  Reflect.deleteProperty(process.env, "OPENSESAME_STATE_DIR");
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
async function grant() {
  const store = await openLeaseStore();
  try {
    const binding = describeRequest({ url, reference });
    await store.insert(
      createLease({
        id: "grant",
        principal: await store.principal(),
        binding,
        resource: { id: "a".repeat(26), version: 1 },
        now: Date.now(),
      }),
    );
  } finally {
    store.close();
  }
}
function adapter() {
  const steps: string[] = [];
  const accounts: (string | undefined)[] = [];
  let version = 1;
  let failRead = false;
  let rotate = false;
  const invoke = vi.fn(
    async (args: readonly string[], options: InvokeOptions = {}) => {
      accounts.push(options.account);
      if (args.includes("list")) {
        steps.push("metadata");
        return JSON.stringify([
          { id: "a".repeat(26), title: "Database", version },
        ]);
      }
      steps.push("read");
      if (failRead) throw new Error("private-read-canary");
      if (rotate) version++;
      return "credential-canary\n";
    },
  );
  const addresses = vi.fn(async () => {
    steps.push("dns");
    return [{ address: "93.184.216.34", family: 4 as const }];
  });
  const send = vi.fn(async () => {
    steps.push("send");
    return {
      status: 200,
      body: "credential-canary credential-canary private-person@example.com",
      bytes: 64,
    };
  });
  return {
    steps,
    accounts,
    invoke,
    addresses,
    send,
    fail() {
      failRead = true;
    },
    rotate() {
      rotate = true;
    },
  };
}
function command(destination = url) {
  return [
    "request",
    destination,
    "--secret",
    reference,
    "--lease",
    "grant",
    "--desktop",
  ];
}
it("real CLI dispatch orders public DNS then atomic claim read version recheck and emits only receipt", async () => {
  await grant();
  const ports = adapter();
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  expect(
    await runCli([...command(), "--account", "selected.account"], {
      parityPort: { invoke: ports.invoke },
      requestTransport: ports,
    }),
  ).toBe(0);
  expect(ports.steps).toEqual(["dns", "metadata", "read", "metadata", "send"]);
  expect(ports.accounts).toEqual([
    "selected.account",
    "selected.account",
    "selected.account",
  ]);
  const output = stdout.mock.calls.map(([value]) => String(value)).join("");
  expect(output).toContain('"secretEchoes": 2');
  expect(output).not.toContain("credential-canary");
  expect(output).not.toContain("private-person");
  expect(output).not.toContain("query=canary");
  const store = await openLeaseStore();
  try {
    expect((await store.get("grant")).usesRemaining).toBe(0);
  } finally {
    store.close();
  }
});
it("real CLI dispatch denies destination binding and mixed private DNS before secret read", async () => {
  await grant();
  const ports = adapter();
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  expect(
    await runCli(command("https://request.example/other"), {
      parityPort: { invoke: ports.invoke },
      requestTransport: ports,
    }),
  ).toBe(1);
  expect(ports.steps).toEqual([]);
  const mixed = {
    ...ports,
    addresses: async () => [
      { address: "93.184.216.34", family: 4 as const },
      { address: "127.0.0.1", family: 4 as const },
    ],
  };
  expect(
    await runCli(command(), {
      parityPort: { invoke: ports.invoke },
      requestTransport: mixed,
    }),
  ).toBe(1);
  expect(ports.invoke).not.toHaveBeenCalled();
});
it.each(["read", "rotation", "send"])(
  "real CLI dispatch burns failed %s use and performs no automatic retry",
  async (mode) => {
    await grant();
    const ports = adapter();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    if (mode === "read") ports.fail();
    if (mode === "rotation") ports.rotate();
    if (mode === "send")
      ports.send.mockRejectedValue(new Error("private-transport-canary"));
    expect(
      await runCli(command(), {
        parityPort: { invoke: ports.invoke },
        requestTransport: ports,
      }),
    ).toBe(1);
    const store = await openLeaseStore();
    try {
      expect((await store.get("grant")).usesRemaining).toBe(0);
    } finally {
      store.close();
    }
    expect(ports.send).toHaveBeenCalledTimes(mode === "send" ? 1 : 0);
    const reads = ports.invoke.mock.calls.filter(
      ([args]) => args[0] === "read",
    );
    expect(reads).toHaveLength(1);
    expect(
      await runCli(command(), {
        parityPort: { invoke: ports.invoke },
        requestTransport: ports,
      }),
    ).toBe(1);
    expect(
      ports.invoke.mock.calls.filter(([args]) => args[0] === "read"),
    ).toHaveLength(1);
  },
);
it("real CLI dispatch rejects unsafe shape and newline credentials without sending", async () => {
  const ports = adapter();
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  for (const destination of [
    "http://request.example",
    "https://user@request.example",
    "https://request.example:8443",
    "https://request.example/#fragment",
  ]) {
    expect(
      await runCli(command(destination), {
        parityPort: { invoke: ports.invoke },
        requestTransport: ports,
      }),
    ).toBe(1);
  }
  expect(ports.steps).toEqual([]);
  await grant();
  ports.invoke.mockImplementation(async (args) =>
    args.includes("list")
      ? JSON.stringify([{ id: "a".repeat(26), title: "Database", version: 1 }])
      : "credential-canary\r\nInjected: canary",
  );
  expect(
    await runCli(command(), {
      parityPort: { invoke: ports.invoke },
      requestTransport: ports,
    }),
  ).toBe(1);
  expect(ports.send).not.toHaveBeenCalled();
});
it("durable SQLite denies every changed authority binding principal resource version and lifetime", async () => {
  await grant();
  const store = await openLeaseStore();
  try {
    const binding = describeRequest({ url, reference });
    const principal = await store.principal();
    const resource = { id: "a".repeat(26), version: 1 };
    for (const changed of [
      { ...binding, reference: "op://Automation/Other/password" },
      { ...binding, destination: "https://other.example" },
      { ...binding, destinationFingerprint: "changed" },
      { ...binding, header: "X-API-Key" as const },
      { ...binding, prefix: "Basic " },
    ])
      await expect(
        store.claim("grant", changed, resource, principal, Date.now()),
      ).rejects.toThrow();
    await expect(
      store.claim("grant", binding, resource, "other-principal", Date.now()),
    ).rejects.toThrow();
    await expect(
      store.claim(
        "grant",
        binding,
        { ...resource, version: 2 },
        principal,
        Date.now(),
      ),
    ).rejects.toThrow();
    await expect(
      store.claim(
        "grant",
        binding,
        { ...resource, id: "b".repeat(26) },
        principal,
        Date.now(),
      ),
    ).rejects.toThrow();
    await expect(
      store.claim("grant", binding, resource, principal, Date.now() + 3600001),
    ).rejects.toThrow();
    expect((await store.get("grant")).usesRemaining).toBe(1);
  } finally {
    store.close();
  }
});
it("real CLI lease status list revoke use durable metadata and perform no credential operations", async () => {
  await grant();
  const ports = adapter();
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  for (const args of [
    ["lease", "status", "grant"],
    ["lease", "list"],
    ["lease", "revoke", "grant"],
  ])
    expect(await runCli(args, { parityPort: { invoke: ports.invoke } })).toBe(
      0,
    );
  expect(ports.invoke).not.toHaveBeenCalled();
  expect(
    stdout.mock.calls.map(([value]) => String(value)).join(""),
  ).not.toContain("query=canary");
  const store = await openLeaseStore();
  try {
    expect((await store.get("grant")).revoked).toBe(true);
  } finally {
    store.close();
  }
});
