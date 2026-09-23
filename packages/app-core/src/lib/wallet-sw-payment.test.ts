import { describe, expect, it } from "vitest";
import { assessPaymentDuringWorkerUpdate } from "./wallet-sw-payment.js";

describe("assessPaymentDuringWorkerUpdate (WAL-B09)", () => {
  it("allows execute when no payment is in flight", () => {
    expect(
      assessPaymentDuringWorkerUpdate({
        paymentInFlight: false,
        workerState: "installing",
        controllerChanged: true,
      }),
    ).toEqual({ allowExecute: true });
  });

  it("refuses execute while a worker is activating under an in-flight payment", () => {
    expect(
      assessPaymentDuringWorkerUpdate({
        paymentInFlight: true,
        workerState: "activating",
        controllerChanged: false,
      }),
    ).toEqual({
      allowExecute: false,
      code: "SERVICE_WORKER_UPDATE_REQUIRES_REAUTHORIZATION",
    });
  });

  it("refuses execute when the controller changed mid-payment", () => {
    expect(
      assessPaymentDuringWorkerUpdate({
        paymentInFlight: true,
        workerState: "activated",
        controllerChanged: true,
      }),
    ).toEqual({
      allowExecute: false,
      code: "SERVICE_WORKER_UPDATE_REQUIRES_REAUTHORIZATION",
    });
  });
});
