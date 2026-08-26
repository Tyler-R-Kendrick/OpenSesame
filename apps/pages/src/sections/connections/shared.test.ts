import { describe, expect, it } from "vitest";
import type { Connection } from "../../lib/connections.js";
import { ConnectionsError } from "../../lib/connections.js";
import {
  connectorPath,
  errorText,
  formatWhen,
  relative,
  statusSentence,
} from "./shared.js";

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    connectionId: "conn_1",
    connectionRef: "osc://acme/github/conn_1",
    logicalName: "github",
    displayName: "GitHub",
    providerId: "github",
    integrationId: null,
    status: "active",
    statusDetail: null,
    organizationId: "org_1",
    projectId: null,
    ownerKind: "user",
    shareability: "private",
    requestedScopes: [],
    grantedScopes: [],
    accountLabel: null,
    expiresAt: null,
    refreshable: true,
    lastRefreshedAt: null,
    maxInvokeLevel: 1,
    egress: { scheme: "https", authorities: [], pathPrefixes: [] },
    bindings: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("connectorPath", () => {
  it("encodes provider and connection ids", () => {
    expect(connectorPath("github")).toBe("/connections/github");
    expect(connectorPath("a b", "c/d")).toBe("/connections/a%20b/c%2Fd");
  });
});

describe("formatWhen", () => {
  it("dashes out a missing timestamp and passes garbage through", () => {
    expect(formatWhen(null)).toBe("—");
    expect(formatWhen("not-a-date")).toBe("not-a-date");
  });
});

describe("relative", () => {
  it("returns null for missing or invalid input", () => {
    expect(relative(null)).toBeNull();
    expect(relative("nope")).toBeNull();
  });

  it("describes a near-future horizon", () => {
    const soon = new Date(Date.now() + 10 * 60_000).toISOString();
    expect(relative(soon)).toMatch(/minute/);
  });
});

describe("errorText", () => {
  it("maps bad-credential exchange failures to plain advice", () => {
    const error = new ConnectionsError(
      400,
      "exchange_failed",
      "Bad credentials",
    );
    expect(errorText(error)).toMatch(/classic PAT/);
  });

  it("never renders a Zod issue wall", () => {
    const zodish = Object.assign(new Error("boom"), { issues: [{}] });
    expect(errorText(zodish)).toMatch(/does not understand/);
  });

  it("falls back to a plain sentence for unknown values", () => {
    expect(errorText(undefined)).toBe("Something went wrong.");
  });
});

describe("statusSentence", () => {
  it("describes a refreshable active connection", () => {
    expect(statusSentence(connection({ accountLabel: "octocat" }))).toMatch(
      /as octocat.*Renews itself/,
    );
  });

  it("prefers the provider's own detail for needs_reauth", () => {
    expect(
      statusSentence(
        connection({ status: "needs_reauth", statusDetail: "Token revoked" }),
      ),
    ).toBe("Token revoked");
  });

  it("explains expiry when there is no refresh token", () => {
    expect(statusSentence(connection({ status: "expired" }))).toMatch(
      /no refresh token/,
    );
  });
});
