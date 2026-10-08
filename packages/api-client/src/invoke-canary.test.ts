import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "./index.js";
const ref = `oscanary:v1:${"A".repeat(43)}`;
const input = {
  connectionRef: ref,
  operation: "canary.status",
  resource: "synthetic",
  input: {},
};
describe("actual Host invocation canary boundary", () => {
  it("rejects all reserved references before any production fetch without an installed binding", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}"));
    const client = createApiClient({
      baseUrl: "https://host.example",
      accessToken: "synthetic-fixture-bearer",
      fetchImpl,
    });
    for (const reference of [
      ref,
      "oscanary:v1:malformed",
      "oscanary:v2:unknown",
      `${ref}=`,
      `${ref.slice(0, -1)}B`,
    ])
      await expect(
        client.invoke({ ...input, connectionRef: reference }),
      ).rejects.toThrow("controlled_reference_rejected");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("records through only the bound classifier and returns one fixed synthetic result", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}"));
    const resolve = vi.fn(async () => ({
      kind: "canary" as const,
      response: "synthetic_readonly" as const,
    }));
    const client = createApiClient({
      baseUrl: "https://host.example",
      fetchImpl,
      controlledReferences: { resolve },
    });
    await expect(client.invoke(input)).resolves.toEqual({
      synthetic: true,
      readonly: true,
      authority: "none",
    });
    expect(resolve).toHaveBeenCalledWith(ref);
    await expect(
      client.invoke({ ...input, operation: "credential.resolve" }),
    ).rejects.toThrow();
    await expect(
      client.invoke({ ...input, input: { secret: "fixture" } }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("a forged production classification cannot release a reserved reference", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}"));
    const client = createApiClient({
      baseUrl: "https://host.example",
      fetchImpl,
      controlledReferences: {
        resolve: async () => ({ kind: "production", assertCurrent: () => {} }),
      },
    });
    await expect(client.invoke(input)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("preserves ordinary invocation and withholds authority across a stale bound generation", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}'));
    let current = true;
    const client = createApiClient({
      baseUrl: "https://host.example",
      fetchImpl,
      controlledReferences: {
        resolve: async () => ({
          kind: "production",
          assertCurrent: () => {
            if (!current) throw new Error("stale generation");
          },
        }),
      },
    });
    await expect(
      client.invoke({ ...input, connectionRef: "conn://org/github/main" }),
    ).resolves.toEqual({ ok: true });
    current = false;
    await expect(
      client.invoke({ ...input, connectionRef: "conn://org/github/main" }),
    ).rejects.toThrow("stale generation");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
