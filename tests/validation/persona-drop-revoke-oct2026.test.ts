/**
 * Persona must-fix #1 (Oct 2026): revoke + ciphertext disposal anchors.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

describe("persona drop revoke anchors", () => {
  it("revokes local claims and clears ciphertext after presentation", () => {
    const claims = read("packages/app-core/src/lib/vault/local-drop-claims.ts");
    expect(claims).toMatch(/export async function revokeLocalDropClaim/);
    expect(claims).toMatch(/targetManifest: \{\}/);

    const store = read("packages/app-core/src/lib/vault/store.ts");
    expect(store).toMatch(/commitDiscard/);

    const revoke = read("packages/app-core/src/lib/vault/drop-revoke.ts");
    expect(revoke).toMatch(/export async function commitDiscard/);
    expect(revoke).toMatch(/export async function revokeDropVaultItem/);

    const edits = read("packages/app-core/src/lib/vault/body-edits.ts");
    expect(edits).toMatch(/export function expireDropClaims/);
  });

  it("keeps share-once sends on a sender ledger outside the vault", () => {
    const outbound = read("packages/app-core/src/lib/vault/outbound-drops.ts");
    expect(outbound).toMatch(/recordOutboundDrop/);
    expect(outbound).toMatch(/listOutboundDrops/);

    const drop = read("packages/app-core/src/lib/vault/drop.ts");
    expect(drop).toMatch(/recordOutboundDrop/);
  });
});
