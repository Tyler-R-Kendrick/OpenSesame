import { expect, it } from "vitest";
import {
  type PendingCodeWindow,
  pendingCodeBudgetFull,
  reclaimPendingCodes,
} from "./local-pending-codes.js";
it("bounds pending consent codes at128 and preserves all unexpired requests", () => {
  const codes = new Map<string, PendingCodeWindow>();
  for (let index = 0; index < 127; index++)
    codes.set(String(index), { issuedAt: 1000, expiresAt: 121000 });
  expect(pendingCodeBudgetFull(codes)).toBe(false);
  codes.set("last", { issuedAt: 1000, expiresAt: 121000 });
  expect(pendingCodeBudgetFull(codes)).toBe(true);
  reclaimPendingCodes(codes, 120999);
  expect(codes.size).toBe(128);
  expect(pendingCodeBudgetFull(codes)).toBe(true);
  reclaimPendingCodes(codes, 121000);
  expect(codes.size).toBe(0);
  expect(pendingCodeBudgetFull(codes)).toBe(false);
});
it("reclaims expired and future-issued requests while retaining current authority windows", () => {
  const codes = new Map<string, PendingCodeWindow>([
    ["expired", { issuedAt: 1000, expiresAt: 2000 }],
    ["current", { issuedAt: 1000, expiresAt: 3000 }],
    ["future", { issuedAt: 2001, expiresAt: 4000 }],
  ]);
  reclaimPendingCodes(codes, 2000);
  expect([...codes.keys()]).toEqual(["current"]);
});
