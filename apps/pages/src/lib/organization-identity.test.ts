import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearHostSession,
  hostFetch,
  identityFetch,
  listSessionOrganizations,
} from "./organization-identity.js";

type FetchHarness = {
  fetch: ReturnType<typeof vi.fn>;
  approvals: string[];
  authorizeBodies: Record<string, unknown>[];
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function hostHarness(
  options: {
    endpointStatuses?: number[];
    approvalStatuses?: number[];
    tokenOrganization?: (approved: string) => string;
  } = {},
): FetchHarness {
  const approvals: string[] = [];
  const authorizeBodies: Record<string, unknown>[] = [];
  const endpointStatuses = [...(options.endpointStatuses ?? [200])];
  const approvalStatuses = [...(options.approvalStatuses ?? [])];
  let grants = 0;
  const fetch = vi.fn(
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith("/api/v1/device/authorize")) {
        grants += 1;
        authorizeBodies.push(JSON.parse(String(init.body)));
        return json({
          device_code: `device-${grants}`,
          user_code: `code-${grants}`,
        });
      }
      if (url.endsWith("/v1/device/approve")) {
        const body = JSON.parse(String(init.body)) as {
          organization_id: string;
        };
        approvals.push(body.organization_id);
        const status = approvalStatuses.shift() ?? 200;
        return status === 200
          ? json({ approved: true })
          : json({ error: "organization_access_denied" }, status);
      }
      if (url.endsWith("/api/v1/device/token")) {
        const approved = approvals.at(-1) ?? "";
        return json({
          access_token: `opaque-session:${grants}`,
          expires_in: 300,
          session: {
            organization_id: options.tokenOrganization?.(approved) ?? approved,
          },
        });
      }
      return json({}, endpointStatuses.shift() ?? 200);
    },
  );
  vi.stubGlobal("fetch", fetch);
  return { fetch, approvals, authorizeBodies };
}

describe("organization-bound Host sessions", () => {
  beforeEach(() => {
    clearHostSession();
    vi.stubGlobal("location", {
      href: "http://127.0.0.1:5180/connections",
      origin: "http://127.0.0.1:5180",
    });
  });

  afterEach(() => {
    clearHostSession();
    vi.unstubAllGlobals();
  });

  it("sends the ambient cookie from the cross-origin Pages dev server", async () => {
    const fetch = vi.fn(async () =>
      json({
        organizations: [{ id: "org_1", displayName: "Acme", role: "owner" }],
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(listSessionOrganizations()).resolves.toEqual([
      { id: "org_1", displayName: "Acme", role: "owner" },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8788/v1/organizations",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("explains the same-site deployment requirement when Identity rejects the cookie", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "unauthorized" }, 401)),
    );

    await expect(listSessionOrganizations()).rejects.toThrow(
      /sign in.*same-site.*sibling custom domains/iu,
    );
  });

  it("sends the ambient cookie to same-origin Identity", async () => {
    vi.stubGlobal("location", {
      href: "http://127.0.0.1:8788/connections",
      origin: "http://127.0.0.1:8788",
    });
    const fetch = vi.fn(async () => json({ organizations: [] }));
    vi.stubGlobal("fetch", fetch);

    await listSessionOrganizations();

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8788/v1/organizations",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("refuses a request that escapes the configured Identity origin", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      identityFetch("@untrusted.example/v1/organizations"),
    ).rejects.toThrow("escaped the configured API origin");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("approves the selected organization and omits it from Host authorize", async () => {
    const harness = hostHarness();

    await hostFetch("org_selected", "/api/v1/providers");

    expect(harness.approvals).toEqual(["org_selected"]);
    expect(harness.authorizeBodies).toEqual([
      { client_id: "opensesame-pages", scope: "opensesame.session" },
    ]);
    for (const [url, init] of harness.fetch.mock.calls) {
      expect(init?.credentials).toBe(
        String(url).includes("/v1/device/approve") ? "include" : "omit",
      );
    }
  });

  it("rejects a Host session that is not exactly bound to the selected org", async () => {
    hostHarness({ tokenOrganization: () => "" });

    await expect(
      hostFetch("org_selected", "/api/v1/providers"),
    ).rejects.toThrow("different organization");
  });

  it("remints after an organization switch and after a Host 401", async () => {
    const harness = hostHarness({ endpointStatuses: [200, 401, 200] });

    await expect(
      hostFetch("org_1", "/api/v1/providers").then(
        (response) => response.status,
      ),
    ).resolves.toBe(200);
    clearHostSession();
    await expect(
      hostFetch("org_2", "/api/v1/providers").then(
        (response) => response.status,
      ),
    ).resolves.toBe(200);

    expect(harness.approvals).toEqual(["org_1", "org_2", "org_2"]);
  });

  it("surfaces organization denial while reminting after a Host 401", async () => {
    const harness = hostHarness({
      endpointStatuses: [200, 401],
      approvalStatuses: [200, 200, 403],
    });

    await hostFetch("org_1", "/api/v1/providers");
    clearHostSession();

    await expect(hostFetch("org_2", "/api/v1/providers")).rejects.toThrow(
      "organization_access_denied",
    );
    expect(harness.approvals).toEqual(["org_1", "org_2", "org_2"]);
  });

  it("deduplicates reminting after concurrent requests reject one token", async () => {
    const harness = hostHarness({
      endpointStatuses: [200, 401, 401, 200, 200],
    });

    await hostFetch("org_1", "/api/v1/providers");
    const responses = await Promise.all([
      hostFetch("org_1", "/api/v1/providers"),
      hostFetch("org_1", "/api/v1/integrations"),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(harness.approvals).toEqual(["org_1", "org_1"]);
  });
});
