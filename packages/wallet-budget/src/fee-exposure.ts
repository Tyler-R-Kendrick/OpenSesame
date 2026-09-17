/**
 * WAL-E26 — transfer caps and fee exposure are separate remaining amounts.
 * Charging gas/relayer fees from the transfer allocation is refused. A transfer
 * ceiling is never an all-in loss cap.
 */

export type FeeExposureOk = {
  readonly ok: true;
  readonly transferReserved: bigint;
  readonly feeReserved: bigint;
  readonly transferRemainingAfter: bigint;
  readonly feeRemainingAfter: bigint;
  /** Always false: transfer remaining is not an all-assets loss bound. */
  readonly allInLossCap: false;
};

export type FeeExposureRefusal = {
  readonly ok: false;
  readonly code:
    | "FEE_FROM_TRANSFER_REFUSED"
    | "INSUFFICIENT_FEE_BUDGET"
    | "INSUFFICIENT_AVAILABLE"
    | "INVALID_AMOUNT";
};

export type FeeExposureAssessment = FeeExposureOk | FeeExposureRefusal;

export function reserveTransferAndFee(input: {
  readonly transferAmount: bigint;
  readonly feeAmount: bigint;
  readonly transferRemaining: bigint;
  readonly feeRemaining: bigint;
  readonly chargeFeeFromTransferBudget: boolean;
}): FeeExposureAssessment {
  if (input.transferAmount < 0n || input.feeAmount < 0n) {
    return { ok: false, code: "INVALID_AMOUNT" };
  }
  if (input.chargeFeeFromTransferBudget && input.feeAmount > 0n) {
    return { ok: false, code: "FEE_FROM_TRANSFER_REFUSED" };
  }
  if (input.transferAmount > input.transferRemaining) {
    return { ok: false, code: "INSUFFICIENT_AVAILABLE" };
  }
  if (input.feeAmount > input.feeRemaining) {
    return { ok: false, code: "INSUFFICIENT_FEE_BUDGET" };
  }
  return {
    ok: true,
    transferReserved: input.transferAmount,
    feeReserved: input.feeAmount,
    transferRemainingAfter: input.transferRemaining - input.transferAmount,
    feeRemainingAfter: input.feeRemaining - input.feeAmount,
    allInLossCap: false,
  };
}

export function transferCapAllInLossLabel(transferCapDisplay: string): string {
  return `Transfer cap ${transferCapDisplay} (not an all-in loss cap; fees are separate)`;
}
