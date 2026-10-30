import { overlapCast } from "@opensesame/os-domain";
import { expect, it, vi } from "vitest";
import { type Container, webauthnCeremony } from "./ceremony.js";

it("snapshots the exact registration byte views before the container can mutate inputs", async () => {
  const challengeBacking = new Uint8Array([9, 1, 2, 9]);
  const userBacking = new Uint8Array([9, 3, 4, 9]);
  const prfBacking = new Uint8Array([9, 5, 6, 9]);
  const create = vi.fn(async (options: Parameters<Container["create"]>[0]) => {
    challengeBacking[1] = 8;
    userBacking[1] = 8;
    prfBacking[1] = 8;
    expect(options?.publicKey).toMatchObject({
      challenge: new Uint8Array([1, 2]),
      user: { id: new Uint8Array([3, 4]) },
      extensions: { prf: { eval: { first: new Uint8Array([5, 6]) } } },
    });
    throw new Error("container stop");
  });
  const ceremony = webauthnCeremony(overlapCast({ create, get: vi.fn() }));
  await expect(
    ceremony.register({
      rpId: "example.test",
      rpName: "Example",
      userId: userBacking.subarray(1, 3),
      userName: "user",
      challenge: challengeBacking.subarray(1, 3),
      prfInput: prfBacking.subarray(1, 3),
      excludeCredentialIds: [],
      requireUserVerification: true,
    }),
  ).rejects.toThrow("container stop");
  expect(create).toHaveBeenCalledOnce();
});

it("refuses a spoofed shared challenge before invoking the container", async () => {
  const shared = new Uint8Array(new SharedArrayBuffer(2));
  Object.defineProperty(shared, "buffer", { value: new ArrayBuffer(2) });
  const create = vi.fn();
  const ceremony = webauthnCeremony(overlapCast({ create, get: vi.fn() }));
  await expect(
    ceremony.register({
      rpId: "example.test",
      rpName: "Example",
      userId: new Uint8Array([1]),
      userName: "user",
      challenge: shared,
      prfInput: new Uint8Array([2]),
      excludeCredentialIds: [],
      requireUserVerification: true,
    }),
  ).rejects.toThrow(TypeError);
  expect(create).not.toHaveBeenCalled();
});

it("uses one PRF input reading consistently across an assertion", async () => {
  const get = vi.fn(async () => null);
  const ceremony = webauthnCeremony(overlapCast({ create: vi.fn(), get }));
  const first = new Uint8Array([1, 2]);
  let reads = 0;
  const input = {
    rpId: "example.test",
    challenge: new Uint8Array([3]),
    allowCredentialIds: [],
    requireUserVerification: true,
    get prfInput() {
      reads += 1;
      return reads === 1 ? first : undefined;
    },
  };
  await expect(ceremony.assert(input)).rejects.toThrow();
  expect(get).toHaveBeenCalledOnce();
  expect(reads).toBe(1);
});

it("snapshots the PRF view before later option getters can mutate it", async () => {
  const backing = new Uint8Array([9, 1, 2, 9]);
  const get = vi.fn(async (options: Parameters<Container["get"]>[0]) => {
    expect(options?.publicKey).toMatchObject({
      extensions: { prf: { eval: { first: new Uint8Array([1, 2]) } } },
    });
    return null;
  });
  const ceremony = webauthnCeremony(overlapCast({ create: vi.fn(), get }));
  const input = {
    rpId: "example.test",
    challenge: new Uint8Array([3]),
    allowCredentialIds: [],
    requireUserVerification: true,
    prfInput: backing.subarray(1, 3),
    get prfOptional() {
      backing[1] = 8;
      return true;
    },
  };
  await expect(ceremony.assert(input)).rejects.toThrow("no assertion was made");
  expect(get).toHaveBeenCalledOnce();
});

function assertionWithoutPrf() {
  return {
    type: "public-key",
    rawId: new Uint8Array([1]).buffer,
    response: {
      clientDataJSON: new Uint8Array([2]).buffer,
      authenticatorData: new Uint8Array([3]).buffer,
      signature: new Uint8Array([4]).buffer,
    },
    getClientExtensionResults: () => ({}),
  };
}

it("requires PRF output when the first PRF getter value requested it", async () => {
  const ceremony = webauthnCeremony(
    overlapCast({
      create: vi.fn(),
      get: vi.fn(async () => assertionWithoutPrf()),
    }),
  );
  let reads = 0;
  const input = {
    rpId: "example.test",
    challenge: new Uint8Array([3]),
    allowCredentialIds: [],
    requireUserVerification: true,
    prfOptional: false,
    get prfInput() {
      reads += 1;
      return reads === 1 ? new Uint8Array([1, 2]) : undefined;
    },
  };
  await expect(ceremony.assert(input)).rejects.toMatchObject({
    code: "prf_missing_output",
  });
  expect(reads).toBe(1);
});

it("allows an explicitly optional PRF to be absent", async () => {
  const ceremony = webauthnCeremony(
    overlapCast({
      create: vi.fn(),
      get: vi.fn(async () => assertionWithoutPrf()),
    }),
  );
  const result = await ceremony.assert({
    rpId: "example.test",
    challenge: new Uint8Array([3]),
    allowCredentialIds: [],
    requireUserVerification: true,
    prfInput: new Uint8Array([1, 2]),
    prfOptional: true,
  });
  expect(result.prfOutput).toBeNull();
});

it("does not allow the container to relax required PRF policy in flight", async () => {
  const input = {
    rpId: "example.test",
    challenge: new Uint8Array([3]),
    allowCredentialIds: [],
    requireUserVerification: true,
    prfInput: new Uint8Array([1, 2]),
    prfOptional: false,
  };
  const get = vi.fn(async () => {
    input.prfOptional = true;
    return assertionWithoutPrf();
  });
  const ceremony = webauthnCeremony(overlapCast({ create: vi.fn(), get }));
  await expect(ceremony.assert(input)).rejects.toMatchObject({
    code: "prf_missing_output",
  });
  expect(get).toHaveBeenCalledOnce();
});
