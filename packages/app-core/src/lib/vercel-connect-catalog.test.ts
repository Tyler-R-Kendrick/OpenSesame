import { describe, expect, it } from "vitest";
import type { Provider } from "./connections.js";
import { catalogProvider } from "./connector-catalog.js";
import { getBundledProviders } from "./embedded-catalog.js";
import {
  catalogTileNote,
  hasConnectRoute,
  isVercelCatalogId,
  isVercelConnectable,
  mergeVercelCatalog,
  vercelConnectCatalog,
} from "./vercel-connect-catalog.js";

describe("Vercel Connect browse catalog", () => {
  it("lists the Vercel browse catalog including managed and preset services", () => {
    const ids = vercelConnectCatalog().map((row) => row.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "linear",
        "slack",
        "microsoft",
        "snowflake",
        "notion",
        "openai",
        "stripe",
      ]),
    );
    expect(ids).not.toContain("github");
    expect(ids.length).toBeGreaterThan(100);
  });

  it("keeps registered readonly payment contracts configurable and unknown providers unavailable", () => {
    expect(isVercelConnectable("slack")).toBe(true);
    expect(isVercelConnectable("github")).toBe(false);
    expect(isVercelConnectable("stripe")).toBe(true);
    expect(isVercelConnectable("razorpay")).toBe(true);
    expect(isVercelConnectable("agentcard")).toBe(true);
    expect(hasConnectRoute("unknown-native-payment")).toBe(false);
    expect(isVercelConnectable("unknown-native-payment")).toBe(false);
    expect(isVercelConnectable("tailscale")).toBe(false);
  });

  it("keeps managed connectors human-authorized, never autoConfigurable", () => {
    expect(
      vercelConnectCatalog()
        .filter((row) => row.autoConfigurable)
        .map((row) => row.id),
    ).toEqual([]);
  });

  it("notes admitted but unconfigured Vercel rows without claiming a verification", () => {
    const slack = vercelConnectCatalog().find((row) => row.id === "slack");
    const stripe = vercelConnectCatalog().find((row) => row.id === "stripe");
    expect(slack).toBeTruthy();
    expect(stripe).toBeTruthy();
    // SAFETY: fixture constructed in this test matches the declared contract.
    expect(catalogTileNote(slack as Provider, null)).toEqual({
      label: "Not configured",
      tone: "chip",
    });
    // SAFETY: fixture constructed in this test matches the declared contract.
    expect(catalogTileNote(stripe as Provider, null)).toEqual({
      label: "Not configured",
      tone: "chip",
    });
  });

  it("keeps OpenSesame-only bundled rows that Vercel does not list", () => {
    // SAFETY: fixture constructed in this test matches the declared contract.
    const tailscale = {
      id: "tailscale",
      displayName: "Tailscale",
      category: "networking",
    } as Provider;
    // SAFETY: fixture constructed in this test matches the declared contract.
    const github = {
      id: "github",
      displayName: "GitHub (bundled)",
      category: "developer",
    } as Provider;
    const merged = mergeVercelCatalog([tailscale, github]);
    expect(merged.some((row) => row.id === "tailscale")).toBe(true);
    // GitHub is Host/App-backed, not a Connect browse row — bundled wins.
    expect(merged.filter((row) => row.id === "github")).toHaveLength(1);
    expect(merged.find((row) => row.id === "github")?.displayName).toBe(
      "GitHub (bundled)",
    );
  });

  it("lists Bitbucket under backup/recovery", () => {
    const row = vercelConnectCatalog().find((item) => item.id === "bitbucket");
    expect(row).toMatchObject({
      displayName: "Bitbucket",
      category: "backup_recovery",
      authKind: "oauth2_authorization_code",
    });
  });

  it("lists Codeberg under backup/recovery", () => {
    const row = vercelConnectCatalog().find((item) => item.id === "codeberg");
    expect(row).toMatchObject({
      displayName: "Codeberg",
      category: "backup_recovery",
      authKind: "oauth2_authorization_code",
    });
  });

  it("lists Cursor Origin under backup/recovery", () => {
    const row = vercelConnectCatalog().find((item) => item.id === "origin");
    expect(row).toMatchObject({
      displayName: "Cursor Origin",
      category: "backup_recovery",
      authKind: "oauth2_authorization_code",
    });
  });

  it("never replaces a bundled row Vercel does not list", () => {
    const merged = mergeVercelCatalog(getBundledProviders());
    for (const id of ["doppler", "huggingface"]) {
      expect(isVercelCatalogId(id)).toBe(false);
      expect(hasConnectRoute(id)).toBe(true);
      const rows = merged.filter((row) => row.id === id);
      expect(rows).toHaveLength(1);
      // The bundled row, with its own operations, not a plan-built one.
      expect(rows[0]).toEqual(
        getBundledProviders().find((row) => row.id === id),
      );
    }
  });

  it("lists a plan with no bundled row of its own", () => {
    const ids = vercelConnectCatalog().map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining(["discord", "brevo"]));
  });

  it("distinguishes local wallet configuration from a verified specialized key", () => {
    const wallet = getBundledProviders().find(
      (provider) => provider.id === "google-wallet",
    );
    if (!wallet) throw new Error("Expected Google Wallet");
    const connection: NonNullable<Parameters<typeof catalogTileNote>[1]> = {
      connectionId: "local-wallet",
      connectionRef: "local/connector/local-wallet",
      logicalName: "local-wallet",
      displayName: "Local Google Wallet",
      providerId: "google-wallet",
      integrationId: null,
      status: "active",
      statusDetail: null,
      organizationId: "local",
      projectId: null,
      ownerKind: "user",
      shareability: "private",
      requestedScopes: [],
      grantedScopes: [],
      accountLabel: null,
      expiresAt: null,
      refreshable: false,
      lastRefreshedAt: null,
      maxInvokeLevel: 0,
      egress: { scheme: "none", authorities: [], pathPrefixes: [] },
      bindings: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    expect(catalogTileNote(wallet, connection, "native-local")).toEqual({
      label: "Configured",
      tone: "chip--ok",
    });
    expect(catalogTileNote(wallet, connection, "api-key")).toEqual({
      label: "Connected",
      tone: "chip--ok",
    });
    expect(catalogTileNote(wallet, { ...connection, status: "error" })).toEqual(
      {
        label: "Broken",
        tone: "chip--err",
      },
    );
  });

  it("keeps legacy active Google Drive connections labeled connected", () => {
    const drive = catalogProvider("google-drive");
    if (!drive) throw new Error("Expected Google Drive");
    const connection: NonNullable<Parameters<typeof catalogTileNote>[1]> = {
      connectionId: "legacy-drive",
      connectionRef: "legacy-drive",
      logicalName: "legacy-drive",
      displayName: "Google Drive",
      providerId: "google-drive",
      integrationId: "google-drive",
      status: "active",
      statusDetail: null,
      organizationId: "org",
      projectId: null,
      ownerKind: "user",
      shareability: "private",
      requestedScopes: [],
      grantedScopes: [],
      accountLabel: null,
      expiresAt: null,
      refreshable: false,
      lastRefreshedAt: null,
      maxInvokeLevel: 0,
      egress: { scheme: "none", authorities: [], pathPrefixes: [] },
      bindings: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    expect(catalogTileNote(drive, connection)).toEqual({
      label: "Connected",
      tone: "chip--ok",
    });
  });

  it("admits fixed readonly issuer routes while retaining their bundled catalog ownership", () => {
    const merged = mergeVercelCatalog(getBundledProviders());
    for (const id of ["privacy", "lithic", "marqeta", "stripe-issuing"]) {
      expect(hasConnectRoute(id)).toBe(true);
      expect(isVercelConnectable(id)).toBe(false);
      expect(merged.filter((row) => row.id === id)).toHaveLength(1);
      const row = merged.find((item) => item.id === id);
      expect(row?.category).toBe("wallet");
      if (!row) throw new Error(`Expected the retained wallet provider ${id}`);
      expect(catalogTileNote(row, null)).toBeNull();
    }
  });
});
