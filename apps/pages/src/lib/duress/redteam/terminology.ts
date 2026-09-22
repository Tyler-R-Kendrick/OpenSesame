/**
 * REDTEAM-E: Forbidden product claims / terminology that must not appear as
 * affirmative guarantees in duress docs, UI copy, or effect assurances.
 */

export const FORBIDDEN_CLAIM_PATTERNS: readonly {
  id: string;
  pattern: RegExp;
  reason: string;
}[] = [
  {
    id: "TERM-SAFE-COERCION",
    pattern:
      /\b(safe from coercion|coercion[- ]proof|guarantees? (personal )?safety)\b/i,
    reason: "Product cannot observe or prevent physical coercion (INV-07).",
  },
  {
    id: "TERM-FORENSIC",
    pattern:
      /\b(forensic(ally)? (eras|wip|delet)|secure delete of all traces|unrecoverable from disk)\b/i,
    reason:
      "Local removal is application-scoped, not forensic wipe (INV-22..24).",
  },
  {
    id: "TERM-UNDETECTABLE",
    pattern:
      /\b(undetectable activation|completely hidden duress|invisible to observer)\b/i,
    reason: "INV-27 constrains default product signals only.",
  },
  {
    id: "TERM-TAMPER-CLOCK",
    pattern: /\b(tamper[- ]proof (timer|hold|clock)|unforgeable local hold)\b/i,
    reason: "Client clocks are mutable (INV-19).",
  },
  {
    id: "TERM-ALERT-HANDLED",
    pattern:
      /\b(alert (means|equals) (emergency )?handled|delivery confirms safety)\b/i,
    reason: "Delivery ≠ human receipt/ack (INV-14, INV-16).",
  },
  {
    id: "TERM-RETRO-SECRECY",
    pattern:
      /\b(root rotation (implies|ensures) retroactive secrecy|historical copies (are )?erased)\b/i,
    reason: "Historical offline copies remain (INV-24).",
  },
  {
    id: "TERM-NETWORK-AUTH",
    pattern:
      /\b(network presence (is|=) authority|online (implies|means) trusted)\b/i,
    reason: "Peer/network presence is not authority (AT-060).",
  },
  {
    id: "TERM-DECOY-FORGE",
    pattern:
      /\b(decoy forges production|indistinguishable from production vault)\b/i,
    reason: "Decoy must not forge production (INV-28).",
  },
  {
    id: "TERM-AGENT-ADMIN",
    pattern:
      /\b(agent (can|may) (enroll|arm|administer) duress|mcp duress admin)\b/i,
    reason: "Agent surfaces must not administer duress (INV-32).",
  },
  {
    id: "TERM-UV-BIOMETRIC",
    pattern:
      /\b(UV (equals|is|=) biometrics|biometric (alone )?unlocks duress)\b/i,
    reason: "UV ≠ biometrics; two-input crypto required when claimed (INV-08).",
  },
] as const;

export type ForbiddenClaimHit = Readonly<{
  id: string;
  reason: string;
}>;

export function findForbiddenClaims(text: string): ForbiddenClaimHit[] {
  const hits: ForbiddenClaimHit[] = [];
  for (const row of FORBIDDEN_CLAIM_PATTERNS) {
    if (row.pattern.test(text)) hits.push({ id: row.id, reason: row.reason });
  }
  return hits;
}
