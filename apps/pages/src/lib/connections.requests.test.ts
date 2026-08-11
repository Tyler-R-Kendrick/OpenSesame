import { beforeEach, describe, expect, it, vi } from "vitest";

const fetches = vi.hoisted(() => ({
  host: vi.fn(),
  identity: vi.fn(),
}));

vi.mock("./identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./identity.js")>();
  return {
    ...actual,
    hostFetch: fetches.host,
    identityFetch: fetches.identity,
  };
});

import { listMembers, listProviders } from "./connections.js";

function json(value: unknown, status: number) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("connections request errors", () => {
  beforeEach(() => vi.clearAllMocks());

  it("explains same-site cookie recovery only for Identity 401s", async () => {
    fetches.identity.mockResolvedValue(json({ error: "unauthorized" }, 401));
    await expect(listMembers("org_1")).rejects.toThrow(
      /sign in.*same-site.*sibling custom domains/iu,
    );

    fetches.host.mockResolvedValue(json({ error: "invalid_session" }, 401));
    await expect(listProviders("org_1")).rejects.toThrow("invalid_session");
  });
});
