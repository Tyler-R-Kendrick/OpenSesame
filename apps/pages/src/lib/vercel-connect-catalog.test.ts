import { describe, expect, it } from "vitest";
import type { Provider } from "./connections.js";
import {
  catalogTileNote,
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
});
