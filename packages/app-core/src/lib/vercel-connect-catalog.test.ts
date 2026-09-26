import { describe, expect, it } from "vitest";
import type { Provider } from "./connections.js";
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

  it("marks payment and card issuers as not connectable", () => {
    expect(isVercelConnectable("slack")).toBe(true);
    expect(isVercelConnectable("github")).toBe(false);
    expect(isVercelConnectable("stripe")).toBe(false);
    expect(isVercelConnectable("razorpay")).toBe(false);
    expect(isVercelConnectable("agentcard")).toBe(false);
    expect(isVercelConnectable("tailscale")).toBe(false);
  });

  it("keeps managed connectors human-authorized, never autoConfigurable", () => {
    expect(
      vercelConnectCatalog()
        .filter((row) => row.autoConfigurable)
        .map((row) => row.id),
    ).toEqual([]);
  });

  it("notes unconfigured Vercel rows and blocked rows on the tile", () => {
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
      label: "Not connectable",
      tone: "chip--err",
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
    expect(ids).toEqual(expect.arrayContaining(["discord", "groq"]));
  });

  it("refuses card issuers on Connect and keeps their bundled road", () => {
    const merged = mergeVercelCatalog(getBundledProviders());
    for (const id of ["privacy", "lithic", "marqeta", "stripe-issuing"]) {
      expect(hasConnectRoute(id)).toBe(false);
      expect(isVercelConnectable(id)).toBe(false);
      expect(merged.filter((row) => row.id === id)).toHaveLength(1);
      const row = merged.find((item) => item.id === id);
      expect(row?.category).toBe("wallet");
      if (row) expect(catalogTileNote(row, null)).toBeNull();
    }
  });
});
