/**
 * WAL-B09 — a service-worker update during payment is not background auto-pay.
 * Execute must be re-authorized after the controller changes.
 */

export type WalletWorkerState =
  | "none"
  | "installing"
  | "installed"
  | "activating"
  | "activated"
  | "redundant";

export type WalletWorkerPaymentAssessment =
  | { readonly allowExecute: true }
  | {
      readonly allowExecute: false;
      readonly code: "SERVICE_WORKER_UPDATE_REQUIRES_REAUTHORIZATION";
    };

export function assessPaymentDuringWorkerUpdate(input: {
  readonly paymentInFlight: boolean;
  readonly workerState: WalletWorkerState;
  readonly controllerChanged: boolean;
}): WalletWorkerPaymentAssessment {
  if (!input.paymentInFlight) {
    return { allowExecute: true };
  }
  if (
    input.controllerChanged ||
    input.workerState === "installing" ||
    input.workerState === "activating"
  ) {
    return {
      allowExecute: false,
      code: "SERVICE_WORKER_UPDATE_REQUIRES_REAUTHORIZATION",
    };
  }
  return { allowExecute: true };
}
