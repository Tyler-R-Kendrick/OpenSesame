import { expect, it, vi } from "vitest";

it("seeds jitless before imported shared-contract schemas and worker commands", async () => {
  const previous = globalThis.__zod_globalConfig;
  globalThis.__zod_globalConfig = { jitless: false };
  vi.resetModules();
  try {
    const { NativeWorkerRequest, NativeWorkerReply } = await import(
      "./bitwarden-native-worker-protocol.js"
    );
    expect(globalThis.__zod_globalConfig.jitless).toBe(true);
    const initialize = {
      id: 1,
      type: "initialize",
      settings: {
        providerId: "bitwarden",
        name: "Personal vault",
        baseUrl: "https://api.bitwarden.com",
        identityUrl: "https://identity.bitwarden.com",
        clientId: "user.11111111-1111-4111-8111-111111111111",
        clientSecret: "synthetic",
        vaultId: "",
        accountEmail: "test@example.invalid",
        masterPassword: "temporary",
        deviceIdentifier: "22222222-2222-4222-8222-222222222222",
      },
    };
    expect(NativeWorkerRequest.parse(initialize)).toEqual(initialize);
    expect(
      NativeWorkerRequest.safeParse({ ...initialize, extra: true }).success,
    ).toBe(false);
    expect(NativeWorkerRequest.safeParse({ id: 0, type: "list" }).success).toBe(
      false,
    );
    expect(NativeWorkerReply.parse({ id: 1, ok: true, value: [] })).toEqual({
      id: 1,
      ok: true,
      value: [],
    });
    expect(
      NativeWorkerReply.safeParse({ id: 1, ok: true, value: {}, extra: true })
        .success,
    ).toBe(false);
  } finally {
    globalThis.__zod_globalConfig = previous;
    vi.resetModules();
  }
});

it("seeds jitless in the network protocol before the runtime is imported", async () => {
  const previous = globalThis.__zod_globalConfig;
  globalThis.__zod_globalConfig = { jitless: false };
  vi.resetModules();
  try {
    const { NativeFetchRequest } = await import(
      "./bitwarden-native-network-protocol.js"
    );
    expect(globalThis.__zod_globalConfig.jitless).toBe(true);
    const request = {
      type: "native-fetch",
      id: 1,
      url: "https://api.bitwarden.com/sync",
      method: "GET",
      headers: [],
      body: "",
    };
    expect(NativeFetchRequest.parse(request)).toEqual(request);
    expect(
      NativeFetchRequest.safeParse({ ...request, extra: true }).success,
    ).toBe(false);
  } finally {
    globalThis.__zod_globalConfig = previous;
    vi.resetModules();
  }
});
