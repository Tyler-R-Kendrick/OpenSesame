import { describe, expect, it } from "vitest";
import { DURESS_ATTACK_TREES, attackTreeById } from "./attack-trees.js";
import { findForbiddenClaims } from "./terminology.js";

describe("duress redteam catalogs", () => {
  it("covers coercion, operator, peer, stale, backup, alert, crypto", () => {
    const ids = DURESS_ATTACK_TREES.map((n) => n.id);
    for (const need of [
      "AT-COERCE-01",
      "AT-OP-01",
      "AT-PEER-01",
      "AT-STALE-01",
      "AT-BACKUP-01",
      "AT-ALERT-01",
      "AT-CRYPTO-01",
      "AT-BYPASS-01",
    ]) {
      expect(ids).toContain(need);
      expect(attackTreeById(need)?.expectedDefense.length).toBeGreaterThan(10);
    }
  });

  it("terminology detector works", () => {
    expect(
      findForbiddenClaims("undetectable activation guaranteed").length,
    ).toBeGreaterThan(0);
    expect(findForbiddenClaims("application-scoped removal only").length).toBe(
      0,
    );
  });
});
