import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const doubles = { start: vi.fn(), load: vi.fn() };
import {
  closeProviderAuthResources,
  providerAuthCases,
  providerAuthPhases,
  retainProviderAuthTls,
} from "./provider-auth-case-runtime.mjs";

const directories = [];
const resources = [];
function directory() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "provider-case-test-"));
  directories.push(out);
  return out;
}
function scope() {
  const out = directory();
  return {
    out,
    phases: providerAuthPhases(out),
    root: "/owned/source",
    providers: doubles,
  };
}
beforeEach(() => {
  doubles.load
    .mockReset()
    .mockReturnValue({ openbao: "/pinned/openbao", vault: "/pinned/vault" });
  doubles.start.mockReset().mockImplementation(async (config) => {
    const owned = { config, close: vi.fn(async () => {}) };
    resources.push(owned);
    return owned;
  });
});
afterEach(() => {
  resources.length = 0;
  for (const out of directories.splice(0))
    fs.rmSync(out, { recursive: true, force: true });
});

it("opens only the active width and closes its distinct pair before the next case", async () => {
  const input = scope();
  const cases = providerAuthCases(input);
  expect(doubles.start).not.toHaveBeenCalled();
  let desktop;
  await cases.run("desktop", async ({ services }) => {
    desktop = services;
    expect(resources).toHaveLength(2);
    expect(
      resources.every((entry) => entry.close.mock.calls.length === 0),
    ).toBe(true);
  });
  expect(resources.every((entry) => entry.close.mock.calls.length === 1)).toBe(
    true,
  );
  await cases.run("phone", async ({ services }) => {
    expect(services.vault).not.toBe(desktop.vault);
    expect(services.openbao).not.toBe(desktop.openbao);
    expect(
      resources
        .slice(0, 2)
        .every((entry) => entry.close.mock.calls.length === 1),
    ).toBe(true);
    expect(
      resources.slice(2).every((entry) => entry.close.mock.calls.length === 0),
    ).toBe(true);
  });
  expect(resources.every((entry) => entry.close.mock.calls.length === 1)).toBe(
    true,
  );
  expect(doubles.load).toHaveBeenCalledTimes(1);
  expect(doubles.load).toHaveBeenCalledWith(input.root, input.out);
  expect(resources.map((entry) => entry.config.providerBinary)).toEqual([
    "/pinned/openbao",
    "/pinned/vault",
    "/pinned/openbao",
    "/pinned/vault",
  ]);
});

it("refuses overlapping width work before opening more providers", async () => {
  const cases = providerAuthCases(scope());
  let release;
  let started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const first = cases.run("desktop", async () => {
    started();
    await held;
  });
  await entered;
  await expect(cases.run("phone", async () => {})).rejects.toThrow("serial");
  expect(doubles.start).toHaveBeenCalledTimes(2);
  release();
  await first;
  await cases.run("phone", async () => {});
  expect(doubles.start).toHaveBeenCalledTimes(4);
});

it("admits each of the two finite width cases exactly once", async () => {
  const cases = providerAuthCases(scope());
  await expect(cases.run("tablet", async () => {})).rejects.toThrow("Known");
  expect(doubles.start).not.toHaveBeenCalled();
  await cases.run("desktop", async () => {});
  await expect(cases.run("desktop", async () => {})).rejects.toThrow("once");
  expect(doubles.start).toHaveBeenCalledTimes(2);
});

it("closes the first real owner if the second service cannot start", async () => {
  const failure = new Error("vault startup failed");
  doubles.start
    .mockImplementationOnce(async () => {
      const owner = { close: vi.fn(async () => {}) };
      resources.push(owner);
      return owner;
    })
    .mockRejectedValueOnce(failure);
  await expect(
    providerAuthCases(scope()).run("desktop", async () => {}),
  ).rejects.toBe(failure);
  expect(resources[0].close).toHaveBeenCalledTimes(1);
});

it("retains work failure while closing both providers even if close fails", async () => {
  const work = new Error("assertion failed");
  const cleanup = new Error("close failed");
  doubles.start.mockImplementation(async () => {
    const owner = {
      close: vi.fn(async () => {
        throw cleanup;
      }),
    };
    resources.push(owner);
    return owner;
  });
  const result = await providerAuthCases(scope())
    .run("desktop", async () => {
      throw work;
    })
    .catch((error) => error);
  expect(result).toBeInstanceOf(AggregateError);
  expect(result.errors).toEqual([work, cleanup, cleanup]);
  expect(resources.every((entry) => entry.close.mock.calls.length === 1)).toBe(
    true,
  );
});

it("closes browser, issuer and origin even after a synchronous close exception", async () => {
  const seen = [];
  const primary = new Error("primary");
  const cleanup = new Error("close");
  const first = {
    close() {
      seen.push("browser");
      throw cleanup;
    },
  };
  const second = {
    async close() {
      seen.push("issuer");
    },
  };
  const third = {
    async close() {
      seen.push("origin");
    },
  };
  await expect(
    closeProviderAuthResources([first, second, third], primary),
  ).rejects.toMatchObject({
    errors: [primary, cleanup],
  });
  expect(seen.sort()).toEqual(["browser", "issuer", "origin"]);
});

it("retains only the original site's three TLS files with private modes", async () => {
  const out = directory();
  const original = directory();
  const names = ["vault-key.pem", "vault-cert.pem", "vault-ca.pem"];
  for (const name of [...names, "unrelated.env"])
    fs.writeFileSync(path.join(original, name), name);
  const retained = retainProviderAuthTls(out, original);
  expect(fs.readdirSync(retained.directory).sort()).toEqual([...names].sort());
  for (const name of names) {
    const file = path.join(retained.directory, name);
    expect(fs.readFileSync(file, "utf8")).toBe(name);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  }
  fs.rmSync(original, { recursive: true });
  expect(fs.existsSync(path.join(retained.directory, names[0]))).toBe(true);
  await retained.close();
  expect(fs.existsSync(retained.directory)).toBe(false);
});

it("records actual success/failure duration without credential or error bodies", async () => {
  const input = scope();
  const secret = "private-issued-provider-token";
  await expect(input.phases.run("success", async () => 42)).resolves.toBe(42);
  await expect(
    input.phases.run("failure", async () => {
      throw new Error(secret);
    }),
  ).rejects.toThrow(secret);
  const text = fs.readFileSync(input.phases.file, "utf8");
  const receipt = JSON.parse(text);
  expect(receipt.clock).toBe("monotonic");
  expect(receipt.stages.map((row) => row.status)).toEqual(["passed", "failed"]);
  for (const row of receipt.stages) {
    expect(row.startMs).toBeGreaterThanOrEqual(0);
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
  }
  expect(text).not.toContain(secret);
  expect(fs.statSync(input.phases.file).mode & 0o777).toBe(0o600);
});

it("bounds phase names/cardinality and refuses to overwrite an existing receipt", async () => {
  const input = scope();
  await expect(input.phases.run("../bad", async () => {})).rejects.toThrow();
  for (let index = 0; index < 32; index += 1)
    await input.phases.run(`stage-${index}`, async () => {});
  const never = vi.fn();
  await expect(input.phases.run("extra", never)).rejects.toThrow("32");
  expect(never).not.toHaveBeenCalled();
  const before = fs.readFileSync(input.phases.file);
  expect(() => providerAuthPhases(input.out)).toThrow();
  expect(fs.readFileSync(input.phases.file)).toEqual(before);
  assert.ok(before.byteLength < 16384);
});

it("closes both owners when phase finalization rejects after successful startup", async () => {
  const input = scope();
  const failure = new Error("phase receipt unavailable");
  const phases = {
    async run(name, work) {
      const value = await work();
      if (name === "fixtures-desktop") throw failure;
      return value;
    },
  };
  const body = vi.fn();
  await expect(
    providerAuthCases({ ...input, phases }).run("desktop", body),
  ).rejects.toBe(failure);
  expect(body).not.toHaveBeenCalled();
  expect(resources).toHaveLength(2);
  expect(resources.every((entry) => entry.close.mock.calls.length === 1)).toBe(
    true,
  );
});

it("preserves a primary operation failure when the timing receipt also fails", async () => {
  const input = scope();
  const primary = new Error("operation");
  const result = await input.phases
    .run("broken-receipt", async () => {
      fs.unlinkSync(input.phases.file);
      throw primary;
    })
    .catch((error) => error);
  expect(result).toBeInstanceOf(AggregateError);
  expect(result.errors[0]).toBe(primary);
  expect(result.errors).toHaveLength(2);
});
