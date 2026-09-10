import { expect } from "vitest";
/** The hard rule from the design contract: no multi-sentence paragraphs. */
export function expectProseBudget(container: HTMLElement) {
  for (const p of container.querySelectorAll("p")) {
    const text = p.textContent ?? "";
    const sentences = text
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => sentence.trim().length > 0);
    expect(
      sentences.length,
      `multi-sentence paragraph: ${text}`,
    ).toBeLessThanOrEqual(1);
  }
}

type ClientOverrides = { id?: string; state?: string };

export function makeClient(overrides: ClientOverrides = {}) {
  return {
    id: "cli_1",
    displayName: "Release pipeline",
    admissionMode: "pre_registered",
    state: "active",
    redirectUris: ["https://ci.example.com/callback"],
    sectorIdentifier: "https://ci.example.com",
    tokenEndpointAuthMethod: "none",
    allowedScopes: ["openid"],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}
