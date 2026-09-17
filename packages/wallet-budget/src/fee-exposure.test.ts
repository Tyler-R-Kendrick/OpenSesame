import { describe, expect, it } from "vitest";
import {
  reserveTransferAndFee,
  transferCapAllInLossLabel,
} from "./fee-exposure.js";

describe("reserveTransferAndFee (WAL-E26)", () => {
  it("reserves transfer and fee from disjoint remainders", () => {
    const result = reserveTransferAndFee({
      transferAmount: 10n,
      feeAmount: 2n,
      transferRemaining: 100n,
      feeRemaining: 5n,
      chargeFeeFromTransferBudget: false,
    });
    expect(result).toEqual({
      ok: true,
      transferReserved: 10n,
      feeReserved: 2n,
      transferRemainingAfter: 90n,
      feeRemainingAfter: 3n,
      allInLossCap: false,
    });
  });

  it("refuses charging fees from the transfer allocation", () => {
    const transferRemaining = 100n;
    const result = reserveTransferAndFee({
      transferAmount: 10n,
      feeAmount: 2n,
      transferRemaining,
      feeRemaining: 0n,
      chargeFeeFromTransferBudget: true,
    });
    expect(result).toEqual({ ok: false, code: "FEE_FROM_TRANSFER_REFUSED" });
    expect(transferRemaining).toBe(100n);
  });

  it("refuses when the fee budget is too small without touching transfer remaining", () => {
    const transferRemaining = 50n;
    const result = reserveTransferAndFee({
      transferAmount: 10n,
      feeAmount: 9n,
      transferRemaining,
      feeRemaining: 1n,
      chargeFeeFromTransferBudget: false,
    });
    expect(result).toEqual({ ok: false, code: "INSUFFICIENT_FEE_BUDGET" });
    expect(transferRemaining).toBe(50n);
  });

  it("never labels a transfer cap as an all-in loss cap", () => {
    const label = transferCapAllInLossLabel("100");
    expect(label).toContain("not an all-in loss cap");
  });
});
